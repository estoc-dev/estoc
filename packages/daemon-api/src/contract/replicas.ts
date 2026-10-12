/**
 * The replicas of a vault at its arrangement's mediator, and the history
 * they send one another. Which replicas there are is the mediator's
 * word, each one borne out by the seed: the daemon asks it when its
 * replica connects, before it sends history and when asked to, and
 * shows the last answer, with when it came, while the mediator is out of
 * reach. History goes as a link to a snapshot of the whole vault, put at
 * the mediator and mailed through it to the other replica, which
 * imports the snapshot as the link arrives.
 */

import type { DisplayTime, ReplicaId } from "./ids.js";
import type { MergeResult } from "./methods.js";

/** The last history this daemon sent a replica: when, and why it did not go when it did not. */
export type HistorySent = { at: DisplayTime; outcome: "sent" } | { at: DisplayTime; outcome: "failed"; because: string };

/** A replica the arrangement's account added, as its mediator listed it. */
export interface ReplicaRecord {
  replicaId: ReplicaId;
  /** its DID at the mediator, in the short form */
  did: string;
  /** whether it is this daemon's own */
  self: boolean;
  /** `removed` once the mediator holds it no more: it takes no mail then, and no history is sent to it */
  state: "active" | "removed";
  /** by the mediator's clock; null where the time it gave is none a `DisplayTime` spells */
  addedAt: DisplayTime | null;
  /** null while the mediator holds it, or where the time it gave is none a `DisplayTime` spells */
  removedAt: DisplayTime | null;
  /** null while this daemon has sent it none */
  sent: HistorySent | null;
}

/** The mediator's last answer on which replicas the account holds, in the order it added them. */
export interface ReplicaListing {
  listedAt: DisplayTime;
  replicas: ReplicaRecord[];
}

/** The last history another replica sent this daemon's: from which, when it came, and how its import went or is going; one the daemon stopped in the middle of is shown as failed. */
export type HistoryReceived = { from: ReplicaId; at: DisplayTime } & ({ status: "importing" } | { status: "imported"; merged: MergeResult } | { status: "failed"; because: string });
