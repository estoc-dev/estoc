/**
 * A conversation's ID is its projection key, and a nameless one's moves
 * when its head does or when it is given a name. A view keeping a
 * conversation on screen across snapshots follows it by the channels it
 * showed: the conversation that shows any of them now is the same one,
 * as long as it is the only one that does. What the view keeps of a
 * conversation to follow it is its trail, IDs alone: no record of the
 * snapshot that showed it outlives that snapshot.
 */

import type { ChannelId, ConversationId, ConversationRecord, Snapshot } from "../contract/index.js";

/** Where a conversation was seen: the vault, its ID there, and the channels it showed. */
export interface ConversationTrail {
  anchor: string;
  id: ConversationId;
  channels: ChannelId[];
}

/** The trail of the conversation `snapshot` shows by `id`; null when it shows none. */
export function trailOf(snapshot: Snapshot, id: ConversationId): ConversationTrail | null {
  const conversation = snapshot.conversations.find((c) => c.id === id);
  return conversation === undefined ? null : { anchor: snapshot.anchor, id, channels: conversation.channels.map(({ channelId }) => channelId) };
}

/**
 * The conversation of `after` that the one on `trail` has become: the
 * same ID while `after` still has it, else the one conversation of
 * `after` showing a channel it showed. Null when `after` is another
 * vault's, when none shows one, and when several do, which only the
 * person can tell apart. It follows navigation only: a draft does not
 * move with it, and a send is authorized by nothing here.
 */
export function successorOf(trail: ConversationTrail, after: Snapshot): ConversationRecord | null {
  if (trail.anchor !== after.anchor) return null;
  const kept = after.conversations.find((conversation) => conversation.id === trail.id);
  if (kept !== undefined) return kept;
  const shown = new Set(trail.channels);
  const heirs = after.conversations.filter(({ channels }) => channels.some(({ channelId }) => shown.has(channelId)));
  return heirs.length === 1 ? heirs[0]! : null;
}
