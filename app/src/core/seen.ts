import { reactive } from "vue";

import { pairKey } from "./conversations.js";
import type { Conversation } from "./types.js";

/**
 * What this device remembers of the person's own looking: when each
 * conversation was last open, and when a backup was last exported.
 * These are this copy's habits, not facts of the vault, so they live in
 * the browser and travel in no backup; another device starts with none.
 * A conversation is remembered by the channels it showed, so that the
 * record follows it when its key moves.
 */
interface Remembered {
  seen: Record<string, string>;
  exportedAt: string | null;
}

const KEY = "estoc.device";

function load(): Remembered {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Remembered> | null;
    return { seen: stored?.seen ?? {}, exportedAt: stored?.exportedAt ?? null };
  } catch {
    return { seen: {}, exportedAt: null };
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
  for (const { channel } of conversation.channels) remembered.seen[pairKey(channel)] = at;
  save();
}

/** When the conversation was last open on this device; null when it never was. */
export function seenAt(conversation: Conversation): string | null {
  let latest: string | null = null;
  for (const { channel } of conversation.channels) {
    const at = remembered.seen[pairKey(channel)];
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

export function exportedAt(): string | null {
  return remembered.exportedAt;
}

export function markExported(at: string = new Date().toISOString()): void {
  remembered.exportedAt = at;
  save();
}

export function forgetDevice(): void {
  remembered.seen = {};
  remembered.exportedAt = null;
  save();
}
