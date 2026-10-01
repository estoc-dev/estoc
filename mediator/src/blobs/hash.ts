import { base16 } from "multiformats/bases/base16";
import { base32 } from "multiformats/bases/base32";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "multiformats/hashes/sha2";

/**
 * Two strings name a blob, for two purposes. The **hash** — a sha2-256
 * multihash in multibase base32 lower, `b` + base32(0x12 0x20 <32-byte
 * digest>), 56 characters, the same string an object-share package carries
 * as `data.hash` — is what the bytes are checked against on the way in.
 * The **id** — 20 random bytes, base32 lower, 32 characters — is where they
 * are served: `/b/<id>`. The id says nothing about the bytes or who put
 * them, and two mediations putting the same hash get two ids.
 */

const SHA256_BYTES = 32;
export const BLOB_NAME_PATTERN = /^b[a-z2-7]{55}$/;
export const BLOB_ID_PATTERN = /^[a-z2-7]{32}$/;
const ID_BYTES = 20;

export function mintBlobId(): string {
  return base32.baseEncode(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

/** The blob name for a sha-256 digest. */
export function blobName(digest: Uint8Array): string {
  if (digest.length !== SHA256_BYTES) {
    throw new Error("sha-256 digests are 32 bytes");
  }
  return base32.encode(Digest.create(sha256.code, digest).bytes);
}

/** The digest a blob name encodes, or null if the string is not a name. */
export function blobDigest(name: string): Uint8Array | null {
  if (!BLOB_NAME_PATTERN.test(name)) {
    return null;
  }
  let digest: Uint8Array;
  try {
    const multihash = Digest.decode(base32.decode(name));
    if (multihash.code !== sha256.code || multihash.size !== SHA256_BYTES) {
      return null;
    }
    digest = multihash.digest;
  } catch {
    return null;
  }
  // The name must be canonical: re-encoding must give the same string.
  return blobName(digest) === name ? digest : null;
}

export function hex(bytes: Uint8Array): string {
  return base16.baseEncode(bytes);
}
