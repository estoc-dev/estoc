import type { Port, PortHandlers, Transport } from "../../src/wire/index.js";

interface End {
  handlers: PortHandlers | null;
  /** frames delivered before the handlers were installed */
  held: unknown[];
  closed: boolean;
}

export interface Pair {
  left: Port;
  right: Port;
  /** every frame the right end was handed, in order */
  toRight: unknown[];
  toLeft: unknown[];
  /** makes the left end a slow reader: what the right end sends waits until released */
  stall(): () => void;
}

/** Two ends of one in-memory link: what one sends the other receives, on the next microtask, in order. */
export function pair(transport: Transport): Pair {
  const ends: [End, End] = [
    { handlers: null, held: [], closed: false },
    { handlers: null, held: [], closed: false },
  ];
  const logs: [unknown[], unknown[]] = [[], []];
  let stalled: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const deliver = (to: 0 | 1, data: unknown): void => {
    const end = ends[to];
    if (end.closed) return;
    logs[to].push(data);
    if (end.handlers === null) end.held.push(data);
    else end.handlers.message(data);
  };
  const closeBoth = (): void => {
    for (const end of ends) {
      if (end.closed) continue;
      end.closed = true;
      end.handlers?.close();
    }
  };
  const portOf = (own: 0 | 1, other: 0 | 1): Port => ({
    transport,
    async send(data) {
      if (ends[own].closed) throw new Error("closed");
      if (other === 0 && stalled !== null) await stalled;
      await Promise.resolve();
      deliver(other, data);
    },
    listen(handlers) {
      ends[own].handlers = handlers;
      for (const data of ends[own].held.splice(0)) handlers.message(data);
    },
    close: closeBoth,
  });
  return {
    left: portOf(0, 1),
    right: portOf(1, 0),
    toRight: logs[1],
    toLeft: logs[0],
    stall() {
      stalled = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        release?.();
        stalled = null;
      };
    },
  };
}

/** Lets every queued microtask and every send in flight run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
