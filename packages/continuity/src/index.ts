/**
 * @estoc/continuity — continuity between oriented DID pairs, derived
 * from normalized facts. This entry point is the pure model: the fact
 * schema and its keys, and synchronous deterministic queries over a set
 * of facts. It parses no JWT and does no cryptography; that is
 * `@estoc/continuity/from-prior`.
 */

export type { AddressObservation, Change, Channel, ContinuityFact, Did, Ending, EvidenceRef, FactKey, FactKind, LocalDecision, PeerTransition, Rotation } from "./types.js";
export { PROFILE_VERSION } from "./types.js";
export { InvalidFact } from "./errors.js";
export { channelOf, compareChannels, compareUtf8, sameChannel, successorChannel, validateFact } from "./facts.js";
export { deriveContinuity } from "./model.js";
export type { ChangeRecord, Confirmation, ConfirmationResult, Conflict, Continuity, EndingRecord, FactStatus, HeadResult, History, PathResult, PositiveLink, Side } from "./model.js";
