/**
 * What only the running agent knows and the vault does not record:
 * its lines to mediators, the deliveries it holds for a retry and
 * what it discarded. A complete replacement each time; not history.
 */

import type { Epoch, MediationId, Revision } from "./ids.js";

/** What the last connection had the account hold at its mediator. A DID among `refused` is not held, and is asked for again by the next connection. */
export interface RecipientsRecord {
  /** the DIDs the account is to hold, by short form */
  wanted: string[];
  /** those this connection asked for and the mediator confirmed */
  added: string[];
  /** those not added, and why */
  refused: { did: string; because: string }[];
}

export interface DrainRecord {
  /** deliveries acknowledged over every round */
  acked: number;
  /** `empty`: the queue is; `left`: a round acknowledged nothing, so what is queued waits; `rounds`: the round limit ran out with more queued */
  ended: "empty" | "left" | "rounds";
}

/** How the line to one arrangement's mediator stands. */
export interface ConnectionRecord {
  mediationId: MediationId;
  /** why the last connection stopped short; null when it ran through */
  unreachable: string | null;
  recipients: RecipientsRecord | null;
  drained: DrainRecord | null;
  /** whether the socket is open, or opening */
  live: boolean;
}

export type DeliverySource = { kind: "pickup"; mediationId: MediationId; deliveryId: string } | { kind: "direct" };

export interface WaitingDeliveryRecord {
  key: string;
  source: DeliverySource;
  reason: string;
  /** whether its bytes are held, so a retry needs no redelivery */
  held: boolean;
}

export interface DiscardRecord {
  source: DeliverySource;
  reason: string;
}

export interface Lines {
  connections: ConnectionRecord[];
  waiting: WaitingDeliveryRecord[];
  discarded: DiscardRecord[];
}

/** Lines count their own revisions from 1 in every state epoch; the three lists are empty in non-open phases. */
export interface LinesState {
  epoch: Epoch;
  revision: Revision;
  value: Lines;
}

/** A display line with the epoch it belongs to: no authority, no replay. */
export interface LogLine {
  epoch: Epoch;
  line: string;
}
