/**
 * What an open lists for manual action, and dispatches nothing of:
 * the outbounds not yet submitted or terminated, each with the work
 * it still needs; the replies established inputs may still be given;
 * the notifications verified decisions still permit; the decisions
 * whose notification intents disagree, listed as a diagnostic, since
 * no retry may select among them; the proofs that wait for issuer
 * material a repair or an import may bring.
 */

import type { Carrier, Decision, Source } from "./fold/channels.js";
import type { Execution } from "./fold/inbound.js";
import { PING_RESPONSE_EFFECT, PING_TYPE, PURE_ACK_EFFECT, type Notification, type Outbound } from "./fold/outbound.js";
import type { VaultFold } from "./fold/vault.js";
import { automaticIntent, notificationChannel, responseChannel } from "./response-policy.js";
import type { Channel } from "./types.js";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A reply an established input may still be given and no intent
 * records: a candidate for manual completion, listed with the channel
 * the completion would fix it to. Whether it is given is the
 * completion's call, under current policy and what the body says.
 */
export interface MissingResponse {
  readonly execution: Execution;
  readonly effectType: string;
  readonly channel: Channel;
  /** the complete witness whose fields the reply is built from */
  readonly source: Source;
}

/** A verified rotation record with no notification intent yet, while its source, when it has one, still permits one. Each record has its own notification, whatever intent it shares with others. */
export interface MissingNotification {
  readonly decision: Decision;
  /** from the successor to the decision's peer */
  readonly channel: Channel;
  readonly source: Source | null;
}

export interface NotificationConflict {
  readonly decision: Decision;
  readonly notification: Extract<Notification, { status: "conflict" }>;
}

export interface PendingWork {
  readonly outbounds: readonly Outbound[];
  readonly responses: readonly MissingResponse[];
  readonly notifications: readonly MissingNotification[];
  readonly notificationConflicts: readonly NotificationConflict[];
  readonly proofs: readonly Carrier[];
}

export function unfinishedWork(fold: VaultFold): PendingWork {
  const { notifications, conflicts } = missingNotifications(fold);
  return {
    outbounds: [...fold.outbound.outbounds.values()].filter((o) => (o.outcome.status === "queued" || o.outcome.status === "prepared") && !o.erased).sort((a, b) => cmp(a.messageId, b.messageId)),
    responses: missingResponses(fold),
    notifications,
    notificationConflicts: conflicts,
    proofs: [...fold.channels.carriers.values()].filter((carrier) => carrier.proof.status === "pending-proof"),
  };
}

/**
 * A pure ACK is a candidate for every established input requesting its
 * own receipt, whatever the input's kind, an erased body included: the
 * request is in the headers, and honoring it is policy the completion
 * applies. A Ping reply is a candidate for an established, unerased
 * Ping; whether it asked for a response, and whether it has expired,
 * is in its body and its timing, which the completion reads.
 */
function missingResponses(fold: VaultFold): MissingResponse[] {
  const missing: MissingResponse[] = [];
  const executions = [...fold.inbound.executions.values()].sort((a, b) => cmp(a.messageId, b.messageId));
  for (const execution of executions) {
    if (execution.firstWitness === null) continue;
    const { source } = execution.firstWitness;
    const candidates: string[] = [];
    if (fold.outbound.ackTarget(source.event.cid).status === "eligible") candidates.push(PURE_ACK_EFFECT);
    if (source.event.data.msgType === PING_TYPE && !execution.erased) candidates.push(PING_RESPONSE_EFFECT);
    if (candidates.length === 0) continue;
    const channel = responseChannel(fold, execution);
    if (channel.status === "none") continue;
    for (const effectType of candidates) {
      if (automaticIntent(fold, execution, effectType).existing !== null) continue;
      missing.push({ execution, effectType, channel: channel.channel, source });
    }
  }
  return missing;
}

/** A verified decision no intent names yet, while its channel still takes the notification; several intents naming one decision are its conflict. */
function missingNotifications(fold: VaultFold): { notifications: MissingNotification[]; conflicts: NotificationConflict[] } {
  const notifications: MissingNotification[] = [];
  const conflicts: NotificationConflict[] = [];
  for (const decision of fold.channels.decisions.values()) {
    const notification = fold.outbound.notificationFor(decision.event.cid);
    if (notification.status === "conflict") conflicts.push({ decision, notification });
    if (notification.status !== "none") continue;
    const selected = notificationChannel(fold, decision);
    if (selected.status === "selected") notifications.push({ decision, channel: selected.channel, source: selected.source });
  }
  return { notifications, conflicts };
}
