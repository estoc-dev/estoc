/**
 * This runtime's replica as a member of its arrangement, bound to this
 * runtime: the runtime and its keys, the replica's ID, arrangement, DID
 * and mediator, and the link that speaks as that DID to the
 * arrangement's mediator, with the queue picked up over it and the blob
 * store spoken to through it. Every request the replica makes goes
 * through it, so that no caller pairs a link with a replica DID. A
 * runtime has one replica, bound to one arrangement for good, so an
 * agent binds one membership and keeps it; a host is handed it by that
 * arrangement as a `Membership` and cannot make one.
 *
 * The binding never changes; whether the replica may act on it is
 * decided request by request. Every request that reaches the mediator
 * passes one gate first: the agent that bound the replica still open,
 * and the replica found enrolled over the fold as it stands, a member
 * of a usable arrangement whose adding the mediator confirmed to this
 * runtime. A request the gate refuses fails alone, with nothing sent,
 * and the next is judged anew: a binding handed out earlier is not
 * revoked, and nothing hangs on the agent being rebuilt. Enrolling is
 * not the gate's to do: a host enrolls through the agent and asks
 * again. The link is not made until a request passes. Every drain of
 * the replica's queue is a request of its own, the one that follows
 * live delivery coming on as much as the first; telling the mediator
 * what a drain or the socket took is not, even for a delivery left
 * waiting and acknowledged once its wait ends, since it ends a request
 * let through rather than beginning one.
 */

import type { Secret } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store";
import { scanVault, type ExecutionId, type Keys, type MediationId, type ReplicaId, type VaultFold } from "@estoc/vault";

import type { Account } from "./arrangement.js";
import { BlobStore } from "./blob-store.js";
import { LinkClosed, UnknownEntity, Unusable } from "./errors.js";
import { replicaSecrets } from "./keyring.js";
import type { Lifetime } from "./lifetime.js";
import type { MediatorLink } from "./link.js";
import { Pickup, type Drained, type Handle } from "./pickup.js";
import { plainMessage } from "./protocol/didcomm.js";
import { STATUS } from "./protocol/mediation.js";
import { SNAPSHOT_LINK, snapshotLinkBody } from "./protocol/replica-channel.js";
import { replicaAdded } from "./replica-enrollment.js";
import { replicaRoute, sendOverRoute, usableReplica, type BoundReplica, type ReplicaAddress, type SendOverRouteOptions } from "./replica-channel.js";
import { knownLongForms } from "./resolver.js";
import { registerExecution, type Responder } from "./responder.js";
import type { BlobLink } from "./sealed-blob.js";

/** What a host does as this runtime's replica at its arrangement's mediator. */
export interface Membership {
  readonly replicaId: ReplicaId;
  readonly mediationId: MediationId;
  /**
   * blob-store/1.0 at the arrangement's mediator, spoken as the replica:
   * a blob put through it is the replica's, counted against the
   * replica's quota and ended with the replica. Each request passes the
   * gate first: `Unusable` when the replica is not enrolled, `LinkClosed`
   * once the agent closed, and nothing sent in either case.
   */
  readonly blobs: BlobStore;
  /**
   * A snapshot link sent to another replica of this vault's seed at the
   * arrangement, through its mediator. Which replica to write to is the
   * caller's to know — the mediator's list, the fold — and `to` is
   * written to only when the seed bears it out as another replica
   * there. Nothing is recorded and nothing is sent again: the link asks
   * `to` to import what the vault already says, so a lost one costs
   * another send. Passes the gate first: `Unusable` when the replica is
   * not enrolled, `LinkClosed` once the agent closed; then `NotAReplica`
   * when `to` is no one to send to, and `MediatorRefused` when the
   * mediator does not take the mail.
   */
  sendSnapshotLink(to: ReplicaAddress, link: BlobLink): Promise<void>;
}

/** What makes a link to the arrangement's mediator speaking as `me`, with the keys `secrets` gives. */
export type LinkAs = (me: string, secrets: () => Secret[]) => MediatorLink;

export interface MemberOptions extends SendOverRouteOptions {
  log?: (line: string) => void;
}

/** The replica `replicaId` as its creation binds it, none of which ever changes; `UnknownEntity` while the fold has no such replica, `Unusable` while its grants disagree on where it is. */
export function bindingOf(fold: VaultFold, replicaId: ReplicaId): BoundReplica {
  const replica = fold.replicas.replicas.get(replicaId);
  if (replica === undefined) throw new UnknownEntity("replica", replicaId);
  const { mediationId, did, longFormDid } = replica;
  if (mediationId === null || did === null || longFormDid === null) throw new Unusable("replica", replicaId, replica.faults);
  const mediatorDid = fold.mediations.mediations.get(mediationId)?.mediatorDid ?? null;
  if (mediatorDid === null) throw new Unusable("replica", replicaId, [`the arrangement ${mediationId} has no creation`]);
  return { replicaId, mediationId, mediatorDid, did, longFormDid };
}

