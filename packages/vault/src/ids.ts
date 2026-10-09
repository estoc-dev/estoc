/**
 * The deterministic identifiers: the reproducible UUIDv5 namespaces and
 * every entity ID a rule derives rather than mints — an inbound
 * observation, an execution, an automatic effect's key and message, the
 * arrangement with a mediator, a DID entity that follows from another —
 * the channel a local and a peer DID form and the order channels are
 * kept in, plus the reserved keystore names. Each derivation hashes
 * exactly the transcript its rule specifies, never a payload or an API
 * object standing in for it.
 */

import { compareUtf8 } from "@estoc/continuity";
import { isLongForm, isShortForm, longToShort } from "@estoc/did-peer";
import { canonicalText, canonicalize, forbiddenIn, type JsonValue } from "@estoc/event-store";
import { sha256 } from "@noble/hashes/sha2";
import { base64urlnopad } from "@scure/base";
import { v5 as uuidv5 } from "uuid";

import { InvalidIdentifier } from "./errors.js";
import { isDerivedId, isDid, isEntityId, isMintedId } from "./syntax.js";
import type { Channel, Did, DidId, EffectKey, EventReference, ExecutionId, KeyName, MediationId, MessageId, ReplicaId, WireMessageId } from "./types.js";

export const NAMESPACE_PURPOSES = ["inbound-message", "message-execution", "automatic-mid", "mediation", "did-entity", "forward"] as const;

export type NamespacePurpose = (typeof NAMESPACE_PURPOSES)[number];

const NAMESPACE_URI = "https://estoc.dev/uuid/v1/";

const namespaces = new Map<NamespacePurpose, string>();

/** The UUIDv5 namespace of one purpose, derived from the RFC 9562 URL namespace. */
export function estocNamespace(purpose: NamespacePurpose): string {
  let namespace = namespaces.get(purpose);
  if (namespace === undefined) {
    namespace = uuidv5(NAMESPACE_URI + purpose, uuidv5.URL);
    namespaces.set(purpose, namespace);
  }
  return namespace;
}

function derive(purpose: NamespacePurpose, transcript: JsonValue): string {
  return uuidv5(canonicalize(transcript), estocNamespace(purpose));
}

function nonEmpty(value: string, what: string): string {
  if (value.length === 0) throw new InvalidIdentifier(`${what} is empty`);
  return value;
}

/**
 * A DID in the one spelling every replica compares and derives by: a
 * did:peer:4 by its short form, whichever spelling arrived, any other
 * DID as it is. String work over a DID verified elsewhere: a long
 * form's document is checked against its hash where it is resolved,
 * not here. A long form is kept where it was recorded, as the material
 * its short form resolves from; only comparisons go through here.
 */
export function canonicalDid(did: string): Did {
  return (isLongForm(did) ? longToShort(did) : did) as Did;
}

export function sameDid(a: string, b: string): boolean {
  return a === b || canonicalDid(a) === canonicalDid(b);
}

function canonical(value: string, what: string): string {
  nonEmpty(value, what);
  if (!isDid(value)) throw new InvalidIdentifier(`${what} is a DID`);
  if (value.startsWith("did:peer:4") && !isShortForm(value) && !isLongForm(value)) throw new InvalidIdentifier(`${what} is a did:peer:4 in its short or long form`);
  return canonicalDid(value);
}

export { compareUtf8 };

const encoder = new TextEncoder();

/**
 * The spelling every reference to a wire ID is compared by: its ASCII
 * letters in lower case. DIDComm compares message IDs without regard to
 * case, and an ID consists of URI unreserved characters, so nothing
 * else folds. A stored field keeps the spelling received; only
 * comparisons go through here.
 */
