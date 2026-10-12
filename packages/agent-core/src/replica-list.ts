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

import { isJsonObject } from "@estoc/event-store";
import { IdentityMismatch, InvalidDidDocument, InvalidReplicaGrant, sameDid, verifyReplicaGrant, type Did } from "@estoc/vault";

import type { Account } from "./arrangement.js";
import { MediatorRefused } from "./errors.js";
import { control, type MediatorLink } from "./link.js";
import { registeredAccountOf } from "./mediation.js";
import type { IMessage } from "./protocol/didcomm.js";
import { INVALID_MESSAGE, REPLICA_LIST, REPLICAS } from "./protocol/replica-mediation.js";
import type { ReplicaAddress } from "./replica-channel.js";

/** Whether the account still holds the replica, and when the mediator removed one it no longer holds, in seconds since the epoch by the mediator's clock. */
type Standing = { state: "active"; removedTime: null } | { state: "removed"; removedTime: number };

/** A replica the account added, as the mediator lists it, under the grant the seed bears out. */
export type ListedReplica = ReplicaAddress &
  Standing & {
    /** the replica's DID, in its short form */
    did: Did;
    /** when the mediator added it, in seconds since the epoch by the mediator's clock */
    addedTime: number;
    /** whether it is this runtime's own replica */
    self: boolean;
  };

type Entry = Standing & { grant: string; addedTime: number };

/** The page a listing asks for first: the most a mediator takes unless it is configured otherwise. */
const PAGE = 16;

/**
 * Every replica the account ever added, in the order the mediator added
 * them, each under the grant it was added with: those whose grant the
 * seed and the arrangement's creation bear out, with `self` set on this
 * runtime's own. A grant that does not stand is left out and its reason
 * traced. Needs the arrangement neither retired nor in conflict, and its
 * account registered; the mediator is not reached otherwise. Throws
 * `MediatorRefused` when the mediator refuses the listing or answers
 * with no listing.
 */
export async function listReplicas(account: Account): Promise<ListedReplica[]> {
  const { session, mediationId } = account;
  const mediation = registeredAccountOf(await session.fold(), mediationId);
  // a grant has more than one encoding that verifies, so a replica is told apart by its DID and not by its grant's characters
  const listed = new Map<Did, ListedReplica>();
  const refused: string[] = [];
  for (const { grant: jws, ...entry } of await everyEntry(await account.link(mediation))) {
    try {
      const grant = await verifyReplicaGrant(session.keys, jws, mediation.me.did);
      if (grant.mediationId !== mediationId || !sameDid(grant.mediator, mediation.mediatorDid)) throw new IdentityMismatch(`the grant binds its replica to mediation ${grant.mediationId} at ${grant.mediator}`);
      if (!listed.has(grant.replicaDid)) listed.set(grant.replicaDid, { replicaId: grant.replicaId, did: grant.replicaDid, longFormDid: grant.replicaLongForm, ...entry, self: grant.replicaId === session.runtime.author });
    } catch (err) {
      if (!(err instanceof InvalidReplicaGrant || err instanceof IdentityMismatch || err instanceof InvalidDidDocument)) throw err;
      refused.push(err.message);
    }
  }
  const replicas = [...listed.values()];
  await account.observe("replica-list", { mediationId, listed: replicas.map(({ did }) => did), refused });
  return replicas;
}

/**
 * Every entry of one listing, from its first page to its last, each
 * once. A page is `PAGE` entries, or one once the first page is
 * refused: a mediator refuses a page larger than it takes, and says how
 * large only in answer to the account's registration. A listing whose
 * cursor is refused begins again, once.
 */
async function everyEntry(link: MediatorLink): Promise<Entry[]> {
  let limit = PAGE;
  let begunAgain = false;
  for (;;) {
    const listing = new Listing();
    try {
      do listing.take(pageOf(await control(link, REPLICA_LIST, { cursor: listing.cursor, limit }, REPLICAS)));
      while (listing.cursor !== null);
      return listing.entries();
    } catch (err) {
      if (!(err instanceof MediatorRefused && err.code === INVALID_MESSAGE)) throw err;
      if (listing.cursor === null && limit > 1) limit = 1;
      else if (listing.cursor !== null && !begunAgain) begunAgain = true;
      else throw err;
    }
  }
}

interface Page {
  entries: Entry[];
  next: string | null;
}

/**
 * One listing as far as it got: each entry once, and the cursor to ask
 * with next, null before the first page and after the last. A page
 * that goes on to a cursor the listing was given before, or that lists
 * no entry not listed before, is refused: a mediator could otherwise
 * have the listing ask for pages forever.
 */
class Listing {
  cursor: string | null = null;
  private readonly listed = new Map<string, Entry>();
  private readonly cursors = new Set<string>();

  take(page: Page): void {
    const before = this.listed.size;
    for (const entry of page.entries) if (!this.listed.has(entry.grant)) this.listed.set(entry.grant, entry);
    if (page.next !== null) {
      if (this.cursors.has(page.next)) throw new MediatorRefused("replicas goes on to a cursor it gave before");
      if (this.listed.size === before) throw new MediatorRefused("replicas goes on to another page without listing an entry not listed before");
      this.cursors.add(page.next);
    }
    this.cursor = page.next;
  }

  entries(): Entry[] {
    return [...this.listed.values()];
  }
}

function pageOf(reply: IMessage): Page {
  const { entries, next_cursor: next } = reply.body as { entries?: unknown; next_cursor?: unknown };
  if (!Array.isArray(entries) || !(next === null || typeof next === "string")) throw new MediatorRefused("replicas is not a page of entries and the cursor of the next");
  return { entries: entries.map(entryOf), next };
}

function entryOf(entry: unknown): Entry {
  const { grant, state, added_time: addedTime, removed_time: removedTime } = isJsonObject(entry) ? entry : {};
  const standing = standingOf(state, removedTime);
  if (typeof grant !== "string" || standing === null || !Number.isSafeInteger(addedTime)) throw new MediatorRefused("a replicas entry is not a grant, a state and the times that state has");
  return { grant, addedTime: addedTime as number, ...standing };
}

function standingOf(state: unknown, removedTime: unknown): Standing | null {
  if (state === "active" && removedTime === null) return { state, removedTime };
  if (state === "removed" && Number.isSafeInteger(removedTime)) return { state, removedTime: removedTime as number };
  return null;
}
