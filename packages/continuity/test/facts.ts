import { compareUtf8, factIdentity, type AddressObservation, type Channel, type ContinuityFact, type Did, type LocalDecision, type PeerEnding } from "../src/index.js";

export const C = (localDid: Did, peerDid: Did): Channel => ({ localDid, peerDid });

/** A receipt from the peer of `at` to its local DID that carried no proof. */
export const observe = (at: Channel): AddressObservation => ({ kind: "address-observed", at, rotatedFrom: null });

/** A receipt from the peer of `at` to its local DID that carried the peer's rotation from `from`. */
export const rotated = (at: Channel, from: Did): AddressObservation => ({ kind: "address-observed", at, rotatedFrom: from });

export const peerEnd = (at: Channel): PeerEnding => ({ kind: "peer-ended", at });

export const decide = (at: Channel, successor: Did): LocalDecision => ({ kind: "local-decision", at, change: { kind: "rotate", successor } });

export const localEnd = (at: Channel): LocalDecision => ({ kind: "local-decision", at, change: { kind: "end" } });

/** Facts as the model lists them, in the order of their identities. */
export const ordered = (...facts: ContinuityFact[]): ContinuityFact[] => [...facts].sort((a, b) => compareUtf8(factIdentity(a), factIdentity(b)));

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
