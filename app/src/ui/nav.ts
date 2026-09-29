import { ref, shallowRef, watch } from "vue";
import { successorOf } from "@estoc/daemon-api/views";

import { state } from "../core/store.js";
import type { ConversationId, Snapshot } from "../core/types.js";

/**
 * Where the person is. A phone shows one screen at a time and steps
 * back through them with the browser's own back gesture, so each step
 * forward is a history entry, and the screen is read back off the
 * entry when the person returns to it. Wider windows keep the list
 * beside whatever the screen is about; the screen is the same either
 * way, the shell decides how much of it to lay out.
 */
export type Screen =
  | { kind: "list" }
  | { kind: "chat"; key: ConversationId }
  | { kind: "details"; key: ConversationId }
  | { kind: "hood"; key: ConversationId }
  | { kind: "you" }
  | { kind: "attention" }
  | { kind: "new" };

export type Layout = "narrow" | "medium" | "wide";

const LIST: Screen = { kind: "list" };

export const screen = shallowRef<Screen>(LIST);

export function keyOf(s: Screen): ConversationId | null {
  return "key" in s ? s.key : null;
}

export function go(to: Screen): void {
  history.pushState({ screen: to }, "");
  screen.value = to;
}

/** Land on `to` in place of the screen shown, so that stepping back skips it. */
export function swap(to: Screen): void {
  history.replaceState({ screen: to }, "");
  screen.value = to;
}

export function back(): void {
  if (history.state?.screen === undefined) screen.value = LIST;
  else history.back();
}

// An entry may name a conversation by an ID that has since moved, or
// one that has gone, or a screen the vault no longer has: it lands on
// where the conversation is now, or on the list.
function valid(s: Screen | undefined): Screen {
  if (s === undefined || state.phase !== "open") return LIST;
  const key = keyOf(s);
  if (key === null) return s;
  const now = follow(key);
  return now === null ? LIST : ({ kind: s.kind, key: now } as Screen);
}

window.addEventListener("popstate", (event) => {
  screen.value = valid((event.state as { screen?: Screen } | null)?.screen);
});

// A conversation is known by its ID: a contact's, or for one not named
// yet the channel it leads to, which moves when either side rotates,
// and when it is named. Every conversation shown is therefore
// remembered in the snapshot that showed it, and an ID that no longer
// holds is followed to whichever conversation shows its channels now.
// An ID chosen ahead of the snapshot that brings its conversation is
// waited for.
const shownIn = new Map<ConversationId, Snapshot>();

const has = (snapshot: Snapshot | null, key: ConversationId): boolean => snapshot !== null && snapshot.conversations.some((c) => c.id === key);

function remember(key: ConversationId): void {
  if (has(state.snapshot, key)) shownIn.set(key, state.snapshot!);
}

/** The ID the conversation goes by now, or null when it is gone or was never shown. */
function follow(key: ConversationId): ConversationId | null {
  const now = state.snapshot;
  if (now === null) return null;
  if (has(now, key)) return key;
  const before = shownIn.get(key);
  return before === undefined ? null : (successorOf(before, now, key)?.id ?? null);
}

watch(
  screen,
  (s) => {
    const key = keyOf(s);
    if (key !== null) remember(key);
  },
  { immediate: true }
);

watch(
  () => state.snapshot,
  (snapshot) => {
    const s = screen.value;
    const key = keyOf(s);
    if (key !== null && !has(snapshot, key) && shownIn.has(key)) {
      const now = follow(key);
      if (now === null) swap(LIST);
      else swap({ kind: s.kind, key: now } as Screen);
    }
    // a conversation still shown is remembered in the newest snapshot; one gone stays remembered where it was last seen, for an entry that names it
    for (const id of shownIn.keys()) if (has(snapshot, id)) shownIn.set(id, snapshot!);
  }
);

watch(
  () => state.phase,
  (phase) => {
    if (phase !== "open") swap(LIST);
  }
);

// A link this page was opened with is offered where a conversation starts.
watch(
  () => [state.phase, state.pendingInvitation] as const,
  ([phase, invitation]) => {
    if (phase === "open" && invitation !== null && screen.value.kind !== "new") go({ kind: "new" });
  },
  { immediate: true }
);

// How much fits beside the screen: one screen, list and screen, or the
// details as a third column too.
const MEDIUM = matchMedia("(min-width: 720px)");
const WIDE = matchMedia("(min-width: 1100px)");

function layoutNow(): Layout {
  return WIDE.matches ? "wide" : MEDIUM.matches ? "medium" : "narrow";
}

export const layout = ref<Layout>(layoutNow());

for (const query of [MEDIUM, WIDE]) query.addEventListener("change", () => (layout.value = layoutNow()));

/** Whether the pointer is a mouse or trackpad: Enter then sends, and a keyboard is not the screen. */
export const FINE_POINTER = matchMedia("(pointer: fine)");
