/**
 * The raw channel evidence, what each event establishes on its own,
 * kept apart from the continuity model derived over it. A source is
 * one `message.in` read against the local entity and the resolution it
 * names; a carrier is a source that brought a `from_prior` proof, read
 * first against the profile and the receipt alone, then against the
 * verdict reached beside the fold under the issuer's document; a
 * decision is a `did.rotationSelected` checked as far as its own fields
 * and its source allow. Whatever needs the whole history, confirmation
 * of a predecessor, joins, contexts, conflicts, is the model's question
 * and is not asked here.
 */

import type { ContinuityFact, LocalDecision } from "@estoc/continuity";
import { InvalidFromPrior, bindFromPrior, precheckFromPrior, verifyFromPrior, type VerifiedFromPrior } from "@estoc/from-prior";
import { isLongForm, longToShort } from "@estoc/did-peer";

import { InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { issuerLongFormOf } from "../from-prior.js";
import { methodPublicKey } from "../peer-document.js";
import { channelOf, didKeyName, inboundMessageId } from "../ids.js";
import { agreementKey, decodePublicKey, type DecodedPublicKey, type KeyType } from "../public-key.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, Did, DidId, EventCid, VaultData } from "../types.js";
import type { EvidenceCheck, ReadObject } from "./evidence.js";
import type { LocalDidEntity, DidFold } from "./dids.js";
import type { VaultEventSet } from "./set.js";

/**
 * One `message.in` read against the local entity and the resolution it
 * names, with whether its own authentication evidence is all here and
 * consistent. Complete evidence places it in its channel. Missing
 * evidence is incomplete and may still arrive; evidence that
 * contradicts the observation is a conflict for good and places it in
 * no channel. An anonymous observation names no resolution: there is
 * no sender to authenticate and no channel to place it in.
 */
export type Source = {
  readonly event: VaultEvent<"message.in">;
  /** the entity the local key name derives from, whatever its state; null while no entity here records that name */
  readonly localDidId: DidId | null;
  /** the resolution the observation names, once it is here and is one */
  readonly resolution: VaultEvent<"peer.resolved"> | null;
  /** the actual pair, once the local endpoint is known */
  readonly channel: Channel | null;
} & (
  | { readonly status: "complete"; readonly localDidId: DidId; readonly resolution: VaultEvent<"peer.resolved">; readonly channel: Channel }
  | { readonly status: "incomplete"; readonly because: string }
  | { readonly status: "conflict"; readonly because: string; readonly channel: null }
  | { readonly status: "anonymous"; readonly resolution: null; readonly channel: null }
);

/** A source whose own authentication is complete, in the channel its local entity and the resolution it names agree on. */
export type PlacedSource = Extract<Source, { readonly status: "complete" }>;

/**
 * What a carrier's proof establishes on its own. Invalid is for good:
 * a form or profile the token fails, a successor that is not the
 * sender, a predecessor that is the carrier's own local DID, a
 * signature its issuer's document refuses, or a binding the receipt
 * contradicts. Unsupported is for good too: an ending, which this
 * vault retains as a diagnostic and applies to no relationship.
 * Pending while the issuer's document is not here or not yet checked.
 */
export type Proof = { status: "invalid"; because: string } | { status: "unsupported"; because: string } | { status: "pending-proof" } | { status: "verified"; proof: VerifiedFromPrior };

export interface Carrier {
  readonly source: Source;
  readonly proof: Proof;
  /** the observation of the successor, carrying the rotation from its predecessor; null until the proof is verified and bound and the source placed */
  readonly fact: ContinuityFact | null;
}

/**
 * A decision checked without the history. Invalid contradicts its own
 * fields or proof; conflict contradicts the evidence it references;
 * pending waits for evidence that may still arrive. A candidate is the
 * local-decision fact the continuity model confirms or leaves waiting.
 */
export type DecisionStatus = { status: "invalid"; because: string } | { status: "conflict"; because: string } | { status: "pending"; because: string } | { status: "candidate"; fact: LocalDecision };

export interface Decision {
  readonly event: VaultEvent<"did.rotationSelected">;
  /** the pair the decision rotates away from, once its predecessor entity reads */
  readonly channel: Channel | null;
  readonly status: DecisionStatus;
}

export interface ChannelEvidence {
  readonly sources: ReadonlyMap<EventCid, Source>;
  /** every source that brought a proof, by its event */
  readonly carriers: ReadonlyMap<EventCid, Carrier>;
  readonly decisions: ReadonlyMap<EventCid, Decision>;
  /**
   * Does this observation stand as a peer observation? It is
   * placed, and any proof it brought is verified and bound. This is
   * what the continuity model is derived from and what intent
   * conflicts are detected over; it authorizes no operation by itself.
   */
  positive(sourceEventCid: EventCid): boolean;
}

/** The verdict on a proof reached under its issuer's document; none while the document is not here. */
export type ProofCheck = { status: "verified"; proof: VerifiedFromPrior } | { status: "invalid"; because: string };

export type ChannelChecks = {
  resolutionChecks?: ReadonlyMap<EventCid, EvidenceCheck>;
  /** each carried or frozen proof against its issuer's document, from `verifyProofs` */
  proofChecks?: ReadonlyMap<EventCid, ProofCheck>;
};

const noResolutionChecks = new Map<EventCid, EvidenceCheck>();
const noProofChecks = new Map<EventCid, ProofCheck>();

export function foldChannelEvidence(set: VaultEventSet, dids: DidFold, checks: ChannelChecks = {}): ChannelEvidence {
  const sources = foldSources(set, dids, checks.resolutionChecks ?? noResolutionChecks);
  const carriers = foldCarriers(sources, checks.proofChecks ?? noProofChecks);
  const positive = (id: EventCid) => {
    const source = sources.get(id);
    if (source === undefined || source.status !== "complete") return false;
    return source.event.data.fromPrior === null || (carriers.get(id)?.fact ?? null) !== null;
  };
  return { sources, carriers, decisions: foldDecisions(set, dids, sources, carriers, checks.proofChecks ?? noProofChecks), positive };
}

/**
 * Whatever contradicts an observation does so for good, however much
 * else is still missing, so each contradiction is looked for as soon
 * as what it needs is here, and every one is reported before any
 * absence.
 */
export function foldSources(set: VaultEventSet, dids: DidFold, resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>): Map<EventCid, Source> {
  const sources = new Map<EventCid, Source>();
  for (const event of set.of("message.in")) {
    const localDidId = dids.entityOfKey(event.data.localKeyName);
    const local = localDidId === null ? null : dids.entities.get(localDidId)!;
    sources.set(event.cid, sourceOf(event, localDidId, local, set, resolutionChecks));
  }
  return sources;
}

function sourceOf(event: VaultEvent<"message.in">, localDidId: DidId | null, local: LocalDidEntity | null, set: VaultEventSet, resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>): Source {
  const { data } = event;
  if (data.peerResolutionEventCid === null) return { event, localDidId, resolution: null, channel: null, status: "anonymous" };
  const missing: string[] = [];
  let channel: Channel | null = null;
  let resolution: VaultEvent<"peer.resolved"> | null = null;
  let localKeyType: KeyType | null = null;
  const conflict = (because: string): Source => ({ event, localDidId, resolution, channel: null, status: "conflict", because });

  if (local === null) missing.push("no communication DID here derives the local key");
  else if (local.conflict) return conflict(`the local entity is in conflict: ${local.faults[0]}`);
  else if (local.keyNames.keyAgreement !== data.localKeyName) return conflict("the local key is not the entity's key-agreement key");
  else if (local.created === null) missing.push("the local entity has no creation here");
  else {
    if (local.created.did === data.did) return conflict("the sender is the recipient");
    channel = channelOf(local.created.did, data.did);
    const expected = inboundMessageId(data.did, local.created.did, data.wireMessageId);
    if (data.messageId !== expected) return conflict(`the message ID is not the one the endpoints and wire ID derive, ${expected}`);
    localKeyType = keyAgreementTypeOf(local);
    if (local.identity === "unchecked") missing.push("the local entity's keys are not yet checked against the seed");
  }

  const resolved = set.resolve(data.peerResolutionEventCid, "peer.resolved");
  if (resolved.status === "missing") missing.push("the resolution it names is not here");
  else if (resolved.status === "mismatched") return conflict(`the resolution it names is a ${resolved.event.type}`);
  else {
    resolution = resolved.event;
    if (resolution.data.localKeyName !== data.localKeyName || resolution.data.did !== data.did || resolution.data.presentedDid !== data.presentedDid) {
      return conflict("the resolution it names is not of this sender at this key");
    }
    let peerKey: DecodedPublicKey;
    try {
      peerKey = agreementKey(resolution.data.peerPublicKey);
    } catch (err) {
      if (!(err instanceof InvalidPublicKey)) throw err;
      return conflict(err.message);
    }
    const check = resolutionChecks.get(resolution.cid);
    if (check === "invalid") return conflict("the resolution's snapshot is not its document's");
    if (localKeyType !== null && peerKey.type !== localKeyType) return conflict(`the peer key is ${peerKey.type} and the entity's key-agreement key ${localKeyType}: no key is agreed across curves`);
    if (check === undefined) missing.push("the resolution's document is not here");
  }

  if (missing.length > 0 || localDidId === null || resolution === null || channel === null) return { event, localDidId, resolution, channel, status: "incomplete", because: missing[0]! };
  return { event, localDidId, resolution, channel, status: "complete" };
}

/** The curve of the entity's own key-agreement key, null while its document does not read. */
export function keyAgreementTypeOf(local: LocalDidEntity): KeyType | null {
  const [id] = local.methodIds.keyAgreement;
  if (local.resolution === null || id === undefined) return null;
  try {
    return decodePublicKey(methodPublicKey(local.resolution.document, id)).type;
  } catch (err) {
    if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey) return null;
    throw err;
  }
}

