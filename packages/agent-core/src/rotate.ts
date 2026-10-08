/**
 * A local rotation: one of our DIDs replaced toward one peer by a
 * successor, decided under the writer lock and frozen as one record —
 * the predecessor, the canonical peer, the successor, the input that
 * selected it or none, and the proof the predecessor's authentication
 * key signs — committed atomically with the successor's creation, so
 * that a crash leaves both or neither and never a DID allocated for
 * nothing. A pair has one rotation intent in its context, which
 * several records may support when two replicas decide the same
 * rotation apart or one decides it again over a restored snapshot: the
 * intent already recorded from the predecessor anywhere in its
 * verified peer-only context is reused under its first candidate
 * record, and no second successor is minted while a record waits for
 * evidence or two intents contradict each other. An admitted receipt must
 * show the peer writing to exactly the predecessor address, since a
 * link from an address the peer never used confirms nothing, and an
 * observation the runtime has not accepted for application use
 * decides nothing new. The successor is the one the fold's recipe
 * names, a start of an entry bound to the peer's start or a next of a
 * branch address, on the predecessor's own route, so that every
 * replica deciding the rotation arrives at one entity; the rotation
 * waits where the recipe waits for evidence, and is made by a runtime
 * that can pick the successor up. The decision is folded with the
 * evidence here before it is written, and refused when that fold puts
 * it or its context in conflict: the continuity graph keeps every
 * branch and chooses no winner, so a cycle the producer could see
 * coming would leave the whole context without authority for good.
 * The notification announcing the rotation is the decision's own
 * operation, called under an initial action once the lock is released.
 * A manual rotation makes it right after the decision commits, under
 * the same lock. One a live input selected is made under a later lock,
 * once the input is known to be this runtime's to answer, while the
 * decision itself is committed at once: each replica the input came to
 * holds the successor before it opens mail the peer writes there, and
 * only the replica answering the input announces it. A decision found
 * already recorded makes none: its missing notification, left by a
 * crash between the two commits or by a replica that answered nothing,
 * is manual work, made only by an explicit completion while the input
 * that selected it still permits one.
 */

import { v7 as uuidv7 } from "uuid";

