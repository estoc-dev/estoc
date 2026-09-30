import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { decode as decodeLongForm, decodeAnew, isLongForm } from "../../did-peer/src/did-peer-4.js";
import { InvalidDidDocument, InvalidPublicKey } from "../../vault/src/errors.js";
import { peerResolution, retainedDocumentAnew } from "../../vault/src/peer-document.js";
import { agreementKey, agreementKeyAnew, decodePublicKey, decodePublicKeyAnew } from "../../vault/src/public-key.js";
import type { PublicKey } from "../../vault/src/types.js";
import { expected, foldText, hashOf, readCorpus, snapshotText, spelled } from "./corpus.js";

/** The fold's text where it can be read, for a fold that is not the one kept: the text of the one kept is made by the same read at a commit where this test passes. */
async function written(text: string): Promise<string> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "estoc-corpus-")), "fold.json");
  await writeFile(file, text);
  return file;
}

/** What `work` returns, or the message of what it refuses with. */
function outcome(work: () => unknown, refusal: new (...args: never[]) => Error): unknown {
  try {
    return work();
  } catch (error) {
    if (error instanceof refusal) return { refused: error.message };
    throw error;
  }
}

describe("the kept vault, read from nothing", () => {
  it("folds to the fold kept beside it and is shown as the records kept beside it, read once or again", async () => {
    const first = await readCorpus();
    const text = foldText(first.fold);
    const kept = await expected("fold.sha256");
    if (hashOf(text) !== kept) expect.fail(`the fold is not the one kept: its text is in ${await written(text)}`);
    expect(snapshotText(first.snapshot)).toBe(await expected("snapshot.json"));

    const again = await readCorpus();
    expect(foldText(again.fold)).toBe(foldText(first.fold));
    expect(snapshotText(again.snapshot)).toBe(snapshotText(first.snapshot));
  });

  it("spells DIDs and keys that decode, remembered, to what each works out to from its text", async () => {
    const { dids, keys } = spelled(await readCorpus());
    const longForms = dids.filter(isLongForm);
    expect(longForms.length).toBeGreaterThan(3);
    expect(keys.length).toBeGreaterThan(3);
    for (const did of longForms) {
      expect(decodeLongForm(did), did).toEqual(decodeAnew(did));
      expect(
        outcome(() => peerResolution(did).document, InvalidDidDocument),
        did
      ).toEqual(outcome(() => retainedDocumentAnew(did), InvalidDidDocument));
    }
    for (const key of keys as PublicKey[]) {
      expect(
        outcome(() => decodePublicKey(key), InvalidPublicKey),
        key
      ).toEqual(outcome(() => decodePublicKeyAnew(key), InvalidPublicKey));
      expect(
        outcome(() => agreementKey(key), InvalidPublicKey),
        key
      ).toEqual(outcome(() => agreementKeyAnew(key), InvalidPublicKey));
    }
  });
});