/** Each proof read against its own carrier alone: one carrier's verdict says nothing about another's. */
export function foldCarriers(sources: ReadonlyMap<EventCid, Source>, proofChecks: ReadonlyMap<EventCid, ProofCheck>): Map<EventCid, Carrier> {
  const carriers = new Map<EventCid, Carrier>();
  for (const source of sources.values()) {
    const { cid, data } = source.event;
    if (data.fromPrior === null || data.presentedDid === null) continue;
    carriers.set(cid, { source, ...carrierOf(source, data.fromPrior, data.presentedDid, proofChecks.get(cid)) });
  }
  return carriers;
}

function carrierOf(source: Source, jwt: string, sender: Did, check: ProofCheck | undefined): { proof: Proof; fact: ContinuityFact | null } {
  const refused = (proof: Proof) => ({ proof, fact: null });
  let claims: ReturnType<typeof precheckFromPrior>;
  try {
    claims = precheckFromPrior(jwt, { authenticatedSender: sender });
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return refused({ status: "invalid", because: err.message });
  }
  if (claims.claims.sub === undefined) return refused({ status: "unsupported", because: "an ending is not applied: this vault retains it and ends no relationship by it" });
  const local = source.channel?.localDid ?? null;
  if (local !== null && shortFormOf(claims.claims.iss) === local) return refused({ status: "invalid", because: "the predecessor is the local DID" });
  if (check === undefined) return refused({ status: "pending-proof" });
  if (check.status === "invalid") return refused({ status: "invalid", because: check.because });
  const proof: Proof = { status: "verified", proof: check.proof };
  if (source.status !== "complete") return { proof, fact: null };
  const binding = bindFromPrior(check.proof, { token: jwt, recipient: source.channel.localDid, sender });
  if (binding.status !== "bound") return refused({ status: "invalid", because: binding.because });
  return { proof, fact: binding.fact };
}

