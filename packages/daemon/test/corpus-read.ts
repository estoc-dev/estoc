/**
 * A vault read from nothing, as the daemon reads one for a state, and
 * the text that says what the read made of it: free of any platform,
 * so Node and a browser read one vault with the same code.
 */

import { BUILT_IN_HANDLERS, MAX_CONTENT_BYTES, effectTypesOf, recorder } from "@estoc/agent-core";
import type { Snapshot } from "@estoc/daemon-api/contract";
import type { PortableDatabase } from "@estoc/event-store";
import { VaultEventSet, objectReader, scanVault, type Keys, type VaultFold } from "@estoc/vault";

import { localDidRecords, mediationRecords, project } from "../src/projection.js";

export const SCAN = { effectTypes: effectTypesOf(BUILT_IN_HANDLERS) };

const isEvent = (value: object): value is { cid: string } => ["cid", "at", "author", "type"].every((member) => typeof (value as Record<string, unknown>)[member] === "string") && "data" in value && "roots" in value;

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

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
  if (value instanceof Uint8Array) return { "#bytes": hex(value) };
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
export const snapshotText = (snapshot: Snapshot): string => `${JSON.stringify(snapshot, null, 1)}\n`;

export interface CorpusRead {
  fold: VaultFold;
  snapshot: Snapshot;
}

/** The vault `source` holds, unlocked by `keys`, read from nothing as the daemon reads one for a state. */
export async function readPortable(source: PortableDatabase, keys: Keys): Promise<CorpusRead> {
  const fold = await scanVault(source.vault, keys, SCAN);
  const snapshot = await project(await recorder(fold, objectReader(source.vault.objects, MAX_CONTENT_BYTES)), {
    anchor: source.metadata.anchor,
    label: fold.label ?? "",
    restoreUnexplained: false,
    mediations: mediationRecords(fold.mediations),
    dids: localDidRecords(fold.dids),
  });
  return { fold, snapshot };
}
