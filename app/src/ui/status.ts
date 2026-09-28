import { computed } from "vue";

import { state } from "../core/store.js";

/**
 * How this vault is reached, as one lamp and a few words: whether a
 * mediator is chosen, and whether the line to it is up, which only the
 * running agent knows.
 */
export function useStatus() {
  const mediation = computed(() => state.snapshot?.mediations.find((m) => m.selected) ?? null);
  const line = computed(() => state.lines?.connections.find((c) => c.mediationId === mediation.value?.mediationId) ?? null);

  const lamp = computed<"live" | "connecting" | "error" | "">(() => {
    if (state.away !== null || (line.value !== null && line.value.unreachable !== null)) return "error";
    if (line.value?.live === true) return "live";
    return mediation.value === null ? "" : "connecting";
  });

  const word = computed(() => {
    if (state.away !== null) return "daemon away";
    if (mediation.value === null) return "no mediator";
    if (line.value === null) return "connecting";
    if (line.value.unreachable !== null) return "unreachable";
    return line.value.live ? "live" : "connected";
  });

  const sentence = computed(() => {
    if (state.away !== null) return state.away;
    if (mediation.value === null) return "not reachable yet: no mediator chosen";
    if (line.value === null) return "connecting to the mediator";
    if (line.value.unreachable !== null) return line.value.unreachable;
    return line.value.live ? "live delivery on" : "connected, no live delivery";
  });

  return { mediation, line, lamp, word, sentence };
}
