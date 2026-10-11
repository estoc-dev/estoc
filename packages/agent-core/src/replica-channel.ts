/**
 * Mail between the replicas of one vault's seed, within the one
 * arrangement each replica is bound to. The channel carries the mail
 * and authenticates its sender as a holder of the seed, and nothing
 * more: which replicas there are and which to write to is the caller's,
 * and a sender is authenticated whether or not this runtime has heard
 * of it. A sender's document must be the one the seed derives for the
 * replica ID its message names, sending to the arrangement's mediator,
 * and the envelope sealed under it; any holder of the seed derives
 * every replica's keys, so the ID names a replica, not a device.
 * Nothing here is written to the vault: the channel's messages ask for
 * what the vault already says.
 */

import { isLongForm } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store";
import { IdentityMismatch, InvalidDidDocument, authorizedMethodIds, checkReplicaDocument, methodPublicKey, peerResolution, type Did, type Keys, type LocalKey, type MediationId, type ReplicaId, type VaultFold } from "@estoc/vault";

import { DISPATCH_TIMEOUT_MS } from "./dispatch.js";
import { carry, recipientEndOf, seal, type CarryOptions, type Destination, type Ends, type SenderEnd } from "./ends.js";
import { MediatorRefused, NotAReplica, UnknownEntity, Unusable } from "./errors.js";
import { didcommDocumentOf } from "./evidence.js";
import { bounded, sealData, type MediatorLink } from "./link.js";
import { mediationOf } from "./mediation.js";
import type { IMessage } from "./protocol/didcomm.js";
import { REPLICA_CHANNEL, SNAPSHOT_LINK, readSnapshotLink } from "./protocol/replica-channel.js";
import type { ReplicaReceipt, ReplicaReceiptOutcome } from "./receive/receiver.js";
import { resolve, type KnownLongForms, type Resolution } from "./resolver.js";
import type { BlobLink } from "./sealed-blob.js";

/** A replica of this vault as the fold binds it: a member of one arrangement, under one DID at that arrangement's mediator. */
export interface BoundReplica {
  replicaId: ReplicaId;
  mediationId: MediationId;
  /** the arrangement's mediator, as its creation spells it */
  mediatorDid: Did;
  did: Did;
  longFormDid: Did;
}

/** The replica `replicaId` as the fold binds it; null unless it is a member of its arrangement. */
export function boundReplica(fold: VaultFold, replicaId: ReplicaId): BoundReplica | null {
  const replica = fold.replicas.replicas.get(replicaId);
  if (replica === undefined || replica.status !== "member" || replica.mediationId === null || replica.did === null || replica.longFormDid === null) return null;
  const mediatorDid = fold.mediations.mediations.get(replica.mediationId)?.mediatorDid ?? null;
  return mediatorDid === null ? null : { replicaId, mediationId: replica.mediationId, mediatorDid, did: replica.did, longFormDid: replica.longFormDid };
}

/** Another replica of this vault's seed, as the caller learned of it: its ID, and the long form of its DID, which alone carries its document. */
export interface ReplicaAddress {
  replicaId: ReplicaId;
  longFormDid: Did;
}

/** Mail from this runtime's replica to another: the replica it goes from, the two ends, and where the envelope goes. */
export interface ReplicaRoute {
  from: BoundReplica;
  ends: Ends;
  destination: Destination;
}

/**
 * The route of mail from this runtime's replica `author` to `to`: from
 * the long form the fold binds the replica to, a member of an
 * arrangement that can carry mail, to `to` when the seed bears it out
 * as another replica at that arrangement's mediator, with no
 * `from_prior`, since a replica DID never rotates. Nothing is derived
 * for another arrangement: a replica is bound to one, and its mail
 * stays there. `UnknownEntity` or `Unusable` when this runtime's
 * replica cannot send, `NotAReplica` when `to` is no one to send to.
 */
export async function replicaRoute(keys: Keys, fold: VaultFold, author: ReplicaId, to: ReplicaAddress): Promise<ReplicaRoute> {
  const recorded = fold.replicas.replicas.get(author);
  if (recorded === undefined) throw new UnknownEntity("replica", author);
  const from = boundReplica(fold, author);
  if (from === null) throw new Unusable("replica", author, recorded.faults.length > 0 ? recorded.faults : [recorded.status]);
  const mediation = mediationOf(fold, from.mediationId);
  if (mediation.status !== "usable") throw new Unusable("mediation", from.mediationId, mediation.faults.length > 0 ? mediation.faults : [mediation.status]);
  const key = (await keys.replicaKeys(author)).keyAgreement;
  const sender = senderEndOf(from, key);
  if (sender === null) throw new Unusable("replica", author, ["its document authorizes no key-agreement method didcomm seals from with the key the seed derives"]);
  const resolution = await recipientDocument(keys, from, to);
  const recipient = recipientEndOf(to.longFormDid, resolution, key);
  if (recipient === null) throw new NotAReplica(to.replicaId, to.longFormDid, "its document has no key-agreement method to seal to");
  return { from, ends: { sender, recipient, fromPrior: null }, destination: { did: to.longFormDid, service: resolution.service } };
}

/**
 * The replica as `key` seals from it: at the first method, in document
 * order, its document authorizes for key agreement, that carries `key`
 * and that didcomm can seal from. Null when there is none. The document
 * may authorize the key under a suite didcomm does not pack with, which
 * its projection marks `Other`; naming that method would fail the seal.
 */
function senderEndOf(from: BoundReplica, key: LocalKey): SenderEnd | null {
  const resolution = peerResolution(from.longFormDid);
  const projected = didcommDocumentOf(resolution, resolution.document["id"] as string);
  const packable = new Set(projected.verificationMethod.filter((method) => method.type !== "Other").map((method) => method.id));
  const methodId = authorizedMethodIds(resolution.document, "keyAgreement").find((id) => packable.has(id) && methodPublicKey(resolution.document, id) === key.publicKey);
  return methodId === undefined ? null : { did: from.longFormDid, resolution, methodId, key };
}

