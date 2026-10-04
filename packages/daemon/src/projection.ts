/**
 * The records of one read, as a view is shown them: every message,
 * observation, channel and contact once, in a table of its own, and
 * the rest referring to them by ID. A channel is named by its ID
 * wherever it is named; a conversation is a contact's, or the
 * nameless group of channels under one head; and every list is in an
 * order that is a presentation order and nothing more.
 */

import type * as read from "@estoc/agent-core";
import type { Channel, StoredAttachment, VaultFold } from "@estoc/vault";
import type {
  AttachmentDescriptor,
  BodyRecord,
  ChannelId,
  ChannelRecord,
  ContactId,
  ContactRecord,
  ConversationId,
  ConversationRecord,
  Diagnostic,
  DisplayTime,
  EventCid,
  InvitationRecord,
  LocalDidRecord,
  MediationRecord,
  MessageId,
  MessageRecord,
  ObservationRecord,
  PendingWork,
  Snapshot,
  UnplacedRecord,
} from "@estoc/daemon-api/contract";

import { channelIdOf } from "./channels.js";
import { summaryOf } from "./summaries.js";

export interface ReadVault {
  anchor: string;
  label: string;
  restoreUnexplained: boolean;
  mediations: MediationRecord[];
  dids: LocalDidRecord[];
}

const apiId = <Id extends string>(id: string): Id => id as Id;

export function mediationRecords(mediations: VaultFold["mediations"]): MediationRecord[] {
  return [...mediations.mediations.values()].map((mediation) => ({
    mediationId: apiId(mediation.mediationId),
    mediatorDid: mediation.mediatorDid,
    selected: mediations.selected === mediation.mediationId,
    usable: mediations.usable(mediation.mediationId),
    retired: mediation.retired,
    diagnostics: [...mediation.faults],
  }));
}

export function localDidRecords(dids: VaultFold["dids"]): LocalDidRecord[] {
  return [...dids.entities.values()].map((entity) => ({
    didId: apiId(entity.didId),
    did: entity.created?.did ?? null,
    longFormDid: entity.created?.longFormDid ?? null,
    live: entity.live,
    retired: entity.retired,
    disclosures: entity.disclosures.map(({ data }) => ({ as: data.as })),
    diagnostics: [...entity.faults],
  }));
}
const displayTime = (at: string): DisplayTime => at as DisplayTime;
const channelId = (channel: Channel | null): ChannelId | null => (channel === null ? null : channelIdOf(channel));

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byId = <T>(id: (record: T) => string) => (a: T, b: T) => compare(id(a), id(b));

const byTimeThenId = (a: { at: string; id: string }, b: { at: string; id: string }): number => compare(a.at, b.at) || compare(a.id, b.id);

function attachmentDescriptor({ id, description, filename, media_type, format, lastmod_time, byte_count, data }: StoredAttachment): AttachmentDescriptor {
  return {
    id,
    description,
    filename,
    mediaType: media_type,
    format,
    lastModifiedTime: lastmod_time,
    byteCount: byte_count,
    content: data.kind === "links" ? { kind: "links", links: data.links } : { kind: data.kind, cid: data.root },
    hash: data.hash,
    signed: data.jws !== null,
  };
}

const bodyRecord = (body: read.BodyRecord): BodyRecord => (body.state === "available" ? { state: "available", body: body.body, attachments: body.attachments.map(attachmentDescriptor) } : body);

const diagnostic = ({ kind, because, report }: read.Diagnostic): Diagnostic => ({ kind, because, reportMessageId: report === undefined ? null : apiId<MessageId>(report) });

function messageRecord(message: read.MessageRecord): MessageRecord {
  const { messageId, direction, channel, contactIds, at, msg, body, kind, effectType, input, outcome, acknowledged, late, verification, manualAction, completes, diagnostics } = message;
  return {
    messageId: apiId(messageId),
    direction,
    channelId: channelId(channel),
    contactIds: contactIds.map((contactId) => apiId<ContactId>(contactId)),
    at: displayTime(at),
    headers: msg,
    body: bodyRecord(body),
    kind,
    effectType,
    input,
    delivery: outcome,
    acknowledged,
    late,
    verification,
    manualAction,
    completes,
    diagnostics: diagnostics.map(diagnostic),
    summary: msg !== null && body.state === "available" ? summaryOf(msg.type, body.body) : null,
  };
}

