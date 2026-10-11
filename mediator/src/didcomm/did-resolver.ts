import {
  isPeerDID2,
  isPeerDID4,
  isShortForm,
  resolveLongForm,
  resolvePeer2,
  toDIDCommDIDDoc,
} from "@estoc/did-peer";
import type { DIDDoc } from "@estoc/did-peer";

export interface ResolveResult {
  didDocument: Record<string, unknown> | null;
  didDocumentMetadata: Record<string, unknown>;
  didResolutionMetadata: {
    contentType?: string;
    error?: string;
    message?: string;
  };
}

const WEB_PREFIX = "did:web:";

/**
 * A did:peer carries its document or its keys in base58, and decoding that
 * takes time that grows faster than its length: an identifier well under the
 * envelope limit can hold the process for seconds. Whoever names one decides
 * its size and need not be known here, so the size is judged before anything
 * is decoded. The documents agents mint are a small fraction of this.
 */
export const MAX_PEER_DID_BYTES = 8192;

export function isDecodable(peerDid: string): boolean {
  return Buffer.byteLength(peerDid) <= MAX_PEER_DID_BYTES;
}

function resolved(didDocument: Record<string, unknown>): ResolveResult {
  return {
    didDocument,
    didDocumentMetadata: {},
    didResolutionMetadata: { contentType: "application/did+ld+json" },
  };
}

