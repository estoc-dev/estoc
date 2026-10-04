import { computed } from "vue";

import { state } from "../core/store.js";
import type { ObservationRecord } from "../core/types.js";

export function useAttention() {
  const pending = computed(() => state.snapshot?.pending ?? null);
  const byHand = computed(() => {
    const p = pending.value;
    if (p === null) return 0;
    return p.pendingOutbounds.length + p.missingResponses.length + p.rotationCandidates.length + p.missingNotifications.length + p.notificationConflicts.length + p.pendingProofs.length;
  });
  const waiting = computed(() => state.lines?.waiting ?? []);
  const discarded = computed(() => state.lines?.discarded ?? []);
  const unplacedInputs = computed(() => {
    const index = state.index;
    return index === null ? [] : index.snapshot.unplaced.observationIds.flatMap((cid): ObservationRecord[] => (index.observation(cid) === null ? [] : [index.observation(cid)!]));
  });
  const unplacedOutputs = computed(() => state.snapshot?.unplaced.outputs ?? []);
  const count = computed(
    () => byHand.value + waiting.value.length + discarded.value.length + unplacedInputs.value.length + unplacedOutputs.value.length
  );
  return { pending, byHand, waiting, discarded, unplacedInputs, unplacedOutputs, count };
}