function observationRecord({ sourceEventCid, messageId, channel, at, standing, verification, disposition, contradicting }: read.ObservationRecord): ObservationRecord {
  return { sourceEventCid: apiId(sourceEventCid), messageId: apiId(messageId), channelId: channelId(channel), at: displayTime(at), standing, verification, disposition, contradicting };
}

const invitationRecord = ({ disclosureEventCid, oobId, didId, localDid, state }: read.InvitationRecord): InvitationRecord => ({ disclosureEventCid: apiId(disclosureEventCid), oobId, didId: apiId(didId), localDid, state });

function pendingWork(pending: read.PendingWork): PendingWork {
  return {
    pendingOutbounds: pending.pendingOutbounds.map(({ messageId, channel, outcome, because, entries }) => ({ messageId: apiId(messageId), channelId: channelId(channel), outcome, because, entries })),
    missingResponses: pending.missingResponses.map(({ executionId, messageId, effectType, channel, entries }) => ({ executionId: apiId(executionId), messageId: apiId(messageId), effectType, channelId: channelIdOf(channel), entries })),
    rotationCandidates: pending.rotationCandidates.map(({ channel, sourceEventCids, status, because, entries }) => ({ channelId: channelIdOf(channel), sourceEventCids: sourceEventCids.map((cid) => apiId<EventCid>(cid)), status, because, entries })),
    missingNotifications: pending.missingNotifications.map(({ rotationEventCid, channel, sourceEventCid, entries }) => ({ rotationEventCid: apiId(rotationEventCid), channelId: channelIdOf(channel), sourceEventCid: sourceEventCid === null ? null : apiId<EventCid>(sourceEventCid), entries })),
    notificationConflicts: pending.notificationConflicts.map(({ rotationEventCid, messageIds, entries }) => ({ rotationEventCid: apiId(rotationEventCid), messageIds: messageIds.map((messageId) => apiId<MessageId>(messageId)), entries })),
    pendingProofs: pending.pendingProofs.map(({ sourceEventCid, messageId, channel, entries }) => ({ sourceEventCid: apiId(sourceEventCid), messageId: apiId(messageId), channelId: channelId(channel), entries })),
  };
}

/** The channels of a read, each taken once, by ID. */
class Channels {
  private readonly records = new Map<ChannelId, read.ChannelRecord>();

  constructor(private readonly reader: read.Recorder) {}

  async take(channel: Channel): Promise<read.ChannelRecord> {
    const id = channelIdOf(channel);
    let record = this.records.get(id);
    if (record === undefined) this.records.set(id, (record = await this.reader.channel(channel)));
    return record;
  }

  keep(record: read.ChannelRecord): void {
    this.records.set(channelIdOf(record.channel), record);
  }

  /** Every head a channel taken leads to, taken too, until each is in. */
  async takeHeads(): Promise<void> {
    for (const record of [...this.records.values()]) {
      let head = record.head;
      while (head !== null && !this.records.has(channelIdOf(head))) head = (await this.take(head)).head;
    }
  }

  all(): read.ChannelRecord[] {
    return [...this.records.values()];
  }
}

const messageReferences = (messages: Iterable<read.MessageRecord>): MessageId[] =>
  [...messages]
    .map(({ at, messageId }) => ({ at, id: messageId }))
    .sort(byTimeThenId)
    .map(({ id }) => apiId<MessageId>(id));

const observationReferences = (observations: Iterable<read.ObservationRecord>): EventCid[] =>
  [...observations]
    .map(({ at, sourceEventCid }) => ({ at, id: sourceEventCid }))
    .sort(byTimeThenId)
    .map(({ id }) => apiId<EventCid>(id));