/**
 * The identity a did:peer:4 spelling the profile has already validated
 * names. Only spellings are compared here; whether the issuer's
 * document supports the proof is the shared proof verifier's verdict,
 * and the vault's full document validator, which can throw, is not
 * applied to an identity comparison.
 */
const shortFormOf = (did: string): string => (isLongForm(did) ? longToShort(did) : did);

/**
 * What contradicts a decision does so for good, so each contradiction
 * is looked for as soon as what it needs is here, before the decision
 * is left pending on what may still arrive. A frozen proof is held to
 * the two entities' exact long forms, since the vault signed it that
 * way itself. What the predecessor was confirmed by is the model's
 * question.
 */
export function foldDecisions(
  set: VaultEventSet,
  dids: DidFold,
  sources: ReadonlyMap<EventCid, Source>,
  carriers: ReadonlyMap<EventCid, Carrier>,
  proofChecks: ReadonlyMap<EventCid, ProofCheck>
): Map<EventCid, Decision> {
  const decisions = new Map<EventCid, Decision>();
  for (const event of set.of("did.rotationSelected")) {
    const { data } = event;
    const from = dids.entities.get(data.fromDidId);
    const to = dids.entities.get(data.toDidId);
    const channel = from?.created == null || from.conflict || from.created.did === data.peerDid ? null : channelOf(from.created.did, data.peerDid);
    const status = decisionStatus(event, from, to, channel, set, sources, carriers, proofChecks.get(event.cid));
    decisions.set(event.cid, { event, channel, status });
  }
  return decisions;
}

