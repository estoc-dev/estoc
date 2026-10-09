/**
 * Which events each continuity fact rests on. The model names a fact by
 * its content alone, so receipts or decisions that say the same thing
 * are one fact there, and which of them an answer reports, an admitted
 * receipt for one, is the vault's to choose: whatever the vault reads
 * off the model by event, or reports back as events, passes through
 * this index.
 */

import { factIdentity, type ContinuityFact, type FactIdentity } from "@estoc/continuity";

import { compareUtf8 } from "../ids.js";
import type { EventCid } from "../types.js";

export interface ContinuityIndex {
  /** each projected fact once: what the model is derived over */
  readonly facts: readonly ContinuityFact[];
  /** the fact the event projects; undefined when it projects none */
  factOf(cid: EventCid): ContinuityFact | undefined;
  /** every event that projects the fact, in byte order */
  evidenceOf(fact: ContinuityFact): readonly EventCid[];
  /** the facts as the events that project them, for a diagnostic */
  describe(facts: readonly ContinuityFact[]): string;
}

/** One event projects at most one fact; projecting a second is a fault of the projection, not of the evidence. */
export function indexContinuity(projected: Iterable<readonly [EventCid, ContinuityFact]>): ContinuityIndex {
  const byEvent = new Map<EventCid, FactIdentity>();
  const byIdentity = new Map<FactIdentity, { fact: ContinuityFact; cids: EventCid[] }>();
  for (const [cid, fact] of projected) {
    if (byEvent.has(cid)) throw new Error(`${cid} projects more than one continuity fact`);
    const identity = factIdentity(fact);
    byEvent.set(cid, identity);
    const entry = byIdentity.get(identity);
    if (entry === undefined) byIdentity.set(identity, { fact, cids: [cid] });
    else entry.cids.push(cid);
  }
  for (const { cids } of byIdentity.values()) cids.sort(compareUtf8);
  const evidenceOf = (fact: ContinuityFact): readonly EventCid[] => byIdentity.get(factIdentity(fact))?.cids ?? [];
  return {
    facts: [...byIdentity.values()].map(({ fact }) => fact),
    factOf: (cid) => {
      const identity = byEvent.get(cid);
      return identity === undefined ? undefined : byIdentity.get(identity)!.fact;
    },
    evidenceOf,
    describe: (facts) => facts.map((fact) => `the ${fact.kind} of ${evidenceOf(fact).join(", ")}`).join("; "),
  };
}