/** Each message once, whichever channels of a conversation show it. */
function shownMessages(records: readonly read.ChannelRecord[]): read.MessageRecord[] {
  const messages = new Map<string, read.MessageRecord>();
  for (const record of records) for (const message of record.messages) messages.set(message.messageId, message);
  return [...messages.values()];
}

function unadmittedObservations(records: readonly read.ChannelRecord[]): read.ObservationRecord[] {
  const observations = new Map<string, read.ObservationRecord>();
  for (const record of records) for (const observation of record.observations) if (observation.disposition.status !== "admitted") observations.set(observation.sourceEventCid, observation);
  return [...observations.values()];
}

/**
 * The name the peer claims across the channels shown: the latest claim
 * by the time of its message, then by message ID, among the claims
 * whose message is still here to read in the channel it was made in.
 */
function claimedName(records: readonly read.ChannelRecord[]): ConversationRecord["claimedName"] {
  let latest: { name: string; messageId: MessageId; at: string } | null = null;
  for (const record of records) {
    const claim = record.peerName;
    if (claim === null) continue;
    const message = record.messages.find(({ messageId }) => messageId === claim.messageId);
    if (message === undefined || message.direction !== "in" || message.body.state !== "available") continue;
    const candidate = { name: claim.name, messageId: apiId<MessageId>(claim.messageId), at: message.at };
    if (latest === null || byTimeThenId({ at: latest.at, id: latest.messageId }, { at: candidate.at, id: candidate.messageId }) < 0) latest = candidate;
  }
  return latest === null ? null : { name: latest.name, messageId: latest.messageId };
}

function channelRecord(record: read.ChannelRecord): ChannelRecord {
  const { channel, head, superseded, blocked, conflicted, send, peerName, profileSubmitted, messages, observations } = record;
  return {
    channelId: channelIdOf(channel),
    localDid: channel.localDid,
    peerDid: channel.peerDid,
    headChannelId: channelId(head),
    superseded,
    blocked,
    conflicted,
    send,
    peerName: peerName === null ? null : { name: peerName.name, messageId: apiId<MessageId>(peerName.messageId) },
    profileSubmitted: profileSubmitted === null ? null : apiId<MessageId>(profileSubmitted),
    messageIds: messageReferences(messages),
    observationIds: observationReferences(observations),
  };
}

function contactConversation(contactId: ContactId, contact: read.ContactRecord): ConversationRecord {
  return {
    id: apiId<ConversationId>(`contact:${contactId}`),
    contactId,
    petname: contact.petname,
    claimedName: claimedName(contact.channels),
    channels: contact.channels.map(({ channel, selected }) => ({ channelId: channelIdOf(channel), selected })),
    writeTo: contact.writeTo.map(channelIdOf),
    defaultWriteTo: channelId(contact.defaultWriteTo),
    messageIds: messageReferences(shownMessages(contact.channels)),
    unadmittedObservationIds: observationReferences(unadmittedObservations(contact.channels)),
    diagnostics: contact.diagnostics,
  };
}

/**
 * The channels no contact shows, grouped under the head each leads to
 * or under itself: one conversation a group, writing to its head when
 * the head is one of them and takes a send, and to nothing else. No
 * contact selects any of these, so none is marked selected.
 */
function namelessConversations(channels: Channels, assigned: ReadonlySet<ChannelId>): ConversationRecord[] {
  const groups = new Map<ChannelId, read.ChannelRecord[]>();
  for (const record of channels.all()) {
    const id = channelIdOf(record.channel);
    if (assigned.has(id)) continue;
    const key = record.head === null ? id : channelIdOf(record.head);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups].map(([key, members]) => {
    const head = members.find((record) => channelIdOf(record.channel) === key);
    const writeTo = head !== undefined && head.send.status === "open" ? [key] : [];
    return {
      id: apiId<ConversationId>(`channel:${key}`),
      contactId: null,
      petname: null,
      claimedName: claimedName(members),
      channels: members.map((record) => ({ channelId: channelIdOf(record.channel), selected: false })).sort(byId(({ channelId }) => channelId)),
      writeTo,
      defaultWriteTo: writeTo[0] ?? null,
      messageIds: messageReferences(shownMessages(members)),
      unadmittedObservationIds: observationReferences(unadmittedObservations(members)),
      diagnostics: [],
    };
  });
}

