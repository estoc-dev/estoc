/**
 * Where a built-in reply to an input goes, where a rotation decision's
 * notification goes, and the tuple either is recorded under: pure
 * decisions over the fold that every path building such an outbound
 * takes before it commits — the manual completion, the rotation, the
 * listing of what is still owed.
 */

import { channelPolicy, senderGate } from "./channel-policy.js";
import type { Decision, Source } from "./fold/channels.js";
import { kindOf, type Execution } from "./fold/inbound.js";
import type { Outbound } from "./fold/outbound.js";
import type { VaultFold } from "./fold/vault.js";
import { automaticMessageId, channelOf, effectKey, sameChannel } from "./ids.js";
import type { Channel, EffectKey, EventCid, ExecutionId, MessageId } from "./types.js";

/** An operation's tuple over an input, the message ID it names and the intent already recorded under it, if any. */
export interface AutomaticIntent {
  readonly executionId: ExecutionId;
  readonly effectType: string;
  readonly effectKey: EffectKey;
  readonly messageId: MessageId;
  readonly existing: Outbound | null;
}

export function automaticIntent(fold: VaultFold, execution: Execution, effectType: string): AutomaticIntent {
  const key = effectKey(execution.id, effectType);
  const messageId = automaticMessageId(key);
  return { executionId: execution.id, effectType, effectKey: key, messageId, existing: fold.outbound.outbounds.get(messageId) ?? null };
}

/**
 * Where a built-in reply to an input goes: the carrier's own channel
 * while its local DID may still send there, otherwise the unique
 * verified local-only successor head that keeps the carrier's peer,
 * when that may send. A denied channel, one in conflict, or one whose
 * peer has replaced its DID takes no reply and hands it to no
 * successor; an input that is not established, or whose intents
 * disagree, earns none.
 */
export type ResponseChannel = { status: "selected"; channel: Channel } | { status: "none"; because: string };

export function responseChannel(fold: VaultFold, execution: Execution): ResponseChannel {
  const none = (because: string): ResponseChannel => ({ status: "none", because });
  if (execution.status.status !== "complete") return none(`the input is not established: ${execution.status.because}`);
  const denied = channelPolicy(fold, execution.channel);
  if (denied !== null) return none(denied);
  const own = senderGate(fold, execution.channel);
  if (own.status === "open") return { status: "selected", channel: execution.channel };
  const head = fold.continuity.head(execution.channel);
  if (head === null || sameChannel(head, execution.channel) || head.peerDid !== execution.channel.peerDid) return none(`${own.because}, and no verified local successor keeping the peer is unique`);
  const successor = senderGate(fold, head);
  return successor.status === "open" ? { status: "selected", channel: head } : none(`${own.because}, and its successor cannot reply: ${successor.because}`);
}

/**
 * Where a decision's notification goes, once continuity has verified
 * the decision: from the successor to the decision's peer, when the
 * successor may send there. With a source, the source must still be an
 * admitted complete witness of an established application input, since
 * a control input triggers none, and its channel must not be denied, in
 * conflict, or left by the peer. A source-free decision is held only
 * to the successor's channel. Whether an intent already names the
 * decision is the outbound fold's answer, not this one's.
 */
export type NotificationChannel = { status: "selected"; channel: Channel; source: Source | null } | { status: "none"; because: string };

export function notificationChannel(fold: VaultFold, decision: Decision): NotificationChannel {
  const none = (because: string): NotificationChannel => ({ status: "none", because });
  if (decision.channel === null) return none("the decision's predecessor is not known here");
  const continuity = fold.continuity.status(decision.event.cid);
  if (continuity.status !== "verified") return none(`the rotation is not verified: ${continuity.status}${"because" in continuity ? `, ${continuity.because}` : ""}`);
  const successor = fold.dids.entities.get(decision.event.data.toDidId)?.created?.did;
  if (successor === undefined) return none("the successor has no consistent creation here");
  const channel = channelOf(successor, decision.channel.peerDid);
  const gate = senderGate(fold, channel);
  if (gate.status === "closed") return none(`the successor cannot send to the peer: ${gate.because}`);
  const { sourceEventCid } = decision.event.data;
  if (sourceEventCid === null) return { status: "selected", channel, source: null };
  const source = fold.channels.sources.get(sourceEventCid as EventCid) ?? null;
  if (source === null) return none("the source is not here");
  const witness = fold.continuity.witness(source.event.cid);
  if (witness.status !== "complete") return none(`the source is no complete witness: ${witness.because}`);
  if (!fold.admissions.admitted(source.event.cid)) return none(`the source is not admitted: ${dispositionReason(fold, source.event.cid)}`);
  const execution = fold.inbound.ofSource(source.event.cid);
  if (execution === null) return none("the source is in no input here");
  if (execution.status.status !== "complete") return none(`the source's input is not established: ${execution.status.because}`);
  if (kindOf(source.event.data) !== "application") return none(`a control input triggers no notification: the source is ${kindOf(source.event.data)}`);
  const denied = channelPolicy(fold, decision.channel);
  return denied === null ? { status: "selected", channel, source } : none(denied);
}

function dispositionReason(fold: VaultFold, sourceEventCid: EventCid): string {
  const disposition = fold.dispositions.disposition(sourceEventCid);
  return "because" in disposition ? disposition.because : disposition.status;
}
