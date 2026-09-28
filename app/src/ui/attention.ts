import { computed } from "vue";

import { state } from "../core/store.js";

/**
 * Everything that waits for the person, counted once so that the list
 * can say how many things need them and the page can lay them out.
 */
export function useAttention() {
  const pending = computed(() => state.snapshot?.pending ?? null);
  const byHand = computed(() => {
    const p = pending.value;
    if (p === null) return 0;
    return p.pendingOutbounds.length + p.missingResponses.length + p.missingNotifications.length + p.notificationConflicts.length + p.pendingProofs.length;
  });
  const waiting = computed(() => state.lines?.waiting ?? []);
  const discarded = computed(() => state.lines?.discarded ?? []);
  const unknownRegistrations = computed(() => (state.lines?.connections ?? []).flatMap((c) => c.unknownRegistrations));
  const unplacedInputs = computed(() => state.snapshot?.unplaced.inputs ?? []);
  const unplacedOutputs = computed(() => state.snapshot?.unplaced.outputs ?? []);
  const count = computed(
    () => byHand.value + waiting.value.length + discarded.value.length + unknownRegistrations.value.length + unplacedInputs.value.length + unplacedOutputs.value.length
  );
  return { pending, byHand, waiting, discarded, unknownRegistrations, unplacedInputs, unplacedOutputs, count };
}
