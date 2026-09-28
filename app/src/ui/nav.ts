import { ref, shallowRef, watch } from "vue";

import { pairKey, successorOf } from "../core/conversations.js";
import { state } from "../core/store.js";

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
  | { kind: "chat"; key: string }
  | { kind: "details"; key: string }
  | { kind: "hood"; key: string }
  | { kind: "you" }
  | { kind: "attention" }
  | { kind: "new" };

export type Layout = "narrow" | "medium" | "wide";

const LIST: Screen = { kind: "list" };

export const screen = shallowRef<Screen>(LIST);

export function keyOf(s: Screen): string | null {
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

// An entry may name a conversation by a key that has since moved, or
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

// A conversation is known by its key: a contact's ID, or for one not
// named yet the pair it leads to, which moves when either side rotates,
// and when it is named. Every conversation shown is therefore
// remembered by the channels it showed, and a key that no longer
// holds is followed to whichever conversation shows them now. A key
// chosen ahead of the snapshot that brings its conversation is waited
// for.
const pairsShown = new Map<string, Set<string>>();

function remember(key: string): void {
  const conversation = state.conversations.find((c) => c.key === key);
  if (conversation !== undefined) pairsShown.set(key, new Set(conversation.channels.map(({ channel }) => pairKey(channel))));
}

/** The key the conversation goes by now, or null when it is gone or was never shown. */
function follow(key: string): string | null {
  if (state.conversations.some((c) => c.key === key)) return key;
  const pairs = pairsShown.get(key);
  return pairs === undefined ? null : (successorOf(pairs, state.conversations)?.key ?? null);
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
  () => state.conversations,
  (conversations) => {
    const s = screen.value;
    const key = keyOf(s);
    if (key === null) return;
    if (conversations.some((c) => c.key === key)) return remember(key);
    if (!pairsShown.has(key)) return;
    const now = follow(key);
    if (now === null) swap(LIST);
    else swap({ kind: s.kind, key: now } as Screen);
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
