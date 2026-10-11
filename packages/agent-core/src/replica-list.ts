/**
 * The replicas an arrangement's account ever added, as its mediator
 * lists them. The mediator is the authority on which replicas the
 * account holds and whether each is still enrolled; the seed is the
 * authority on who each one is. Every grant listed is checked against
 * the seed and the arrangement's creation, and a replica whose grant
 * does not stand is left out, so that a mediator can say a replica was
 * removed but cannot make one up. Nothing is written, to the vault or
 * beside it: whether the list is kept, and where, is the host's.
 */

import { isJsonObject, type VaultRuntime } from "@estoc/event-store";
import { IdentityMismatch, InvalidDidDocument, InvalidReplicaGrant, sameDid, scanVault, verifyReplicaGrant, type Did, type Keys, type MediationId } from "@estoc/vault";

import { MediatorRefused, Unusable } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { toward } from "./mediation.js";
import type { IMessage } from "./protocol/didcomm.js";
import { INVALID_MESSAGE, REPLICA_LIST, REPLICAS } from "./protocol/replica-mediation.js";
import type { ReplicaAddress } from "./replica-channel.js";
import { accountOf, control } from "./replica-enrollment.js";

/** A replica the account added, as the mediator lists it, under the grant the seed bears out. */
export interface ListedReplica extends ReplicaAddress {
  /** the replica's DID, in its short form */
  did: Did;
  state: "active" | "removed";
  /** when the mediator added it, in seconds since the epoch by the mediator's clock */
  addedTime: number;
  /** when the mediator removed it; null while it is active */
  removedTime: number | null;
  /** whether it is this runtime's own replica */
  self: boolean;
}

type Entry = Pick<ListedReplica, "state" | "addedTime" | "removedTime"> & { grant: string };

/** The page a listing asks for first: the most a mediator takes unless it is configured otherwise. */
const PAGE = 16;

/**
 * Every replica the account of the arrangement ever added, in the
 * order the mediator added them, each under the grant it was added
 * with: those whose grant the seed and the arrangement's creation bear
 * out, with `self` set on this runtime's own. A grant that does not
 * stand is left out and its reason traced. Needs the arrangement
 * created toward the link's mediator, neither retired nor in conflict,
 * and its account registered. Throws `MediatorRefused` when the
 * mediator refuses the listing or answers with no listing.
 */
export async function listReplicas(link: MediatorLink, runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<ListedReplica[]> {
  const mediation = accountOf(await scanVault(runtime.vault, keys), mediationId);
  toward(link, mediation);
  if (mediation.routingDid === null) throw new Unusable("mediation", mediationId, ["its account is not registered"]);
  const listed: ListedReplica[] = [];
  const refused: string[] = [];
  for (const entry of await listing(link)) {
    try {
      const grant = await verifyReplicaGrant(keys, entry.grant, mediation.me.did);
      if (grant.mediationId !== mediationId || !sameDid(grant.mediator, mediation.mediatorDid)) throw new IdentityMismatch(`the grant binds its replica to mediation ${grant.mediationId} at ${grant.mediator}`);
      const { state, addedTime, removedTime } = entry;
      listed.push({ replicaId: grant.replicaId, did: grant.replicaDid, longFormDid: grant.replicaLongForm, state, addedTime, removedTime, self: grant.replicaId === runtime.author });
    } catch (err) {
      if (!(err instanceof InvalidReplicaGrant || err instanceof IdentityMismatch || err instanceof InvalidDidDocument)) throw err;
      refused.push(err.message);
    }
  }
  await link.observe("diag", "replica-list", { mediationId, listed: listed.map(({ did }) => did), refused });
  return listed;
}

/**
 * Every entry of one listing, from its first page to its last, each
 * once. A page is `PAGE` entries, or one once the first page is
 * refused: a mediator refuses a page larger than it takes, and says how
 * large only in answer to the account's registration. A listing whose
 * cursor is refused begins again, once.
 */
async function listing(link: MediatorLink): Promise<Entry[]> {
  let limit = PAGE;
  let begunAgain = false;
  for (;;) {
    const entries = new Map<string, Entry>();
    let cursor: string | null = null;
    try {
      do {
        const page = pageOf(await control(link, REPLICA_LIST, { cursor, limit }, REPLICAS));
        const before = entries.size;
        for (const entry of page.entries) if (!entries.has(entry.grant)) entries.set(entry.grant, entry);
        // a mediator that goes on without listing a replica it has not listed would be asked for pages forever
        if (page.next !== null && entries.size === before) throw new MediatorRefused("replicas goes on to another page without listing a replica not listed before");
        cursor = page.next;
      } while (cursor !== null);
      return [...entries.values()];
    } catch (err) {
      if (!(err instanceof MediatorRefused && err.code === INVALID_MESSAGE)) throw err;
      if (cursor === null && limit > 1) limit = 1;
      else if (cursor !== null && !begunAgain) begunAgain = true;
      else throw err;
    }
  }
}

function pageOf(reply: IMessage): { entries: Entry[]; next: string | null } {
  const { entries, next_cursor: next } = reply.body as { entries?: unknown; next_cursor?: unknown };
  if (!Array.isArray(entries) || !(next === null || typeof next === "string")) throw new MediatorRefused("replicas is not a page of entries and the cursor of the next");
  return { entries: entries.map(entryOf), next };
}

function entryOf(entry: unknown): Entry {
  const { grant, state, added_time: addedTime, removed_time: removedTime } = isJsonObject(entry) ? entry : {};
  const removed = state === "removed";
  if (typeof grant !== "string" || !(state === "active" || removed) || !Number.isSafeInteger(addedTime) || (removed ? !Number.isSafeInteger(removedTime) : removedTime !== null)) {
    throw new MediatorRefused("a replicas entry is not a grant, a state and the times that state has");
  }
  return { grant, state, addedTime: addedTime as number, removedTime: removedTime as number | null };
}
