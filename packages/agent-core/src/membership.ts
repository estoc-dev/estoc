/**
 * This runtime's replica as a member of its arrangement, bound to this
 * runtime: the runtime and its keys, the replica's ID, arrangement and
 * DID, and the link that speaks as that DID to the arrangement's
 * mediator, with the queue picked up over it and the blob store spoken
 * to through it. Every request the replica makes goes through it, so
 * that no caller pairs a link with a replica DID. A runtime has one
 * replica, bound to one arrangement for good, so an agent binds one
 * membership and keeps it; a host is handed it as a `Membership` and
 * cannot make one.
 *
 * Binding is local and immediate, and needs the replica's creation; the
 * link is not made until an operation has to reach the mediator. What
 * can change after the binding — the replica still a member, its
 * arrangement still usable — is checked over the fold by each operation
 * a host asks for, before its request. A membership has no closing of
 * its own: once the agent closes, an operation that has to reach the
 * mediator is refused with `LinkClosed`.
 */

import type { Secret } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store";
import { scanVault, type Did, type ExecutionId, type Keys, type MediationId, type ReplicaId, type VaultFold } from "@estoc/vault";

import type { Account } from "./arrangement.js";
import { BlobStore } from "./blob-store.js";
import { UnknownEntity, Unusable } from "./errors.js";
import { replicaSecrets } from "./keyring.js";
import type { MediatorLink } from "./link.js";
import { Pickup, type Handle } from "./pickup.js";
import { plainMessage } from "./protocol/didcomm.js";
import { SNAPSHOT_LINK, snapshotLinkBody } from "./protocol/replica-channel.js";
import { replicaRoute, sendOverRoute, usableReplica, type ReplicaAddress, type SendOverRouteOptions } from "./replica-channel.js";
import { knownLongForms } from "./resolver.js";
import { registerExecution, type Responder } from "./responder.js";
import type { BlobLink } from "./sealed-blob.js";

/** What a host does as this runtime's replica at its arrangement's mediator. */
export interface Membership {
  readonly replicaId: ReplicaId;
  /** the arrangement the replica is a member of */
  readonly mediationId: MediationId;
  /**
   * blob-store/1.0 at the arrangement's mediator, spoken as the replica:
   * a blob put through it is the replica's, counted against the
   * replica's quota and ended with the replica. Each request is made
   * once this runtime is enrolled in the arrangement, each step of that
   * only when it is not known to be done, and once the replica is found
   * a member of an arrangement that is usable.
   */
  readonly blobs: BlobStore;
  /**
   * A snapshot link sent to another replica of this vault's seed at the
   * arrangement, through its mediator. Which replica to write to is the
   * caller's to know — the mediator's list, the fold — and `to` is
   * written to only when the seed bears it out as another replica
   * there. Nothing is recorded and nothing is sent again: the link asks
   * `to` to import what the vault already says, so a lost one costs
   * another send. `UnknownEntity` or `Unusable` when the replica cannot
   * send, `NotAReplica` when `to` is no one to send to, and
   * `MediatorRefused` when the mediator does not take the mail.
   */
  sendSnapshotLink(to: ReplicaAddress, link: BlobLink): Promise<void>;
}

/** What makes a link to the arrangement's mediator speaking as `me`, with the keys `secrets` gives. */
export type LinkAs = (me: string, secrets: () => Secret[]) => MediatorLink;

export interface MemberOptions extends SendOverRouteOptions {
  log?: (line: string) => void;
}

/** A replica as its creation binds it: none of this ever changes. */
export interface ReplicaBinding {
  replicaId: ReplicaId;
  mediationId: MediationId;
  did: Did;
  longFormDid: Did;
}

/** The replica `replicaId` as its creation binds it; `UnknownEntity` while the fold has no such replica, `Unusable` while its grants disagree on where it is. */
export function bindingOf(fold: VaultFold, replicaId: ReplicaId): ReplicaBinding {
  const replica = fold.replicas.replicas.get(replicaId);
  if (replica === undefined) throw new UnknownEntity("replica", replicaId);
  const { mediationId, did, longFormDid } = replica;
  if (mediationId === null || did === null || longFormDid === null) throw new Unusable("replica", replicaId, replica.faults);
  return { replicaId, mediationId, did, longFormDid };
}

export class Member implements Membership {
  readonly replicaId: ReplicaId;
  readonly mediationId: MediationId;
  readonly did: Did;
  readonly longFormDid: Did;
  readonly blobs: BlobStore;
  private linked: MediatorLink | null = null;
  private picking: Pickup | null = null;

  constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    binding: ReplicaBinding,
    private readonly account: Account,
    private readonly line: () => Promise<LinkAs>,
    private readonly handle: Handle,
    private readonly options: MemberOptions
  ) {
    this.replicaId = binding.replicaId;
    this.mediationId = binding.mediationId;
    this.did = binding.did;
    this.longFormDid = binding.longFormDid;
    this.blobs = new BlobStore(() => this.enrolledLink(), { timeoutMs: options.timeoutMs });
  }

  async sendSnapshotLink(to: ReplicaAddress, link: BlobLink): Promise<void> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const route = await replicaRoute(this.keys, fold, this.replicaId, to);
    const plaintext = plainMessage(SNAPSHOT_LINK, route.ends.sender.did, route.ends.recipient.did, snapshotLinkBody({ replicaId: this.replicaId, link }));
    await sendOverRoute(await this.link(), route, plaintext, knownLongForms(fold), this.options);
  }

  /** Is a socket open, or opening, on the replica's link? */
  get live(): boolean {
    return this.linked?.live ?? false;
  }

  /**
   * The link that speaks as the replica, with that DID's keys alone,
   * under both its spellings, since the mediator seals what it pushes to
   * the short form: made on first need.
   */
  async link(): Promise<MediatorLink> {
    if (this.linked !== null) return this.linked;
    const linkAs = await this.line();
    const secrets = await replicaSecrets(this.keys, this);
    this.linked ??= linkAs(this.longFormDid, () => secrets);
    return this.linked;
  }

  /** The replica's queue at the mediator, picked up over its link. */
  async pickup(): Promise<Pickup> {
    const link = await this.link();
    this.picking ??= new Pickup(link, this.handle, { log: this.options.log });
    return this.picking;
  }

  /** Who answers the input of an execution, as the mediator registers this replica under it. */
  registerExecution(executionId: ExecutionId): Promise<Responder> {
    return registerExecution(this, executionId);
  }

  /** The replica's link closed, as the agent that bound it closes. */
  close(): void {
    this.linked?.close();
  }

  /** The link for a blob request: once this runtime is enrolled, and its replica is found still able to speak at the arrangement. */
  private async enrolledLink(): Promise<MediatorLink> {
    await this.account.enroll();
    usableReplica(await scanVault(this.runtime.vault, this.keys), this.replicaId);
    return this.link();
  }
}
