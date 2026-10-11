import {
  isPeerDID2,
  isPeerDID4,
  isShortForm,
  resolveLongForm,
  resolvePeer2,
  toDIDCommDIDDoc,
} from "@estoc/did-peer";
import type { DIDDoc } from "@estoc/did-peer";
import { fetchWebDid, type WebDidOptions } from "@estoc/did-web";

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

/** How long a fetched document is reused, in seconds. */
const CACHE_TTL = Number(process.env.DID_CACHE_TTL ?? 300) * 1000;

/** Past this many entries the oldest is dropped, so a busy endpoint cannot grow it forever. */
const CACHE_MAX = 512;

/**
 * The most bytes a document is read to unless the policy says otherwise.
 * Whoever presents a did:web makes the mediator fetch it and keep it, up to
 * `CACHE_MAX` at once, so the bound sits well below `@estoc/did-web`'s
 * default; a DIDComm agent's document is a few kilobytes.
 */
export const MAX_WEB_DOCUMENT_BYTES = 64 * 1024;

/**
 * The did:web documents fetched under one network policy, each reused for a
 * while. A did:peer is never kept here: decoding one costs no request, and so a
 * stranger introducing themselves under one pushes out none of the
 * documents that did.
 */
export class WebDids {
  private readonly cache = new Map<string, { document: Record<string, unknown>; expiresAt: number }>();

  private readonly policy: WebDidOptions;

  /** `policy` is `@estoc/did-web`'s, with `MAX_WEB_DOCUMENT_BYTES` unless it says otherwise. */
  constructor(policy: WebDidOptions) {
    this.policy = { ...policy, maxBytes: policy.maxBytes ?? MAX_WEB_DOCUMENT_BYTES };
  }

  async resolve(did: string): Promise<ResolveResult> {
    const hit = this.cached(did);
    if (hit !== null) {
      return resolved(hit);
    }
    const fetched = await fetchWebDid(did, this.policy);
    switch (fetched.outcome) {
      case "resolved":
        this.remember(did, fetched.document);
        return resolved(fetched.document);
      case "refused":
        return failure("invalidDid", fetched.reason);
      default:
        return failure("notFound", `${fetched.url.href}: ${fetched.reason}`);
    }
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
