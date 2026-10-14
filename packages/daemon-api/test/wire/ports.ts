import { encode } from "cbor2/encoder";

import type { Port, PortHandlers } from "../../src/wire/index.js";

interface End {
  handlers: PortHandlers | null;
  /** frames delivered before the handlers were installed */
  held: Uint8Array[];
  closed: boolean;
}

export interface Pair {
  left: Port;
  right: Port;
  /** every frame the right end was handed, in order */
  toRight: Uint8Array[];
  toLeft: Uint8Array[];
  /** makes the left end a slow reader: what the right end sends waits until released */
  stall(): () => void;
}

/** Two ends of one in-memory link: what one sends the other receives, on the next microtask, in order. */
export function pair(): Pair {
  const ends: [End, End] = [
    { handlers: null, held: [], closed: false },
    { handlers: null, held: [], closed: false },
  ];
  const logs: [Uint8Array[], Uint8Array[]] = [[], []];
  let stalled: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const deliver = (to: 0 | 1, data: Uint8Array): void => {
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

/** `value` as one CBOR data item, written as the encoder writes it whatever it holds: a frame no writer of the wire's would send. */
export const cbor = (value: unknown): Uint8Array => encode(value);

/** The bytes a string of hex digits spells. */
export const hex = (digits: string): Uint8Array => Uint8Array.from(digits.match(/../g) ?? [], (byte) => parseInt(byte, 16));

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
};