function decisionStatus(
  event: VaultEvent<"did.rotationSelected">,
  from: LocalDidEntity | undefined,
  to: LocalDidEntity | undefined,
  channel: Channel | null,
  set: VaultEventSet,
  sources: ReadonlyMap<EventCid, Source>,
  carriers: ReadonlyMap<EventCid, Carrier>,
  check: ProofCheck | undefined
): DecisionStatus {
  const { data } = event;
  const missing: string[] = [];
  const invalid = (because: string): DecisionStatus => ({ status: "invalid", because });
  const conflict = (because: string): DecisionStatus => ({ status: "conflict", because });

  const predecessor = creationOf(from, "predecessor", missing);
  if (typeof predecessor === "string") return conflict(predecessor);
  const successor = creationOf(to, "successor", missing);
  if (typeof successor === "string") return conflict(successor);
  if (predecessor !== null && channel === null) return invalid("the peer is the predecessor's own DID");
  if (successor !== null && successor.did === data.peerDid) return invalid("the successor is the peer's DID");
  if (predecessor !== null && successor !== null && successor.did === predecessor.did) return invalid("the successor is the predecessor's DID");

  let claims: ReturnType<typeof precheckFromPrior>["claims"];
  try {
    ({ claims } = precheckFromPrior(data.fromPrior));
  } catch (err) {
    if (!(err instanceof InvalidFromPrior)) throw err;
    return invalid(err.message);
  }
  if (claims.sub === undefined) return invalid("the proof is an ending, not a rotation");
  if (predecessor !== null && claims.iss !== predecessor.longFormDid) return invalid("the proof's iss is not the predecessor's long form");
  if (successor !== null && claims.sub !== successor.longFormDid) return invalid("the proof's sub is not the successor's long form");
  if (check?.status === "invalid") return invalid(check.because);
  if (check === undefined) missing.push("the proof is not yet checked");

  if (data.sourceEventCid !== null) {
    const resolved = set.resolve(data.sourceEventCid, "message.in");
    if (resolved.status === "missing") missing.push("the source it names is not here");
    else if (resolved.status === "mismatched") return conflict(`the source it names is a ${resolved.event.type}`);
    else {
      const source = sources.get(data.sourceEventCid)!;
      if (source.status === "anonymous") return conflict("the source is anonymous, in no pair");
      if (source.event.data.did !== data.peerDid) return conflict("the source is not from the peer the decision rotates away from");
      if (source.event.data.localKeyName !== didKeyName(data.fromDidId, "key-agreement")) return conflict("the source is not at the predecessor's key-agreement key");
      if (source.status === "conflict") return conflict(`the source's authentication is in conflict: ${source.because}`);
      const carrier = carriers.get(data.sourceEventCid);
      if (carrier?.proof.status === "invalid" || carrier?.proof.status === "unsupported") return conflict(`the source's proof is ${carrier.proof.status}: ${carrier.proof.because}`);
      if (source.status === "incomplete") missing.push(`the source's authentication is incomplete: ${source.because}`);
      if (carrier?.proof.status === "pending-proof") missing.push("the source's proof is not yet verified");
    }
  }

  if (missing.length > 0) return { status: "pending", because: missing[0]! };
  return { status: "candidate", fact: { kind: "local-decision", at: channel!, change: { kind: "rotate", successor: successor!.did } } };
}

