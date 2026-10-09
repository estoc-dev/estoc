/**
 * What an open lists for manual action, and dispatches nothing of:
 * the outbounds not yet submitted or terminated, each with the work
 * it still needs; the replies established inputs may still be given;
 * the rotations the private-address policy would make from a disclosed
 * entry, with what each waits for or is stopped by, until a decision is
 * recorded; the notifications verified decisions still permit; the
 * decisions whose notification intents disagree, listed as a
 * diagnostic, since no retry may select among them; the proofs that
 * wait for issuer material a repair or an import may bring.
 */

import { canonicalText, compareEvents } from "@estoc/event-store";

import { channelPolicy } from "./channel-policy.js";
import type { Carrier, Decision, PlacedSource, Source } from "./fold/channels.js";
import { kindOf, type Execution } from "./fold/inbound.js";
import { PING_RESPONSE_EFFECT, PING_TYPE, PURE_ACK_EFFECT, type Notification, type Outbound } from "./fold/outbound.js";
import type { VaultFold } from "./fold/vault.js";
import { channelKey } from "./ids.js";
import { automaticIntent, notificationChannel, responseChannel } from "./response-policy.js";
import { decisionFor } from "./rotation-policy.js";
import { successorRecipe, type SuccessorChoice } from "./succession.js";
import type { Channel } from "./types.js";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A reply an established input may still be given, which no intent and
 * no skip records: a candidate for manual completion, listed with the channel
 * the completion would fix it to. Whether it is given is the
 * completion's call, under current policy and what the body says.
 */
export interface MissingResponse {
  readonly execution: Execution;
  readonly effectType: string;
  readonly channel: Channel;
  /** the complete witness whose fields the reply is built from */
  readonly source: PlacedSource;
}

/** A verified rotation record with no notification intent yet, while its source, when it has one, still permits one. Each record has its own notification, whatever intent it shares with others. */
export interface MissingNotification {
  readonly decision: Decision;
  /** from the successor to the decision's peer */
  readonly channel: Channel;
  readonly source: Source | null;
}

/**
 * A rotation away from a disclosed entry that established application
 * inputs call for and no decision records yet: one per rotation
 * intent, the local DID toward the peer anywhere in its verified
 * same-local context, with every input supporting it. Ready names the
 * successor the inputs would select; waiting and blocked say what keeps
 * it from being made. Listing one takes no action: a rotation made by
 * hand reads the fold again under the lock, and the policy acts on a
 * live input alone.
 */
export interface RotationCandidate {
  /** the pair of the context the rotation would be made from, canonical: the one current policy still rotates */
  readonly channel: Channel;
  /** the established application inputs at the entry in this context, in canonical event order */
  readonly sources: readonly PlacedSource[];
  readonly choice: SuccessorChoice;
}

export interface NotificationConflict {
  readonly decision: Decision;
  readonly notification: Extract<Notification, { status: "conflict" }>;
}

export interface PendingWork {
  readonly outbounds: readonly Outbound[];
  readonly responses: readonly MissingResponse[];
  readonly rotationCandidates: readonly RotationCandidate[];
  readonly notifications: readonly MissingNotification[];
  readonly notificationConflicts: readonly NotificationConflict[];
  readonly proofs: readonly Carrier[];
}

export function unfinishedWork(fold: VaultFold): PendingWork {
  const { notifications, conflicts } = missingNotifications(fold);
  return {
    outbounds: [...fold.outbound.outbounds.values()].filter((o) => (o.outcome.status === "queued" || o.outcome.status === "prepared") && !o.erased).sort((a, b) => cmp(a.messageId, b.messageId)),
    responses: missingResponses(fold),
    rotationCandidates: rotationCandidates(fold),
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
    if (execution.status !== "complete") continue;
    const { source } = execution.firstWitness;
    const candidates: string[] = [];
    if (fold.outbound.ackTarget(source.event.cid).status === "eligible") candidates.push(PURE_ACK_EFFECT);
    if (source.event.data.msgType === PING_TYPE && !execution.erased) candidates.push(PING_RESPONSE_EFFECT);
    if (candidates.length === 0) continue;
    const channel = responseChannel(fold, execution);
    if (channel.status === "none") continue;
    for (const effectType of candidates) {
      if (automaticIntent(fold, execution, effectType).result.status !== "pending") continue;
      missing.push({ execution, effectType, channel: channel.channel, source });
    }
  }
  return missing;
}

/** An input the policy reads as selecting a rotation: a complete, admitted, established application input at a disclosed entry of ours. */
function selectingInput(fold: VaultFold, execution: Execution): PlacedSource | null {
  if (execution.status !== "complete") return null;
  const { source } = execution.firstWitness;
  if (!fold.admissions.admitted(source.event.cid) || kindOf(source.event.data) !== "application") return null;
  const entity = fold.dids.entities.get(source.localDidId);
  if (entity === undefined || entity.disclosures.length === 0 || fold.dids.lineage(entity.didId).status !== "entry") return null;
  return source;
}

/**
 * The selecting inputs grouped by the intent they call for, a
 * recorded candidate decision taking the group over to its
 * notification; a decision still waiting or in conflict, a denied or
 * superseded pair and whatever the successor's recipe waits for or is
 * stopped by are the group's reason.
 */
function rotationCandidates(fold: VaultFold): RotationCandidate[] {
  const groups = new Map<string, PlacedSource[]>();
  const inputs = [...fold.inbound.executions.values()].flatMap((execution) => selectingInput(fold, execution) ?? []).sort((a, b) => compareEvents(a.event, b.event));
  for (const source of inputs) {
    const { channel } = source;
    const key = canonicalText([channel.localDid, channelKey(fold.continuity.sameLocal(channel)[0]!)]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [source]);
    else group.push(source);
  }
  const candidates: RotationCandidate[] = [];
  for (const sources of groups.values()) {
    const channel = rotatingPair(fold, sources);
    const decision = decisionFor(fold, channel.localDid, channel.peerDid);
    if (decision.status === "candidate") continue;
    const blocked = (because: string): SuccessorChoice => ({ status: "blocked", because });
    const denied = channelPolicy(fold, channel);
    const choice = decision.status !== "none" ? blocked(decision.because) : denied !== null ? blocked(denied) : successorRecipe(fold, channel);
    candidates.push({ channel, sources, choice });
  }
  return candidates.sort((a, b) => cmp(channelKey(a.channel), channelKey(b.channel)));
}

/**
 * The pair of a context a rotation would be made from: the one current
 * policy holds nothing against, since the peer's verified replacements
 * leave one address current whatever the clocks of the inputs say;
 * else the one whose peer is not replaced, so that the reason shown is
 * the current address's own; else the first in canonical order.
 */
function rotatingPair(fold: VaultFold, sources: readonly PlacedSource[]): Channel {
  const pairs = [...new Map(sources.map(({ channel }) => [channelKey(channel), channel])).values()].sort((a, b) => cmp(channelKey(a), channelKey(b)));
  return pairs.find((pair) => channelPolicy(fold, pair) === null) ?? pairs.find((pair) => !fold.continuity.superseded(pair)) ?? pairs[0]!;
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
