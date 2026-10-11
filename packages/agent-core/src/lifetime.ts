/**
 * How long an agent, or one of its parts used alone, runs: one
 * `closed` for all of it, asked by every side effect in the same
 * synchronous step that makes it, so that no wait between the steps of
 * a procedure can let one through after a close. The transports are
 * reached through it alone: a request is refused at the call, a socket
 * at its opening and at every send. So are the waits: none is set once
 * it closed, and every one set is dropped when it closes. Nothing under
 * way is cut short: a request already made is answered and its body
 * still read, and closing waits for nothing.
 */

import { LinkClosed } from "./errors.js";

/** What waits are kept by: the global timers by default, a test's own otherwise. */
export interface Timers {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const GLOBAL_TIMERS: Timers = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A wait set through a lifetime. */
export interface Timer {
  /** the wait dropped, if it has not fired */
  cancel(): void;
}

const gated: unique symbol = Symbol("lifetime");

/** `fetch` refused once its lifetime closed: what the parts of an agent make requests with, so that the host's own transport reaches none of them. */
export type Fetch = typeof fetch & { readonly [gated]: Lifetime };

/** A socket opened through a lifetime: it sends nothing once the lifetime closed. */
export interface Socket {
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/** What opens sockets through a lifetime: none is opened once it closed. */
export interface Sockets {
  readonly [gated]: Lifetime;
  open(url: string): Socket;
}

export class Lifetime {
  private ended = false;
  private readonly waits = new Set<unknown>();

  constructor(private readonly timers: Timers = GLOBAL_TIMERS) {}

  get closed(): boolean {
    return this.ended;
  }

  /** Every wait set through it dropped, and no side effect made through it from now on. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const handle of this.waits) this.timers.clear(handle);
    this.waits.clear();
  }

  /** `fire` after `ms`, unless the wait is cancelled or the lifetime closes first; once it closed, nothing is set. */
  setTimer(fire: () => void, ms: number): Timer {
    if (this.ended) return { cancel: () => undefined };
    const handle = this.timers.set(() => {
      if (this.waits.delete(handle)) fire();
    }, ms);
    this.waits.add(handle);
    return {
      cancel: () => {
        if (this.waits.delete(handle)) this.timers.clear(handle);
      },
    };
  }

  /** `transport` as the parts of an agent call it: refused with `LinkClosed` once this lifetime closed. One already gated by it is returned as it is. */
  fetch(transport: typeof fetch): Fetch {
    if (ownerOf(transport) === this) return transport as Fetch;
    // a function of its own rather than the transport branded: the host's fetch is left as it was, and a native one is called unbound, as browsers require
    const call = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => (this.ended ? Promise.reject(new LinkClosed()) : transport(input, init));
    return Object.assign(call, { [gated]: this }) as unknown as Fetch;
  }

  /** Sockets of `Socket`, opened only while this lifetime lasts: refused with `LinkClosed` once it closed, at the opening and at each send. */
  sockets(Socket: typeof WebSocket): Sockets {
    const open = (url: string): Socket => {
      if (this.ended) throw new LinkClosed();
      return gatedSocket(new Socket(url), this);
    };
    const sockets: Sockets = { [gated]: this, open };
    return sockets;
  }
}

function ownerOf(transport: object): Lifetime | undefined {
  return (transport as { [gated]?: Lifetime })[gated];
}

function gatedSocket(socket: WebSocket, lifetime: Lifetime): Socket {
  const opened: Socket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    send: (data) => {
      if (lifetime.closed) throw new LinkClosed();
      socket.send(data);
    },
    close: () => socket.close(),
  };
  socket.onopen = () => opened.onopen?.();
  socket.onmessage = (event) => opened.onmessage?.(event);
  socket.onclose = () => opened.onclose?.();
  return opened;
}
