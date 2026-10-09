import type { AddressObservation, Channel, Did, EvidenceRef, FactKey, LocalDecision, PeerTransition } from "../src/index.js";

export const C = (localDid: Did, peerDid: Did): Channel => ({ localDid, peerDid });

export const rotate = (evidence: EvidenceRef, at: Channel, successor: Did): PeerTransition => ({ kind: "peer-transition", at, change: { kind: "rotate", successor }, evidence });

export const peerEnd = (evidence: EvidenceRef, at: Channel): PeerTransition => ({ kind: "peer-transition", at, change: { kind: "end" }, evidence });

export const decide = (evidence: EvidenceRef, at: Channel, successor: Did, source: EvidenceRef | null = null): LocalDecision => ({ kind: "local-decision", at, change: { kind: "rotate", successor }, source, evidence });

export const localEnd = (evidence: EvidenceRef, at: Channel): LocalDecision => ({ kind: "local-decision", at, change: { kind: "end" }, source: null, evidence });

/** With `carried`, the transition under the same evidence is the one this receipt carried. */
export const observe = (evidence: EvidenceRef, at: Channel, carried = false): AddressObservation => ({ kind: "address-observed", at, carried, evidence });

/** The keys of a transition, a decision and an observation, as results name them. */
export const T = (evidence: EvidenceRef): FactKey => ({ kind: "peer-transition", evidence });
export const D = (evidence: EvidenceRef): FactKey => ({ kind: "local-decision", evidence });
export const O = (evidence: EvidenceRef): FactKey => ({ kind: "address-observed", evidence });

export const keyOf = (fact: FactKey): FactKey => ({ kind: fact.kind, evidence: fact.evidence });

/** Every permutation of a short array. */
export function* permutations<Item>(items: readonly Item[]): Generator<Item[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i]!, ...tail];
  }
}
