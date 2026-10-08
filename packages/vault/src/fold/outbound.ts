/**
 * The outbound messages: for each message ID, the one intent its
 * `message.out` records must agree on, every preparation of it, each
 * checked on its own against the intent and its own evidence, the
 * submissions that say a transport accepted one of them, the
 * termination that ended it unsent, and the peers' receipts that
 * acknowledge it; and for each automatic operation over an input, what
 * it came to. Records of one message agree when they name one intent
 * CID, sender, canonical recipient, effect tuple and rotation; each
 * names its own source, which is evidence, judged on its own. Each fact
 * is derived from its own evidence: under a consistent intent a
 * submission that is complete stays complete however many other
 * preparations or later lifecycle events are imported, and a
 * termination stands without any preparation. A preparation names
 * nothing the runtime must send: several valid ones are candidates, and
 * which envelope a runtime carries is its own local choice. An intent
 * derived from an inbound input is checked against that input's
 * execution and the producing operation's rules; what contradicts it
 * does so for good, what is missing leaves it pending. The fold says
 * what a message still needs — a preparation, or a transport call of
 * one of those it has — and never whether to make that call: dispatch
 * authority is the runtime's live action.
 */

import { InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { automaticMessageId, canonicalWireId, channelOf, effectKey, sameChannel, sameWireId } from "../ids.js";
import { compareEvents } from "@estoc/event-store";
import { canonicalDidOf } from "../peer-document.js";
import { SELF, intentOfOutbound, replyThread, requestsAck } from "../projection.js";
import { agreementKey } from "../public-key.js";
import type { VaultEvent } from "../schema.js";
import { senderGate } from "../channel-policy.js";
import type { Channel, Did, EffectKey, EventCid, EventReference, ExecutionId, MessageId, MessageOut, WireMessageId } from "../types.js";
import { keyAgreementTypeOf, type ChannelEvidence, type PlacedSource, type Source } from "./channels.js";
import type { Continuity } from "./continuity.js";
import type { EvidenceCheck } from "./evidence.js";
import type { Erasures } from "./held.js";
import { EMPTY_CONTENT_CID, EMPTY_MESSAGE_TYPE, PING_RESPONSE_TYPE, kindOf, type InboundFold } from "./inbound.js";
import type { LocalDidEntity, DidFold } from "./dids.js";
import { groupBy, type VaultEventSet } from "./set.js";

export const PURE_ACK_EFFECT = "https://estoc.dev/distributed-delivery/1.0#pure-ack";
export const PING_RESPONSE_EFFECT = PING_RESPONSE_TYPE;
export const ROTATION_NOTIFICATION_EFFECT = "https://estoc.dev/distributed-delivery/1.0#rotation-notification";
export const PING_TYPE = "https://didcomm.org/trust-ping/2.0/ping";

/** The operations whose output intents this fold can check field by field. */
export const BUILT_IN_EFFECTS: ReadonlySet<string> = new Set([PURE_ACK_EFFECT, PING_RESPONSE_EFFECT, ROTATION_NOTIFICATION_EFFECT]);

/** The first record in canonical order stands for the agreeing records: each reads to the same plaintext through its projection. */
export type IntentStatus = { status: "consistent"; data: MessageOut } | { status: "conflict"; because: string };

/**
 * A preparation on its own. Conflict is for good: it contradicts the
 * intent or its own evidence. Pending while the resolution it names,
 * or that resolution's document, is not here.
 */
export type PreparationStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/** One `message.prepared`, named by its event CID: an event of equal payload under another CID is another preparation. */
export interface Preparation {
  readonly event: VaultEvent<"message.prepared">;
  readonly status: PreparationStatus;
  /** an erasure of the message names the envelope: nothing to send */
  readonly erased: boolean;
}

export type SubmissionStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/**
 * A recorded acceptance of one preparation, found by the exact event
 * CID it names. A preparation not here leaves it unresolved; one here
 * completes it, or not, as that preparation stands.
 */
export interface Submission {
  readonly event: VaultEvent<"delivery.submitted">;
  /** the preparation it names, once that is here among the message's */
  readonly preparation: Preparation | null;
  readonly status: SubmissionStatus;
}

export type TerminationStatus = { status: "complete" } | { status: "invalid"; because: string };

export interface Termination {
  readonly event: VaultEvent<"delivery.failed">;
  readonly status: TerminationStatus;
}

/**
 * The receipt a carrier earns: its own canonical wire ID, or none. A
 * pure ACK acknowledges its carrier alone, so what it says never
 * depends on the order inputs were received in.
 */
export type AckTarget = { status: "eligible"; wireMessageId: WireMessageId } | { status: "none"; because: string };

/** An admitted complete witness in the outbound's channel, or a role-preserving successor of it, whose `ack` names the outbound. */
export interface AckWitness {
  readonly source: PlacedSource;
}

export type AcknowledgementStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/** A recorded `delivery.acknowledged`, checked against the one carrier it names. */
export interface Acknowledgement {
  readonly event: VaultEvent<"delivery.acknowledged">;
  readonly status: AcknowledgementStatus;
}

/**
 * What an intent derived from an input rests on: the input's
 * execution, each record's source witness, the operation's rules, the
 * output's channel. Complete for a locally initiated send that names
 * no rotation. Conflict is for good; pending waits for evidence that
 * may still arrive, or for an operation this vault does not know.
 */
export type EffectStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

/**
 * Conflict is the intent's, or its sender's, recipient's or derivation's,
 * and is for good. A preparation that contradicts the intent is that
 * preparation's own: the message stays prepared, waiting for another
 * preparation's arrival or its cancellation.
 */
export type Outcome = { status: "conflict"; because: string } | { status: "submitted" } | { status: "terminal"; code: "expired" | "cancelled" } | { status: "prepared" } | { status: "queued" };

/**
 * What the message still needs, whatever the wall clock says: a
 * preparation, or a transport call of one of its valid preparations,
 * the candidates in canonical order, among which the runtime carries
 * the one it selected. The runtime checks expiry, bytes and its own
 * dispatch authority before either.
 */
export type Work = { kind: "none"; because: string } | { kind: "prepare" } | { kind: "dispatch"; candidates: readonly Preparation[] };

export interface Outbound {
  readonly messageId: MessageId;
  readonly intents: readonly VaultEvent<"message.out">[];
  readonly intent: IntentStatus;
  /** the sender entity the consistent intent names, whatever its state; null while none is here */
  readonly sender: LocalDidEntity | null;
  /** the fixed pair, once the sender's creation reads */
  readonly channel: Channel | null;
  /** every preparation, one per event, in canonical order */
  readonly preparations: readonly Preparation[];
  readonly submissions: readonly Submission[];
  /** a complete submission names the consistent intent and a complete preparation: no other, competing or later evidence withdraws it */
  readonly submitted: boolean;
  readonly terminations: readonly Termination[];
  /** the first valid termination in canonical order */
  readonly terminal: Termination | null;
  readonly effect: EffectStatus;
  /** the admitted witnesses whose `ack` names the message, in canonical event order; none until a complete preparation is here to attribute the receipts to */
  readonly ackWitnesses: readonly AckWitness[];
  readonly acknowledgements: readonly Acknowledgement[];
  readonly acknowledged: boolean;
  /** acknowledged, with an expiry, and the earliest witness observed at or after it */
  readonly late: boolean;
  /** an erasure names the message */
  readonly erased: boolean;
  readonly outcome: Outcome;
  readonly work: Work;
  /** every envelope the preparations name is released: submitted or terminal under a consistent intent */
  readonly released: boolean;
}

/** One `effect.skipped`, its source checked as an automatic intent's is. */
export interface Skip {
  readonly event: VaultEvent<"effect.skipped">;
  readonly status: EffectStatus;
}

/**
 * What one automatic operation came to over one input. Produced: an
 * intent is recorded under the tuple, whatever its own status. Skipped:
 * the operation's decision that the input owes it no output, every
 * record of it listed with its own evidence. Pending: neither, and the
 * output is still to make. Both an output and a skip are the tuple's
 * conflict for good.
 */
export type EffectResult =
  | { status: "produced"; outbound: Outbound }
  | { status: "skipped"; skips: readonly Skip[] }
  | { status: "pending" }
  | { status: "conflict"; because: string; outbound: Outbound; skips: readonly Skip[] };

export type Notification = { status: "none" } | { status: "selected"; messageId: MessageId } | { status: "conflict"; messageIds: readonly MessageId[] };

/** A delivery event of a message ID no intent is recorded under. */
export type StrayEvent = VaultEvent<"message.prepared"> | VaultEvent<"delivery.submitted"> | VaultEvent<"delivery.failed"> | VaultEvent<"delivery.acknowledged">;

export interface OutboundFold {
  /** every message ID an intent is recorded under */
  readonly outbounds: ReadonlyMap<MessageId, Outbound>;
  /** in canonical order */
  readonly stray: readonly StrayEvent[];
  /** the messages whose envelope contribution is released */
  readonly released: ReadonlySet<MessageId>;
  /** the notification intents naming a rotation decision, whatever their form: one selects, several conflict and stop each one's work */
  notificationFor(rotationEventCid: EventCid): Notification;
  /** what an automatic operation came to over one input, read before anything is decided for it */
  effectResult(executionId: ExecutionId, effectType: string): EffectResult;
  /**
   * The receipt a carrier earns: its own canonical wire ID when its
   * request names itself and it is the admitted complete witness
   * establishing an input whose admitted intents agree. A request
   * naming other messages earns them nothing.
   */
  ackTarget(sourceEventCid: EventCid): AckTarget;
  /** the outbound a ping-response or problem report answers, when its thread names one this carrier may answer, in any case */
  inReplyTo(sourceEventCid: EventCid): Outbound | null;
}

export type OutboundFoldOptions = {
  /** operations beyond the built-in three whose intents this vault produces; an intent of another operation is pending */
  effectTypes?: Iterable<string>;
};

export function foldOutbound(
  set: VaultEventSet,
  dids: DidFold,
  evidence: ChannelEvidence,
  continuity: Continuity,
  inbound: InboundFold,
  erasures: Erasures,
  resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>,
  options: OutboundFoldOptions = {}
): OutboundFold {
  const known = new Set([...BUILT_IN_EFFECTS, ...(options.effectTypes ?? [])]);
  const intents = groupBy(set.of("message.out"), (event) => event.data.messageId);
  const prepared = groupBy(set.of("message.prepared"), (event) => event.data.messageId);
  const submissions = groupBy(set.of("delivery.submitted"), (event) => event.data.messageId);
  const failures = groupBy(set.of("delivery.failed"), (event) => event.data.messageId);
  const acknowledgements = groupBy(set.of("delivery.acknowledged"), (event) => event.data.messageId);
  const witnesses = witnessesByTarget(evidence, inbound);
  const selections = new Map<EventCid, MessageId[]>();
  for (const event of set.of("message.out")) {
    if (event.data.rotationEventCid === null) continue;
    const selected = selections.get(event.data.rotationEventCid) ?? [];
    if (!selected.includes(event.data.messageId)) selections.set(event.data.rotationEventCid, [...selected, event.data.messageId].sort());
  }

  const shared = { set, dids, evidence, continuity, inbound, erasures, resolutionChecks, known, selections };
  const outbounds = new Map<MessageId, Outbound>();
  const released = new Set<MessageId>();
  for (const [messageId, events] of intents) {
    const outbound = outboundOf(messageId, events, {
      ...shared,
      preparations: prepared.get(messageId) ?? [],
      submissions: submissions.get(messageId) ?? [],
      failures: failures.get(messageId) ?? [],
      acknowledgements: acknowledgements.get(messageId) ?? [],
      witnesses: witnesses.get(messageId) ?? [],
    });
    outbounds.set(messageId, outbound);
    if (outbound.released) released.add(messageId);
  }

  const skips = new Map<EffectKey, Skip[]>();
  for (const event of set.of("effect.skipped")) {
    const skip: Skip = { event, status: skipStatus(event, shared) };
    const list = skips.get(event.data.effectKey);
    if (list === undefined) skips.set(event.data.effectKey, [skip]);
    else list.push(skip);
  }

  const stray: StrayEvent[] = [];
  for (const group of [prepared, submissions, failures, acknowledgements]) {
    for (const [messageId, events] of group) if (!intents.has(messageId)) stray.push(...events);
  }
  stray.sort((a, b) => cmp(a.at, b.at) || cmp(a.cid, b.cid) || cmp(a.author, b.author));

  return {
    outbounds,
    stray,
    released,
    notificationFor: (rotationEventCid) => {
      const messageIds = selections.get(rotationEventCid) ?? [];
      if (messageIds.length === 0) return { status: "none" };
      return messageIds.length === 1 ? { status: "selected", messageId: messageIds[0]! } : { status: "conflict", messageIds };
    },
    effectResult: (executionId, effectType) => {
      const key = effectKey(executionId, effectType);
      const outbound = outbounds.get(automaticMessageId(key)) ?? null;
      const skipped = skips.get(key) ?? [];
      if (outbound !== null && skipped.length > 0) return { status: "conflict", because: "both an output and a skip are recorded for the operation over the input", outbound, skips: skipped };
      if (outbound !== null) return { status: "produced", outbound };
      return skipped.length > 0 ? { status: "skipped", skips: skipped } : { status: "pending" };
    },
    ackTarget: (sourceEventCid) => ackTargetOf(sourceEventCid, evidence, inbound),
    inReplyTo: (sourceEventCid) => {
      const source = evidence.sources.get(sourceEventCid);
      const execution = inbound.ofSource(sourceEventCid);
      if (source === undefined || source.channel === null || execution === null || execution.status !== "complete") return null;
      if (!admittedWitness(sourceEventCid, inbound)) return null;
      const { data } = source.event;
      const thread = execution.kind === "ping-response" ? data.thid : execution.kind === "error" ? data.pthid : null;
      if (thread === null) return null;
      const outbound = outbounds.get(canonicalWireId(thread) as MessageId);
      if (outbound?.channel == null || !continuity.ackPath(outbound.channel, source.channel)) return null;
      return outbound;
    },
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Is the observation an admitted complete witness of an input whose
 * admitted intents agree: what a receipt must be before it is read as
 * the peer acknowledging or answering an outbound. A witness no
 * admission names is an observation of something received, and says
 * nothing yet of what the peer has; one of an input whose admitted
 * intents disagree says nothing either, since which of its `ack`
 * lists or threads the peer meant is not known.
 */
function admittedWitness(sourceEventCid: EventCid, inbound: InboundFold): boolean {
  const member = inbound.memberOf(sourceEventCid);
  return member !== null && member.admitted && member.witness.status === "complete" && inbound.ofSource(sourceEventCid)!.status !== "conflict";
}

/** The admitted witnesses whose `ack` names each canonical wire ID, in canonical event order. */
function witnessesByTarget(evidence: ChannelEvidence, inbound: InboundFold): Map<string, PlacedSource[]> {
  const byTarget = new Map<string, PlacedSource[]>();
  const sources = [...evidence.sources.values()].sort((a, b) => compareEvents(a.event, b.event));
  for (const source of sources) {
    if (source.status !== "complete" || source.event.data.ack.length === 0 || !admittedWitness(source.event.cid, inbound)) continue;
    for (const target of new Set(source.event.data.ack.map(canonicalWireId))) {
      const list = byTarget.get(target);
      if (list === undefined) byTarget.set(target, [source]);
      else list.push(source);
    }
  }
  return byTarget;
}

/** What every message and every skip is judged against. */
type Shared = {
  set: VaultEventSet;
  dids: DidFold;
  evidence: ChannelEvidence;
  continuity: Continuity;
  inbound: InboundFold;
  erasures: Erasures;
  resolutionChecks: ReadonlyMap<EventCid, EvidenceCheck>;
  known: ReadonlySet<string>;
  /** the distinct notification message IDs naming each rotation */
  selections: ReadonlyMap<EventCid, readonly MessageId[]>;
};

type Inputs = Shared & {
  preparations: readonly VaultEvent<"message.prepared">[];
  submissions: readonly VaultEvent<"delivery.submitted">[];
  failures: readonly VaultEvent<"delivery.failed">[];
  acknowledgements: readonly VaultEvent<"delivery.acknowledged">[];
  witnesses: readonly PlacedSource[];
};

function outboundOf(messageId: MessageId, events: readonly VaultEvent<"message.out">[], inputs: Inputs): Outbound {
  const intent = intentOf(events);
  const data = intent.status === "consistent" ? intent.data : null;
  const sender = data === null ? null : (inputs.dids.entities.get(data.senderDidId) ?? null);
  const erased = inputs.erasures.has(messageId);

  let channel: Channel | null = null;
  let fault: string | null = intent.status === "conflict" ? intent.because : null;
  let waiting: string | null = null;
  if (data !== null) {
    if (sender === null) waiting = "no communication DID here records the sender";
    else if (sender.conflict) fault = `the sender entity is in conflict: ${sender.faults[0]}`;
    else if (sender.created === null) waiting = "the sender entity has no consistent creation here";
    else {
      const recipient = canonicalRecipient(data.recipientDid);
      if (recipient === null) fault = "the recipient is no valid did:peer:4";
      else if (recipient === sender.created.did) fault = "the recipient is the sender's own DID";
      else channel = channelOf(sender.created.did, recipient);
    }
  }

  const preparations = inputs.preparations.map((event) => ({ event, status: preparationStatus(event, data, sender, channel, inputs), erased: inputs.erasures.get(messageId)?.has(event.data.envelopeCid) ?? false }));
  const prepared = preparedOf(preparations);

  const submissions = inputs.submissions.map((event) => submissionOf(event, preparations, data, inputs.set));
  const submitted = submissions.some((submission) => submission.status.status === "complete");
  const unresolved = submissions.some((submission) => submission.preparation === null && submission.status.status === "pending");
  const terminations = inputs.failures.map((event) => terminationOf(event, data));
  const terminal = terminations.find((termination) => termination.status.status === "complete") ?? null;

  const effect = data === null ? { status: "complete" as const } : effectOfRecords(events, channel, inputs);
  if (effect.status === "conflict" && fault === null) fault = effect.because;

  const ackWitnesses: AckWitness[] = channel === null || prepared.status !== "complete" ? [] : inputs.witnesses.filter((source) => inputs.continuity.ackPath(channel, source.channel)).map((source) => ({ source }));
  const acknowledgements = inputs.acknowledgements.map((event) => acknowledgementOf(event, prepared, ackWitnesses, inputs.evidence, inputs.continuity, inputs.inbound));
  const acknowledged = ackWitnesses.length > 0;
  const late = acknowledged && data?.expiresTime != null && Math.min(...ackWitnesses.map(({ source }) => Date.parse(source.event.at))) >= data.expiresTime * 1000;

  const outcome: Outcome =
    fault !== null
      ? { status: "conflict", because: fault }
      : submitted
        ? { status: "submitted" }
        : terminal !== null
          ? { status: "terminal", code: terminal.event.data.code }
          : preparations.length > 0
            ? { status: "prepared" }
            : { status: "queued" };
  const released = data !== null && (submitted || terminal !== null);

  const work = workOf({ outcome, waiting, channel, erased, effect, preparations, unresolved, dids: inputs.dids, continuity: inputs.continuity });
  return { messageId, intents: events, intent, sender, channel, preparations, submissions, submitted, terminations, terminal, effect, ackWitnesses, acknowledgements, acknowledged, late, erased, outcome, work, released };
}

/**
 * Records of one message are one intent when they agree on the intent
 * CID, the sender, the canonical recipient, the effect tuple and its
 * key, and the rotation they announce. Their sources are evidence and
 * may differ: each is judged on its own.
 */
function intentOf(events: readonly VaultEvent<"message.out">[]): IntentStatus {
  const first = events[0]!.data;
  for (const { data } of events) {
    if (!sameIntent(first, data)) return { status: "conflict", because: "the intents recorded under one message ID disagree" };
  }
  return { status: "consistent", data: first };
}

function sameIntent(a: MessageOut, b: MessageOut): boolean {
  return (
    a.intentCid === b.intentCid &&
    a.senderDidId === b.senderDidId &&
    (a.recipientDid === b.recipientDid || (canonicalRecipient(a.recipientDid) ?? a.recipientDid) === (canonicalRecipient(b.recipientDid) ?? b.recipientDid)) &&
    a.executionId === b.executionId &&
    a.effectType === b.effectType &&
    a.effectKey === b.effectKey &&
    a.rotationEventCid === b.rotationEventCid
  );
}

function canonicalRecipient(did: Did): Did | null {
  try {
    return canonicalDidOf(did);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return null;
    throw err;
  }
}

/**
 * A peer key on another curve than the sender's own is a
 * contradiction, since no key is agreed across curves. Each
 * contradiction is found as soon as what it needs is here, before any
 * absence.
 */
function preparationStatus(event: VaultEvent<"message.prepared">, data: MessageOut | null, sender: LocalDidEntity | null, channel: Channel | null, inputs: Inputs): PreparationStatus {
  const conflict = (because: string): PreparationStatus => ({ status: "conflict", because });
  if (data === null) return { status: "pending", because: "the intent is not consistent" };
  const { data: preparation } = event;
  if (preparation.senderDidId !== data.senderDidId) return conflict("the preparation's sender is not the intent's");
  if (preparation.intentCid !== data.intentCid) return conflict("the preparation's intent CID is not the intent's");
  const recipient = canonicalRecipient(preparation.recipientDid);
  if (recipient === null) return conflict("the preparation's recipient is no valid did:peer:4");
  if (channel !== null && recipient !== channel.peerDid) return conflict("the preparation's recipient is not the intent's");
  const resolved = inputs.set.resolve(preparation.peerResolutionEventCid, "peer.resolved");
  if (resolved.status === "missing") return { status: "pending", because: "the resolution it names is not here" };
  if (resolved.status === "mismatched") return conflict(`the resolution it names is a ${resolved.event.type}`);
  const resolution = resolved.event.data;
  if (resolution.localKeyName !== preparation.localKeyName) return conflict("the resolution it names was not taken at the preparation's key");
  if (resolution.did !== recipient) return conflict("the resolution it names is not of the recipient");
  let peerKeyType: string;
  try {
    peerKeyType = agreementKey(resolution.peerPublicKey).type;
  } catch (err) {
    if (!(err instanceof InvalidPublicKey)) throw err;
    return conflict(err.message);
  }
  const check = inputs.resolutionChecks.get(resolved.event.cid);
  if (check === "invalid") return conflict("the resolution's snapshot is not its document's");
  const localKeyType = sender === null ? null : keyAgreementTypeOf(sender);
  if (localKeyType !== null && peerKeyType !== localKeyType) return conflict(`the peer key is ${peerKeyType} and the sender's key-agreement key ${localKeyType}: no key is agreed across curves`);
  if (check === undefined) return { status: "pending", because: "the resolution's document is not here" };
  if (channel === null) return { status: "pending", because: "the sender entity has no consistent creation here" };
  if (localKeyType === null) return { status: "pending", because: "the sender's own document does not read" };
  return { status: "complete" };
}

/** Whether a complete preparation is here to attribute receipts to: the best any preparation reaches, one still waiting before one in conflict. */
function preparedOf(preparations: readonly Preparation[]): PreparationStatus {
  if (preparations.some((preparation) => preparation.status.status === "complete")) return { status: "complete" };
  if (preparations.length === 0) return { status: "pending", because: "no preparation is here" };
  return (preparations.find((preparation) => preparation.status.status === "pending") ?? preparations[0]!).status;
}

/**
 * A submission names the intent's message and, by its exact event CID,
 * one of the message's preparations here, and stands as that
 * preparation does. One whose preparation is not here is still to
 * resolve; a reference to another kind of event, or to another
 * message's preparation, completes nothing, for good.
 */
function submissionOf(event: VaultEvent<"delivery.submitted">, preparations: readonly Preparation[], data: MessageOut | null, set: VaultEventSet): Submission {
  const resolved = set.resolve(event.data.preparationEventCid, "message.prepared");
  if (resolved.status === "missing") return { event, preparation: null, status: { status: "pending", because: "the preparation it names is not here" } };
  if (resolved.status === "mismatched") return { event, preparation: null, status: { status: "conflict", because: `the preparation it names is a ${resolved.event.type}` } };
  const preparation = preparations.find((candidate) => candidate.event.cid === resolved.event.cid) ?? null;
  if (preparation === null) return { event, preparation, status: { status: "conflict", because: "the preparation it names is another message's" } };
  if (data === null) return { event, preparation, status: { status: "pending", because: "the intent is not consistent" } };
  const { status } = preparation;
  return { event, preparation, status: status.status === "conflict" ? { status: "conflict", because: `the preparation it names contradicts the intent: ${status.because}` } : status };
}

function terminationOf(event: VaultEvent<"delivery.failed">, data: MessageOut | null): Termination {
  if (data === null) return { event, status: { status: "invalid", because: "the intent is not consistent" } };
  if (event.data.code === "expired" && data.expiresTime === null) return { event, status: { status: "invalid", because: "the intent has no expiry to reach" } };
  return { event, status: { status: "complete" } };
}

/**
 * A recorded acknowledgement rests on a complete preparation and
 * repeats one carrier's key, peer key and wire ID exactly. The
 * witnesses of one input under the peer's several authorized keys share
 * its message ID: any one of them matching in full carries the record,
 * and no two lend each other a field. One whose own evidence is still
 * short, and whose fields so far do not refute the record, keeps it
 * pending: another key's complete witness proves nothing about it.
 */
function acknowledgementOf(event: VaultEvent<"delivery.acknowledged">, prepared: PreparationStatus, witnesses: readonly AckWitness[], evidence: ChannelEvidence, continuity: Continuity, inbound: InboundFold): Acknowledgement {
  if (prepared.status !== "complete") return { event, status: prepared.status === "conflict" ? { status: "conflict", because: `the preparation contradicts the intent: ${prepared.because}` } : prepared };
  const { data } = event;
  const pending = (because: string): Acknowledgement => ({ event, status: { status: "pending", because } });
  const carriers = witnesses.filter(({ source }) => source.event.data.messageId === data.ackMessageId);
  const mismatches = carriers.map(({ source }) => {
    const carrier = source.event.data;
    if (carrier.wireMessageId !== data.ackWireMessageId) return "the wire ID is not the carrier's";
    if (carrier.localKeyName !== data.localKeyName) return "the local key is not the carrier's";
    if (source.resolution.data.peerPublicKey !== data.peerPublicKey) return "the peer key is not the carrier's";
    return null;
  });
  if (mismatches.includes(null)) return { event, status: { status: "complete" } };
  let known = false;
  for (const source of evidence.sources.values()) {
    const carrier = source.event.data;
    if (carrier.messageId !== data.ackMessageId) continue;
    known = true;
    if (carriers.some((witness) => witness.source === source)) continue;
    if (carrier.wireMessageId !== data.ackWireMessageId || carrier.localKeyName !== data.localKeyName || !carrier.ack.some((target) => sameWireId(target, data.messageId))) continue;
    if (source.resolution !== null && source.resolution.data.peerPublicKey !== data.peerPublicKey) continue;
    const witness = continuity.witness(source.event.cid);
    if (witness.status === "pending") return pending(`the carrier it names is no complete witness yet: ${witness.because}`);
    if (witness.status !== "complete") continue;
    if (!inbound.memberOf(source.event.cid)!.admitted) return pending("the carrier it names is not admitted");
    return pending("the carrier it names has no verified path to this message's channel yet");
  }
  if (carriers.length === 0) return pending(known ? "the carrier it names does not acknowledge this message as a complete witness" : "the carrier it names is not here");
  return { event, status: { status: "conflict", because: mismatches.length === 1 ? mismatches[0]! : `none of the ${mismatches.length} carriers with that message ID has the record's wire ID, local key and peer key` } };
}

/**
 * Agreeing records share everything checked here but their sources,
 * and each source is evidence of its own: the first record in canonical
 * order whose own check contradicts it decides a conflict, and else
 * the first still waiting decides that the intent waits.
 */
function effectOfRecords(events: readonly VaultEvent<"message.out">[], channel: Channel | null, inputs: Inputs): EffectStatus {
  const verdicts = events.map(({ data }) => effectOf(data, channel, inputs));
  return verdicts.find((verdict) => verdict.status === "conflict") ?? verdicts.find((verdict) => verdict.status === "pending") ?? { status: "complete" };
}

type SourceReading = { status: "conflict"; because: string } | { status: "read"; source: Source | null };

/**
 * The observation an automatic record names, read against the execution
 * the record claims: a source that is no observation, is anonymous or
 * contradicted, belongs to another input or to one in conflict, or is
 * no witness for good, contradicts the record; one not here, or whose
 * witness is still waiting, adds to what is missing.
 */
function readSource(sourceEventCid: EventReference<"message.in">, executionId: ExecutionId | null, inputs: Shared, missing: string[]): SourceReading {
  const conflict = (because: string): SourceReading => ({ status: "conflict", because });
  const resolved = inputs.set.resolve(sourceEventCid, "message.in");
  if (resolved.status === "mismatched") return conflict(`the source it names is a ${resolved.event.type}`);
  if (resolved.status === "missing") {
    missing.push("the source it names is not here");
    return { status: "read", source: null };
  }
  const source = inputs.evidence.sources.get(sourceEventCid)!;
  if (source.status === "anonymous") return conflict("the source is anonymous, in no channel");
  if (source.status === "conflict") return conflict(`the source's authentication is in conflict: ${source.because}`);
  const execution = inputs.inbound.ofSource(sourceEventCid);
  if (execution !== null) {
    if (execution.id !== executionId) return conflict(`the execution ID is not the one the source's input derives, ${execution.id}`);
    if (execution.status === "conflict") return conflict(`the source's input is in conflict: ${execution.because}`);
  }
  const witness = inputs.continuity.witness(sourceEventCid);
  if (witness.status === "invalid" || witness.status === "conflict") return conflict(`the source is no complete witness: ${witness.because}`);
  if (witness.status === "pending") missing.push(`the source is no complete witness yet: ${witness.because}`);
  return { status: "read", source };
}

/**
 * The operation the intent declares decides what is checked: an
 * intent naming a rotation, or of the notification operation, is
 * checked as a notification; another automatic one as its built-in
 * operation's output. Either rests on its source's execution and
 * witness. A witness still pending, or an operation this vault does
 * not know, leaves the intent pending.
 */
function effectOf(data: MessageOut, channel: Channel | null, inputs: Inputs): EffectStatus {
  const pending = (because: string): EffectStatus => ({ status: "pending", because });
  const missing: string[] = [];

  let source: Source | null = null;
  if (data.sourceEventCid !== null) {
    const read = readSource(data.sourceEventCid, data.executionId, inputs, missing);
    if (read.status === "conflict") return read;
    source = read.source;
  }

  if (data.rotationEventCid !== null || data.effectType === ROTATION_NOTIFICATION_EFFECT) {
    const verdict = notificationOf(data, source, channel, inputs, missing);
    if (verdict !== null) return verdict;
  } else if (data.effectType !== null) {
    if (!inputs.known.has(data.effectType)) return pending(`no operation here produces ${data.effectType}`);
    const verdict = builtInOf(data, source, channel, inputs, missing);
    if (verdict !== null) return verdict;
  }

  if (missing.length > 0) return pending(missing[0]!);
  return { status: "complete" };
}

/** A skip rests on its source as an automatic intent does: the observation of the input the tuple's execution names. */
function skipStatus(event: VaultEvent<"effect.skipped">, inputs: Shared): EffectStatus {
  const missing: string[] = [];
  const read = readSource(event.data.sourceEventCid, event.data.executionId, inputs, missing);
  if (read.status === "conflict") return read;
  return missing.length > 0 ? { status: "pending", because: missing[0]! } : { status: "complete" };
}

/**
 * The output of an ACK or a Ping reply continues the source's channel,
 * or a verified role-preserving successor that keeps the peer. Another
 * peer, or continuity in conflict at either end, is a contradiction. A
 * path not verified here is otherwise still to arrive: the intent
 * names no decision, so one decision failing on its own proves nothing
 * about the path another may yet establish.
 */
function continues(data: MessageOut, source: Source, channel: Channel | null, inputs: Inputs): { status: "pending" | "conflict"; because: string } | null {
  if (channel === null || source.channel === null) return null;
  if (sameChannel(source.channel, channel)) return null;
  if (channel.peerDid !== source.channel.peerDid) return { status: "conflict", because: "the output's peer is not the source's" };
  if (inputs.continuity.ackPath(source.channel, channel)) return null;
  const because = "the output's channel does not continue the source's";
  if (inputs.continuity.conflicted(source.channel) || inputs.continuity.conflicted(channel)) return { status: "conflict", because: `${because}: the continuity between them is in conflict` };
  const toward = [...inputs.evidence.decisions.values()]
    .filter((decision) => decision.event.data.peerDid === channel.peerDid && decision.event.data.toDidId === data.senderDidId)
    .map((decision) => inputs.continuity.status(decision.event.cid));
  for (const status of toward) if (status.status === "pending-history") return { status: "pending", because: `${because} yet: ${status.because}` };
  return { status: "pending", because: `${because} yet: no verified rotation to the output's sender is here` };
}

function builtInOf(data: MessageOut, source: Source | null, channel: Channel | null, inputs: Inputs, missing: string[]): EffectStatus | null {
  const conflict = (because: string): EffectStatus => ({ status: "conflict", because });
  const carried = source?.event.data ?? null;
  const continued = source === null ? null : continues(data, source, channel, inputs);
  if (continued?.status === "conflict") return conflict(continued.because);
  if (continued !== null) missing.push(continued.because);
  const empty = data.bodyCid === EMPTY_CONTENT_CID && data.attachmentCids.length === 0 && Object.keys(data.headers).length === 0;
  const threaded = carried === null || (data.thid === replyThread(carried) && data.pthid === carried.pthid);
  switch (data.effectType) {
    case PURE_ACK_EFFECT:
      if (data.msgType !== EMPTY_MESSAGE_TYPE || !empty) return conflict("a pure ACK is an Empty message with body {} and nothing else");
      if (data.pleaseAck !== null || data.expiresTime !== null) return conflict("a pure ACK requests no ACK and does not expire");
      if (data.ack.length !== 1) return conflict("a pure ACK names one target, its carrier");
      if (!threaded || (carried !== null && data.createdTime !== carried.createdTime)) return conflict("a pure ACK keeps the carrier's thread and creation time");
      if (carried !== null && carried.msgType === EMPTY_MESSAGE_TYPE && carried.pleaseAck === null) return conflict("a pure ACK answers no pure ACK");
      if (carried !== null && data.ack[0] !== canonicalWireId(carried.wireMessageId)) return conflict("a pure ACK names its carrier alone, by its canonical wire ID");
      if (carried !== null && !requestsAck(carried.wireMessageId, carried.pleaseAck)) return conflict("the source requests no receipt of itself");
      return null;
    case PING_RESPONSE_EFFECT:
      if (data.msgType !== PING_RESPONSE_TYPE || !empty) return conflict("a Ping reply is a ping-response with an empty body and nothing else");
      if (data.pleaseAck !== null || data.ack.length > 0) return conflict("a Ping reply neither requests nor carries an ACK");
      if (carried !== null && carried.msgType !== PING_TYPE) return conflict("a Ping reply answers a Ping");
      if (carried !== null && (data.thid !== canonicalWireId(carried.wireMessageId) || data.pthid !== carried.pthid || data.createdTime !== carried.createdTime || data.expiresTime !== carried.expiresTime)) {
        return conflict("a Ping reply threads on the Ping's canonical wire ID and keeps its parent thread and timing");
      }
      return null;
    default:
      return null;
  }
}

/**
 * A notification is triggered exactly as the decision it names was, by
 * the same source, or manually by none. A control input — an ACK, a
 * Ping reply, an error — triggers none, or notifications would answer
 * each other. It rests on the decision's continuity, a predecessor
 * still unconfirmed being pending, and one decision selects one
 * notification. Its own thread and its receipt request are read
 * through its intent, where naming the notification itself under any
 * spelling is the self reference.
 */
function notificationOf(data: MessageOut, source: Source | null, channel: Channel | null, inputs: Inputs, missing: string[]): EffectStatus | null {
  const conflict = (because: string): EffectStatus => ({ status: "conflict", because });
  if (data.effectType !== null && data.effectType !== ROTATION_NOTIFICATION_EFFECT) return conflict("an intent naming a rotation is a rotation notification");
  if (data.rotationEventCid === null) return conflict("a rotation notification names its rotation");
  const intent = intentOfOutbound(data).value;
  const empty = data.bodyCid === EMPTY_CONTENT_CID && data.attachmentCids.length === 0 && Object.keys(data.headers).length === 0;
  if (data.msgType !== EMPTY_MESSAGE_TYPE || !empty) return conflict("a notification is an Empty message with body {} and nothing else");
  if (intent.pleaseAck === null || intent.pleaseAck.length !== 1 || intent.pleaseAck[0] !== SELF || data.ack.length > 0 || data.expiresTime !== null) {
    return conflict("a notification requests its own receipt, carries no ACK and does not expire");
  }
  if (data.sourceEventCid === null) {
    if (intent.thid !== SELF || data.pthid !== null || data.createdTime !== null) return conflict("a manual notification has no thread and no creation time");
  } else if (source !== null) {
    const carried = source.event.data;
    if (data.thid !== replyThread(carried) || data.pthid !== carried.pthid || data.createdTime !== carried.createdTime) {
      return conflict("a triggered notification keeps its source's thread and creation time");
    }
    if (kindOf(carried) !== "application") return conflict(`a control input triggers no notification: the source is ${kindOf(carried)}`);
  }
  if ((inputs.selections.get(data.rotationEventCid) ?? []).length > 1) return conflict("another notification is selected for the rotation");
  const resolved = inputs.set.resolve(data.rotationEventCid, "did.rotationSelected");
  if (resolved.status === "mismatched") return conflict(`the rotation it names is a ${resolved.event.type}`);
  if (resolved.status === "missing") {
    missing.push("the rotation it names is not here");
    return null;
  }
  const { data: rotation } = resolved.event;
  if (rotation.sourceEventCid !== data.sourceEventCid) return conflict("a notification is triggered exactly as its decision was, by the same source");
  if (rotation.toDidId !== data.senderDidId) return conflict("a notification is sent from the decision's successor");
  if (channel !== null && channel.peerDid !== rotation.peerDid) return conflict("a notification is sent to the decision's peer");
  const status = inputs.continuity.status(resolved.event.cid);
  if (status.status === "invalid" || status.status === "conflict") return conflict(`the rotation it names is ${status.status}: ${status.because}`);
  if (status.status !== "verified") missing.push(`the rotation it names is not verified yet${"because" in status ? `: ${status.because}` : ""}`);
  return null;
}

type WorkInputs = { outcome: Outcome; waiting: string | null; channel: Channel | null; erased: boolean; effect: EffectStatus; preparations: readonly Preparation[]; unresolved: boolean; dids: DidFold; continuity: Continuity };

/**
 * A submission naming a preparation not here is no absence of a
 * preparation: nothing is prepared, and nothing else is sent, while
 * it may still arrive. Neither is a preparation here that waits for
 * its evidence or contradicts the intent: no other is made beside it,
 * and the message waits for that evidence, another runtime's valid
 * preparation or its cancellation. The send gate is the one every path
 * to the wire reads, so a replacement of either endpoint stops the
 * preparation and the call alike, whoever asks.
 */
function workOf(w: WorkInputs): Work {
  const none = (because: string): Work => ({ kind: "none", because });
  if (w.outcome.status === "conflict") return none(w.outcome.because);
  if (w.outcome.status === "submitted") return none("submitted");
  if (w.outcome.status === "terminal") return none(`terminated: ${w.outcome.code}`);
  if (w.erased) return none("erased");
  if (w.waiting !== null || w.channel === null) return none(w.waiting ?? "the sender's channel is not known");
  const gate = senderGate({ dids: w.dids, continuity: w.continuity }, w.channel);
  if (gate.status === "closed") return none(gate.because);
  if (w.effect.status !== "complete") return none(w.effect.because);
  if (w.unresolved) return none("a submission names a preparation that is not here");
  if (w.preparations.length === 0) return { kind: "prepare" };
  const candidates = w.preparations.filter((preparation) => preparation.status.status === "complete" && !preparation.erased);
  if (candidates.length > 0) return { kind: "dispatch", candidates };
  const waiting = w.preparations.flatMap(({ status }) => (status.status === "pending" ? [status.because] : []));
  const contradicting = w.preparations.flatMap(({ status }) => (status.status === "conflict" ? [`the preparation contradicts the intent: ${status.because}`] : []));
  return none([...waiting, ...contradicting][0] ?? "the envelope is erased");
}

function ackTargetOf(sourceEventCid: EventCid, evidence: ChannelEvidence, inbound: InboundFold): AckTarget {
  const none = (because: string): AckTarget => ({ status: "none", because });
  const source = evidence.sources.get(sourceEventCid);
  if (source === undefined) return none("the carrier is not here");
  const { data } = source.event;
  if (!requestsAck(data.wireMessageId, data.pleaseAck)) return none("the carrier requests no receipt of itself");
  if (source.channel === null) return none("the carrier's channel is not known");
  const member = inbound.memberOf(sourceEventCid);
  if (member === null) return none("the carrier is in no input here");
  if (!member.admitted) return none("the carrier is not admitted");
  if (member.witness.status !== "complete") return none(`the carrier is no complete witness: ${member.witness.because}`);
  const execution = inbound.ofSource(sourceEventCid)!;
  if (execution.status === "conflict") return none(`the carrier's input is in conflict: ${execution.because}`);
  return { status: "eligible", wireMessageId: canonicalWireId(data.wireMessageId) as WireMessageId };
}
