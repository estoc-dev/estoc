/**
 * The identifier vocabulary of the vault and the payload of
 * each event type. Every kind of value a payload or a runtime interface
 * names is a distinct nominal type over the validated string it
 * serializes as, with no wrapper and no prefix. Nothing here checks a
 * value: the parser or the derivation that produces one is the check,
 * and a cast is not. Event identity comes from `@estoc/event-store`,
 * content identity from `@estoc/dasl` through it.
 */

import type { AuthorId, Cid, EventCid, JsonObject } from "@estoc/event-store";

export type { AuthorId, Cid, EventCid };

export type EntityId<Kind extends string> = string & { readonly __entity: Kind };

/** A vault message entity, or an inbound observation group. */
export type MessageId = EntityId<"message">;
export type ContactId = EntityId<"contact">;
/** A local communication-DID entity, not the DID string. */
export type DidId = EntityId<"did">;
export type MediationId = EntityId<"mediation">;
/** A channel-scoped automatic execution. */
export type ExecutionId = EntityId<"execution">;
/** Deferred configuration events only. */
export type SyncId = EntityId<"sync">;
export type ReplicaId = AuthorId;

/** A received DIDComm plaintext `id`, in the sender's scope. */
export type WireMessageId = string & { readonly __wireMessageId: unique symbol };
/** A scoped mediator delivery. */
export type DeliveryId = string & { readonly __deliveryId: unique symbol };
export type KeyName = string & { readonly __keyName: unique symbol };
/** A complete canonical public-key value. */
export type PublicKey = string & { readonly __publicKey: unique symbol };
export type Did = string & { readonly __did: unique symbol };
/** A verification-method DID URL. */
export type DidUrl = string & { readonly __didUrl: unique symbol };
/** The derived idempotency key of one automatic effect. */
export type EffectKey = string & { readonly __effectKey: unique symbol };
/** The raw CID of the intent projection: one fixed application message, whichever ID, channel or envelope carries it. */
export type IntentCid = Cid & { readonly __intentCid: unique symbol };
/** The raw CID of one complete plaintext, own ID, addressing and proof included. */
export type PlaintextCid = Cid & { readonly __plaintextCid: unique symbol };
/** The raw CID of one normalized encrypted envelope: the object a preparation retains. */
export type EnvelopeCid = Cid & { readonly __envelopeCid: unique symbol };

/** A value under the CID that identifies it, taken from the value as it is held: the two never part. */
export type Identified<C extends Cid, V> = { readonly cid: C; readonly value: V };

/** One of our DIDs and a peer's, both canonical short forms, as an ordered pair: the unit every receipt, intent and continuity fact is scoped to. */
export type Channel = { localDid: Did; peerDid: Did };

/**
 * A reference to one event whose type the referencing schema fixes. It
 * records what the target must be; it is no proof the target is
 * available or valid.
 */
export type EventReference<T extends string> = EventCid & { readonly __eventType: T };

// ---- payloads -----------------------------------------------------------

/** An integer count of seconds since the Unix epoch, as DIDComm timing headers carry it. */
export type EpochSeconds = number;

export type DisclosureAs = "oob" | "direct";
export type ContactOrigin = "user" | "automatic";
/** Why an unsubmitted outbound ended: its expiry was reached, or the user cancelled it. */
export type DeliveryFailureCode = "expired" | "cancelled";

/** The headers of a message that no dedicated field models; none of them a reserved DIDComm name. */
export type AdditionalHeaders = JsonObject;

/** A locally initiated send: no producing tuple, no source. */
export type LocalSend = { executionId: null; effectType: null; effectKey: null; sourceEventCid: null };

/** An automatic effect: the producing tuple, its key, and the exact observation the effect derives from. */
export type AutomaticEffect = { executionId: ExecutionId; effectType: string; effectKey: EffectKey; sourceEventCid: EventReference<"message.in"> };

/**
 * The intent an outbound event freezes: what the plaintext will carry,
 * and the channel it is fixed to. The rotation is the decision a
 * notification announces, whether its source triggered it or the user
 * completed it by hand.
 */
export type MessageOut = {
  messageId: MessageId;
  senderDidId: DidId;
  recipientDid: Did;
  msgType: string;
  thid: string | null;
  pthid: string | null;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
  pleaseAck: string[] | null;
  ack: string[];
  headers: AdditionalHeaders;
  bodyCid: Cid;
  attachmentCids: Cid[];
  intentCid: IntentCid;
  rotationEventCid: EventReference<"did.rotationSelected"> | null;
} & (LocalSend | AutomaticEffect);

/**
 * The terminal result of one automatic operation over one input that
 * owes no output: the tuple, its key, the observation the decision was
 * read from, and the operation's own code for why.
 */
export type EffectSkipped = AutomaticEffect & { code: string };