import { eventCidOf, type Event, type EventEnvelope, type Held, type VaultRuntime } from "@estoc/event-store";
import {
  EMPTY_MESSAGE_TYPE,
  ROTATION_NOTIFICATION_EFFECT,
  VaultEventSet,
  automaticIntent,
  canonicalDidOf,
  channelKey,
  channelOf,
  channelPolicy,
  checkVault,
  decisionFor,
  foldVault,
  kindOf,
  notificationChannel,
  objectReader,
  readVaultEvent,
  replyThread,
  sameChannel,
  scanVault,
  signFromPrior,
  successorRecipe,
  vaultDraft,
  type Channel,
  type ScopedConflict,
  type Did,
  type DidId,
  type EventCid,
  type EventReference,
  type ExecutionId,
  type Keys,
  type MessageId,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import { LiveAction, initialAction, type Responding } from "./action.js";
import { didOf } from "./dids.js";
import type { Dispatched } from "./dispatch.js";
import { dispatched, refused, resultOutcome, type Drafted, type EffectOutcome } from "./effects.js";
import { NotificationConflict, UnknownEntity, Unusable } from "./errors.js";
import { automaticDraft, manualNotificationDraft, type EffectContent } from "./send.js";
import { materializeSuccessor } from "./successor.js";
import type { AgentTrace } from "./trace.js";

/** The pair to rotate away from: one of our DID entities and the peer, in any spelling; and the live application input that selected the rotation, none for a manual one. */
export interface RotationTarget {
  localDidId: DidId;
  peerDid: string;
  sourceEventCid?: EventReference<"message.in"> | null;
}

export interface RotateOptions {
  /** the clock the proof's issue time is read from, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
  /** a notification that could not be recorded or called goes to the `diag` stream */
  trace?: AgentTrace;
  /** the one transport call of the notification under its action: the dispatcher's */
  dispatch: (action: LiveAction) => Promise<Dispatched>;
}

export interface Rotated {
  /** the first candidate record of the intent, in canonical event order */
  decision: VaultEvent<"did.rotationSelected">;
  /** every record supporting the intent, in canonical event order, `decision` among them */
  records: readonly VaultEvent<"did.rotationSelected">[];
  /** the pair rotated away from, canonical */
  channel: Channel;
  successor: DidId;
  /** the intent was recorded already: reused as it is, no successor made, and its notification left to a completion */
  existed: boolean;
  notification: EffectOutcome;
}

/** A decision already recorded is returned with the state of its notification, nothing written or called. */
export async function rotate(runtime: VaultRuntime, keys: Keys, target: RotationTarget, options: RotateOptions): Promise<Rotated> {
  return callRotation(await decideRotation(runtime, keys, target, options), options);
}

/** A rotation's decision as the lock recorded or found it, its notification not yet made. */
export interface RotationSelected {
  channel: Channel;
  decision: VaultEvent<"did.rotationSelected">;
  records: readonly VaultEvent<"did.rotationSelected">[];
  existed: boolean;
}

/** A rotation as the lock decided it: the decision, and its notification drafted with the action minted for it, before the call. */
export interface RotationDecided extends RotationSelected {
  drafted: Drafted;
  executionId: ExecutionId | null;
}

/** The decision of `rotate` alone, under the lock: what a caller records before it makes the call. */
export async function decideRotation(runtime: VaultRuntime, keys: Keys, target: RotationTarget, options: Omit<RotateOptions, "dispatch">): Promise<RotationDecided> {
  return runtime.locked(async (held) => {
    const { fold, selected } = await select(held, runtime, keys, target, options);
    if (selected.existed) return { ...selected, drafted: recorded(fold, selected.decision.cid), executionId: null };
    return { ...selected, ...(await notification(held, keys, selected.decision, options)) };
  });
}

/** The decision alone, under the lock, its notification left to `notifyRotation`: what a live input selects before who answers it is known. */
export async function selectRotation(runtime: VaultRuntime, keys: Keys, target: RotationTarget, options: Omit<RotateOptions, "dispatch">): Promise<RotationSelected> {
  return runtime.locked(async (held) => (await select(held, runtime, keys, target, options)).selected);
}

/**
 * The notification of a decision a live input selected, made under
 * the lock by the runtime answering that input: the decision must name
 * the input as its source.
 */
export async function notifyRotation(runtime: VaultRuntime, keys: Keys, selected: RotationSelected, answering: Responding, options: Omit<RotateOptions, "dispatch">): Promise<RotationDecided> {
  if (selected.decision.data.sourceEventCid !== answering.cid) throw new Unusable("rotation", selected.decision.cid, ["the input answered is not the one that selected the rotation"]);
  return runtime.locked(async (held) => ({ ...selected, ...(await notification(held, keys, selected.decision, options)) }));
}

/** The decision's notification, settled over the fold read now, a new intent with the initial action minted for it. */
async function notification(held: Held, keys: Keys, decision: VaultEvent<"did.rotationSelected">, options: Omit<RotateOptions, "dispatch">): Promise<Pick<RotationDecided, "drafted" | "executionId">> {
  const fold = await scanVault(held, keys);
  const settled = await settleNotification(held, fold, decision.cid as EventReference<"did.rotationSelected">, options.trace ?? null);
  return { drafted: settled.drafted.outcome === "created" ? { ...settled.drafted, action: initialAction(settled.drafted.messageId) } : settled.drafted, executionId: settled.executionId };
}

/** The decision under the lock held: the one recorded for the pair already, or made and committed now with its successor. */
async function select(held: Held, runtime: VaultRuntime, keys: Keys, target: RotationTarget, options: Omit<RotateOptions, "dispatch">): Promise<{ fold: VaultFold; selected: RotationSelected }> {
  const fold = await scanVault(held, keys);
  const predecessor = didOf(fold, target.localDidId);
  if (predecessor.created === null || predecessor.conflict) throw new Unusable("DID", predecessor.didId, predecessor.faults);
  const peerDid = canonicalDidOf(target.peerDid) as Did;
  if (peerDid === predecessor.created.did) throw new Unusable("DID", predecessor.didId, ["the peer is the local DID itself"]);
  const channel = channelOf(predecessor.created.did, peerDid);
  const key = channelKey(channel);
  const sourceEventCid = target.sourceEventCid ?? null;
  const denied = channelPolicy(fold, channel);
  if (denied !== null) throw new Unusable("channel", key, [denied]);
  const existing = decisionFor(fold, channel.localDid, channel.peerDid);
  if (existing.status === "candidate") return { fold, selected: { channel, decision: existing.candidate.event, records: existing.group.records.map((record) => record.event), existed: true } };
  if (existing.status !== "none") throw new Unusable("channel", key, [existing.because]);
  if (sourceEventCid !== null) assertSelectingSource(fold, channel, sourceEventCid);
  if (fold.continuity.confirmedBy(channel.localDid, channel.peerDid) === null) throw new Unusable("channel", key, ["no admitted receipt shows the peer writing to exactly this address"]);
  const chosen = successorRecipe(fold, channel);
  if (chosen.status !== "ready") throw new Unusable("channel", key, [`the successor is not decided, ${chosen.status}: ${chosen.because}`]);

  const { drafts, successor } = await materializeSuccessor(fold, keys, runtime.author, predecessor, chosen.recipe);
  const iat = Math.floor((options.now ?? Date.now)() / 1000);
  const fromPrior = await signFromPrior(keys, { didId: predecessor.didId, longFormDid: predecessor.created.longFormDid }, successor.longFormDid, iat);
  drafts.push(vaultDraft("did.rotationSelected", { fromDidId: predecessor.didId, peerDid: channel.peerDid, toDidId: successor.didId, sourceEventCid, fromPrior }));
  const refusal = await rotationRefusal(held, runtime, keys, fold, drafts);
  if (refusal !== null) throw new Unusable("DID", successor.didId, [refusal]);
  const events = (await held.commit([], drafts)).map(readVaultEvent);
  const decision = events[events.length - 1] as VaultEvent<"did.rotationSelected">;
  return { fold, selected: { channel, decision, records: [decision], existed: false } };
}

/** The call of `rotate`: the notification decided, dispatched under the action minted for it. */
export async function callRotation(decided: RotationDecided, options: Pick<RotateOptions, "dispatch" | "trace">): Promise<Rotated> {
  const notification = await dispatched(decided.drafted, decided.executionId, options);
  return { decision: decided.decision, records: decided.records, channel: decided.channel, successor: decided.decision.data.toDidId, existed: decided.existed, notification };
}

/**
 * The explicit completion of a decision's notification: the one
 * missing after a crash, made under the same decision, source and
 * successor while its channel still takes it; or the one recorded,
 * called again. Either goes under a manual action. Several intents
 * naming the decision are its conflict, which no completion resolves.
 */
export async function completeNotification(runtime: VaultRuntime, keys: Keys, rotationEventCid: EventReference<"did.rotationSelected">, options: RotateOptions): Promise<EffectOutcome> {
  const decided = await runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const settled = await settleNotification(held, fold, rotationEventCid, options.trace ?? null);
    const { drafted } = settled;
    return { ...settled, drafted: drafted.outcome === "created" || drafted.outcome === "existing" ? { ...drafted, action: LiveAction.manual(drafted.messageId) } : drafted };
  });
  return dispatched(decided.drafted, decided.executionId, options);
}

