/**
 * What a mediator remembers: who it mediates for, which recipient DIDs route
 * to whom, and the messages waiting to be picked up.
 *
 * An account is a DID that asked for mediation and was granted it — existence
 * of the row is the grant. A keylist entry binds a recipient DID to exactly
 * one owner account; the binding is exclusive and first-come. Who is asking
 * is the protocol layer's to prove; that a DID is bound once, under one
 * protocol only, is kept here, inside the write that binds it.
 *
 * Every method is async because the least capable backend sets the contract:
 * Cloudflare D1 has no synchronous API, and the protocol layer is shared.
 */

export type AddRecipientResult = "added" | "already-yours" | "taken";

export interface StoredMessage {
  id: string;
  packed: string;
  createdAt: number;
}

/** `full`: the account is at its quota, and nothing was written. */
export type StoreOutcome = { outcome: "stored"; message: StoredMessage } | { outcome: "full" };

/** A replica-mediation account; its DID is a did:peer:4 short form. */
export interface ReplicaAccount {
  accountDid: string;
  /** What resolves the account DID later. */
  accountLongForm: string;
  /** The mediator DID the account is bound to, in short form when it is a did:peer:4. */
  mediator: string;
  /** Whether an absent account may be created. */
  create: boolean;
}

/**
 * `registered` also answers a repeat, with the time of the first.
 * `refused`: the account is absent and may not be created. `conflict`: the
 * DID is already bound otherwise, here or under ordinary mediation, or the
 * account is bound to another mediator DID.
 */
export type RegisterAccountOutcome =
  | { outcome: "registered"; registeredTime: number }
  | { outcome: "refused" | "conflict" };

/**
 * One replica's enrollment in a replica-mediation account. Both DIDs are
 * did:peer:4 short forms; the long form is what resolves the replica later.
 */
export interface ReplicaAddition {
  accountDid: string;
  /** The mediator DID the account is bound to, in short form when it is a did:peer:4. */
  mediator: string;
  replicaDid: string;
  replicaLongForm: string;
  grant: string;
  maxReplicas: number;
}

/**
 * `added` also answers a replica the account already has active, with the
 * time of the first, and keeps the first grant. `unknown`: there is no such
 * account. `conflict`: the DID is already bound otherwise, here or under
 * ordinary mediation, to a removed replica included, or the account is bound
 * to another mediator DID.
 * `full`: the account is at its limit of replicas not removed.
 */
export type AddReplicaOutcome =
  | { outcome: "added"; addedTime: number }
  | { outcome: "unknown" | "conflict" | "full" };

export interface RosterEntry {
  /** The replica's place in the order its account enrolled them, from 1. */
  ordinal: number;
  grant: string;
  addedTime: number;
  /** Null while the replica is active. */
  removedTime: number | null;
}

export interface RosterPage {
  /**
   * Names this registration of the account: one that is deleted and
   * registered again under the same DID has another.
   */
  registration: string;
  /** How many replicas the account has enrolled, the removed ones included. */
  size: number;
  entries: RosterEntry[];
}

/**
 * `removed` also answers a repeat, with the time of the first. `unknown`: no
 * such account is bound to that mediator. `not-enrolled`: the account never
 * enrolled that DID.
 */
export type RemoveOutcome =
  | { outcome: "removed"; removedTime: number }
  | { outcome: "unknown" | "not-enrolled" };

/** A communication DID a replica-mediation account asks to receive mail for. */
export interface SharedRecipient {
  accountDid: string;
  /** The mediator DID the request addressed; the account must be bound to it. */
  mediator: string;
  /** A did:peer:4 in its short form, and the long form that resolves it. */
  recipientDid: string;
  recipientLongForm: string;
  maxRecipients: number;
}

/**
 * `added` also answers a recipient the account already held, whatever its
 * limit is now, with the time of the first. `unknown`: no such account is
 * bound to that mediator. `conflict`: the DID is bound otherwise, under
 * either protocol. `full`: the account is at its recipient limit.
 */
export type ShareOutcome =
  | { outcome: "added"; addedTime: number }
  | { outcome: "unknown" | "conflict" | "full" };

/** Where a shared recipient stands among its account's: by when it was added, in milliseconds, then by DID. */
export interface RecipientPlace {
  addedAt: number;
  did: string;
}

export interface SharedRecipientPage {
  /** As in a roster page. */
  registration: string;
  recipients: RecipientPlace[];
  /** Whether the account holds recipients after these. */
  more: boolean;
}

