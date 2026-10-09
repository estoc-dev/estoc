/**
 * The fact schema and the identity of a fact. A fact is admitted by
 * reading every member once into a fresh value, so nothing a caller
 * passed can answer differently later; its identity is the RFC 8785
 * serialization of that value, which orders members but keeps every
 * string exact.
 */

import serialize from "canonicalize";

import { InvalidFact } from "./errors.js";
import type { Change, Channel, ContinuityFact, Did, FactKind } from "./types.js";

const FACT_MEMBERS: Record<FactKind, readonly string[]> = {
  "peer-observation": ["kind", "at", "rotatedFrom"],
  "peer-ending": ["kind", "at"],
  "local-decision": ["kind", "at", "change"],
};

// I-JSON keeps a lone surrogate out of a string; RFC 8785 has no
// serialization for one that both sides agree on.
const LONE_SURROGATE = /\p{Cs}/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactMembers(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  for (const name of expected) if (!Object.hasOwn(value, name)) throw new InvalidFact(`${where} lacks ${name}`);
  for (const name of Object.keys(value)) if (!expected.includes(name)) throw new InvalidFact(`${where} has an unknown member ${JSON.stringify(name)}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new InvalidFact(`${where} is a non-empty string`);
  if (LONE_SURROGATE.test(value)) throw new InvalidFact(`${where} has an unpaired surrogate`);
  return value;
}

function textOrNull(value: unknown, where: string): string | null {
  return value === null ? null : text(value, where);
}

function channel(value: unknown, where: string): Channel {
  if (!isPlainObject(value)) throw new InvalidFact(`${where} is an object`);
  exactMembers(value, ["localDid", "peerDid"], where);
  const localDid = text(value["localDid"], `${where}.localDid`);
  const peerDid = text(value["peerDid"], `${where}.peerDid`);
  if (localDid === peerDid) throw new InvalidFact(`${where} pairs a DID with itself`);
  return { localDid, peerDid };
}

function change(value: unknown, where: string): Change {
  if (!isPlainObject(value)) throw new InvalidFact(`${where} is an object`);
  const kind = value["kind"];
  if (kind === "rotate") {
    exactMembers(value, ["kind", "successor"], where);
    return { kind, successor: text(value["successor"], `${where}.successor`) };
  }
  if (kind === "end") {
    exactMembers(value, ["kind"], where);
    return { kind };
  }
  throw new InvalidFact(`${where}.kind is rotate or end`);
}

/** `value` as a fact of the profile, read once, or `InvalidFact`. */
export function validateFact(value: unknown, where = "fact"): ContinuityFact {
  if (!isPlainObject(value)) throw new InvalidFact(`${where} is an object`);
  const kind = value["kind"];
  if (kind !== "peer-observation" && kind !== "peer-ending" && kind !== "local-decision") throw new InvalidFact(`${where}.kind is peer-observation, peer-ending or local-decision`);
  exactMembers(value, FACT_MEMBERS[kind], where);
  const at = channel(value["at"], `${where}.at`);
  switch (kind) {
    case "peer-observation": {
      const rotatedFrom = textOrNull(value["rotatedFrom"], `${where}.rotatedFrom`);
      if (rotatedFrom === at.peerDid) throw new InvalidFact(`${where}: the peer rotated from the DID it rotated to`);
      if (rotatedFrom === at.localDid) throw new InvalidFact(`${where}: the peer rotated from the local DID`);
      return { kind, at, rotatedFrom };
    }
    case "peer-ending":
      return { kind, at };
    case "local-decision": {
      const decided = change(value["change"], `${where}.change`);
      if (decided.kind === "rotate" && decided.successor === at.localDid) throw new InvalidFact(`${where}: the successor is the DID it replaces`);
      if (decided.kind === "rotate" && decided.successor === at.peerDid) throw new InvalidFact(`${where}: the successor is the other endpoint of the pair`);
      return { kind, at, change: decided };
    }
  }
}

/** The RFC 8785 text of a fact as the profile reads it: two facts with one identity are one fact. */
export type FactIdentity = string;

/**
 * The identity the model gives a fact, for a host that keeps its own
 * index from facts to the evidence they were projected from: the same
 * test of sameness the model applies. Throws `InvalidFact` for a value
 * the profile refuses.
 */
export function factIdentity(fact: ContinuityFact): FactIdentity {
  return identityOf(validateFact(fact));
}

/** The identity of a fact already validated. */
export function identityOf(fact: ContinuityFact): FactIdentity {
  return serialize(fact) as string;
}

/**
 * Code point order, which is the order of the strings' UTF-8 bytes;
 * the `<` operator would order by UTF-16 code units, which disagrees
 * for supplementary characters.
 */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

export function compareChannels(a: Channel, b: Channel): number {
  return compareUtf8(a.localDid, b.localDid) || compareUtf8(a.peerDid, b.peerDid);
}

export function sameChannel(a: Channel, b: Channel): boolean {
  return a.localDid === b.localDid && a.peerDid === b.peerDid;
}

/** A map key for the pair; a DID has no U+0000. */
export function channelKey(channel: Channel): string {
  return `${channel.localDid}\u0000${channel.peerDid}`;
}

export function channelOf(localDid: Did, peerDid: Did): Channel {
  return { localDid, peerDid };
}

/** A map key for the change, so that two facts declaring the same change compare equal. */
export function changeKey(change: Change): string {
  return change.kind === "end" ? "end" : `rotate\u0000${change.successor}`;
}

export function sortedChannels(channels: Iterable<Channel>): Channel[] {
  const byKey = new Map<string, Channel>();
  for (const channel of channels) byKey.set(channelKey(channel), channel);
  return [...byKey.values()].sort(compareChannels);
}
