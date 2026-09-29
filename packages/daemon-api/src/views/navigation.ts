/**
 * A conversation's ID is its projection key, and a nameless one's moves
 * when its head does or when it is given a name. A view keeping a
 * conversation on screen across snapshots follows it by the channels it
 * showed: the conversation that shows any of them now is the same one,
 * as long as it is the only one that does.
 */

import type { ConversationId, ConversationRecord, Snapshot } from "../contract/index.js";

/**
 * The conversation of `after` that `id` of `before` has become: `id`
 * itself while `after` still has it, else the one conversation of
 * `after` showing a channel the old one showed. Null when `after` is
 * another vault's, when none shows one, and when several do, which
 * only the person can tell apart. It follows navigation only: a draft
 * does not move with it, and a send is authorized by nothing here.
 */
export function successorOf(before: Snapshot, after: Snapshot, id: ConversationId): ConversationRecord | null {
  if (before.anchor !== after.anchor) return null;
  const kept = after.conversations.find((conversation) => conversation.id === id);
  if (kept !== undefined) return kept;
  const old = before.conversations.find((conversation) => conversation.id === id);
  if (old === undefined) return null;
  const shown = new Set(old.channels.map(({ channelId }) => channelId));
  const heirs = after.conversations.filter(({ channels }) => channels.some(({ channelId }) => shown.has(channelId)));
  return heirs.length === 1 ? heirs[0]! : null;
}