/** What the fold would refuse the recorded decision for is refused here first, so that no decision is committed to be refused. */
function assertSelectingSource(fold: VaultFold, channel: Channel, sourceEventCid: EventReference<"message.in">): void {
  const source = fold.channels.sources.get(sourceEventCid as EventCid);
  if (source === undefined) throw new UnknownEntity("input", sourceEventCid);
  const faults: string[] = [];
  if (source.channel === null || !sameChannel(source.channel, channel)) faults.push(`not in channel ${channelKey(channel)}`);
  const witness = fold.continuity.witness(source.event.cid);
  if (witness.status !== "complete") faults.push(`no complete witness: ${witness.because}`);
  if (!fold.admissions.admitted(source.event.cid)) faults.push(`not admitted: ${fold.dispositions.disposition(source.event.cid).status}`);
  const execution = fold.inbound.ofSource(source.event.cid);
  if (execution === null) faults.push("in no input here");
  else if (execution.status !== "complete") faults.push(`its input is not established: ${execution.because}`);
  const kind = kindOf(source.event.data);
  if (kind !== "application") faults.push(`a control input selects no rotation: it is ${kind}`);
  if (faults.length > 0) throw new Unusable("input", sourceEventCid, faults);
}

/**
 * Why the fold would refuse the decision once the drafts, the
 * decision last, are committed with the evidence here, or null: a
 * join it implies may confirm a decision still waiting, and a channel
 * no conflict reached before may be reached now. The candidates exist
 * only in this set; nothing is appended here.
 */