/**
 * What bounds a package beyond the store's own retention and message count:
 * the time its sender set for it to lapse, in milliseconds, when it set one,
 * and the bytes its account may hold.
 */
export interface PackageBounds {
  deadline: number | null;
  maxRetainedBytes: number;
}

/** One replica's copy of a package; the message's id names the delivery, not the package. */
export interface ReplicaDelivery {
  replicaDid: string;
  message: StoredMessage;
}

/**
 * `unknown`: the recipient is neither a shared recipient nor an active
 * replica. `full`: the account is at its message or byte limit. `lapsed`: the
 * deadline has already passed. Only `stored` put a package in, and it put in
 * every delivery of it too.
 */
export type FanOutOutcome =
  | { outcome: "stored"; deliveries: ReplicaDelivery[] }
  | { outcome: "unknown" | "full" | "lapsed" };

export interface RecipientPage {
  recipients: string[];
  /** Entries remaining after this page. */
  remaining: number;
}

export interface BlobRow {
  /** where the bytes are served: `/b/<id>` — random, unrelated to the hash */
  id: string;
  /** the mediation that put it; the only one that can delete it */
  ownerDid: string;
  hash: string;
  size: number;
  /** When the bytes arrived and were verified; null while still expected. */
  uploadedAt: number | null;
  retainUntil: number;
}

/** A blob a mediation asks to hold until `retainUntil`, under `id` if it is new to it. */
export interface BlobKeep {
  id: string;
  ownerDid: string;
  hash: string;
  size: number;
  retainUntil: number;
}

/**
 * `kept`: the mediation holds the blob, as the row says. `mismatch`: it holds
 * the hash at another size. `full`: holding it would take the mediation past
 * its quota. Only `kept` wrote anything.
 */
export type KeepOutcome = { outcome: "kept"; blob: BlobRow } | { outcome: "mismatch" | "full" };

export interface UploadGrant {
  id: string;
  hash: string;
  size: number;
}

export interface MediationStore {
  /**
   * The mediator's stored identity secrets as JSON, or null before first
   * mint. The identity lives in the same database as everything else on
   * purpose: one file (or one D1 database) is the whole mediator.
   */
  loadIdentity(): Promise<string | null>;
  /**
   * Store the secrets unless a row already exists, and return the row that
   * won — insert-if-absent, so concurrent first contacts all end up holding
   * the same keys no matter whose mint got there first.
   */
  initIdentity(secretsJson: string): Promise<string>;

  /**
   * Grants `did` an ordinary account unless replica mediation has bound it;
   * whether it holds an ordinary account afterwards.
   */
  grantMediation(did: string): Promise<boolean>;
  revokeMediation(did: string): Promise<void>;
  isMediated(did: string): Promise<boolean>;

  addRecipient(ownerDid: string, recipientDid: string): Promise<AddRecipientResult>;
  removeRecipient(ownerDid: string, recipientDid: string): Promise<boolean>;
  listRecipients(
    ownerDid: string,
    offset: number,
    limit: number
  ): Promise<RecipientPage>;
  /** The account a recipient DID routes to, if any. */
  ownerOf(recipientDid: string): Promise<string | null>;

