/**
 * What only the running agent knows and the vault does not record:
 * its lines to mediators, the deliveries it holds for a retry and
 * what it discarded. A complete replacement each time; not history.
 */

import type { Epoch, MediationId, Revision } from "./ids.js";

/** What one reconciliation of a mediator's registrations found; nothing here says whether the mediator acted on it. */
export interface ReconciliationRecord {
  /** the live DIDs on the arrangement's mediated routes: what the mediator is to hold */
  desired: string[];
  /** what the mediator held before this run */
  held: string[];
  added: string[];
  removed: string[];
  /** what the mediator would not add or remove; a desired DID among them is not registered */
  refused: string[];
  /** what the mediator held that no DID this vault ever created accounts for: asked to be removed */
  unknown: string[];
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
  reconciled: ReconciliationRecord | null;
  /** registrations a reconciliation found that no DID of the vault accounts for, a bounded first few */
  unknownRegistrations: string[];
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
