/**
 * The publisher's publications as the events the RPC of `rpc.ts` and
 * its listeners still take — `phase`, `opened`, `changed`, `lines`,
 * `log` — for as long as that RPC is served: a bridge, until every
 * view attaches to the publisher itself.
 */

import type { BaselineOf, Publisher, StateOf } from "./publisher.js";

export type Emit = (name: string, ...args: unknown[]) => void;

export interface LegacyEvents {
  /** Where things stand, to `to` alone: what a listener that was not there for the events so far is told first. Refused while the state is stale. */
  replayTo(to: Emit): Promise<void>;
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function tell<S>(to: Emit, { value }: StateOf<S>, opened: boolean): void {
  if (value.phase !== "open") to("phase", value.phase, value.detail, value.hold);
  else if (opened) to("opened", value.snapshot, value.hold);
  else to("changed", value.snapshot);
}

export function legacyEvents<S, L>(publisher: Publisher<S, L>, emit: Emit): LegacyEvents {
  const shown = ({ state }: BaselineOf<S, L>): boolean => state.value.phase === "open";
  publisher.attach({
    state: (state) => tell(emit, state, state.revision === 1),
    lines: (lines) => {
      if (shown(publisher.current)) emit("lines", lines.value);
    },
    log: (line) => emit("log", line.line),
    unavailable: (error) => emit("log", `the snapshot could not be read: ${failure(error)}`),
  });
  return {
    async replayTo(to) {
      const unavailable = publisher.unavailable;
      if (unavailable !== null) throw unavailable.error;
      const current = publisher.current;
      tell(to, current.state, true);
      if (shown(current)) to("lines", current.lines.value);
    },
  };
}
