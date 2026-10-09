/**
 * A rotation away from a pair is one intent: this local predecessor,
 * toward the peer anywhere in its verified same-local context, replaced
 * by this successor. Several records may support one intent, each
 * under its own author, time, source and proof, when two replicas
 * decide the same rotation apart or one decides it again over a
 * restored snapshot; they are read as one, in canonical event order.
 * Two successors in one scope compete, and the same successor from two
 * predecessors is not one intent. A record whose pair cannot be read
 * yet, its predecessor's creation not being here, is kept apart as
 * unresolved rather than dropped, since it may be the very rotation
 * that is waiting. The one reading serves both what a rotation reuses
 * and what a successor's preparation freezes as its proof: nothing while a
 * record is contradicted or the records are several intents, waiting
 * while one is unresolved or none is a candidate yet, and the first
 * candidate otherwise. A record refused for good never enters.
 */

import { canonicalText, compareEvents } from "@estoc/event-store";

import type { Decision } from "./fold/channels.js";
import type { VaultFold } from "./fold/vault.js";
import { channelKey, channelOf } from "./ids.js";
import type { Channel, Did, DidId } from "./types.js";

export interface DecisionGroup {
  readonly fromDidId: DidId;
  readonly toDidId: DidId;
  /** the verified same-local context the records' pairs fall in */
  readonly context: readonly Channel[];
  /** in canonical event order, each under its own status */
  readonly records: readonly Decision[];
}

export interface DecisionGroups {
  readonly groups: readonly DecisionGroup[];
  /** the records whose pair is not in the fold yet, which no scope holds */
  readonly unresolved: readonly Decision[];
}

type Fold = Pick<VaultFold, "continuity">;

/** The intents the records support, a record refused for good left out. */
export function decisionGroups(fold: Fold, records: readonly Decision[]): DecisionGroups {
  const groups = new Map<string, DecisionGroup & { readonly records: Decision[] }>();
  const unresolved: Decision[] = [];
  for (const record of [...records].sort((a, b) => compareEvents(a.event, b.event))) {
    if (record.status.status === "invalid") continue;
    if (record.channel === null) {
      unresolved.push(record);
      continue;
    }
    const { fromDidId, toDidId } = record.event.data;
    const context = fold.continuity.sameLocal(record.channel);
    const key = canonicalText([fromDidId, toDidId, channelKey(context[0]!)]);
    let group = groups.get(key);
    if (group === undefined) groups.set(key, (group = { fromDidId, toDidId, context, records: [] }));
    group.records.push(record);
  }
  return { groups: [...groups.values()], unresolved };
}

export type RotationIntent =
  | { status: "none" }
  /** a record is contradicted, or the records are several intents */
  | { status: "conflict"; records: readonly Decision[]; because: string }
  /** a record's scope cannot be read yet, or no record of the one intent is a candidate yet */
  | { status: "pending"; record: Decision; because: string }
  /** the one intent, under its first candidate record */
  | { status: "candidate"; candidate: Decision; group: DecisionGroup };

export function rotationIntent(fold: Fold, records: readonly Decision[]): RotationIntent {
  const related = records.filter(({ status }) => status.status !== "invalid");
  if (related.length === 0) return { status: "none" };
  const conflict = (because: string): RotationIntent => ({ status: "conflict", records: related, because });
  const pending = (record: Decision): RotationIntent => ({ status: "pending", record, because: `the rotation ${record.event.cid} is pending: ${record.status.status === "pending" ? record.status.because : record.status.status}` });
  for (const record of related) {
    if (record.status.status === "conflict") return conflict(`the rotation ${record.event.cid} is in conflict: ${record.status.because}`);
    const continuity = fold.continuity.status(record.event.cid);
    if (continuity.status === "conflict") return conflict(`the rotation ${record.event.cid} is in conflict: ${continuity.because}`);
  }
  const { groups, unresolved } = decisionGroups(fold, related);
  const predecessors = new Set(related.map((record) => record.event.data.fromDidId));
  if (groups.length > 1 || predecessors.size > 1) return conflict(`${related.length} rotations here are not one intent`);
  if (unresolved.length > 0) return pending(unresolved[0]!);
  const group = groups[0]!;
  const candidate = group.records.find((record) => record.status.status === "candidate");
  return candidate === undefined ? pending(group.records[0]!) : { status: "candidate", candidate, group };
}

/** The intent a rotation away from the pair reuses: the one recorded from that local DID anywhere in its verified same-local context. */
export function decisionFor(fold: VaultFold, localDid: Did, peerDid: Did): RotationIntent {
  return rotationIntent(fold, fold.continuity.decisionsIn(channelOf(localDid, peerDid)));
}