  /*
   * replica-mediation/1.0. An account and the replicas it enrolled are kept
   * until the account is deleted, a removed replica as removed, and their
   * DIDs and its shared recipients' are kept apart from ordinary accounts and
   * recipients in both directions: neither kind of binding can be made over
   * the other. Its mail is kept per account and handed out per replica, apart
   * from the ordinary queues.
   */
  registerReplicaAccount(account: ReplicaAccount): Promise<RegisterAccountOutcome>;
  /**
   * Deletes the account with everything kept for it: its replicas, the
   * removed ones included, its shared recipients and its mail. Every DID it
   * bound is free again. False, and nothing deleted, without such an
   * account bound to `mediator`.
   */
  deleteReplicaAccount(accountDid: string, mediator: string): Promise<boolean>;
  addReplica(addition: ReplicaAddition): Promise<AddReplicaOutcome>;
  /**
   * Ends a replica's enrollment and its deliveries, and with them every
   * package it was the last target of. Its DID stays bound, so it is never
   * enrolled again while the account exists.
   */
  removeReplica(accountDid: string, mediator: string, replicaDid: string): Promise<RemoveOutcome>;
  isReplicaAccount(did: string): Promise<boolean>;
  /** Null for a DID no account enrolled as a replica. */
  replicaState(did: string): Promise<"active" | "removed" | null>;
  /**
   * The account's replicas with an ordinal after `after` and up to `through`
   * (its current size when null), oldest first, the removed ones in their
   * place; null without such an account bound to `mediator`.
   */
  replicaRoster(
    accountDid: string,
    mediator: string,
    after: number,
    through: number | null,
    limit: number
  ): Promise<RosterPage | null>;
  /** The long form of a replica-mediation account or replica DID, if `did` is one. */
  resolutionMaterial(did: string): Promise<string | null>;
  addSharedRecipient(recipient: SharedRecipient): Promise<ShareOutcome>;
  /**
   * Unbinds a recipient from its account and forgets its long form; mail
   * already kept for it still waits. `no_change`: the account did not hold
   * it. `unknown`: no such account is bound to that mediator.
   */
  removeSharedRecipient(
    accountDid: string,
    mediator: string,
    recipientDid: string
  ): Promise<"removed" | "no_change" | "unknown">;
  /**
   * The account's recipients after `after`, oldest first; null without such
   * an account bound to `mediator`.
   */
  listSharedRecipients(
    accountDid: string,
    mediator: string,
    after: RecipientPlace | null,
    limit: number
  ): Promise<SharedRecipientPage | null>;
  /** The long form of a replica-mediation account's shared recipient, if `did` is one. */
  sharedRecipientMaterial(did: string): Promise<string | null>;
  /**
   * Keeps `packed` once for the account `next` routes to at that moment and
   * queues a delivery of it: for each active replica the account holds when
   * the recipient is shared, for that replica alone when it is one. A replica
   * enrolled later gets none. The package is deleted with its last delivery;
   * one that has none from the start waits out its retention.
   */
  fanOut(next: string, packed: string, bounds: PackageBounds): Promise<FanOutOutcome>;
  /**
   * What waits for a replica, oldest first, each under its delivery's id;
   * only what was forwarded to `next` when one is given.
   */
  deliveriesFor(replicaDid: string, limit: number, next?: string | null): Promise<StoredMessage[]>;
  deliveryCount(replicaDid: string, next?: string | null): Promise<number>;
  /**
   * Ends the named deliveries that are this replica's and ignores every other
   * id. A package goes with the last of its deliveries.
   */
  acknowledgeDeliveries(replicaDid: string, ids: string[]): Promise<void>;

  storeMessage(ownerDid: string, packed: string): Promise<StoreOutcome>;
  messageCount(ownerDid: string): Promise<number>;
  messagesFor(ownerDid: string, limit: number): Promise<StoredMessage[]>;
  /** Deletes the named messages; returns the ids that existed and are gone. */
  deleteMessages(ownerDid: string, ids: string[]): Promise<string[]>;

  purgeExpired(): Promise<number>;

  /*
   * blob-store/1.0. A blob row is one mediation's bytes: (owner, hash) is
   * unique, and nothing is shared between mediations — the same hash put by
   * two of them is two rows, two ids, two uploads. Bytes are kept by a
   * BlobStorage under the id; the store only knows what should exist.
   */
  blobOf(ownerDid: string, hash: string): Promise<BlobRow | null>;
  blobById(id: string): Promise<BlobRow | null>;
  /** Bytes of this mediation's live blobs, uploaded or not. */
  blobUsage(ownerDid: string): Promise<number>;
  /**
   * Creates the row if absent (under `keep.id`), else extends its retention
   * and never shortens it, all within `quotaBytes` of live blobs. A blob still
   * retained renews for nothing; one past its retention counts as new.
   */
  keepBlob(keep: BlobKeep, quotaBytes: number): Promise<KeepOutcome>;
  /** Removes the mediation's blob for the hash; returns its id (bytes to delete) or null if there was none. */
  dropBlob(ownerDid: string, hash: string): Promise<string | null>;
  /** A one-time upload token for the blob, good until `expiresAt`. */
  grantUpload(id: string, expiresAt: number): Promise<string>;
  /** The blob a live token names, consumed on read; null if unknown or expired. */
  claimUpload(token: string): Promise<UploadGrant | null>;
  markUploaded(id: string): Promise<void>;
  /**
   * Drops every blob past its retention or whose mediation has ended, and
   * expired tokens; returns the ids whose bytes should now be deleted.
   */
  purgeBlobs(): Promise<string[]>;

  close(): void;
}
