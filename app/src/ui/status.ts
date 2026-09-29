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

  /** The mediator was reached and live delivery is off: the socket went, and the agent is on its way back. */
  const lost = computed(() => line.value !== null && line.value.unreachable === null && !line.value.live && line.value.drained !== null);

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
    if (line.value.live) return "live";
    return lost.value ? "reconnecting" : "connecting";
  });

  const sentence = computed(() => {
    if (state.away !== null) return state.away;
    if (mediation.value === null) return "not reachable yet: no mediator chosen";
    if (line.value === null) return "connecting to the mediator";
    if (line.value.unreachable !== null) return line.value.unreachable;
    if (line.value.live) return "live delivery on";
    return lost.value ? "live delivery was lost; connecting again" : "connecting to the mediator";
  });

  return { mediation, line, lamp, lost, word, sentence };
}
