/**
 * blob-store/1.0, the client side. Keeping and deleting a blob go to the
 * mediator over a link, as whoever the link speaks for: the blob is that
 * DID's, counted against its quota, and ends with its standing at the
 * mediator. The bytes go over plain HTTP, uploaded where a put says and
 * read back from the blob's URL. Reading needs no identity: anyone with
 * the URL may read the blob, its bytes being ciphertext under a key the
 * store never sees.
 */

import { BlobTooLarge, BlobTransferFailed, MediatorRefused } from "./errors.js";
import { bounded, type MediatorLink } from "./link.js";
import { BLOB_DELETE, BLOB_DELETE_RESULT, BLOB_PUT, BLOB_PUT_RESULT } from "./protocol/blob-store.js";
import { control } from "./replica-enrollment.js";

/** What the mediator says of its blobs. */
export interface BlobLimits {
  /** the most bytes one blob may have */
  maxBytes: number;
  /** the most bytes one owner's blobs may have together */
  quotaBytes: number;
  /** how long a put keeps a blob */
  retainSeconds: number;
}

/** Where a put left a blob. Times are milliseconds since the epoch. */
export interface BlobPlacement {
  hash: string;
  /** where the blob is served once its bytes are uploaded */
  url: string;
  /** until when the store means to keep the blob */
  retainUntil: number;
  /** where to PUT the bytes, and until when that is granted; null when the store holds them already */
  upload: { url: string; expires: number } | null;
}

export interface BlobStoreOptions {
  /** injectable for tests; the global one by default */
  fetch?: typeof fetch;
  /** how long reading the mediator's limits may take; default 15s */
  timeoutMs?: number;
}

export class BlobStore {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly link: MediatorLink,
    options: BlobStoreOptions = {}
  ) {
    // wrapped, not assigned: a native fetch called with `this` bound to anything but the global is an "Illegal invocation" in browsers
    const fetchImpl = options.fetch ?? fetch;
    this.fetchFn = (input, init) => fetchImpl(input, init);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The limits the mediator publishes at its HTTP endpoint; null when it keeps no blobs. */
  async limits(): Promise<BlobLimits | null> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const described = await bounded(signal, async () => {
      const response = await this.fetchFn(this.link.http(), { headers: { accept: "application/json" }, signal });
      if (!response.ok) throw new MediatorRefused(`the mediator answered ${response.status} to a request for its limits`);
      return (await response.json()) as unknown;
    });
    const blobs = (described as { blobs?: unknown } | null)?.blobs;
    if (blobs === undefined) return null;
    const { maxBytes, quotaBytes, retainSeconds } = (blobs ?? {}) as Record<string, unknown>;
    if (!isCount(maxBytes) || !isCount(quotaBytes) || !isCount(retainSeconds)) throw new MediatorRefused("the mediator's blob limits are malformed");
    return { maxBytes, quotaBytes, retainSeconds };
  }

  /**
   * Ask the mediator to keep a blob of `size` bytes named `hash`. A hash
   * it keeps already for the same owner is kept longer, under the same
   * URL. A refusal is a `MediatorRefused` whose code says why:
   * `BLOB_TOO_LARGE`, `BLOB_QUOTA` or `BLOB_REFUSED`.
   */
  async put(hash: string, size: number): Promise<BlobPlacement> {
    const reply = await control(this.link, BLOB_PUT, { hash, size }, BLOB_PUT_RESULT);
    const { hash: named, url, retain_until: retainUntil, upload } = reply.body as Record<string, unknown>;
    if (named !== hash) throw new MediatorRefused("put-result names another blob than the one put");
    const placement: BlobPlacement = { hash, url: httpUrl(url, "url"), retainUntil: instant(retainUntil, "retain_until"), upload: null };
    if (upload !== undefined) {
      const { url: to, expires } = (upload ?? {}) as Record<string, unknown>;
      placement.upload = { url: httpUrl(to, "upload.url"), expires: instant(expires, "upload.expires") };
    }
    return placement;
  }

  /** The bytes put where the placement says, given up on when its grant expires; nothing to do when the store holds them already. */
  async upload(placement: BlobPlacement, bytes: Uint8Array): Promise<void> {
    const { upload } = placement;
    if (upload === null) return;
    const signal = AbortSignal.timeout(Math.max(0, upload.expires - Date.now()));
    const response = await bounded(signal, () => this.fetchFn(upload.url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes, signal }));
    await response.body?.cancel();
    if (!response.ok) throw new BlobTransferFailed("upload", response.status);
  }

  /** The blob named `hash` deleted: its URL answers 404 from then on. One the store does not keep for the owner is no error. */
  async delete(hash: string): Promise<void> {
    const reply = await control(this.link, BLOB_DELETE, { hash }, BLOB_DELETE_RESULT);
    if (reply.body["hash"] !== hash) throw new MediatorRefused("delete-result names another blob than the one deleted");
  }
}

export interface ReadBlobOptions {
  /** the most bytes the read takes */
  maxBytes: number;
  /** how long the whole read may take */
  timeoutMs: number;
  /** injectable for tests; the global one by default */
  fetch?: typeof fetch;
}

/**
 * The bytes at a blob's URL, read as they arrive: a blob that declares
 * or runs over `maxBytes` stops the read there (`BlobTooLarge`), and
 * so does `timeoutMs` passing. Any answer but 2xx is a
 * `BlobTransferFailed`.
 */
export async function readBlob(url: string, options: ReadBlobOptions): Promise<Uint8Array> {
  const { maxBytes } = options;
  const fetchFn = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs);
  return bounded(signal, async () => {
    const response = await fetchFn(url, { signal });
    const body = response.body;
    if (!response.ok) {
      await body?.cancel();
      throw new BlobTransferFailed("read", response.status);
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await body?.cancel();
      throw new BlobTooLarge(maxBytes);
    }
    if (body === null) return new Uint8Array();
    const reader = body.getReader();
    const cancel = (): void => void reader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new BlobTooLarge(maxBytes);
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
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  });
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function httpUrl(value: unknown, member: string): string {
  if (typeof value === "string" && URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol)) return value;
  throw new MediatorRefused(`put-result ${member} is no HTTP URL`);
}

function instant(value: unknown, member: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new MediatorRefused(`put-result ${member} is no time`);
  return ms;
}
