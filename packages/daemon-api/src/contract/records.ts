/**
 * What a view is shown of the vault, as one normalized value: every
 * record once, related by ID. A record decides nothing and grants no
 * authority: the send choices and manual steps it lists are hints for
 * presenting actions, and the daemon checks every operation again
 * against current evidence and policy when it executes.
 */

import type { ChannelId, ContactId, ConversationId, DidId, DisplayTime, EventCid, ExecutionId, MediationId, MessageId } from "./ids.js";
import type { DisclosureAs } from "./protocol.js";
import type { JsonObject } from "./values.js";

export interface Snapshot {
  /** the did:key the vault's seed derives: the identity every replica of this vault shares */
  anchor: string;
  label: string;
  /**
   * The vault was restored from a backup and the person has not yet
   * been told what a restore cannot bring back. Until `explainedRestore`
   * commits, the daemon refuses user sends and manual dispatch;
   * receiving, reconciliation and what the runtime owes on its own go on.
   */
  restoreUnexplained: boolean;
  mediations: MediationRecord[];
  dids: LocalDidRecord[];
  contacts: ContactRecord[];
  channels: ChannelRecord[];
  messages: MessageRecord[];
  observations: ObservationRecord[];
  conversations: ConversationRecord[];
  invitations: InvitationRecord[];
  pending: PendingWork;
  unplaced: UnplacedRecord;
}

export interface MediationRecord {
  mediationId: MediationId;
  mediatorDid: string | null;
  selected: boolean;
  usable: boolean;
  /** why it was retired; null while it stands */
  retired: string | null;
  diagnostics: string[];
}

export interface LocalDidRecord {
  didId: DidId;
  /** the canonical spelling; null while the entity is created but its DID is not readable here */
  did: string | null;
  /** the spelling that carries its document, the one handed to a stranger */
  longFormDid: string | null;
  live: boolean;
  retired: string | null;
  disclosures: { as: DisclosureAs }[];
  diagnostics: string[];
}

/**
 * One undeleted contact's metadata. Its petname, shown channels, send
 * choices and diagnostics are on the contact conversation whose
 * `contactId` names this record.
 */
export interface ContactRecord {
  contactId: ContactId;
  /** null when no creation of the contact is in this vault's history */
  origin: "user" | "automatic" | null;
  flags: Record<string, boolean>;
  /** the saved local DID preference, with the channels it leads to that take a send now */
  preference: { didId: DidId; channelIds: ChannelId[] } | null;
}

export type SendGate = { status: "open" } | { status: "closed"; because: string };

export interface ChannelRecord {
  channelId: ChannelId;
  localDid: string;
  peerDid: string;
  /** the channel this one's continuity leads to; null when no unique head follows it */
  headChannelId: ChannelId | null;
  superseded: boolean;
  blocked: boolean;
  conflicted: boolean;
  send: SendGate;
  /** the name the peer last claimed in exactly this channel, and the input that claimed it */
  peerName: { name: string; messageId: MessageId } | null;
  /** the last profile of ours a transport accepted in exactly this channel, whether or not its content is still here */
  profileSubmitted: MessageId | null;
  /** ascending by `(at, messageId)` */
  messageIds: MessageId[];
  /** ascending by `(at, sourceEventCid)` */
  observationIds: EventCid[];
}

export interface MessageHeaders {
  type: string;
  thid: string | null;
  pthid: string | null;
  /** seconds since the Unix epoch, as the DIDComm header carries it */
  createdTime: number | null;
  expiresTime: number | null;
}

/** An attachment's metadata and content reference; the payload itself has no read operation in this version. */
export interface AttachmentDescriptor {
  id: string | null;
  description: string | null;
  filename: string | null;
  mediaType: string | null;
  format: string | null;
  lastModifiedTime: number | null;
  byteCount: number | null;
  content: { kind: "base64" | "json"; cid: string } | { kind: "links"; links: string[] };
  hash: string | null;
  signed: boolean;
}

/** `missing` is content that is not here, is damaged, is too large to read or is no stored message document. */
export type BodyRecord = { state: "available"; body: JsonObject; attachments: AttachmentDescriptor[] } | { state: "erased" } | { state: "missing" };

export type InboundKind = "application" | "pure-ack" | "empty" | "ping-response" | "error";

export type ExecutionStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/** How an output's delivery stands, as the vault records it. */
export type DeliveryOutcome =
  | { status: "queued" }
  | { status: "prepared" }
  | { status: "submitted" }
  | { status: "terminal"; code: "expired" | "cancelled" }
  | { status: "conflict"; because: string };

/** The continuity a carrier's proof, or a rotation decision, has reached. */
export type VerificationStatus =
  | { status: "not-present" }
  | { status: "pending-proof" }
  | { status: "pending-history"; because: string }
  | { status: "verified" }
  | { status: "unsupported"; because: string }
  | { status: "invalid"; because: string }
  | { status: "conflict"; because: string };

export type DiagnosticKind = "input" | "observations" | "contradicting" | "intent" | "outcome" | "effect" | "work" | "remote-error";

export interface Diagnostic {
  kind: DiagnosticKind;
  because: string;
  /** for a remote error, the peer's report */
  reportMessageId: MessageId | null;
}

