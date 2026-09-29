import { ref, shallowRef, watch } from "vue";
import { successorOf, trailOf, type ConversationTrail } from "@estoc/daemon-api/views";

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
// and when it is named. Every conversation shown therefore leaves its
// trail, and an ID that no longer holds is followed along it to
// whichever conversation shows its channels now. An ID chosen ahead of
// the snapshot that brings its conversation is waited for. A trail is
// IDs alone: what a snapshot showed goes with the snapshot.
const trails = new Map<ConversationId, ConversationTrail>();

const has = (snapshot: Snapshot | null, key: ConversationId): boolean => snapshot !== null && snapshot.conversations.some((c) => c.id === key);

function remember(key: ConversationId): void {
  const trail = state.snapshot === null ? null : trailOf(state.snapshot, key);
  if (trail !== null) trails.set(key, trail);
}

/** The ID the conversation goes by now, or null when it is gone or was never shown. */
function follow(key: ConversationId): ConversationId | null {
  const now = state.snapshot;
  if (now === null) return null;
  if (has(now, key)) return key;
  const trail = trails.get(key);
  return trail === undefined ? null : (successorOf(trail, now)?.id ?? null);
}

watch(
  screen,
  (s) => {
    const key = keyOf(s);
    if (key !== null) remember(key);
  },
  { immediate: true }
);

// Another vault in place of the one shown: no screen of the old one holds, and no trail of its conversations leads anywhere.
watch(
  () => state.hold,
  (_hold, before) => {
    trails.clear();
    if (before !== null) swap(LIST);
  }
);

watch(
  () => state.snapshot,
  (snapshot) => {
    const s = screen.value;
    const key = keyOf(s);
    if (key !== null && !has(snapshot, key) && trails.has(key)) {
      const now = follow(key);
      if (now === null) swap(LIST);
      else swap({ kind: s.kind, key: now } as Screen);
    }
    // a conversation still shown leaves a fresh trail; one gone keeps its last, for an entry that names it
    for (const id of trails.keys()) {
      const trail = snapshot === null ? null : trailOf(snapshot, id);
      if (trail !== null) trails.set(id, trail);
    }
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
