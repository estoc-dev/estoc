/** An already validated canonical DID: the model compares it byte for byte and never parses it. */
export type Did = string;

/** A host-allocated, replica-stable reference to one immutable piece of evidence: a receipt, a saved decision. */
export type EvidenceRef = string;

/** An oriented pair with fixed roles; rotation makes another channel rather than rewriting this one. */
export type Channel = Readonly<{ localDid: Did; peerDid: Did }>;

export type Rotation = Readonly<{ kind: "rotate"; successor: Did }>;
export type Ending = Readonly<{ kind: "end" }>;
export type Change = Rotation | Ending;

/** A verified and bound declaration by the peer of `at` that it rotated to `successor`, or ended, in that pair. */
export type PeerTransition = Readonly<{
  kind: "peer-transition";
  at: Channel;
  change: Change;
  /** the receipt that carried the proof */
  evidence: EvidenceRef;
}>;

/**
 * A saved local choice to rotate the local DID of `at`, or to end there.
 * For a rotation, `source` names the receipt whose address observation
 * the host selected as confirming the predecessor address, and null lets
 * the model find any. An ending confirms no address.
 */
export type LocalDecision =
  | Readonly<{ kind: "local-decision"; at: Channel; change: Rotation; source: EvidenceRef | null; evidence: EvidenceRef }>
  | Readonly<{ kind: "local-decision"; at: Channel; change: Ending; source: null; evidence: EvidenceRef }>;

/**
 * One authenticated receipt from the peer of `at` to exactly its local
 * DID. `carried` says the same receipt carried a proof, whose peer
 * transition is the one under the same evidence.
 */
export type AddressObservation = Readonly<{
  kind: "address-observed";
  at: Channel;
  carried: boolean;
  evidence: EvidenceRef;
}>;

export type ContinuityFact = PeerTransition | LocalDecision | AddressObservation;

export type FactKind = ContinuityFact["kind"];

/**
 * The identity of a fact. A receipt gives at most one transition and
 * one observation, and a saved decision one local decision, so the kind
 * and the evidence name exactly one fact.
 */
export type FactKey = Readonly<{ kind: FactKind; evidence: EvidenceRef }>;

/** The fact schema, normalization, proof rules and derivation rules this package implements. */
export const PROFILE_VERSION = "estoc-continuity/2";
