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

import { isJsonObject, type JsonValue, type LocalOptions, type VaultRuntime } from "@estoc/event-store";
import { sameDid, scanVault, signReplicaGrant, vaultDraft, type Did, type Keys, type Mediation, type MediationId, type Replica, type ReplicaId, type VaultEvent, type VaultFold } from "@estoc/vault";

import type { IMessage } from "./protocol/didcomm.js";
import { ACCOUNT_REGISTER, ACCOUNT_REGISTERED, REPLICA_ADD, REPLICA_ADDED } from "./protocol/replica-mediation.js";
import { PROBLEM_REPORT } from "./protocol/spec.js";
import { EntityConflict, MediatorRefused, Unusable } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { mediationOf, toward } from "./mediation.js";
import { decide, serially } from "./procedure.js";

/**
 * Where a runtime keeps what its mediator confirmed to it: its local
 * options, which outlive a reopen and every commit. The local cache
 * would not do, since it is emptied whenever the vault accepts an
 * event. That a replica was added is kept under its replica ID, so
 * the one a runtime takes at an identity reset finds none. That a
 * recipient was added is kept under the arrangement and the DID
 * entity, since the account holds it for every replica: it stays for
 * as long as the runtime's local options do.
 */
export type Confirmations = Pick<LocalOptions, "get" | "set">;

/** Confirmations kept for as long as the returned object is: whoever starts with a new one asks the mediator again, which changes nothing there. */
export function transientConfirmations(): Confirmations {
  const kept = new Map<string, JsonValue>();
  return {
    get: async (key) => kept.get(key),
    set: async (key, value) => void kept.set(key, value),
  };
}

const replicaAddedKey = (mediationId: MediationId, replicaId: ReplicaId): string => `replica-mediation/replica-added/${mediationId}/${replicaId}`;

export async function confirmed(confirmations: Confirmations, key: string, member: string, did: Did): Promise<boolean> {
  const kept = await confirmations.get(key);
  return isJsonObject(kept) && kept[member] === did;
}

/** Has the mediator confirmed to this runtime that it added the replica, as `replicaDid`, to the arrangement? */
export function replicaAdded(confirmations: Confirmations, mediationId: MediationId, replicaId: ReplicaId, replicaDid: Did): Promise<boolean> {
  return confirmed(confirmations, replicaAddedKey(mediationId, replicaId), "replicaDid", replicaDid);
}

/** The arrangement as the fold has it, fit to be enrolled in: created, its keys confirmed, neither retired nor in conflict. */
export function accountOf(fold: VaultFold, mediationId: MediationId): Mediation & { mediatorDid: Did; me: NonNullable<Mediation["me"]> } {
  const mediation = mediationOf(fold, mediationId);
  const faults =
    mediation.status === "conflict"
      ? mediation.faults
      : mediation.retired !== null
        ? [`retired: ${mediation.retired}`]
        : mediation.me === null || mediation.mediatorDid === null
          ? ["no creation"]
          : mediation.identity !== "verified"
            ? ["the seed has not confirmed the arrangement's keys"]
            : [];
  if (faults.length > 0) throw new Unusable("mediation", mediationId, faults);
  return mediation as Mediation & { mediatorDid: Did; me: NonNullable<Mediation["me"]> };
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
 * This runtime enrolled in the arrangement, each step only when it is
 * not already known to be done: account-register → `mediation.granted`
 * when the arrangement has no grant, `replica.created` when the vault
 * has none for this runtime, replica-add when no confirmation of it is
 * kept. A replica this runtime could not join the account as is refused
 * before the mediator is asked for the account. Needs an arrangement
 * created toward the link's mediator, neither retired nor in conflict. Only the runtime's
 * own replica is ever added: another member's grant in the vault is
 * that member's to enroll with. Runs as the account's one procedure at
 * a time. `proceed` is called before each request is begun and stops
 * the enrollment there by throwing: what an answered request settled
 * is recorded first.
 */
export function enroll(link: MediatorLink, runtime: VaultRuntime, keys: Keys, confirmations: Confirmations, mediationId: MediationId, proceed: () => void = () => {}): Promise<Enrolled> {
  return serially(runtime, mediationId, async () => {
    const steps: EnrollStep[] = [];
    const replicaId: ReplicaId = runtime.author;
    let fold = await scanVault(runtime.vault, keys);
    toward(link, accountOf(fold, mediationId));
    await grantWanted(fold, keys, mediationId, replicaId);

    let mediation = accountOf(fold, mediationId);
    if (mediation.routingDid === null) {
      proceed();
      const registered = await control(link, ACCOUNT_REGISTER, {}, ACCOUNT_REGISTERED);
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
    if (!(await replicaAdded(confirmations, mediationId, replicaId, replica.did))) {
      proceed();
      const added = await control(link, REPLICA_ADD, { grant: replica.grants[0] as string }, REPLICA_ADDED);
      if (!echoes(added, "replica_did", replica.did) || added.body["state"] !== "active") {
        throw new MediatorRefused("replica-added names another replica than the one asked for, or one that is not active");
      }
      await confirmations.set(replicaAddedKey(mediationId, replicaId), { replicaDid: replica.did });
      steps.push("replica-added");
    }
    await link.observe("diag", "enroll", { mediationId, replicaId, replicaDid: replica.did, steps });
    return { mediation, replica, steps };
  });
}

export function echoes(reply: IMessage, member: string, did: string): boolean {
  const echoed = reply.body[member];
  return typeof echoed === "string" && sameDid(echoed, did);
}

/** One control and its reply; a problem-report, or any other answer, is the mediator refusing. */
export async function control(link: MediatorLink, type: string, body: Record<string, unknown>, expected: string): Promise<IMessage> {
  const reply = await link.roundTrip(type, body);
  if (reply.type === expected) return reply;
  const name = type.slice(type.lastIndexOf("/") + 1);
  if (reply.type !== PROBLEM_REPORT) throw new MediatorRefused(`expected ${expected.slice(expected.lastIndexOf("/") + 1)} to ${name}, got ${reply.type}`);
  const { code, comment } = reply.body as { code?: unknown; comment?: unknown };
  throw new MediatorRefused(`${name} was refused: ${typeof code === "string" ? code : "no code"}${typeof comment === "string" ? ` (${comment})` : ""}`);
}
