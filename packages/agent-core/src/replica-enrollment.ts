/**
 * A replica-mediation arrangement at its mediator: the account
 * registered, and this runtime's own replica added to it. The vault
 * records each intent before the request that acts on it — the
 * arrangement's creation before the account is registered, the
 * replica's grant before the replica is added — so that a failure
 * leaves something to retry and never a half identity. The grant waits
 * for the account: a replica ID is bound to one arrangement for good,
 * and a mediator that never registered the account must not hold the
 * runtime to itself. That the account exists is recorded as the
 * arrangement's grant, once, for every replica to read. That this
 * replica was added is this runtime's alone to know and is kept beside
 * the vault, where no snapshot carries it: a copy of the vault running
 * elsewhere is another replica and enrolls itself. While the account and the replica
 * stand at the mediator, both requests answer a repeat as they answered
 * the first time, so a confirmation that was lost, or never written,
 * costs one more request and changes nothing. While the account exists,
 * a replica DID the mediator has removed cannot be added again: joining
 * that account once more needs a new replica ID.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { scanVault, signReplicaGrant, vaultDraft, type Did, type Keys, type Mediation, type MediationId, type Replica, type ReplicaId, type VaultEvent, type VaultFold } from "@estoc/vault";

import type { Account } from "./arrangement.js";
import { ACCOUNT_REGISTER, ACCOUNT_REGISTERED, REPLICA_ADD, REPLICA_ADDED } from "./protocol/replica-mediation.js";
import { EntityConflict, MediatorRefused, Unusable } from "./errors.js";
import { control, echoes } from "./link.js";
import { accountOf } from "./mediation.js";
import { decide } from "./procedure.js";

/** That a replica was added is kept under its replica ID, so the one a runtime takes at an identity reset finds none. */
const replicaAddedKey = (mediationId: MediationId, replicaId: ReplicaId): string => `replica-mediation/replica-added/${mediationId}/${replicaId}`;

/** Has the mediator confirmed to this runtime that it added the replica, as `replicaDid`, to the account's arrangement? */
export function replicaAdded(account: Account, replicaId: ReplicaId, replicaDid: Did): Promise<boolean> {
  return account.confirmed(replicaAddedKey(account.mediationId, replicaId), "replicaDid", replicaDid);
}

/** The grant the replica still needs to be a member of the arrangement, signed and not recorded; null when it is one already. */
async function grantWanted(fold: VaultFold, keys: Keys, mediationId: MediationId, replicaId: ReplicaId): Promise<string | null> {
  const mediation = accountOf(fold, mediationId);
  const existing = fold.replicas.replicas.get(replicaId);
  if (existing === undefined) return signReplicaGrant(keys, mediation, replicaId);
  if (existing.mediationId !== mediationId) throw new EntityConflict("replica", replicaId, existing.faults.join("; ") || `enrolled in mediation ${existing.mediationId}`);
  if (existing.status !== "member") throw new Unusable("replica", replicaId, existing.faults.length > 0 ? existing.faults : [existing.status]);
  return null;
}

/**
 * `replica.created` for this runtime in the arrangement: the grant its
 * account signs for the runtime's own replica ID. Committed before the
 * mediator is asked to add the replica. The grant already recorded for
 * this arrangement is returned as it is.
 */
export async function createReplica(runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<VaultEvent<"replica.created">> {
  const replicaId: ReplicaId = runtime.author;
  const { fold, events } = await decide(runtime, keys, async (fold) => {
    const grant = await grantWanted(fold, keys, mediationId, replicaId);
    return grant === null ? [] : [vaultDraft("replica.created", { replicaId, mediationId, grant })];
  });
  return (events[0] as VaultEvent<"replica.created"> | undefined) ?? (fold.set.of("replica.created").find((event) => event.data.replicaId === replicaId) as VaultEvent<"replica.created">);
}

export type EnrollStep = "account-registered" | "replica-created" | "replica-added";

export interface Enrolled {
  mediation: Mediation;
  /** this runtime's replica in the arrangement */
  replica: Replica;
  /** what this run had to do, in order */
  steps: EnrollStep[];
}

/**
 * This runtime enrolled in the account's arrangement, each step only
 * when it is not already known to be done: account-register →
 * `mediation.granted` when the arrangement has no grant,
 * `replica.created` when the vault has none for this runtime,
 * replica-add when no confirmation of it is kept. A replica this
 * runtime could not join the account as is refused before the mediator
 * is asked for the account. Needs an arrangement neither retired nor in
 * conflict. Only the runtime's own replica is ever added: another
 * member's grant in the vault is that member's to enroll with. For a
 * caller holding the account's turn. A link whose holder closes refuses
 * the next request, and the enrollment stops there: what an answered
 * request settled is recorded first.
 */
export async function enroll(account: Account): Promise<Enrolled> {
  const { runtime, keys, mediationId } = account;
  const steps: EnrollStep[] = [];
  const replicaId: ReplicaId = runtime.author;
  let fold = await scanVault(runtime.vault, keys);
  await grantWanted(fold, keys, mediationId, replicaId);

  let mediation = accountOf(fold, mediationId);
  if (mediation.routingDid === null) {
    const registered = await control(await account.link(mediation), ACCOUNT_REGISTER, {}, ACCOUNT_REGISTERED);
    if (!echoes(registered, "account", mediation.me.did) || !echoes(registered, "routing_did", mediation.mediatorDid)) {
      throw new MediatorRefused("account-registered names another account or routing DID than the one asked for");
    }
    const routingDid = mediation.mediatorDid;
    const decided = await decide(runtime, keys, (fold) => (accountOf(fold, mediationId).routingDid === null ? [vaultDraft("mediation.granted", { mediationId, routingDid })] : []));
    if (decided.events.length > 0) steps.push("account-registered");
    fold = await scanVault(runtime.vault, keys);
  }

  if (!fold.replicas.replicas.has(replicaId)) steps.push("replica-created");
  await createReplica(runtime, keys, mediationId);
  fold = await scanVault(runtime.vault, keys);
  mediation = accountOf(fold, mediationId);

  const replica = fold.replicas.replicas.get(replicaId);
  if (replica === undefined || replica.status !== "member" || replica.did === null) throw new Unusable("replica", replicaId, replica === undefined ? ["no creation"] : replica.faults.length > 0 ? replica.faults : [replica.status]);
  if (!(await replicaAdded(account, replicaId, replica.did))) {
    const added = await control(await account.link(mediation), REPLICA_ADD, { grant: replica.grants[0] as string }, REPLICA_ADDED);
    if (!echoes(added, "replica_did", replica.did) || added.body["state"] !== "active") {
      throw new MediatorRefused("replica-added names another replica than the one asked for, or one that is not active");
    }
    await account.confirm(replicaAddedKey(mediationId, replicaId), { replicaDid: replica.did });
    steps.push("replica-added");
  }
  await account.observe("enroll", { mediationId, replicaId, replicaDid: replica.did, steps });
  return { mediation, replica, steps };
}