async function rotationRefusal(held: Held, runtime: VaultRuntime, keys: Keys, fold: VaultFold, drafts: readonly VaultDraft[]): Promise<string | null> {
  const at = new Date().toISOString();
  const candidates: Event[] = drafts.map((draft) => {
    const envelope: EventEnvelope = { at, author: runtime.author, type: draft.type, roots: draft.roots ?? [], data: draft.data };
    return { ...envelope, cid: eventCidOf(envelope) };
  });
  const set = VaultEventSet.of([...fold.set.all(), ...candidates]);
  const next = foldVault(set, await checkVault(set, keys, objectReader(held.objects)));
  const decisionId = candidates[candidates.length - 1]!.cid;
  const decision = next.channels.decisions.get(decisionId)!;
  if (decision.status.status === "invalid" || decision.status.status === "conflict") return `the decision would be ${decision.status.status}: ${decision.status.because}`;
  const continuity = next.continuity.status(decisionId);
  if (continuity.status === "conflict") return `the decision would be in conflict: ${continuity.because}`;
  const before = conflictedChannels(fold.continuity.conflicts);
  for (const [key, kind] of conflictedChannels(next.continuity.conflicts)) if (!before.has(key)) return `the decision would put ${key} in conflict: ${kind}`;
  return null;
}

function conflictedChannels(conflicts: readonly ScopedConflict[]): Map<string, ScopedConflict["conflict"]["kind"]> {
  const reached = new Map<string, ScopedConflict["conflict"]["kind"]>();
  for (const { conflict, channels } of conflicts) for (const channel of channels) reached.set(channelKey(channel), conflict.kind);
  return reached;
}

/** The state of a record's notification, for a rotation that reuses the intent it supports: nothing is made or called for it here. */
function recorded(fold: VaultFold, rotationEventCid: EventCid): Drafted {
  const effectType = ROTATION_NOTIFICATION_EFFECT;
  const notification = fold.outbound.notificationFor(rotationEventCid);
  if (notification.status === "selected") return { effectType, outcome: "existing", messageId: notification.messageId };
  if (notification.status === "conflict") return { effectType, outcome: "none", because: `${notification.messageIds.length} notification intents name the rotation` };
  return { effectType, outcome: "none", because: "the rotation was recorded already: its missing notification is made by an explicit completion" };
}

/** The decision's one notification, reused as recorded or made now over the input that selected the decision, or over none under a fresh message ID. */
async function settleNotification(held: Held, fold: VaultFold, rotationEventCid: EventReference<"did.rotationSelected">, trace: AgentTrace | null): Promise<{ drafted: Drafted; executionId: ExecutionId | null }> {
  const effectType = ROTATION_NOTIFICATION_EFFECT;
  const decision = fold.channels.decisions.get(rotationEventCid as EventCid);
  if (decision === undefined) throw new UnknownEntity("rotation", rotationEventCid);
  const notification = fold.outbound.notificationFor(decision.event.cid);
  if (notification.status === "conflict") throw new NotificationConflict(rotationEventCid, notification.messageIds);
  const executionId = decision.event.data.sourceEventCid === null ? null : (fold.inbound.ofSource(decision.event.data.sourceEventCid as EventCid)?.id ?? null);
  if (notification.status === "selected") return { drafted: { effectType, outcome: "existing", messageId: notification.messageId }, executionId };
  const selected = notificationChannel(fold, decision);
  if (selected.status === "none") return { drafted: { effectType, outcome: "none", because: selected.because }, executionId };
  const { channel, source } = selected;
  const carried = source?.event.data ?? null;
  const content: EffectContent = { type: EMPTY_MESSAGE_TYPE, body: {}, thid: carried === null ? null : replyThread(carried), pthid: carried?.pthid ?? null, createdTime: carried?.createdTime ?? null, expiresTime: null, pleaseAck: [""], ack: [] };
  const execution = executionId === null ? null : fold.inbound.executions.get(executionId)!;
  const messageId = execution === null ? (uuidv7() as MessageId) : automaticIntent(fold, execution, effectType).messageId;
  try {
    let objects;
    let draft;
    if (source === null || execution === null) ({ draft, objects } = manualNotificationDraft(fold, messageId, channel, content, rotationEventCid));
    else {
      const automatic = automaticDraft(fold, { execution, source, effectType, channel, rotationEventCid }, content);
      if (automatic.draft === null) return { drafted: automatic.result.status === "produced" ? { effectType, outcome: "none", because: "the intent under the input's tuple names another rotation" } : resultOutcome(automatic), executionId };
      ({ draft, objects } = automatic);
    }
    const [event] = (await held.commit(objects, [draft])).map(readVaultEvent);
    return { drafted: { effectType, outcome: "created", messageId, intent: event as VaultEvent<"message.out"> }, executionId };
  } catch (err) {
    return { drafted: await refused(effectType, messageId, executionId, err, trace), executionId };
  }
}