function creationOf(entity: LocalDidEntity | undefined, role: string, missing: string[]): VaultData["did.created"] | string | null {
  if (entity?.conflict === true) return `the ${role} entity is in conflict: ${entity.faults[0]}`;
  if (entity?.created == null) {
    missing.push(`the ${role} entity has no consistent creation here`);
    return null;
  }
  if (entity.identity === "unchecked") missing.push(`the ${role} entity's keys are not yet checked against the seed`);
  return entity.created;
}

/**
 * Every proof in the set against its issuer's document, read here
 * rather than in the fold because the material is asynchronous. A
 * token the profile refuses without a document, or an ending, gets no
 * verdict: the fold reads those on its own. What depends on the local
 * endpoint, the entities' creations or the source is the fold's to
 * refuse.
 */
export async function verifyProofs(set: VaultEventSet, resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>, readObject: ReadObject): Promise<Map<EventCid, ProofCheck>> {
  const retained: VaultData["peer.resolved"][] = [];
  for (const event of set.of("peer.resolved")) if (resolutionChecks.get(event.cid) === "verified") retained.push(event.data);
  const longForms = new Map<string, ReturnType<typeof issuerLongFormOf>>();
  const longFormOf = (iss: Did) => {
    let longForm = longForms.get(iss);
    if (longForm === undefined) {
      longForm = issuerLongFormOf(iss, retained, readObject);
      longForms.set(iss, longForm);
    }
    return longForm;
  };
  const checks = new Map<EventCid, ProofCheck>();
  const prechecked = (jwt: string, sender: Did | null): ReturnType<typeof precheckFromPrior>["claims"] | null => {
    try {
      return precheckFromPrior(jwt, sender === null ? undefined : { authenticatedSender: sender }).claims;
    } catch (err) {
      if (!(err instanceof InvalidFromPrior)) throw err;
      return null;
    }
  };
  const verify = async (cid: EventCid, jwt: string, iss: Did) => {
    const longForm = await longFormOf(iss);
    if (longForm === null) return;
    try {
      checks.set(cid, { status: "verified", proof: await verifyFromPrior(jwt, longForm) });
    } catch (err) {
      if (!(err instanceof InvalidFromPrior)) throw err;
      checks.set(cid, { status: "invalid", because: err.message });
    }
  };
  for (const event of set.of("message.in")) {
    const { fromPrior, presentedDid } = event.data;
    if (fromPrior === null || presentedDid === null) continue;
    const claims = prechecked(fromPrior, presentedDid);
    if (claims === null || claims.sub === undefined) continue;
    await verify(event.cid, fromPrior, claims.iss as Did);
  }
  for (const event of set.of("did.rotationSelected")) {
    const { fromPrior } = event.data;
    const claims = prechecked(fromPrior, null);
    if (claims === null || claims.sub === undefined) continue;
    if (!isLongForm(claims.iss)) checks.set(event.cid, { status: "invalid", because: "a decision's issuer is its own long form" });
    else await verify(event.cid, fromPrior, claims.iss as Did);
  }
  return checks;
}
