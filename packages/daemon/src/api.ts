import type { Channel, ContactId, Did, DidId, EventReference, ExecutionId, MediationId, MessageId, ReplicaId } from "@estoc/vault";
import type { Called, Cancelled, Content, Invitation, Selected, TraceLevel } from "@estoc/agent-core";
import type { Hold, SnapshotPart } from "@estoc/daemon-api/contract";

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
  /**
   * A snapshot's bytes restored as this daemon's vault, under the
   * passphrase that opens the snapshot's own wrapped seed: one with no
   * seed is refused. The bytes are the daemon's from then on: a view of
   * a whole buffer is left detached.
   */
  restoreIdentity(snapshot: Uint8Array, passphrase: string): Promise<void>;
  /** The person was shown what a restore cannot bring back: sends and manual dispatch are open from here on. */
  explainedRestore(): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  /** The agent stopped and the seed forgotten, the vault kept hold of; nothing changes for a vault locked already. */
  lock(): Promise<void>;
  /** The vault this daemon holds, removed for good: the one named, and refused when another has taken its place. */
  forgetIdentity(hold: Hold): Promise<void>;
  /** The vault's snapshot with both parts, the seed and the content, as a CAR file, refused whole when it comes to more than `maxBytes`. */
  exportBackup(maxBytes?: number): Promise<{ name: string; bytes: Uint8Array }>;
  /**
   * A snapshot's content merged into the vault open when it is asked;
   * refused, with nothing written, when it has no content, is another
   * vault's or that vault is let go of before its turn. The bytes are
   * taken over as `restoreIdentity` takes them.
   */
  mergeBackup(snapshot: Uint8Array): Promise<Merged>;
  /**
   * The vault's snapshot of `part` sealed under a key of its own
   * and put at the selected mediator as this replica's blob, and the
   * link that restores (the seed) or imports (the content) it; refused
   * whole when the snapshot comes to more than a blob there holds once
   * sealed, or a seed to more than a link to add a device holds, which
   * the daemon was made with. The export takes
   * its turn with the calls on the daemon's files. What is put is kept
   * in this runtime's local state before the put, so that a snapshot
   * whose upload failed is still listed, and revocable.
   */
  publishSnapshotLink(part: SnapshotPart): Promise<PublishedSnapshot>;
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
   * A vault restored from a seed link as `restoreIdentity` restores
   * one from a snapshot's bytes: the sealed snapshot read first, no
   * further than a seed may come to, which the daemon was made with,
   * then checked against its name and opened. Refused before anything
   * is read where no vault could be made, and with nothing written when
   * the read or the opening fails, or the snapshot is content.
   */
  restoreFromLink(link: SnapshotLink, passphrase: string): Promise<void>;
  /**
   * A content link's snapshot merged into the open vault as
   * `mergeBackup` merges one, read and opened as `restoreFromLink`
   * reads it but at most `maxBytes` of plaintext. Refused before
   * anything is read where no vault is open, and with nothing written
   * where the snapshot is a seed or the vault is let go of while it is
   * read.
   */
  importFromLink(link: SnapshotLink, maxBytes: number): Promise<Merged>;
  /** The replicas of the preferred arrangement asked of its mediator again, and kept for the records to show. */
  refreshReplicas(): Promise<void>;
  /**
   * The whole vault's snapshot published as `publishSnapshotLink`
   * publishes one, and its link mailed to `replicaId`, or to every other
   * replica the mediator holds when it is left out, as the mediator
   * lists them now; each imports it as the link arrives. Refused before
   * anything is put when the mediator holds no such replica. `told` is
   * those the mediator took the mail for; what came of each is kept for
   * the records to show.
   */
  sync(replicaId?: ReplicaId): Promise<{ told: ReplicaId[] }>;

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
