/** An already validated canonical DID: the model compares it byte for byte and never parses it. */
export type Did = string;

/** An oriented pair with fixed roles; rotation makes another channel rather than rewriting this one. */
export type Channel = Readonly<{ localDid: Did; peerDid: Did }>;

export type Rotation = Readonly<{ kind: "rotate"; successor: Did }>;
export type Ending = Readonly<{ kind: "end" }>;
export type Change = Rotation | Ending;

/**
 * An authenticated receipt from the peer of `at` to exactly its local
 * DID. With `rotatedFrom`, the receipt carried a verified and bound
 * proof that the peer rotated from that DID to `at.peerDid`, in the pair
 * of the same local DID and `rotatedFrom`: the sender of a rotation is
 * its successor, so a peer rotation is always observed this way.
 */
export type AddressObservation = Readonly<{ kind: "address-observed"; at: Channel; rotatedFrom: Did | null }>;

/** A verified and bound ending of the peer of `at`, carried by an anonymous receipt to its local DID. */
export type PeerEnding = Readonly<{ kind: "peer-ended"; at: Channel }>;

/** A saved local choice to rotate the local DID of `at`, or to end there. */
export type LocalDecision = Readonly<{ kind: "local-decision"; at: Channel; change: Change }>;

/**
 * A fact is its content: two facts that say the same thing are one
 * fact, however many pieces of evidence the host projected them from.
 */
export type ContinuityFact = AddressObservation | PeerEnding | LocalDecision;

export type FactKind = ContinuityFact["kind"];

/** The fact schema, normalization, proof rules and derivation rules this package implements. */
export const PROFILE_VERSION = "estoc-continuity/2";
