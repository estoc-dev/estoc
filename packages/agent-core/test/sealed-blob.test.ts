import { describe, expect, it } from "vitest";

import { BlobMismatch, BlobUnopened, SEAL_OVERHEAD, blobName, openBlob, sealBlob } from "../src/index.js";

const filled = (length: number): Uint8Array => new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);

describe("a sealed blob", () => {
  it("opens under its key to the plaintext, its bytes named by their hash and longer by the overhead", async () => {
    const plaintext = filled(1000);
    const sealed = await sealBlob(plaintext);
    expect(sealed.bytes.length).toBe(plaintext.length + SEAL_OVERHEAD);
    expect(sealed.hash).toBe(await blobName(sealed.bytes));
    expect(sealed.hash).toMatch(/^b[a-z2-7]{55}$/);
    expect(await openBlob(sealed.bytes, sealed)).toEqual(plaintext);
  });

  it("is refused when its bytes are not the ones named", async () => {
    const sealed = await sealBlob(filled(100));
    const other = await sealBlob(filled(100));
    await expect(openBlob(other.bytes, sealed)).rejects.toBeInstanceOf(BlobMismatch);
  });

  it("does not open under another blob's key", async () => {
    const sealed = await sealBlob(filled(100));
    const other = await sealBlob(filled(100));
    await expect(openBlob(sealed.bytes, { hash: sealed.hash, key: other.key })).rejects.toBeInstanceOf(BlobUnopened);
  });

  it("does not open once its bytes are changed, even under the name of the changed bytes", async () => {
    const sealed = await sealBlob(filled(100));
    const changed = sealed.bytes.slice();
    changed[changed.length - 1]! ^= 1;
    await expect(openBlob(changed, { hash: await blobName(changed), key: sealed.key })).rejects.toBeInstanceOf(BlobUnopened);
  });
});