export function canonicalWireId(wireId: string): string {
  return wireId.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Do two wire IDs name one message: equal once canonical. */
export function sameWireId(a: string, b: string): boolean {
  return a === b || canonicalWireId(a) === canonicalWireId(b);
}

/**
 * The channel between one of our DIDs and a peer's, an ordered pair:
 * receiving from the peer at the local DID and sending from it to the
 * peer are the same channel, the reverse pair is another vault's view.
 * The caller canonicalizes both spellings; equal endpoints are no
 * channel.
 */
export function channelOf(localDid: Did, peerDid: Did): Channel {
  nonEmpty(localDid, "local DID");
  nonEmpty(peerDid, "peer DID");
  if (localDid === peerDid) throw new InvalidIdentifier("a channel needs two distinct DIDs");
  return { localDid, peerDid };
}

/** The canonical text a channel sorts and indexes by: `RFC8785([localDid, peerDid])`; a channel the continuity model returns is one the fold gave it, so it keys the same. */
export function channelKey(channel: Readonly<{ localDid: string; peerDid: string }>): string {
  return canonicalText([channel.localDid, channel.peerDid]);
}

export function sameChannel(a: Channel, b: Channel): boolean {
  return a.localDid === b.localDid && a.peerDid === b.peerDid;
}

/** The order of a set of channels: unsigned UTF-8 byte order of their keys. It sorts a set, not the two ends of a pair. */
export function compareChannels(a: Channel, b: Channel): number {
  return compareUtf8(channelKey(a), channelKey(b));
}

/**
 * The observation group of an authenticated inbound message: by the
 * canonical sender and recipient DIDs and the canonical wire ID, so
 * that the same input under another authorized key of the sender's
 * document, or under another spelling of its ID, converges, and the
 * reverse direction under the same wire ID does not.
 */
export function inboundMessageId(sender: Did, recipient: Did, wireMessageId: WireMessageId): MessageId {
  return derive("inbound-message", ["v3", "authenticated", nonEmpty(sender, "sender DID"), nonEmpty(recipient, "recipient DID"), canonicalWireId(nonEmpty(wireMessageId, "wire message ID"))]) as MessageId;
}

/** The observation group of an anonymous inbound message: by the local key that decrypted it and the canonical wire ID. */
export function anonymousMessageId(localKeyName: KeyName, wireMessageId: WireMessageId): MessageId {
  return derive("inbound-message", ["v1", "anonymous", nonEmpty(localKeyName, "local key name"), canonicalWireId(nonEmpty(wireMessageId, "wire message ID"))]) as MessageId;
}

/**
 * The execution of one carrier in one channel: the peer is the sender,
 * the local DID the recipient, the wire ID canonical. The transcript's
 * members are the literal tags `sender` and `recipient`, which RFC 8785
 * orders; the payload's member names are no substitute.
 */
export function executionId(sender: Did, recipient: Did, wireMessageId: WireMessageId): ExecutionId {
  return derive("message-execution", ["v4", { sender: nonEmpty(sender, "sender DID"), recipient: nonEmpty(recipient, "recipient DID") }, canonicalWireId(nonEmpty(wireMessageId, "wire message ID"))]) as ExecutionId;
}

const EFFECT_TAG = "estoc/effect/3\0";
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The idempotency key of an effect: SHA-256 over its tagged,
 * NUL-separated tuple. The effect type is the operation's URI, spelled
 * exactly; it must be text an event can carry — an unpaired surrogate
 * would encode as U+FFFD and make distinct inputs one key — so it is
 * refused here, before the event layer would refuse it.
 */
export function effectKey(executionId: ExecutionId, effectType: string): EffectKey {
  if (!URI_SCHEME.test(effectType) || effectType.includes("\0")) throw new InvalidIdentifier("an effect type is a URI with a scheme and no U+0000");
  const fault = forbiddenIn(effectType);
  if (fault !== null) throw new InvalidIdentifier(`effect type: ${fault}`);
  const transcript = `${EFFECT_TAG}${nonEmpty(executionId, "execution ID")}\0${effectType}`;
  return base64urlnopad.encode(sha256(encoder.encode(transcript))) as EffectKey;
}

/** The message ID, and so the wire ID, of the one response an effect key names. */
export function automaticMessageId(key: EffectKey): MessageId {
  return derive("automatic-mid", ["v1", nonEmpty(key, "effect key")]) as MessageId;
}

/**
 * The Routing 2.0 `forward.id` around one preparation's envelope,
 * derived from the preparation's event CID: every call carrying that
 * envelope carries one forward ID, however often the forward is sealed
 * again, while the mediator, which sees the forward ID, never sees the
 * event CID it hides.
 */
export function forwardId(preparation: EventReference<"message.prepared">): string {
  return derive("forward", ["v1", nonEmpty(preparation, "preparation event CID")]);
}

/**
 * The vault's one arrangement with a mediator, named by the mediator's
 * canonical DID alone: every replica that reaches for the mediator names
 * the same arrangement, derives the same account key and records the
 * same creation, so their histories merge into one account where minted
 * IDs would have made two. The ID outlives the arrangement: once it is
 * retired, the vault has no other ID to arrange with that mediator under.
 */
export function mediationIdOf(mediatorDid: Did): MediationId {
  return derive("mediation", ["v1", canonical(mediatorDid, "mediator DID")]) as MediationId;
}

/**
 * The entity that succeeds one of our DIDs in place, named by the
 * predecessor's canonical DID: the DID commits to the whole document,
 * keys and route, so every replica rotating from it arrives at one
 * successor whose key names, and so whose keys, agree. Its document
 * further depends on the route and every other builder input, which
 * the procedure minting it must fix for replicas to agree on it too.
 * The peer's current DID is no input: replicas learn of a peer's
 * rotation at different times and would otherwise part. The version
 * tag covers this transcript together with the key derivation and
 * document builder the entity's keys and DID are made by.
 */
export function successorDidId(predecessor: Did): DidId {
  return derive("did-entity", [GENERATION_PROFILE, "next", canonical(predecessor, "predecessor DID")]) as DidId;
}

/**
 * The entity a public address of ours first answers one peer from,
 * named by that address and the peer DID the relationship is bound to:
 * each peer gets its own branch, and every replica answering the same
 * peer gets the same one.
 */
export function startDidId(publicDid: Did, binding: Did): DidId {
  const ours = canonical(publicDid, "public DID");
  const theirs = canonical(binding, "binding DID");
  if (ours === theirs) throw new InvalidIdentifier("a relationship binds two distinct DIDs");
  return derive("did-entity", [GENERATION_PROFILE, "start", ours, theirs]) as DidId;
}

/**
 * The generation profile this version makes DID entities under: the
 * two transcripts above, the key derivation by name and the numalgo-4
 * document builder, named together, since a change to any of them makes
 * other entities of the same inputs. A generation recorded under another
 * profile is read as it is and never rebuilt by these rules.
 */
export const GENERATION_PROFILE = "v1";

export const ANCHOR_KEY_NAME = "anchor" as KeyName;

export type DidKeyRole = "authentication" | "key-agreement";

/** The name of one of the two keys of a communication-DID entity; the entity ID is a minted UUIDv7 or a derived UUIDv5. */
export function didKeyName(did: DidId, role: DidKeyRole): KeyName {
  if (!isEntityId(did)) throw new InvalidIdentifier("a DID entity ID is a canonical UUIDv5 or UUIDv7");
  return `did/${did}/${role}` as KeyName;
}

/** The name of the DIDComm identity key of one mediation arrangement; the arrangement ID is derived, a UUIDv5. */
export function mediationKeyName(mediation: MediationId): KeyName {
  if (!isDerivedId(mediation)) throw new InvalidIdentifier("a mediation ID is a canonical UUIDv5");
  return `mediation/${mediation}/me` as KeyName;
}

/**
 * The name of the DIDComm identity key of one replica: the address a
 * mediator delivers that one writer's mail to. It is the only name that
 * says which replica holds it, and no event payload carries it.
 */
export function replicaKeyName(replica: ReplicaId): KeyName {
  if (!isMintedId(replica)) throw new InvalidIdentifier("a replica ID is a canonical UUIDv7");
  return `replica/${replica}/me` as KeyName;
}
