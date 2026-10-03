/**
 * Every public operation, with the named input it takes and the result
 * it returns. The table is the one source the client proxy and the
 * server dispatcher are derived from: a name absent here is no method,
 * whatever the daemon object has.
 */

import type { ChannelId, ContactId, DidId, EventCid, ExecutionId, Hold, MediationId, MessageId } from "./ids.js";
import type { LinesState } from "./lines.js";
import type { Invitation, TraceLevel } from "./protocol.js";
import type { MessageContent } from "./records.js";
import type { RevisionMarker, State } from "./state.js";

/** The input of a method that takes no arguments. */
export type Empty = Record<never, never>;

/** The initial publication a port receives once, as the result of `attach`; the events that follow come after it. */
export interface Baseline {
  state: State;
  lines: LinesState;
}

export const OUTCOMES = ["submitted", "pending", "failed", "uncertain", "expired", "spent", "none", "refused", "existing", "cancelled"] as const;

export type OutcomeTag = (typeof OUTCOMES)[number];

/**
 * What a procedure came to, in its own word, with its reason where it
 * gave one. `submitted` is the transport acceptance the vault recorded,
 * not the peer's ACK; `pending` is deferred work; `failed` a transport
 * answer other than acceptance; `uncertain` an attempt whose arrival
 * is unknown; `expired` and `cancelled` a recorded termination; `none`,
 * `refused`, `spent` and `existing` the procedure's ways of taking no
 * new action. Clients branch on the tag, never on the text.
 */
export interface Outcome<Tag extends OutcomeTag = OutcomeTag> {
  outcome: Tag;
  because: string | null;
}

/** What one transport call of a message can come to. */
export type DispatchOutcome = "submitted" | "pending" | "failed" | "uncertain" | "expired" | "spent" | "none";

/** What a completion, or a rotation's notification, can come to: a dispatch, or an intent it found or refused. */
export type CompletionOutcome = DispatchOutcome | "existing" | "refused";

export type CancelOutcome = "cancelled" | "none";

export interface SendResult extends Outcome<DispatchOutcome> {
  messageId: MessageId;
  channelId: ChannelId;
}

export interface ContactReached extends SendResult {
  contactId: ContactId;
}

export type SendTarget = { channelId: ChannelId; contactId?: never } | { contactId: ContactId; channelId?: never };

export interface SendInput {
  target: SendTarget;
  content: MessageContent;
}

export interface ResolveChannelInput {
  localDid: string;
  peerDid: string;
}

export interface ResolvedChannel {
  channelId: ChannelId;
}

export interface CreateContactInput {
  petname: string;
  channelIds: ChannelId[];
}

export interface SetContactChannelsInput {
  contactId: ContactId;
  channelIds: ChannelId[];
}

export interface DeleteContactInput {
  contactId: ContactId;
  /** also deny the contact's channels, and their successors when asked */
  block: { includeSuccessors: boolean } | null;
  /** also erase the contact's messages, for this reason */
  erase: string | null;
}

export interface BlockChannelsInput {
  channelIds: ChannelId[];
  includeSuccessors: boolean;
}

export interface RotateInput {
  channelId: ChannelId;
}

export interface RotateResult extends Outcome<CompletionOutcome> {
  /** the successor pair the rotation leads to */
  channelId: ChannelId;
}

/** What a merge brought, counted. */
export interface MergeResult {
  added: number;
  duplicates: number;
  objects: number;
  repaired: number;
  /** the backup and this vault had both written under one replica ID, and this one took a fresh ID before the merge */
  renewed: boolean;
}

export interface Method<Input extends object, Result> {
  input: Input;
  result: Result;
}

export interface Methods {
  attach: Method<Empty, Baseline>;
  refresh: Method<Empty, RevisionMarker>;

  createIdentity: Method<{ name: string; passphrase: string }, null>;
  restoreIdentity: Method<{ backup: Uint8Array; passphrase: string }, null>;
  unlock: Method<{ passphrase: string }, null>;
  lock: Method<Empty, null>;
  forgetIdentity: Method<{ hold: Hold }, null>;
  exportBackup: Method<Empty, { name: string; bytes: Uint8Array }>;
  mergeBackup: Method<{ backup: Uint8Array }, MergeResult>;
  explainedRestore: Method<Empty, null>;

  /** The arrangement with that mediator, made and enrolled in when none stands, and selected for new DIDs. */
  setMediator: Method<{ mediatorDid: string }, { mediationId: MediationId }>;
  createInvitation: Method<{ goal?: string }, { didId: DidId; invitation: Invitation }>;
  acceptInvitation: Method<{ invitation: Invitation; petname: string }, ContactReached>;
  addContactByDid: Method<{ did: string; petname: string }, ContactReached>;
  publicDid: Method<Empty, { didId: DidId; did: string }>;
  resolveChannel: Method<ResolveChannelInput, ResolvedChannel>;

  createContact: Method<CreateContactInput, { contactId: ContactId }>;
  renameContact: Method<{ contactId: ContactId; petname: string }, null>;
  setContactChannels: Method<SetContactChannelsInput, null>;
  deleteContact: Method<DeleteContactInput, null>;
  blockChannels: Method<BlockChannelsInput, null>;
  eraseMessage: Method<{ messageId: MessageId }, null>;

  send: Method<SendInput, SendResult>;
  retry: Method<{ messageId: MessageId }, Outcome<DispatchOutcome>>;
  cancel: Method<{ messageId: MessageId }, Outcome<CancelOutcome>>;
  completeResponse: Method<{ executionId: ExecutionId; effectType: string }, Outcome<CompletionOutcome>>;
  completeNotification: Method<{ rotationEventCid: EventCid }, Outcome<CompletionOutcome>>;
  rotate: Method<RotateInput, RotateResult>;

  reconnect: Method<Empty, null>;
  traceLevel: Method<Empty, { level: TraceLevel }>;
  setTraceLevel: Method<{ level: TraceLevel }, { level: TraceLevel }>;
}

export type MethodName = keyof Methods;

export type MethodInput<M extends MethodName> = Methods[M]["input"];

export type MethodResult<M extends MethodName> = Methods[M]["result"];
