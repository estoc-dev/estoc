import { webDidUrl } from "./url.js";

export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The codes a transport failure carries when its answer is final, on
 * the error or down its `cause` chain. `refused`: the transport's
 * policy forbids the connection. `noAddress`: the name has no address,
 * NXDOMAIN or NODATA for every usable address family. A transport
 * that cannot tell a name's absence from a lookup that failed leaves
 * the code off, and the failure counts as no answer now.
 */
export const DEFINITIVE_TRANSPORT_CODES = { refused: "EBLOCKED", noAddress: "ENXDOMAIN" } as const;

/**
 * How a did:web is fetched. Whoever presents a did:web chooses the host
 * it is fetched from, so every fetch is held to one policy: https to a
 * public name, no redirect followed, no cache answering, at most
 * `maxBytes` read, all of it within `timeoutMs`, and the document's `id`
 * the presented DID byte for byte: the spelling is the identity, whatever
 * URL or DNS processing the fetch went through.
 */
export interface WebDidOptions {
  /**
   * The transport, and where the network policy holds. A check on the
   * name binds nothing: only what makes the connection sees every address
   * the name resolves to, at lookup, and can refuse one that is not public
   * unicast, on every connection, since the name may resolve differently
   * next time. So the transport is the host's, under this contract: it
   * refuses what its policy forbids, follows no redirect, answers from no
   * cache, honours `signal`, and marks a failure that is final with a code
   * from `DEFINITIVE_TRANSPORT_CODES`. On Node that is `guardedFetch` from
   * `@estoc/did-web/node`.
   */
  fetch: typeof fetch;
  /** the most bytes a document may be; `MAX_DOCUMENT_BYTES` by default */
  maxBytes?: number;
  /** how long one fetch may take, to the parsed document; `DEFAULT_TIMEOUT_MS` by default */
  timeoutMs?: number;
  /**
   * Plain http to `localhost` or `127.0.0.1`: a service run on this
   * machine for development. Every loopback name is refused without it,
   * and nothing else is fetched over http.
   */
  insecureLoopback?: boolean;
  /** The body as JSON, or a throw that refuses it; fatal UTF-8 and `JSON.parse` by default. */
  parse?: (bytes: Uint8Array) => unknown;
}

/**
 * A fetch's outcome. `refused` is a DID the policy fetches nothing for,
 * settled before any request; `unavailable` is no answer now, and the
 * work stays retryable; `definitive` is an answer from the network that
 * closes the attempt. `url` is where the document was asked for.
 */
export type Fetched =
  | { outcome: "refused"; reason: string }
  | { outcome: "resolved"; url: URL; document: Record<string, unknown> }
  | { outcome: "unavailable"; url: URL; reason: string }
  | { outcome: "definitive"; url: URL; reason: string };

const RETRYABLE_STATUS = new Set([408, 429]);

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = err; at !== undefined && at !== null && chain.length < 8; at = (at as { cause?: unknown }).cause) chain.push(at);
  return chain;
}

function reasonOf(err: unknown): string {
  return [...new Set(causeChain(err).map(messageOf))].join(": ");
}

/** `work`, or the signal's reason once it aborts, whether or not the work heeds the signal. */
function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const running = work();
    const onAbort = (): void => {
      running.catch(() => undefined);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    running.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/**
 * A body, or its reader, no longer wanted, cancelled without waiting:
 * cancelling may wait on the source or fail, and neither changes an
 * answer already settled.
 */
function letGo(stream: { cancel(): Promise<void> } | null): void {
  void stream?.cancel().catch(() => undefined);
}

/** The body, or null once it runs past `maxBytes`; what fails while reading is the transport's. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    letGo(response.body);
    return null;
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > maxBytes ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      letGo(reader);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fetch a did:web's document under the policy in `options`, and check
 * it is the DID's own.
 */
export async function fetchWebDid(did: string, options: WebDidOptions): Promise<Fetched> {
  const derived = webDidUrl(did, options.insecureLoopback ?? false);
  if ("refused" in derived) return { outcome: "refused", reason: `the policy refuses ${did}: ${derived.refused}` };
  const { url } = derived;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DOCUMENT_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  const definitive = (reason: string): Fetched => ({ outcome: "definitive", url, reason });
  const unavailable = (reason: string): Fetched => ({ outcome: "unavailable", url, reason });

  /**
   * A failure of the transport, or of the body, as an outcome. A final
   * answer takes precedence over how it was wrapped: the definitive code
   * is looked for down the whole cause chain, past whatever generic code
   * an outer error carries, and past the deadline.
   */
  const transportFailure = (err: unknown, what: string): Fetched => {
    const codes = new Set(causeChain(err).map((at) => (at as { code?: unknown }).code));
    if (codes.has(DEFINITIVE_TRANSPORT_CODES.refused)) return definitive(`the transport refused the connection: ${reasonOf(err)}`);
    if (codes.has(DEFINITIVE_TRANSPORT_CODES.noAddress)) return definitive(`the authority has no address: ${reasonOf(err)}`);
    if (signal.aborted) return unavailable(`timed out: not resolved within ${timeoutMs} ms`);
    return unavailable(`${what}: ${reasonOf(err)}`);
  };

  // called on its own, not as `options.fetch(…)`: a native fetch called with `this` bound to anything but the global is refused in browsers and workerd
  const transport = options.fetch;
  let response: Response;
  try {
    response = await bounded(signal, () => transport(url.href, { redirect: "manual", cache: "no-store", signal, headers: { accept: "application/did+json, application/json" } }));
  } catch (err) {
    return transportFailure(err, "the fetch failed");
  }
  const { status } = response;
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    letGo(response.body);
    return definitive(`a redirect (${status}) is not followed`);
  }
  if (status < 200 || status >= 300) {
    letGo(response.body);
    if (RETRYABLE_STATUS.has(status) || status >= 500) return unavailable(`HTTP ${status}`);
    if (status === 404 || status === 410) return definitive(`HTTP ${status}: not found or deactivated`);
    return definitive(`HTTP ${status}`);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await bounded(signal, () => readBounded(response, maxBytes));
  } catch (err) {
    return transportFailure(err, "the body did not arrive whole");
  }
  if (bytes === null) return definitive(`the document is larger than ${maxBytes} bytes`);
  let document: unknown;
  try {
    document = (options.parse ?? parseJson)(bytes);
  } catch (err) {
    return definitive(`the document is not JSON: ${messageOf(err)}`);
  }
  if (!isObject(document)) return definitive("the document is not a JSON object");
  if (document["id"] !== did) return definitive(`the document is ${JSON.stringify(document["id"])}'s, not ${did}'s`);
  return { outcome: "resolved", url, document };
}
