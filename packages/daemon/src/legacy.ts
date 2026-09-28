/**
 * The publisher's publications as the events the RPC of `rpc.ts` and
 * its listeners still take — `phase`, `opened`, `changed`, `lines`,
 * `log` — and its records in the shape they still read, channels and
 * contacts carrying their messages and pairs, for as long as that RPC
 * is served: a bridge, until every view attaches to the publisher
 * itself. The old shape is made from the published one and shows no
 * more than it: an attachment's signature is not carried, as no
 * listener of these events reads one.
 */

import type { Cid } from "@estoc/event-store";
import type { Channel, ContactId, Did, DidId, EventCid, MessageId, StoredAttachment } from "@estoc/vault";
import type * as read from "@estoc/agent-core";
import type { AttachmentDescriptor, ChannelId, ChannelRecord, ContactRecord, ConversationRecord, Lines, MessageRecord, ObservationRecord, PendingWork, Snapshot } from "@estoc/daemon-api/contract";

import type { ContactSummary, Lines as LegacyLines, Snapshot as LegacySnapshot } from "./api.js";
import type { BaselineOf, Publisher, StateOf } from "./publisher.js";

export type Emit = (name: string, ...args: unknown[]) => void;

export interface LegacyEvents {
  /** Where things stand, to `to` alone: what a listener that was not there for the events so far is told first. Refused while the state is stale. */
  replayTo(to: Emit): Promise<void>;
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The pair a channel ID of the daemon's own names: the text is read, not checked again. */
function channelOf(channelId: ChannelId): Channel {
  const [localDid, peerDid] = JSON.parse(channelId) as [Did, Did];
  return { localDid, peerDid };
}

const pairOf = (channelId: ChannelId | null): Channel | null => (channelId === null ? null : channelOf(channelId));

function storedAttachment({ id, description, filename, mediaType, format, lastModifiedTime, byteCount, content, hash }: AttachmentDescriptor): StoredAttachment {
  return {
    id,
    description,
    filename,
    media_type: mediaType,
    format,
    lastmod_time: lastModifiedTime as StoredAttachment["lastmod_time"],
    byte_count: byteCount,
    data: content.kind === "links" ? { kind: "links", links: content.links, hash: hash ?? "", jws: null } : { kind: content.kind, root: content.cid as Cid, hash, jws: null },
  };
}

function legacyMessage(message: MessageRecord): read.MessageRecord {
  const { messageId, direction, channelId, contactIds, at, headers, body, kind, effectType, input, delivery, acknowledged, late, verification, manualAction, completes, diagnostics } = message;
  return {
    messageId: messageId as string as MessageId,
    direction,
    channel: pairOf(channelId),
    contactIds: contactIds as string[] as ContactId[],
    at,
    msg: headers as read.MessageHeaders | null,
    body: body.state === "available" ? { state: "available", body: body.body, attachments: body.attachments.map(storedAttachment) } : body,
    kind,
    effectType,
    input,
    outcome: delivery,
    acknowledged,
    late,
    verification,
    manualAction,
    completes,
    diagnostics: diagnostics.map(({ kind, because, reportMessageId }) => (reportMessageId === null ? { kind, because } : { kind, because, report: reportMessageId as string as MessageId })),
  };
}

function legacyObservation({ sourceEventCid, messageId, channelId, at, standing, verification, disposition, contradicting }: ObservationRecord): read.ObservationRecord {
  return {
    sourceEventCid: sourceEventCid as string as EventCid,
    messageId: messageId as string as MessageId,
    channel: pairOf(channelId),
    at,
    standing,
    verification,
    disposition,
    contradicting,
  };
}

function legacyPending(pending: PendingWork): read.PendingWork {
  return {
    pendingOutbounds: pending.pendingOutbounds.map(({ channelId, ...rest }) => ({ ...rest, channel: pairOf(channelId) })) as unknown as read.PendingWork["pendingOutbounds"],
    missingResponses: pending.missingResponses.map(({ channelId, ...rest }) => ({ ...rest, channel: channelOf(channelId) })) as unknown as read.PendingWork["missingResponses"],
    missingNotifications: pending.missingNotifications.map(({ channelId, ...rest }) => ({ ...rest, channel: channelOf(channelId) })) as unknown as read.PendingWork["missingNotifications"],
    notificationConflicts: pending.notificationConflicts as unknown as read.PendingWork["notificationConflicts"],
    pendingProofs: pending.pendingProofs.map(({ channelId, ...rest }) => ({ ...rest, channel: pairOf(channelId) })) as unknown as read.PendingWork["pendingProofs"],
  };
}

function legacyContact(contact: ContactRecord, conversation: ConversationRecord): ContactSummary {
  return {
    contacts: [{ contactId: contact.contactId as string as ContactId, origin: contact.origin, deleted: false, petname: conversation.petname }],
    petname: conversation.petname,
    flags: contact.flags,
    channels: conversation.channels.map(({ channelId, selected }) => ({ channel: channelOf(channelId), selected })),
    writeTo: conversation.writeTo.map(channelOf),
    defaultWriteTo: pairOf(conversation.defaultWriteTo),
    preference: contact.preference === null ? null : { didId: contact.preference.didId as string as DidId, matches: contact.preference.channelIds.map(channelOf) },
    diagnostics: conversation.diagnostics,
  };
}

/** The snapshot as the listeners of the old events read it. */
export function legacySnapshot(snapshot: Snapshot): LegacySnapshot {
  const messages = new Map(snapshot.messages.map((message) => [message.messageId, legacyMessage(message)]));
  const observations = new Map(snapshot.observations.map((observation) => [observation.sourceEventCid, legacyObservation(observation)]));
  const conversations = new Map(snapshot.conversations.filter((conversation) => conversation.contactId !== null).map((conversation) => [conversation.contactId!, conversation]));
  const channel = ({ channelId, headChannelId, superseded, blocked, conflicted, send, peerName, profileSubmitted, messageIds, observationIds }: ChannelRecord): read.ChannelRecord => ({
    channel: channelOf(channelId),
    head: pairOf(headChannelId),
    superseded,
    blocked,
    conflicted,
    send,
    peerName: peerName as read.ChannelRecord["peerName"],
    profileSubmitted: profileSubmitted as string | null as MessageId | null,
    messages: messageIds.map((messageId) => messages.get(messageId)!),
    observations: observationIds.map((sourceEventCid) => observations.get(sourceEventCid)!),
  });
  return {
    anchor: snapshot.anchor as LegacySnapshot["anchor"],
    label: snapshot.label,
    restoreUnexplained: snapshot.restoreUnexplained,
    mediations: snapshot.mediations.map(({ diagnostics, ...mediation }) => ({ ...mediation, faults: diagnostics })) as unknown as LegacySnapshot["mediations"],
    dids: snapshot.dids.map(({ diagnostics, ...did }) => ({ ...did, faults: diagnostics })) as unknown as LegacySnapshot["dids"],
    contacts: snapshot.contacts.map((contact) => legacyContact(contact, conversations.get(contact.contactId)!)),
    channels: snapshot.channels.map(channel),
    unplaced: {
      inputs: snapshot.unplaced.observationIds.map((sourceEventCid) => observations.get(sourceEventCid)!),
      outputs: snapshot.unplaced.outputs.map(({ messageId, candidateChannelIds }) => ({ candidates: candidateChannelIds.map(channelOf), message: messages.get(messageId)! })),
    },
    invitations: snapshot.invitations as unknown as LegacySnapshot["invitations"],
    pending: legacyPending(snapshot.pending),
  };
}

/** The lines as the listeners of the old events read them: each connection's reconciliation naming its arrangement again. */
export function legacyLines(lines: Lines): LegacyLines {
  return {
    connections: lines.connections.map(({ reconciled, ...connection }) => ({ ...connection, reconciled: reconciled === null ? null : { mediationId: connection.mediationId, ...reconciled } })) as unknown as LegacyLines["connections"],
    waiting: lines.waiting as LegacyLines["waiting"],
    discarded: lines.discarded as LegacyLines["discarded"],
  };
}

function tell(to: Emit, { value }: StateOf<Snapshot>, opened: boolean): void {
  if (value.phase !== "open") to("phase", value.phase, value.detail, value.hold);
  else if (opened) to("opened", legacySnapshot(value.snapshot), value.hold);
  else to("changed", legacySnapshot(value.snapshot));
}

export function legacyEvents(publisher: Publisher<Snapshot, Lines>, emit: Emit): LegacyEvents {
  const shown = ({ state }: BaselineOf<Snapshot, Lines>): boolean => state.value.phase === "open";
  publisher.attach({
    state: (state) => tell(emit, state, state.revision === 1),
    lines: (lines) => {
      if (shown(publisher.current)) emit("lines", legacyLines(lines.value));
    },
    log: (line) => emit("log", line.line),
    unavailable: (error) => emit("log", `the snapshot could not be read: ${failure(error)}`),
  });
  return {
    async replayTo(to) {
      const unavailable = publisher.unavailable;
      if (unavailable !== null) throw unavailable.error;
      const current = publisher.current;
      tell(to, current.state, true);
      if (shown(current)) to("lines", legacyLines(current.lines.value));
    },
  };
}
