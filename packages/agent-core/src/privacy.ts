/**
 * The early private-address policy: an entry we disclosed is one
 * anyone may have; the first established application input a peer
 * writes to it selects a private branch toward that peer, the start
 * the fold's recipe names, decided over the input as its source and
 * announced to the peer alone. The policy is applied only while the
 * input is live, in the receipt's own call chain, and to a disclosed
 * entry alone: an address in a branch, disclosed or not, one a peer's
 * rotation led to, or one never disclosed selects nothing. A pair
 * whose predecessor already decided reuses that intent, under its
 * first candidate record, whatever verified it since and however many
 * records support it, and selects no second successor and no other
 * notification. The same input on two replicas selects the same
 * successor; what each then records is its own record of one intent,
 * and the notification is the replica's alone that answers the input.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { ROTATION_NOTIFICATION_EFFECT, channelPolicy, decisionFor, kindOf, scanVault, type Decision, type EventReference, type Keys, type VaultEvent, type VaultFold } from "@estoc/vault";

import type { LiveInput, Responding } from "./action.js";
import { callRotation, notifyRotation, selectRotation, type RotateOptions, type Rotated, type RotationSelected, type RotationTarget } from "./rotate.js";

export type PrivacyPolicy = { status: "rotate"; target: RotationTarget } | { status: "reuse"; decision: Decision } | { status: "none"; because: string };

/** What the policy makes of an observation over the fold: pure, and read again under the lock by the rotation it selects. */
export function privacyPolicy(fold: VaultFold, cid: EventReference<"message.in">): PrivacyPolicy {
  const none = (because: string): PrivacyPolicy => ({ status: "none", because });
  const source = fold.channels.sources.get(cid);
  if (source === undefined) return none("the observation is not here");
  if (source.channel === null || source.localDidId === null) return none("the observation is anonymous or in no channel");
  const witness = fold.continuity.witness(cid);
  if (witness.status !== "complete") return none(`the observation is no complete witness: ${witness.because}`);
  if (!fold.admissions.admitted(cid)) return none(`the observation is not admitted: ${fold.dispositions.disposition(cid).status}`);
  const execution = fold.inbound.ofSource(cid);
  if (execution === null) return none("the observation is in no input here");
  if (execution.status !== "complete") return none(`the input is not established: ${execution.because}`);
  const kind = kindOf(source.event.data);
  if (kind !== "application") return none(`a control input selects no rotation: it is ${kind}`);
  const entity = fold.dids.entities.get(source.localDidId);
  if (entity === undefined || entity.disclosures.length === 0) return none("the local DID is not disclosed");
  if (fold.dids.lineage(entity.didId).status !== "entry") return none("the local DID is not an entry");
  const denied = channelPolicy(fold, source.channel);
  if (denied !== null) return none(denied);
  const existing = decisionFor(fold, source.channel.localDid, source.channel.peerDid);
  if (existing.status === "candidate") return { status: "reuse", decision: existing.candidate };
  if (existing.status !== "none") return none(existing.because);
  return { status: "rotate", target: { localDidId: entity.didId, peerDid: source.channel.peerDid, sourceEventCid: cid } };
}

export type PrivateAddress =
  | { outcome: "rotated"; rotation: Rotated }
  | { outcome: "reused"; decision: VaultEvent<"did.rotationSelected"> }
  | { outcome: "none"; because: string };

/**
 * The policy applied to a live input this runtime answers: the rotation
 * it selects is checked again under the writer lock, where the decision
 * is committed, then the notification's intent under the next, and the
 * notification's one transport call is made once the lock is released.
 * A decision recorded meanwhile is reused as it is, and so is the
 * successor another replica already created for the same start.
 */
export async function privateAddress(runtime: VaultRuntime, keys: Keys, answering: Responding, options: RotateOptions): Promise<PrivateAddress> {
  return notifyPrivateAddress(runtime, keys, await decidePrivateAddress(runtime, keys, answering.live, options), answering, options);
}

/** The policy as the lock decided it: nothing, a decision reused, or a rotation recorded with its notification still to make. */
export type PrivateAddressDecided = Exclude<PrivateAddress, { outcome: "rotated" }> | { outcome: "rotated"; rotation: RotationSelected };

/**
 * The decision of `privateAddress` alone, which every replica the live
 * input came to records at once, in the turn the delivery came in, so
 * that it opens what the peer writes to the successor from then on.
 */
export async function decidePrivateAddress(runtime: VaultRuntime, keys: Keys, live: LiveInput, options: Omit<RotateOptions, "dispatch">): Promise<PrivateAddressDecided> {
  const policy = privacyPolicy(await scanVault(runtime.vault, keys), live.cid);
  if (policy.status === "none") return { outcome: "none", because: policy.because };
  if (policy.status === "reuse") return { outcome: "reused", decision: policy.decision.event };
  const rotation = await selectRotation(runtime, keys, policy.target, options);
  return rotation.existed ? { outcome: "reused", decision: rotation.decision } : { outcome: "rotated", rotation };
}

/** The notification of the rotation decided, if one was, made and called by the runtime answering the input. */
export async function notifyPrivateAddress(runtime: VaultRuntime, keys: Keys, decided: PrivateAddressDecided, answering: Responding, options: RotateOptions): Promise<PrivateAddress> {
  if (decided.outcome !== "rotated") return decided;
  return { outcome: "rotated", rotation: await callRotation(await notifyRotation(runtime, keys, decided.rotation, answering, options), options) };
}

/** The policy as decided, its notification made by no step here: the input is another replica's to answer, or no one's that could be found. */
export function unannounced(decided: PrivateAddressDecided, because: string): PrivateAddress {
  if (decided.outcome !== "rotated") return decided;
  const { decision, records, channel, existed } = decided.rotation;
  return { outcome: "rotated", rotation: { decision, records, channel, successor: decision.data.toDidId, existed, notification: { effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "none", because } } };
}