function unplacedRecord(unplaced: read.Unplaced): UnplacedRecord {
  return {
    observationIds: observationReferences(unplaced.inputs),
    outputs: unplaced.outputs
      .map(({ candidates, message }) => ({ at: message.at, id: message.messageId, candidateChannelIds: candidates.map(channelIdOf).sort(compare) }))
      .sort(byTimeThenId)
      .map(({ id, candidateChannelIds }) => ({ messageId: apiId<MessageId>(id), candidateChannelIds })),
  };
}

/**
 * The snapshot of one read. The channel table has every pair anything
 * else names — a contact's membership and send choices, a message's or
 * an observation's placement, a head, a pending item, an unplaced
 * output's candidates — whether or not the pair has a message.
 */
export async function project(reader: read.Recorder, vault: ReadVault): Promise<Snapshot> {
  const channels = new Channels(reader);
  const contacts: ContactRecord[] = [];
  const conversations: ConversationRecord[] = [];
  const assigned = new Set<ChannelId>();
  for (const id of reader.contactIds()) {
    const contact = await reader.contact(id);
    const contactId = apiId<ContactId>(id);
    for (const shown of contact.channels) {
      channels.keep(shown);
      assigned.add(channelIdOf(shown.channel));
    }
    for (const channel of contact.writeTo) await channels.take(channel);
    for (const channel of contact.preference?.matches ?? []) await channels.take(channel);
    contacts.push({
      contactId,
      origin: contact.contacts.find((entry) => entry.contactId === id)?.origin ?? null,
      flags: contact.flags,
      preference: contact.preference === null ? null : { didId: apiId(contact.preference.didId), channelIds: contact.preference.matches.map(channelIdOf).sort(compare) },
    });
    conversations.push(contactConversation(contactId, contact));
  }
  for (const channel of reader.channels()) await channels.take(channel);
  const unplaced = await reader.unplaced();
  for (const { candidates } of unplaced.outputs) for (const channel of candidates) await channels.take(channel);
  const pending = reader.pending();
  for (const { channel } of [...pending.pendingOutbounds, ...pending.missingResponses, ...pending.rotationCandidates, ...pending.missingNotifications, ...pending.pendingProofs]) if (channel !== null) await channels.take(channel);
  await channels.takeHeads();
  conversations.push(...namelessConversations(channels, assigned));

  const messages = new Map<string, read.MessageRecord>();
  const observations = new Map<string, read.ObservationRecord>();
  for (const record of channels.all()) {
    for (const message of record.messages) messages.set(message.messageId, message);
    for (const observation of record.observations) observations.set(observation.sourceEventCid, observation);
  }
  for (const { message } of unplaced.outputs) messages.set(message.messageId, message);
  for (const observation of unplaced.inputs) observations.set(observation.sourceEventCid, observation);

  return {
    anchor: vault.anchor,
    label: vault.label,
    restoreUnexplained: vault.restoreUnexplained,
    mediations: [...vault.mediations].sort(byId(({ mediationId }) => mediationId)),
    dids: [...vault.dids].sort(byId(({ didId }) => didId)),
    contacts: contacts.sort(byId(({ contactId }) => contactId)),
    channels: channels.all().map(channelRecord).sort(byId(({ channelId }) => channelId)),
    messages: [...messages.values()].map(messageRecord).sort(byId(({ messageId }) => messageId)),
    observations: [...observations.values()].map(observationRecord).sort(byId(({ sourceEventCid }) => sourceEventCid)),
    conversations: conversations.sort(byId(({ id }) => id)),
    invitations: reader.invitations().map(invitationRecord).sort(byId(({ disclosureEventCid }) => disclosureEventCid)),
    pending: pendingWork(pending),
    unplaced: unplacedRecord(unplaced),
  };
}