async function recipientDocument(keys: Keys, from: BoundReplica, to: ReplicaAddress): Promise<Resolution> {
  const refused = (reason: string) => new NotAReplica(to.replicaId, to.longFormDid, reason);
  if (to.replicaId === from.replicaId) throw refused("it is this runtime's own replica");
  if (!isLongForm(to.longFormDid)) throw refused("only a did:peer:4 long form carries a replica's document");
  const answer = await resolve(to.longFormDid, () => null);
  if (answer.outcome !== "resolved") throw refused(answer.reason);
  try {
    await checkReplicaDocument(keys, to.replicaId, answer.resolution, from.mediatorDid);
  } catch (err) {
    if (err instanceof IdentityMismatch || err instanceof InvalidDidDocument) throw refused(err.message);
    throw err;
  }
  return answer.resolution;
}

export interface SendOverRouteOptions extends CarryOptions {
  /** how long sealing, carrying and the call may take together; `DISPATCH_TIMEOUT_MS` when left out */
  timeoutMs?: number;
}

/**
 * The plaintext sealed between the route's ends and forwarded to the
 * recipient through the arrangement's mediator over `line`, the line to
 * that mediator: under a forward ID of its own, posted once, and kept
 * nowhere but in the trace. Throws `MediatorRefused` when the mediator
 * does not take the forward, and what sealing, carrying and the line
 * throw.
 */
export async function sendOverRoute(line: MediatorLink, route: ReplicaRoute, plaintext: IMessage, known: KnownLongForms, options: SendOverRouteOptions): Promise<void> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DISPATCH_TIMEOUT_MS);
  const envelope = await bounded(deadline, () => seal(route.ends, plaintext as unknown as JsonObject, options.didcomm));
  const carried = await carry(route.destination, envelope, crypto.randomUUID(), known, options, deadline);
  if ("because" in carried) throw new Error(`the mail cannot be carried: ${carried.because}`);
  if ("reason" in carried) throw new Error(`the mail was not carried: ${carried.reason}`);
  const out = await bounded(deadline, () => line.traceOut("http", carried.endpoint, carried.body, { type: plaintext.type }));
  const wrapped = carried.forward;
  const forward = wrapped === null ? out : await bounded(deadline, () => line.traceSeal(sealData(wrapped.packed, wrapped.message), out));
  await bounded(deadline, () => line.traceSeal(sealData(envelope, plaintext), forward));
  const { ok, status, text, ms } = await bounded(deadline, () => line.post(carried.endpoint, carried.body, out, deadline));
  await line.traceIn("http", text, { parent: out, status, ms });
  if (!ok) throw new MediatorRefused(`the mediator answered ${status} to the forward`);
}

/** A snapshot link another replica of this vault's seed sent this runtime's replica. */
export interface SnapshotLinkReceived {
  /** the arrangement whose mailbox it came from */
  mediationId: MediationId;
  /** the replica that sent it */
  replicaId: ReplicaId;
  link: BlobLink;
}

export interface ReplicaReceiptOptions {
  /** the HTTP endpoint at which this runtime reaches an arrangement's mediator; throws when it reaches it at none */
  mediatorEndpoint: (mediationId: MediationId) => string;
  /** told of a snapshot link; the delivery is acknowledged once this returns */
  onSnapshotLink: (received: SnapshotLinkReceived) => void | Promise<void>;
}

/**
 * What takes the mail of this runtime's replica once the receiver has
 * opened it: a snapshot link from another replica of the seed at the
 * same arrangement, handed to the host. The sender is that replica when
 * its document is the one the seed derives for the replica ID the body
 * names, at the arrangement's mediator, and that ID is not this
 * runtime's own. The link is taken only at an https URL the mediator
 * itself serves, so that no message makes this runtime fetch from
 * anywhere else. Anything else is terminal.
 */
export function replicaReceiptOf(keys: Keys, options: ReplicaReceiptOptions): ReplicaReceipt {
  return async ({ plaintext, recipient, sender }) => {
    const terminal = (reason: string): ReplicaReceiptOutcome => ({ outcome: "terminal", reason });
    if (plaintext.type !== SNAPSHOT_LINK) return terminal(`${JSON.stringify(plaintext.type)} is no message of ${REPLICA_CHANNEL} this runtime takes`);
    const message = readSnapshotLink(plaintext.body);
    if (message === null) return terminal("the snapshot link is not a replica ID, a URL, a blob's name and its key, and nothing else");
    const { replicaId, link } = message;
    if (replicaId === recipient.replicaId) return terminal(`the sender names this runtime's own replica ID ${replicaId}`);
    try {
      await checkReplicaDocument(keys, replicaId, sender.resolution, recipient.mediatorDid);
    } catch (err) {
      if (err instanceof IdentityMismatch || err instanceof InvalidDidDocument) return terminal(`the sender is not replica ${replicaId} of this seed at the arrangement's mediator: ${err.message}`);
      throw err;
    }
    const endpoint = options.mediatorEndpoint(recipient.mediationId);
    if (!servedAt(link.url, endpoint)) return terminal(`the link ${link.url} is no https URL the mediator serves at ${endpoint}`);
    await options.onSnapshotLink({ mediationId: recipient.mediationId, replicaId, link });
    return { outcome: "handed" };
  };
}

function servedAt(url: string, endpoint: string): boolean {
  try {
    const link = new URL(url);
    return link.protocol === "https:" && link.origin === new URL(endpoint).origin;
  } catch {
    return false;
  }
}
