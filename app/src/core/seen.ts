import { reactive } from "vue";

import type { Conversation, Snapshot } from "./types.js";

/**
 * What this device remembers of the person's own looking: when each
 * conversation was last open, and when a backup of each identity was
 * last exported. These are this copy's habits, not facts of the vault,
 * so they live in the browser and travel in no backup; another device
 * starts with none. A conversation is remembered by the channels it
 * showed, so that the record follows it when its ID moves; an export by
 * the identity's anchor, so that whichever vault stands here reads only
 * what was done for its own identity.
 */
interface Remembered {
  seen: Record<string, string>;
  exported: Record<string, string>;
}

const KEY = "estoc.device";

function load(): Remembered {
  try {
    // an export remembered by an earlier version named no identity, and is not given to whichever stands here now
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Remembered> | null;
    return { seen: stored?.seen ?? {}, exported: stored?.exported ?? {} };
  } catch {
    return { seen: {}, exported: {} };
  }
}

const remembered = reactive<Remembered>(load());

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(remembered));
  } catch {
    // storage that will not take it: the memory of this session is what there is
  }
}

export function markSeen(conversation: Conversation, at: string = new Date().toISOString()): void {
  for (const { channelId } of conversation.channels) remembered.seen[channelId] = at;
  save();
}

/** When the conversation was last open on this device; null when it never was. */
export function seenAt(conversation: Conversation): string | null {
  let latest: string | null = null;
  for (const { channelId } of conversation.channels) {
    const at = remembered.seen[channelId];
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** When a backup of the identity under `anchor` was last exported from this device; null when none was. */
export function exportedAt(anchor: string): string | null {
  return remembered.exported[anchor] ?? null;
}

export function markExported(anchor: string, at: string = new Date().toISOString()): void {
  remembered.exported[anchor] = at;
  save();
}

/** What was remembered of one vault's identity and conversations, forgotten with it. */
export function forgetRemembered(snapshot: Snapshot): void {
  delete remembered.exported[snapshot.anchor];
  for (const { channelId } of snapshot.channels) delete remembered.seen[channelId];
  save();
}