/** Where an inbound observation arrived: both null for direct transport without them. */
export type ReceivedVia = { mediationId: MediationId | null; deliveryId: DeliveryId | null };

/** An anonymous observation: no resolution evidence, so no sender DID. */
export type AnonymousPeer = { peerResolutionEventCid: null; presentedDid: null; did: null };

/** An authenticated observation: its resolution evidence, the sender's DID as presented and its canonical short form. */
export type ResolvedPeer = { peerResolutionEventCid: EventReference<"peer.resolved">; presentedDid: Did; did: Did };

/**
 * How a communication DID came to be, fixed at its creation: an entry is
 * an address branches are made from, a start the first address toward
 * one peer under an entry, bound to the peer's address the relationship
 * was first anchored to, and a next the replacement of a start or a
 * next. The profile names the key derivation, the entity-ID transcripts
 * and the document builder the entity was made by; a generation under
 * another profile is read, never rebuilt by this one's rules.
 */
export type DidGeneration = { kind: "entry"; profile: string } | { kind: "start"; profile: string; predecessor: Did; binding: Did } | { kind: "next"; profile: string; predecessor: Did };

/** One durable inbound observation. `fromPrior` is the original string off the wire, whatever it turns out to be. */
export type MessageIn = {
  messageId: MessageId;
  wireMessageId: WireMessageId;
  intentCid: IntentCid;
  plaintextCid: PlaintextCid;
  localKeyName: KeyName;
  msgType: string;
  thid: string | null;
  pthid: string | null;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
  pleaseAck: string[] | null;
  ack: string[];
  headers: AdditionalHeaders;
  fromPrior: string | null;
  bodyCid: Cid;
  attachmentCids: Cid[];
  bytes: number;
  receivedVia: ReceivedVia;
} & (AnonymousPeer | ResolvedPeer);

/** The payload of each event type of this vault version, by type name. */
export type VaultData = {
  "identity.label": { name: string };
  "peer.resolved": {
    localKeyName: KeyName;
    peerPublicKey: PublicKey;
    presentedDid: Did;
    did: Did;
    documentCid: Cid;
    authenticationMethodIds: DidUrl[];
    keyAgreementMethodIds: DidUrl[];
    service: string | null;
  };
  "mediation.created": { mediationId: MediationId; mediatorDid: Did; me: { keyName: KeyName; did: Did } };
  "mediation.granted": { mediationId: MediationId; routingDid: Did };
  "mediation.selected": { mediationId: MediationId };
  "mediation.retired": { mediationId: MediationId; because: string };
  "replica.created": { replicaId: ReplicaId; mediationId: MediationId; grant: string };
  "did.created": { didId: DidId; did: Did; longFormDid: Did; generation: DidGeneration };
  "did.disclosed": { didId: DidId; as: DisclosureAs; oobId: string | null; goal: string | null };
  "did.retired": { didId: DidId; because: string };
  "message.admitted": { sourceEventCid: EventReference<"message.in"> };
  "did.rotationSelected": { fromDidId: DidId; peerDid: Did; toDidId: DidId; sourceEventCid: EventReference<"message.in"> | null; fromPrior: string };
  "channel.blocked": { localDid: Did; peerDid: Did; includeSuccessors: boolean };
  "contact.created": { contactId: ContactId; because: ContactOrigin };
  "contact.petname": { contactId: ContactId; name: string };
  "contact.flag": { contactId: ContactId; flag: string; value: boolean };
  "contact.useDid": { contactId: ContactId; didId: DidId; because: string };
  "contact.channelsSet": { contactId: ContactId; channels: Channel[] };
  "contact.merged": { contactId: ContactId; fromContactId: ContactId };
  "contact.deleted": { contactId: ContactId };
  "message.out": MessageOut;
  "message.prepared": {
    messageId: MessageId;
    senderDidId: DidId;
    localKeyName: KeyName;
    recipientDid: Did;
    peerResolutionEventCid: EventReference<"peer.resolved">;
    fromPrior: string | null;
    intentCid: IntentCid;
    plaintextCid: PlaintextCid;
    envelopeCid: EnvelopeCid;
  };
  "delivery.submitted": { messageId: MessageId; preparationEventCid: EventReference<"message.prepared"> };
  "delivery.failed": { messageId: MessageId; code: DeliveryFailureCode };
  "delivery.acknowledged": {
    messageId: MessageId;
    localKeyName: KeyName;
    peerPublicKey: PublicKey;
    ackMessageId: MessageId;
    ackWireMessageId: WireMessageId;
  };
  "effect.skipped": EffectSkipped;
  "message.in": MessageIn;
  "message.erased": { messageId: MessageId; dropCids: Cid[]; because: string };
};

export type VaultEventType = keyof VaultData;
