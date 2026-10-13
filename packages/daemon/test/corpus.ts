import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decode as decodeLongForm, isLongForm } from "../../did-peer/src/did-peer-4.js";
import { compare, keptVault, readKept, type CorpusRead, type KeptVault } from "./corpus-read.js";

export { foldText, snapshotText, type CorpusRead } from "./corpus-read.js";

/**
 * One vault's history kept as a fixture, and what a read of it that
 * starts from nothing makes of it: the records in full, and the fold,
 * whose text runs to a megabyte, by the hash of that text. Every way of
 * reading a vault that keeps something from one read to the next is
 * held to these. `scripts/bench-growth.mjs --corpus` writes them anew
 * when what a fold or a record says is changed on purpose.
 */
export const CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus");
export const CORPUS_VAULT = path.join(CORPUS, "vault.car");
export const CORPUS_PASSPHRASE = "a passphrase for a benchmark";

export const hashOf = (text: string): string => `${createHash("sha256").update(text).digest("hex")}\n`;

/** The vault in `file`, a snapshot with both parts, and its keys. */
export const keptIn = async (file = CORPUS_VAULT, passphrase = CORPUS_PASSPHRASE): Promise<KeptVault> => keptVault(new Uint8Array(await readFile(file)), passphrase);

/** The vault in `file` read from nothing as the daemon reads one for a state. */
export const readCorpus = async (file = CORPUS_VAULT, passphrase = CORPUS_PASSPHRASE): Promise<CorpusRead> => readKept(await keptIn(file, passphrase));

export const expected = (name: "fold.sha256" | "snapshot.json"): Promise<string> => readFile(path.join(CORPUS, name), "utf8");

/** Every numalgo-4 DID the vault's events spell, and every public key they and the documents of its long forms spell, in the order of their text. */
export function spelled({ fold }: CorpusRead): { dids: string[]; keys: string[] } {
  const dids = new Set<string>();
  const keys = new Set<string>();
  const read = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("did:peer:4")) dids.add(value.split(/[/?#]/)[0]!);
      else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(value)) keys.add(value);
    } else if (value !== null && typeof value === "object") Object.values(value).forEach(read);
  };
  for (const event of fold.set.all()) read(event.data);
  for (const did of [...dids].filter(isLongForm)) read(decodeLongForm(did));
  return { dids: [...dids].sort(compare), keys: [...keys].sort(compare) };
}
