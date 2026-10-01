import { base32 } from "multiformats/bases/base32";

/**
 * Two strings name a blob, for two purposes. The **hash** — a sha2-256
 * multihash in multibase base32 lower, `b` + base32(0x12 0x20 <32-byte
 * digest>), 56 characters, the same string an object-share package carries
 * as `data.hash` — is what the bytes are checked against on the way in.
 * The **id** — 20 random bytes, base32 lower, 32 characters — is where they
 * are served: `/b/<id>`. The id says nothing about the bytes or who put
 * them, and two mediations putting the same hash get two ids.
 */

const SHA256_PREFIX = [0x12, 0x20];
export const BLOB_NAME_PATTERN = /^b[a-z2-7]{55}$/;
export const BLOB_ID_PATTERN = /^[a-z2-7]{32}$/;
const ID_BYTES = 20;

/** A fresh blob id: 20 random bytes as base32. */
export function mintBlobId(): string {
  return base32.baseEncode(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

/** The blob name for a sha-256 digest. */
export function blobName(digest: Uint8Array): string {
  if (digest.length !== 32) {
    throw new Error("sha-256 digests are 32 bytes");
  }
  return base32.encode(Uint8Array.from([...SHA256_PREFIX, ...digest]));
}

/** The digest a blob name encodes, or null if the string is not a name. */
export function blobDigest(name: string): Uint8Array | null {
  if (!BLOB_NAME_PATTERN.test(name)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = base32.decode(name);
  } catch {
    return null;
  }
  if (
    bytes.length !== 34 ||
    bytes[0] !== SHA256_PREFIX[0] ||
    bytes[1] !== SHA256_PREFIX[1]
  ) {
    return null;
  }
  // The name must be canonical: re-encoding must give the same string.
  return blobName(bytes.subarray(2)) === name ? bytes.subarray(2) : null;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
