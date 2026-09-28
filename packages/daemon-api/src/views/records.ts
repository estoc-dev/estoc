import type { ChannelId, ContactId, ConversationId, DidId, EventCid, MediationId, MessageId } from "../contract/ids.js";
import type { ChannelRecord, ContactRecord, ConversationRecord, InvitationRecord, LocalDidRecord, MediationRecord, MessageRecord, ObservationRecord, Snapshot } from "../contract/records.js";

/**
 * Lookups for one complete snapshot. Values are the snapshot's own
 * records, not copies. Treat them as read-only and build a new index
 * for each replacement snapshot; nothing is cached across publications.
 */
export interface SnapshotIndex {
  readonly snapshot: Snapshot;
  readonly mediations: ReadonlyMap<MediationId, MediationRecord>;
  readonly dids: ReadonlyMap<DidId, LocalDidRecord>;
  readonly contacts: ReadonlyMap<ContactId, ContactRecord>;
  readonly channels: ReadonlyMap<ChannelId, ChannelRecord>;
  readonly messages: ReadonlyMap<MessageId, MessageRecord>;
  readonly observations: ReadonlyMap<EventCid, ObservationRecord>;
  readonly conversations: ReadonlyMap<ConversationId, ConversationRecord>;
  readonly invitations: ReadonlyMap<EventCid, InvitationRecord>;
}

/** Index the published tables by their primary IDs, without interpreting any ID or record. */
export function indexSnapshot(snapshot: Snapshot): SnapshotIndex {
  return {
    snapshot,
    mediations: new Map(snapshot.mediations.map((record) => [record.mediationId, record])),
    dids: new Map(snapshot.dids.map((record) => [record.didId, record])),
    contacts: new Map(snapshot.contacts.map((record) => [record.contactId, record])),
    channels: new Map(snapshot.channels.map((record) => [record.channelId, record])),
    messages: new Map(snapshot.messages.map((record) => [record.messageId, record])),
    observations: new Map(snapshot.observations.map((record) => [record.sourceEventCid, record])),
    conversations: new Map(snapshot.conversations.map((record) => [record.id, record])),
    invitations: new Map(snapshot.invitations.map((record) => [record.disclosureEventCid, record])),
  };
}

/** A join of published references. Names, membership and send choices remain on the original records. */
export interface ConversationView {
  readonly conversation: ConversationRecord;
  readonly contact: ContactRecord | null;
  readonly channels: readonly { readonly channel: ChannelRecord; readonly selected: boolean }[];
  readonly messages: readonly MessageRecord[];
  readonly unadmitted: readonly ObservationRecord[];
  readonly writeTo: readonly ChannelRecord[];
  readonly defaultWriteTo: ChannelRecord | null;
}

function required<Id, Record>(table: ReadonlyMap<Id, Record>, id: Id, kind: string): Record {
  const record = table.get(id);
  if (record === undefined) throw new Error(`missing ${kind} record: ${String(id)}`);
  return record;
}

/**
 * Resolve a conversation in this index, or null if its ID is absent.
 * Reference lists keep the daemon's order, including derived history
 * and unadmitted observations. A broken relationship throws instead
 * of silently showing a partial conversation. Logical message IDs on
 * observations and pending work need not have a message record.
 *
 * This only joins records: it neither derives a name or a summary nor
 * recomputes send choices. The daemon rechecks any requested operation.
 */
export function conversationOf(index: SnapshotIndex, id: ConversationId): ConversationView | null {
  const conversation = index.conversations.get(id);
  if (conversation === undefined) return null;
  return {
    conversation,
    contact: conversation.contactId === null ? null : required(index.contacts, conversation.contactId, "contact"),
    channels: conversation.channels.map(({ channelId, selected }) => ({ channel: required(index.channels, channelId, "channel"), selected })),
    messages: conversation.messageIds.map((messageId) => required(index.messages, messageId, "message")),
    unadmitted: conversation.unadmittedObservationIds.map((sourceEventCid) => required(index.observations, sourceEventCid, "observation")),
    writeTo: conversation.writeTo.map((channelId) => required(index.channels, channelId, "channel")),
    defaultWriteTo: conversation.defaultWriteTo === null ? null : required(index.channels, conversation.defaultWriteTo, "channel"),
  };
}
