/**
 * replica-channel/1.0: what one replica of a vault tells another
 * replica of the same seed. Nothing it carries is a fact of the vault:
 * a message asks its recipient to fetch what the vault's events already
 * say, so any message may be lost, repeated or reordered without harm,
 * and none is acknowledged or sent again. A type added here keeps to
 * that: what would do harm if it were lost is made a vault event first.
 */

import { isAuthorId, isJsonObject, type JsonObject } from "@estoc/event-store";
import type { ReplicaId } from "@estoc/vault";
import { base64url } from "multiformats/bases/base64";

import { BLOB_KEY_BYTES, isBlobName, type BlobLink } from "../sealed-blob.js";

export const REPLICA_CHANNEL = "https://estoc.dev/replica-channel/1.0";
/** a snapshot the sender put at the arrangement's mediator, for the recipient to import */
export const SNAPSHOT_LINK = `${REPLICA_CHANNEL}/snapshot-link`;

export interface SnapshotLink {
  /** the replica that sent it, which the sender's document must bear out */
  replicaId: ReplicaId;
  link: BlobLink;
}

const SNAPSHOT_LINK_MEMBERS = ["hash", "key", "replica_id", "url"].join();

export function snapshotLinkBody({ replicaId, link }: SnapshotLink): JsonObject {
  return { replica_id: replicaId, url: link.url, hash: link.hash, key: base64url.baseEncode(link.key) };
}

/**
 * A snapshot-link body: exactly four strings, the replica ID a
 * canonical UUIDv7, the URL absolute, the hash a blob's name and the
 * key the blob's in base64url without padding. Null for anything else.
 */
export function readSnapshotLink(body: unknown): SnapshotLink | null {
  if (!isJsonObject(body) || Object.keys(body).sort().join() !== SNAPSHOT_LINK_MEMBERS) return null;
  const { replica_id: replicaId, url, hash, key } = body;
  if (!isAuthorId(replicaId) || typeof url !== "string" || !isAbsoluteUrl(url) || typeof hash !== "string" || !isBlobName(hash) || typeof key !== "string") return null;
  const bytes = blobKeyOf(key);
  return bytes === null ? null : { replicaId, link: { url, hash, key: bytes } };
}

function isAbsoluteUrl(text: string): boolean {
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

function blobKeyOf(text: string): Uint8Array | null {
  try {
    const bytes = base64url.baseDecode(text);
    return bytes.length === BLOB_KEY_BYTES && base64url.baseEncode(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}