/**
 * The replica `replicaId` enrolled at its arrangement: a member of an
 * arrangement that is usable, and added there as the mediator confirmed
 * to this runtime through `account`. The fold does not hold that
 * confirmation: a vault copied or restored says member of the replica
 * whether or not its adding was ever confirmed to this runtime.
 * `UnknownEntity` while the fold has no such replica, `Unusable` while a
 * step of enrolling is wanting, which its faults name.
 */
export async function enrolledReplica(fold: VaultFold, account: Account, replicaId: ReplicaId): Promise<BoundReplica> {
  const bound = usableReplica(fold, replicaId);
  if (!(await replicaAdded(account, replicaId, bound.did))) throw new Unusable("replica", replicaId, ["the mediator has not confirmed adding it to the arrangement"]);
  return bound;
}

export class Member implements Membership, BoundReplica {
  readonly replicaId: ReplicaId;
  readonly mediationId: MediationId;
  readonly mediatorDid: BoundReplica["mediatorDid"];
  readonly did: BoundReplica["did"];
  readonly longFormDid: BoundReplica["longFormDid"];
  readonly blobs: BlobStore;
  private linked: MediatorLink | null = null;
  private picking: Pickup | null = null;

  constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    binding: BoundReplica,
    private readonly account: Account,
    private readonly holder: Pick<Lifetime, "closed">,
    private readonly line: () => Promise<LinkAs>,
    private readonly handle: Handle,
    private readonly options: MemberOptions
  ) {
    this.replicaId = binding.replicaId;
    this.mediationId = binding.mediationId;
    this.mediatorDid = binding.mediatorDid;
    this.did = binding.did;
    this.longFormDid = binding.longFormDid;
    this.blobs = new BlobStore(() => this.link(), { timeoutMs: options.timeoutMs });
  }

  async sendSnapshotLink(to: ReplicaAddress, link: BlobLink): Promise<void> {
    const fold = await this.admitted();
    const route = await replicaRoute(this.keys, this, to);
    const plaintext = plainMessage(SNAPSHOT_LINK, route.ends.sender.did, route.ends.recipient.did, snapshotLinkBody({ replicaId: this.replicaId, link }));
    await sendOverRoute(await this.spoken(), route, plaintext, knownLongForms(fold), this.options);
  }

  /** Is a socket open, or opening, on the replica's link? */
  get live(): boolean {
    return this.linked?.live ?? false;
  }

  /** The link that speaks as the replica, for a request the gate lets through. */
  async link(): Promise<MediatorLink> {
    await this.admitted();
    return this.spoken();
  }

  /** The replica's queue at the mediator drained over its link. */
  async drain(): Promise<Drained> {
    return this.pickupOver(await this.link()).drain();
  }

  /**
   * A socket opened on the replica's link for live delivery: what the
   * mediator pushes down it is taken like what a drain fetched, `onLive`
   * is told once the mediator says live delivery is on, and `onLost`
   * once the socket closed on its own.
   */
  async openSocket(onLive: () => void, onLost: () => void): Promise<void> {
    const link = await this.link();
    const pickup = this.pickupOver(link);
    link.openSocket((opened) => {
      if (opened.msg.type === STATUS && opened.msg.body["live_delivery"] === true) onLive();
      return pickup.onFrame(opened);
    }, onLost);
  }

  /** Deliveries a drain or the socket took and left waiting, told taken once their wait ended. */
  async acknowledge(attachmentIds: readonly string[]): Promise<void> {
    if (this.picking === null) throw new Error("nothing was picked up over the replica's link");
    await this.picking.acknowledge(attachmentIds);
  }

  /** Who answers the input of an execution, as the mediator registers this replica under it. */
  registerExecution(executionId: ExecutionId): Promise<Responder> {
    return registerExecution(this, executionId);
  }

  /** The replica's link closed, as the agent that bound it closes. */
  close(): void {
    this.linked?.close();
  }

  /** The gate every request passes, and taking the membership too: the agent that bound the replica still open, and the replica found enrolled over the fold as it stands, which is returned for what the request derives from it. */
  async admitted(): Promise<VaultFold> {
    if (this.holder.closed) throw new LinkClosed();
    const fold = await scanVault(this.runtime.vault, this.keys);
    await enrolledReplica(fold, this.account, this.replicaId);
    return fold;
  }

  private pickupOver(link: MediatorLink): Pickup {
    this.picking ??= new Pickup(link, this.handle, { log: this.options.log });
    return this.picking;
  }

  /**
   * The link made on first need, with the replica DID's keys alone,
   * under both its spellings, since the mediator seals what it pushes to
   * the short form.
   */
  private async spoken(): Promise<MediatorLink> {
    if (this.linked !== null) return this.linked;
    const linkAs = await this.line();
    const secrets = await replicaSecrets(this.keys, this);
    this.linked ??= linkAs(this.longFormDid, () => secrets);
    return this.linked;
  }
}
