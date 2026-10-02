/**
 * The replicas of each replica-mediation arrangement: for each replica
 * ID, the one binding its grants agree on, and whether that binding is
 * the arrangement's and the seed's. A replica is a member of its
 * arrangement by the grant and the arrangement's creation alone; that
 * its mediator has enrolled it is the runtime's to know, not the
 * vault's, and whether the arrangement can carry mail, which its
 * routing grant and retirement decide, is the mediation fold's and
 * leaves membership as it is. Whether a grant was signed
 * by the arrangement's account key and names the replica the seed
 * derives needs the seed, so that check runs beside the fold and its
 * verdict is handed in; until it is, the replica is pending.
 */

import { IdentityMismatch, InvalidDidDocument, InvalidReplicaGrant } from "../errors.js";
import type { Keys } from "../identity.js";
import { canonicalDidOf } from "../peer-document.js";
import { readReplicaGrant, sameBinding, verifyReplicaGrant, type ReplicaGrant } from "../replica-grant.js";
import type { Did, MediationId, ReplicaId } from "../types.js";
import { mediationCreations, type IdentityCheck, type KeyCheck } from "./mediation.js";
import { groupBy, type VaultEventSet } from "./set.js";

/**
 * `member` is a replica of its arrangement; `pending` waits for the
 * arrangement's creation or for the seed's verdict; `conflict` is
 * terminal: grants binding one replica ID differently, a binding that
 * is not the arrangement's, or one the seed does not bear out.
 */
export type ReplicaStatus = "member" | "pending" | "conflict";

export interface Replica {
  readonly replicaId: ReplicaId;
  /** the arrangement the consistent binding names, null while grants disagree */
  readonly mediationId: MediationId | null;
  /** the replica's own DID at the arrangement's mediator, in its short form */
  readonly did: Did | null;
  readonly longFormDid: Did | null;
  /** every grant recorded for the consistent binding, in canonical event order: the first is what the replica enrolls with */
  readonly grants: readonly string[];
  readonly faults: readonly string[];
  readonly identity: IdentityCheck;
  readonly status: ReplicaStatus;
}

export interface ReplicaFold {
  readonly replicas: ReadonlyMap<ReplicaId, Replica>;
  /** the members of one arrangement, by replica ID */
  members(mediationId: MediationId): readonly Replica[];
}

export type ReplicaFoldOptions = { grantChecks?: ReadonlyMap<ReplicaId, KeyCheck> };

function accountOf(did: Did): Did | null {
  try {
    return canonicalDidOf(did);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return null;
    throw err;
  }
}

export function foldReplicas(set: VaultEventSet, options: ReplicaFoldOptions = {}): ReplicaFold {
  const creations = mediationCreations(set);
  const created = groupBy(set.of("replica.created"), (event) => event.data.replicaId);
  const replicas = new Map<ReplicaId, Replica>();
  for (const replicaId of [...created.keys()].sort()) {
    const grants = [...new Set(created.get(replicaId)!.map((event) => event.data.grant))];
    const read = grants.map(readReplicaGrant);
    const binding = read[0] as ReplicaGrant;
    const faults: string[] = [];
    let waiting = false;
    if (read.some((grant) => !sameBinding(grant, binding))) {
      faults.push("grants disagree");
    } else {
      const creation = creations.get(binding.mediationId);
      if (creation === undefined) {
        waiting = true;
      } else if (creation === null) {
        faults.push(`the creations of mediation ${binding.mediationId} disagree`);
      } else {
        if (creation.profile === undefined) faults.push(`mediation ${binding.mediationId} is no replica-mediation arrangement`);
        else if (accountOf(creation.me.did) !== binding.account) faults.push("the grant's account is not the arrangement's");
        if (creation.mediatorDid !== binding.mediator) faults.push("the grant's mediator is not the arrangement's");
      }
    }
    const identity: IdentityCheck = options.grantChecks?.get(replicaId) ?? "unchecked";
    if (identity === "mismatch") faults.push("the seed does not bear out the replica's grants");
    const conflict = faults.length > 0;
    const consistent = !faults.includes("grants disagree");
    replicas.set(replicaId, {
      replicaId,
      mediationId: consistent ? binding.mediationId : null,
      did: consistent ? binding.replicaDid : null,
      longFormDid: consistent ? binding.replicaLongForm : null,
      grants: consistent ? grants : [],
      faults,
      identity,
      status: conflict ? "conflict" : waiting || identity === "unchecked" ? "pending" : "member",
    });
  }
  const members = (mediationId: MediationId) => [...replicas.values()].filter((replica) => replica.status === "member" && replica.mediationId === mediationId);
  return { replicas, members };
}

/**
 * Each replica whose grants agree and whose arrangement has one consistent creation, checked against the seed: did the
 * account that creation records sign every grant, and is the replica they name the one the seed derives?
 */
export async function verifyReplicaGrants(keys: Keys, set: VaultEventSet): Promise<Map<ReplicaId, KeyCheck>> {
  const creations = mediationCreations(set);
  const checks = new Map<ReplicaId, KeyCheck>();
  for (const replica of foldReplicas(set).replicas.values()) {
    const creation = replica.mediationId === null ? null : creations.get(replica.mediationId);
    if (creation === null || creation === undefined) continue;
    try {
      for (const grant of replica.grants) await verifyReplicaGrant(keys, grant, creation.me.did);
      checks.set(replica.replicaId, "verified");
    } catch (err) {
      if (!(err instanceof InvalidReplicaGrant || err instanceof IdentityMismatch || err instanceof InvalidDidDocument)) throw err;
      checks.set(replica.replicaId, "mismatch");
    }
  }
  return checks;
}
