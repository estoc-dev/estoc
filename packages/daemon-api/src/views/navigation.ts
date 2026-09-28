import type { ConversationId } from "../contract/ids.js";
import type { ConversationRecord, Snapshot } from "../contract/records.js";

/**
 * The sole conversation in `after` sharing any channel shown by `id`
 * in `before`, or null for another vault, a missing old conversation,
 * no match or several matches. Selected and derived channels both count;
 * IDs are compared as opaque strings, without following channel heads.
 *
 * A view first keeps an existing conversation ID in the same vault and
 * only then asks for a successor. This preserves navigation, not send
 * authority, and does not move drafts or other view-owned state.
 */
export function successorOf(before: Snapshot, after: Snapshot, id: ConversationId): ConversationRecord | null {
  if (before.anchor !== after.anchor) return null;
  const previous = before.conversations.find((conversation) => conversation.id === id);
  if (previous === undefined) return null;
  const channels = new Set(previous.channels.map(({ channelId }) => channelId));
  let successor: ConversationRecord | null = null;
  for (const conversation of after.conversations) {
    if (!conversation.channels.some(({ channelId }) => channels.has(channelId))) continue;
    if (successor !== null) return null;
    successor = conversation;
  }
  return successor;
}
