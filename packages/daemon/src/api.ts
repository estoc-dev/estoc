import type { Channel, ContactId, Did, DidId, EventReference, ExecutionId, MediationId, MessageId } from "@estoc/vault";
import type { Called, Cancelled, Content, Invitation, Selected, TraceLevel } from "@estoc/agent-core";
import type { Hold } from "@estoc/daemon-api/contract";

import type { PublishedSnapshot, PutSnapshot, SnapshotLink } from "./snapshot-links.js";

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

/** What a completion came to: a dispatch's word, the intent standing already, the operation refusing the input, or its recorded decision to owe the input nothing. */
export type CompletionWord = DispatchWord | "existing" | "refused" | "skipped";

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
   * The vault's snapshot sealed under a key of its own and put at the
   * selected mediator as this replica's blob, and the link that
   * restores it; refused whole when the snapshot comes to more than a
   * blob there holds once sealed. The export takes its turn with the
   * calls on the daemon's files. What is put is kept in this runtime's
   * local state before the put, so that a snapshot whose upload failed
   * is still listed, and revocable.
   */
  publishSnapshotLink(): Promise<PublishedSnapshot>;
  /**
   * A snapshot put from here, pending or published, deleted at the
   * mediator and forgotten once a publish of it under way has settled:
   * its link reads nothing from then on. Refused, and kept, when this
   * runtime has given up the replica ID it was put under: only that
   * replica may delete it.
   */
  revokeSnapshotLink(hash: string): Promise<void>;
  /** The snapshots put from here that the mediator keeps or may keep, by when they were put. */
  snapshotLinks(): Promise<PutSnapshot[]>;
  /**
   * A vault restored from a link as `restoreIdentity` restores one
   * from a snapshot's bytes: the sealed snapshot read first, at most
   * `maxBytes` of plaintext and the sealing beside it, checked against
   * its name and opened. Refused before anything is read where no vault
   * could be made, and with nothing written when the read or the
   * opening fails.
   */
  restoreFromLink(link: SnapshotLink, passphrase: string, maxBytes: number): Promise<void>;

  /** An arrangement with `mediatorDid` selected: the one that stands with that mediator, or one created and enrolled in. */
  setMediator(mediatorDid: string): Promise<MediationId>;
  /** A fresh DID routed through the selected arrangement, disclosed as an out-of-band invitation. */
  createInvitation(goal?: string): Promise<CreatedInvitation>;
  /** A fresh DID of ours toward the inviter, a contact that selects the pair, and a Ping under the invitation's ID. */
  acceptInvitation(invitation: Invitation, petname: string): Promise<SendResult & { contactId: ContactId }>;
  /** The same toward a DID handed over on its own, the Ping naming no invitation; a DID of this vault's is refused. */
  addContactByDid(did: string, petname: string): Promise<SendResult & { contactId: ContactId }>;
  /** The DID this vault hands out to anyone, in its long form: the live one disclosed directly, minted through the selected arrangement and disclosed when there is none. */
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
  /** The preparation this runtime's calls of the message carry from now on, chosen by the person; a retry carries it. */
  selectPreparation(messageId: MessageId, preparationEventCid: EventReference<"message.prepared">): Promise<Outcome<Selected["outcome"]>>;
  completeResponse(executionId: ExecutionId, effectType: string): Promise<Outcome<CompletionWord>>;
  completeNotification(rotationEventCid: EventReference<"did.rotationSelected">): Promise<Outcome<CompletionWord>>;
  /** The user's own rotation of `localDidId` toward `peerDid`: a fresh successor, and its notification called. */
  rotate(localDidId: DidId, peerDid: Did): Promise<Outcome<CompletionWord> & { successor: DidId; existed: boolean }>;

  /** Where a snapshot covering every change committed so far stands: published already, or once the read under way or the next one is. Reads and publishes only. */
  refresh(): Promise<{ epoch: string; revision: number }>;
  /** Every arrangement connected again: enrolled, its addresses held, picked up, live. */
  reconnect(): Promise<void>;

  traceLevel(): Promise<TraceLevel>;
  setTraceLevel(level: TraceLevel): Promise<TraceLevel>;
}