export interface MessageRecord {
  messageId: MessageId;
  direction: "in" | "out";
  /** null for an output no one pair is fixed for */
  channelId: ChannelId | null;
  /** the undeleted contacts that select exactly this channel */
  contactIds: ContactId[];
  /** for an input, the time of the observation it is shown by; for an output, the time of its earliest intent */
  at: DisplayTime;
  /** null while the admitted observations of an input, or the intents of an output, do not agree on one */
  headers: MessageHeaders | null;
  body: BodyRecord;
  /** what an input is to the protocols the daemon speaks; null for an output, and while the input's intent is not agreed on */
  kind: InboundKind | null;
  /** the operation an output was produced by; null for an input and for a send of the user's */
  effectType: string | null;
  /** an input's standing; null for an output */
  input: ExecutionStatus | null;
  /** an output's delivery; null for an input */
  delivery: DeliveryOutcome | null;
  acknowledged: boolean;
  late: boolean;
  /** an input's continuity proof, or the rotation decision an output announces */
  verification: VerificationStatus;
  /** `retry` calls transport for an output again; `complete` gives an input a reply it still earns */
  manualAction: "retry" | "complete" | "none";
  /** the effect types `completeResponse` would give */
  completes: string[];
  diagnostics: Diagnostic[];
  /** one line derived from available content by the handler for the message type; null for an unknown type, an unavailable body or a conflicting reading */
  summary: string | null;
}

export type Standing = { status: "complete" } | { status: "incomplete"; because: string } | { status: "conflict"; because: string };

/**
 * What the runtime made of one observation: admitted for application
 * use; refused for good; ignored because the peer has replaced its
 * DID and no admission of it stands; or still pending, with the
 * evidence it lacks or the blocker current policy holds against it.
 */
export type Disposition = { status: "admitted" } | { status: "refused"; because: string } | { status: "ignored-superseded" } | { status: "pending-admission"; because: string };

/** One observation as it was received, apart from the input it may be shown by; nothing it carries is here. */
export interface ObservationRecord {
  sourceEventCid: EventCid;
  messageId: MessageId;
  /** null for an anonymous observation, while the local endpoint is unknown, and under contradicted evidence */
  channelId: ChannelId | null;
  at: DisplayTime;
  standing: Standing;
  verification: VerificationStatus;
  disposition: Disposition;
  /** it carries another content than the one its input has admitted */
  contradicting: boolean;
}

/** Whether the disclosed DID still takes a first message under the invitation: anyone holding it may write, however many did before. */
export type InvitationStatus = { status: "available" } | { status: "unavailable"; because: string };

export interface InvitationRecord {
  disclosureEventCid: EventCid;
  oobId: string;
  didId: DidId;
  localDid: string | null;
  state: InvitationStatus;
}

/** What a view is shown of one relationship: a contact's, or a nameless group of channels under one head. */
export interface ConversationRecord {
  id: ConversationId;
  contactId: ContactId | null;
  petname: string | null;
  /** the peer's latest name claim among the shown channels, with the message that claimed it */
  claimedName: { name: string; messageId: MessageId } | null;
  /** selected by the contact, or history reached from a selected channel over verified continuity */
  channels: { channelId: ChannelId; selected: boolean }[];
  writeTo: ChannelId[];
  defaultWriteTo: ChannelId | null;
  /** ascending by `(at, messageId)`, each once */
  messageIds: MessageId[];
  /** the observations shown here whose disposition is not admitted, ascending by `(at, sourceEventCid)` */
  unadmittedObservationIds: EventCid[];
  diagnostics: string[];
}

export const MANUAL_ENTRIES = ["eraseMessage", "deleteContact", "blockChannels", "cancel", "retry", "completeResponse", "completeNotification", "rotate"] as const;
/** A method a pending item names as the step a person may take on it. */
export type ManualEntry = (typeof MANUAL_ENTRIES)[number];

export interface PendingOutbound {
  messageId: MessageId;
  channelId: ChannelId | null;
  outcome: "queued" | "prepared";
  /** what no retry gets the message past; null while a retry may work on it */
  because: string | null;
  entries: ManualEntry[];
}

export interface MissingResponse {
  executionId: ExecutionId;
  messageId: MessageId;
  effectType: string;
  channelId: ChannelId;
  /** none while the input's receipt is in an integrity conflict */
  entries: ManualEntry[];
}

export interface MissingNotification {
  rotationEventCid: EventCid;
  channelId: ChannelId;
  sourceEventCid: EventCid | null;
  entries: ManualEntry[];
}

/** No entry: no retry may select among the intents that name one decision. */
export interface NotificationConflict {
  rotationEventCid: EventCid;
  messageIds: MessageId[];
  entries: ManualEntry[];
}

/** No entry: a proof waits for issuer material only a repair or an import brings. */
export interface PendingProof {
  sourceEventCid: EventCid;
  messageId: MessageId;
  channelId: ChannelId | null;
  entries: ManualEntry[];
}

export interface PendingWork {
  pendingOutbounds: PendingOutbound[];
  missingResponses: MissingResponse[];
  missingNotifications: MissingNotification[];
  notificationConflicts: NotificationConflict[];
  pendingProofs: PendingProof[];
}

/** What no channel shows: observations whose pair is unknown, and outputs whose intents disagree on the pair. */
export interface UnplacedRecord {
  observationIds: EventCid[];
  outputs: { messageId: MessageId; candidateChannelIds: ChannelId[] }[];
}

/** The content of a message to send: the application body and attachments in wire form, and the control headers the intent freezes. */
export interface MessageContent {
  type: string;
  body: JsonObject;
  /** attachment descriptors as the wire carries them, each with exactly one of `base64`, `json` and `links` */
  attachments?: JsonObject[];
  thid?: string | null;
  pthid?: string | null;
  createdTime?: number | null;
  expiresTime?: number | null;
  /** null omits the wire header; an array is carried exactly, `""` naming this message */
  pleaseAck?: string[] | null;
  /** headers no dedicated field models; none of them a reserved DIDComm name */
  headers?: JsonObject;
}