function failure(error: string, message: string): ResolveResult {
  return {
    didDocument: null,
    didDocumentMetadata: {},
    didResolutionMetadata: { error, message },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A did:peer is decoded from the string. A did:web is fetched only through
 * `web`, which holds the network policy; without it none is resolved.
 */
export async function resolveDID(
  did: string,
  web: WebDids | null = null
): Promise<ResolveResult> {
  if ((isPeerDID2(did) || isPeerDID4(did)) && !isDecodable(did)) {
    return failure(
      "invalidDid",
      `A did:peer larger than ${MAX_PEER_DID_BYTES} bytes is not decoded`
    );
  }

  if (isPeerDID2(did)) {
    return resolveDidPeer2(did);
  }

  if (isPeerDID4(did)) {
    return resolveDidPeer4(did);
  }

  if (did.startsWith(WEB_PREFIX)) {
    return web === null
      ? failure("methodNotSupported", "a did:web is fetched only under a network policy, and none is given")
      : web.resolve(did);
  }

  return failure(
    "methodNotSupported",
    `Unsupported DID method: ${did.split(":")[1] ?? "unknown"}`
  );
}

/**
 * did:webvh is not resolved here — the didwebvh-ts dependency is heavy and no
 * mediator client has shown up naming one. The didcomm-http sibling has the
 * implementation to lift when one does.
 */

/**
 * Resolve a DID into the flat DIDDoc the pack and unpack operations read.
 *
 * Anything that does not resolve, or resolves to something that cannot be
 * converted, is `null` — the same answer as a DID that does not exist, which is
 * what it amounts to for a message addressed to it.
 */
export async function resolveDIDCommDoc(
  did: string,
  web: WebDids | null = null
): Promise<DIDDoc | null> {
  const { didDocument } = await resolveDID(did, web);
  if (didDocument === null) {
    return null;
  }

  try {
    return toDIDCommDIDDoc(didDocument);
  } catch {
    return null;
  }
}

function resolveDidPeer2(did: string): ResolveResult {
  try {
    return resolved(resolvePeer2(did));
  } catch (err) {
    return failure("invalidDid", messageOf(err));
  }
}

function resolveDidPeer4(did: string): ResolveResult {
  // The short form carries no document, so it can only be resolved by a party
  // that already holds the long form.
  if (isShortForm(did)) {
    return failure(
      "notFound",
      "Short form did:peer:4 cannot be resolved on its own; supply the long form"
    );
  }

  try {
    return resolved(resolveLongForm(did));
  } catch (err) {
    return failure("invalidDid", messageOf(err));
  }
}

/**
 * How a did:web is fetched. A mediator resolves the DIDs strangers present,
 * and whoever names a did:web chooses the host it is fetched from, so every
 * fetch is held to one policy: https to a public name, no redirect followed,
 * at most `maxBytes` read, all of it within `timeoutMs`, and the document's
 * `id` the presented DID byte for byte. A fetch the policy refuses is a final
 * answer, and nothing retries it another way.
 */
export interface WebDidPolicy {
  /**
   * The transport. The name is checked here, but where it points can only be
   * checked where the connection is made, on every connection, since a name
   * may resolve differently next time. On Node that is `guardedFetch`, which
   * refuses every address that is not public unicast.
   */
  fetch: typeof fetch;
  /** Plain http to localhost or 127.0.0.1, for a client of a mediator run on this machine; refused otherwise. */
  insecureLoopback?: boolean;
  /** the most bytes a document may be; `MAX_WEB_DOCUMENT_BYTES` by default */
  maxBytes?: number;
  /** how long one fetch may take, to its last byte; `WEB_TIMEOUT_MS` by default */
  timeoutMs?: number;
}

export const MAX_WEB_DOCUMENT_BYTES = 64 * 1024;
export const WEB_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);
/** Name suffixes that name no public host: loopback, mDNS, private naming, reverse DNS. */
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"];
/** The URL parser gives every IPv4 spelling, hex and octal included, this dotted form. */
const IPV4_HOST = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * The one URL a did:web is fetched from, or why it is not fetched: an
 * authority that is more than a host and an optional port, a path segment
 * that would move the path, an IP literal, a reserved name, or a loopback
 * host unless `insecureLoopback` allows it.
 */
export function webDidUrl(did: string, insecureLoopback = false): URL | string {
  if (!did.startsWith(WEB_PREFIX)) {
    return "not a did:web";
  }
  let segments: string[];
  try {
    segments = did
      .slice(WEB_PREFIX.length)
      .split(":")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return "the method-specific ID is not percent-encoded";
  }
  const [authority = "", ...path] = segments;
  if (authority === "" || /[@/?#\\]/.test(authority)) {
    return "the authority is a host and an optional port, nothing else";
  }
  if (path.some((segment) => segment === "" || segment === "." || segment === ".." || /[/?#\\]/.test(segment))) {
    return "a path segment is empty, a dot segment or holds a delimiter";
  }
  let url: URL;
  try {
    url = new URL(`https://${authority}/`);
  } catch {
    return `${JSON.stringify(authority)} is not a host`;
  }
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (LOOPBACK_HOSTS.has(host)) {
    if (!insecureLoopback) {
      return "a loopback host";
    }
    url.protocol = "http:";
  } else if (host.startsWith("[") || IPV4_HOST.test(host)) {
    return "an IP-literal host";
  } else if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `a reserved name: ${host}`;
  }
  url.pathname =
    path.length === 0
      ? "/.well-known/did.json"
      : `/${path.map((segment) => encodeURIComponent(segment)).join("/")}/did.json`;
  return url;
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/** The body, or null once it runs past `maxBytes`; the rest is not waited for. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(response);
    return null;
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function fetchDocument(did: string, policy: WebDidPolicy): Promise<ResolveResult> {
  const url = webDidUrl(did, policy.insecureLoopback ?? false);
  if (typeof url === "string") {
    return failure("invalidDid", `${did} is not fetched: ${url}`);
  }
  const maxBytes = policy.maxBytes ?? MAX_WEB_DOCUMENT_BYTES;
  const timeoutMs = policy.timeoutMs ?? WEB_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const transport = policy.fetch;
  let bytes: Uint8Array | null;
  try {
    const response = await transport(url.href, {
      redirect: "manual",
      signal,
      headers: { accept: "application/did+json, application/json" },
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      discard(response);
      return failure("notFound", `GET ${url.href} answered a redirect (${response.status}), which is not followed`);
    }
    if (!response.ok) {
      discard(response);
      return failure("notFound", `GET ${url.href} answered ${response.status}`);
    }
    bytes = await readBounded(response, maxBytes);
  } catch (err) {
    return failure(
      "notFound",
      signal.aborted
        ? `GET ${url.href} took longer than ${timeoutMs} ms`
        : `GET ${url.href} failed: ${messageOf(err)}`
    );
  }
  if (bytes === null) {
    return failure("notFound", `the document at ${url.href} is larger than ${maxBytes} bytes`);
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    return failure("invalidDidDocument", `the document at ${url.href} is not JSON: ${messageOf(err)}`);
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return failure("invalidDidDocument", `the document at ${url.href} is not a JSON object`);
  }
  const id = (document as { id?: unknown }).id;
  if (id !== did) {
    return failure("invalidDidDocument", `the document at ${url.href} is ${JSON.stringify(id)}'s, not ${did}'s`);
  }
  return resolved(document as Record<string, unknown>);
}

/** How long a fetched document is reused, in seconds. */
const CACHE_TTL = Number(process.env.DID_CACHE_TTL ?? 300) * 1000;

/** Past this many entries the oldest is dropped, so a busy endpoint cannot grow it forever. */
const CACHE_MAX = 512;

/**
 * The did:web documents fetched under one policy, each reused for a while.
 * A did:peer is never kept here: decoding one costs no request, and so a
 * stranger introducing themselves under one pushes out none of the
 * documents that did.
 */
export class WebDids {
  private readonly cache = new Map<string, { document: Record<string, unknown>; expiresAt: number }>();

  constructor(private readonly policy: WebDidPolicy) {}

  async resolve(did: string): Promise<ResolveResult> {
    const hit = this.cached(did);
    if (hit !== null) {
      return resolved(hit);
    }
    const result = await fetchDocument(did, this.policy);
    if (result.didDocument !== null) {
      this.remember(did, result.didDocument);
    }
    return result;
  }

  private cached(did: string): Record<string, unknown> | null {
    const entry = this.cache.get(did);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(did);
      return null;
    }
    return entry.document;
  }

  private remember(did: string, document: Record<string, unknown>): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(did, { document, expiresAt: Date.now() + CACHE_TTL });
  }
}
