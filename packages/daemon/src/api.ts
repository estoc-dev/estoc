import type { Channel, ContactId, Did, DidId, EventReference, ExecutionId, MediationId, MediationProfile, MessageId } from "@estoc/vault";
import type { Called, Cancelled, Content, Invitation, TraceLevel } from "@estoc/agent-core";
import type { Hold } from "@estoc/daemon-api/contract";

/**
 * The daemon in the domain's own terms: the agent and its vault behind
 * one interface, which `methodsOf` answers the API's method table
 * from. Everything that crosses is a plain record or bytes: no
 * runtime, no key, no agent. The seed is unlocked inside the daemon
 * and stays there; a passphrase comes in, and what a view is shown
 * comes out through the publisher.
 */

/** What a merge brought, counted. */
export interface Merged {
  added: number;
  duplicates: number;
  objects: number;
  repaired: number;
  /**
   * The backup and this vault had both written under one replica ID,
   * as two copies of one runtime do, and this one took a fresh ID
   * before the merge went through. Nothing of the history changed.
   */
  renewed: boolean;
}

export interface CreatedInvitation {
  didId: DidId;
  invitation: Invitation;
}

/**
 * What a call came to, in the word of the procedure that made it — a
 * dispatch's `submitted`, `pending`, `failed`, `uncertain`, a
 * completion's `none` — with its reason where it gave one. The vault's
 * own account of the message is in the next snapshot.
 * `threw` is none of the procedure's words: the call of the intent
 * threw, after the intent was committed.
 */
export interface Outcome<Word extends string = string> {
  outcome: Word;
  because: string | null;
  /** the message the procedure was of, committed before whatever the call came to; null where it had none */
  messageId: MessageId | null;
}

/** What a dispatch came to, or that its call threw. */
export type DispatchWord = Called["outcome"];

/** What a completion came to: a dispatch's word, the intent standing already, or the operation refusing the input. */
export type CompletionWord = DispatchWord | "existing" | "refused";

export interface SendResult extends Outcome<DispatchWord> {
  messageId: MessageId;
  channel: Channel;
}

export interface Daemon {
  /**
   * This and the six calls after it, `explainedRestore` apart, work on
   * the daemon's files: they run one at a time in the order asked, and
   * are refused while the phase is `elsewhere`, where the files are
   * another daemon's. One vault is made where none stands; the call
   * that finds one there is refused and removes nothing.
   */
  createIdentity(name: string, passphrase: string): Promise<void>;
  /** A portable snapshot's file restored as this daemon's vault, under the passphrase that opens the snapshot's own wrapped seed. */
  restoreIdentity(snapshot: Uint8Array, passphrase: string): Promise<void>;
  /** The person was shown what a restore cannot bring back: sends and manual dispatch are open from here on. */
  explainedRestore(): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  /** The agent stopped and the seed forgotten, the vault kept hold of; nothing changes for a vault locked already. */
  lock(): Promise<void>;
  /** The vault this daemon holds, removed for good: the one named, and refused when another has taken its place. */
  forgetIdentity(hold: Hold): Promise<void>;
  /** A portable snapshot of the vault, refused whole when its events and objects, or the file they make, come to more than `maxBytes`. */
  exportBackup(maxBytes?: number): Promise<{ name: string; bytes: Uint8Array }>;
  mergeBackup(snapshot: Uint8Array): Promise<Merged>;

  /**
   * An arrangement with `mediatorDid` selected and a route over it
   * configured: the one that stands with that mediator under `profile`,
   * or one created under it. A replica-mediation arrangement, which is
   * what is made when no profile is named, is enrolled in; an ordinary
   * one, of the null profile, is granted.
   */
  setMediator(mediatorDid: string, profile?: MediationProfile | null): Promise<MediationId>;
  /** A fresh DID on the selected arrangement's route, disclosed as an out-of-band invitation. */
  createInvitation(goal?: string): Promise<CreatedInvitation>;
  /** A fresh DID of ours toward the inviter, a contact that selects the pair, and a Ping under the invitation's ID. */
  acceptInvitation(invitation: Invitation, petname: string): Promise<SendResult & { contactId: ContactId }>;
  /** The same toward a DID handed over on its own, the Ping naming no invitation; a DID of this vault's is refused. */
  addContactByDid(did: string, petname: string): Promise<SendResult & { contactId: ContactId }>;
  /** The DID this vault hands out to anyone, in its long form: the live one disclosed directly, minted on the selected arrangement's route and disclosed when there is none. */
  publicDid(): Promise<{ didId: DidId; did: Did }>;
  createContact(petname: string, channels: Channel[]): Promise<ContactId>;
  renameContact(contactId: ContactId, petname: string): Promise<void>;
  setContactChannels(contactId: ContactId, channels: Channel[]): Promise<void>;
  deleteContact(contactId: ContactId, options?: { block?: { includeSuccessors: boolean }; erase?: string }): Promise<void>;
  blockChannels(channels: Channel[], includeSuccessors: boolean): Promise<void>;
  eraseMessage(messageId: MessageId): Promise<void>;

  send(target: { channel: Channel } | { contactId: ContactId }, content: Content): Promise<SendResult>;
  retry(messageId: MessageId): Promise<Outcome<DispatchWord>>;
  cancel(messageId: MessageId): Promise<Outcome<Cancelled["outcome"]>>;
  completeResponse(executionId: ExecutionId, effectType: string): Promise<Outcome<CompletionWord>>;
  completeNotification(rotationEventCid: EventReference<"did.rotationSelected">): Promise<Outcome<CompletionWord>>;
  /** The user's own rotation of `localDidId` toward `peerDid`: a fresh successor, and its notification called. */
  rotate(localDidId: DidId, peerDid: Did): Promise<Outcome<CompletionWord> & { successor: DidId; existed: boolean }>;

  /** Where a snapshot covering every change committed so far stands: published already, or once the read under way or the next one is. Reads and publishes only. */
  refresh(): Promise<{ epoch: string; revision: number }>;
  /** Every arrangement connected again: reconciled, picked up, live. */
  reconnect(): Promise<void>;

  traceLevel(): Promise<TraceLevel>;
  setTraceLevel(level: TraceLevel): Promise<TraceLevel>;
}
