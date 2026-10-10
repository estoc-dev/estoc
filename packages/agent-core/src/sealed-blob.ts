/**
 * A blob sealed for the blob store: AES-256-GCM under a key made for
 * this blob alone, the nonce in front of the ciphertext, and the whole
 * named by its sha2-256 multihash in multibase base32 lower, the name
 * the store checks an upload against. The store never sees the key:
 * whoever is to open the blob is handed the key and the name together,
 * and the bytes are checked against the name before they are opened.
 */

import { base32 } from "multiformats/bases/base32";
import { sha256 } from "multiformats/hashes/sha2";

import { BlobMismatch, BlobUnopened } from "./errors.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What sealing adds to the plaintext: a store's per-blob limit leaves the plaintext that limit less this. */
export const SEAL_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/** What opens a sealed blob: its name and its key. */
export interface BlobKey {
  hash: string;
  key: Uint8Array;
}

export interface SealedBlob extends BlobKey {
  /** the nonce, then the ciphertext and its tag: what is put and uploaded */
  bytes: Uint8Array;
}

export async function blobName(bytes: Uint8Array): Promise<string> {
  return base32.encode((await sha256.digest(bytes)).bytes);
}

export async function sealBlob(plaintext: Uint8Array): Promise<SealedBlob> {
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await aesKey(key, "encrypt"), plaintext);
  const bytes = new Uint8Array(NONCE_BYTES + ciphertext.byteLength);
  bytes.set(nonce);
  bytes.set(new Uint8Array(ciphertext), NONCE_BYTES);
  return { bytes, hash: await blobName(bytes), key };
}

/** The plaintext of a sealed blob. Throws `BlobMismatch` when the bytes are not the ones named, `BlobUnopened` when the key does not open them. */
export async function openBlob(bytes: Uint8Array, { hash, key }: BlobKey): Promise<Uint8Array> {
  const named = await blobName(bytes);
  if (named !== hash) throw new BlobMismatch(hash, named);
  if (key.length !== KEY_BYTES || bytes.length < SEAL_OVERHEAD) throw new BlobUnopened();
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, NONCE_BYTES) }, await aesKey(key, "decrypt"), bytes.subarray(NONCE_BYTES)));
  } catch (err) {
    // Web Crypto reports a tag that does not verify as an OperationError, and nothing else about it
    if ((err as { name?: unknown } | null)?.name === "OperationError") throw new BlobUnopened();
    throw err;
  }
}

function aesKey(key: Uint8Array, use: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, [use]);
}
