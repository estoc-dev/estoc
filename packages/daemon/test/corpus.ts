import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_IN_HANDLERS, MAX_CONTENT_BYTES, effectTypesOf, recorder } from "@estoc/agent-core";
import type { Snapshot } from "@estoc/daemon-api/contract";
import { openPortable } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { Keys, VaultEventSet, objectReader, scanVault, type VaultFold } from "@estoc/vault";

import { decode as decodeLongForm, isLongForm } from "../../did-peer/src/did-peer-4.js";
import { localDidRecords, mediationRecords, project } from "../src/projection.js";

/**
 * One vault's history kept as a fixture, and what a read of it that
 * starts from nothing makes of it: the records in full, and the fold,
 * whose text runs to a megabyte, by the hash of that text. Every way of
 * reading a vault that keeps something from one read to the next is
 * held to these. `scripts/bench-growth.mjs --corpus` writes them anew
 * when what a fold or a record says is changed on purpose.
 */
export const CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus");
export const CORPUS_VAULT = path.join(CORPUS, "vault.sqlite");
export const CORPUS_PASSPHRASE = "a passphrase for a benchmark";

const SCAN = { effectTypes: effectTypesOf(BUILT_IN_HANDLERS) };

const isEvent = (value: object): value is { cid: string } => ["cid", "at", "author", "type"].every((member) => typeof (value as Record<string, unknown>)[member] === "string") && "data" in value && "roots" in value;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A value of a fold as JSON that says the same for the same fold: a
 * map and a set by their members in the order of their text, whatever
 * order they were filled in; an event, which the vault itself keeps,
 * by its CID, and an event set by the CIDs it holds; bytes in hex; an
 * error by its name and message. What a fold computes on
 * request is left out, the records made of it being compared beside.
 */
function plain(value: unknown, path: readonly unknown[] = []): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "function") return undefined;
  if (typeof value === "bigint") return { "#bigint": value.toString() };
  if (path.includes(value)) throw new Error("a fold refers to itself");
  const within = [...path, value];
  const each = (member: unknown): unknown => plain(member, within) ?? null;
  if (value instanceof Uint8Array) return { "#bytes": Buffer.from(value).toString("hex") };
  if (value instanceof Error) return { "#error": value.name, message: value.message };
  if (value instanceof VaultEventSet) return { "#events": [...value.all()].map((event) => event.cid).sort(compare), invalid: value.invalid.map(({ event, error }) => [event.cid, error.message]).sort() };
  if (Array.isArray(value)) return value.map(each);
  if (isEvent(value)) return { "#event": value.cid };
  if (value instanceof Set) return { "#set": [...value].map((member) => JSON.stringify(each(member))).sort(compare).map((text) => JSON.parse(text) as unknown) };
  if (value instanceof Map) {
    const entries = [...value].map(([key, member]) => [JSON.stringify(each(key)), each(member)] as const).sort(([a], [b]) => compare(a, b));
    return { "#map": entries.map(([key, member]) => [JSON.parse(key) as unknown, member]) };
  }
  const members = Object.entries(value)
    .map(([name, member]) => [name, plain(member, within)] as const)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => compare(a, b));
  return Object.fromEntries(members);
}

export const foldText = (fold: VaultFold): string => `${JSON.stringify(plain(fold), null, 1)}\n`;
export const hashOf = (text: string): string => `${createHash("sha256").update(text).digest("hex")}\n`;
export const snapshotText = (snapshot: Snapshot): string => `${JSON.stringify(snapshot, null, 1)}\n`;

export interface CorpusRead {
  fold: VaultFold;
  snapshot: Snapshot;
}

/** The vault in `file`, a portable snapshot, read from nothing as the daemon reads one for a state. */
export async function readCorpus(file = CORPUS_VAULT, passphrase = CORPUS_PASSPHRASE): Promise<CorpusRead> {
  const source = openPortable(openNodeSqlite(file, { mode: "readonly" }));
  try {
    const keys = await Keys.unlock(source.wrapped, passphrase, source.metadata.anchor);
    const fold = await scanVault(source.vault, keys, SCAN);
    const snapshot = await project(recorder(fold, objectReader(source.vault.objects, MAX_CONTENT_BYTES)), {
      anchor: source.metadata.anchor,
      label: fold.label ?? "",
      restoreUnexplained: false,
      mediations: mediationRecords(fold.mediations),
      dids: localDidRecords(fold.routes),
    });
    return { fold, snapshot };
  } finally {
    source.close();
  }
}

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
