/**
 * The snapshot read by ID, and a conversation assembled from what its
 * record refers to. The daemon publishes every record once and relates
 * them by ID; a view that shows one conversation wants its channels,
 * messages and observations in hand, in the order the record lists
 * them. Nothing is derived here that the daemon did not decide: a
 * missing record is the daemon's fault, and is thrown as one.
 */

import type { ChannelId, ChannelRecord, ContactId, ContactRecord, ConversationId, ConversationRecord, EventCid, MessageId, MessageRecord, ObservationRecord, Snapshot } from "../contract/index.js";

/** A channel as one conversation shows it: selected by its contact, or history reached from a selected one. */
export interface ShownChannel extends ChannelRecord {
  selected: boolean;
}

/** A conversation with the records its projection names, each resolved. */
export interface ConversationView extends Omit<ConversationRecord, "channels" | "messageIds" | "unadmittedObservationIds"> {
  channels: ShownChannel[];
  /** ascending by `(at, messageId)`, each once */
  messages: MessageRecord[];
  /** what arrived in a channel shown here and is not admitted, ascending by `(at, sourceEventCid)` */
  unadmitted: ObservationRecord[];
}

export interface SnapshotIndex {
  readonly snapshot: Snapshot;
  /** every conversation of the snapshot, in its order */
  readonly conversations: ConversationView[];
  channel(channelId: ChannelId): ChannelRecord | null;
  message(messageId: MessageId): MessageRecord | null;
  observation(sourceEventCid: EventCid): ObservationRecord | null;
  contact(contactId: ContactId): ContactRecord | null;
  conversation(id: ConversationId): ConversationView | null;
  /** the conversation of an undeleted contact; null for a contact the snapshot has no conversation of */
  contactConversation(contactId: ContactId): ConversationView | null;
}

const byId = <Id extends string, Record>(records: readonly Record[], id: (record: Record) => Id): Map<Id, Record> => new Map(records.map((record) => [id(record), record]));

function resolved<Id extends string, Record>(table: Map<Id, Record>, what: string): (id: Id) => Record {
  return (id) => {
    const record = table.get(id);
    if (record === undefined) throw new Error(`the snapshot names ${what} ${id} and holds no record of it`);
    return record;
  };
}

export function indexSnapshot(snapshot: Snapshot): SnapshotIndex {
  const channels = byId(snapshot.channels, ({ channelId }) => channelId);
  const messages = byId(snapshot.messages, ({ messageId }) => messageId);
  const observations = byId(snapshot.observations, ({ sourceEventCid }) => sourceEventCid);
  const contacts = byId(snapshot.contacts, ({ contactId }) => contactId);
  const channel = resolved(channels, "channel");
  const message = resolved(messages, "message");
  const observation = resolved(observations, "observation");
  const conversations = snapshot.conversations.map(({ channels: shown, messageIds, unadmittedObservationIds, ...record }): ConversationView => ({
    ...record,
    channels: shown.map(({ channelId, selected }) => ({ ...channel(channelId), selected })),
    messages: messageIds.map(message),
    unadmitted: unadmittedObservationIds.map(observation),
  }));
  const byConversationId = byId(conversations, ({ id }) => id);
  return {
    snapshot,
    conversations,
    channel: (channelId) => channels.get(channelId) ?? null,
    message: (messageId) => messages.get(messageId) ?? null,
    observation: (sourceEventCid) => observations.get(sourceEventCid) ?? null,
    contact: (contactId) => contacts.get(contactId) ?? null,
    conversation: (id) => byConversationId.get(id) ?? null,
    contactConversation: (contactId) => conversations.find((conversation) => conversation.contactId === contactId) ?? null,
  };
}
