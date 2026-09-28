/**
 * What a session runs over: something that carries one frame at a time,
 * in order, as one JSON text or as one structured-clone value. The
 * adapters here wrap the ports a browser, a worker and Node's global
 * WebSocket provide, described by the members used and no library type.
 */

export type Transport = "text" | "clone";

export interface PortHandlers {
  message(data: unknown): void;
  close(): void;
}

export interface Port {
  readonly transport: Transport;
  /**
   * Resolves once the transport has taken the frame. A transport that
   * knows when the frame was written out resolves then, and a slow
   * reader is felt by whoever waits; one that knows nothing resolves at
   * once.
   */
  send(data: unknown): Promise<void>;
  /** one set of handlers, installed before anything is sent */
  listen(handlers: PortHandlers): void;
  close(): void;
}

export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "messageerror" | "close", listener: (event: { data?: unknown }) => void): void;
  start?(): void;
  close?(): void;
}

/**
 * A `MessagePort`, a `Worker` or a worker's own global scope as a
 * structured-clone port. A message port says when its other end is
 * gone and the port closes with it; a worker says nothing, and whoever
 * ends the worker closes this port.
 */
export function messagePortOf(target: MessagePortLike): Port {
  let handlers: PortHandlers | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    target.close?.();
    handlers?.close();
  };
  return {
    transport: "clone",
    async send(data) {
      if (!closed) target.postMessage(data);
    },
    listen(installed) {
      handlers = installed;
      target.addEventListener("message", (event) => {
        if (!closed) installed.message(event.data);
      });
      target.addEventListener("messageerror", close);
      target.addEventListener("close", close);
      target.start?.();
    },
    close,
  };
}

export interface WebSocketLike {
  readonly readyState: number;
  /** the bytes handed to `send` and not yet written to the network */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

export interface WebSocketOptions {
  /** the most bytes the socket may hold unwritten before a send waits for it to drain; 1 MiB unless set */
  maxBufferedBytes?: number;
}

const CONNECTING = 0;
const OPEN = 1;
const DEFAULT_MAX_BUFFERED_BYTES = 1 << 20;
const DRAIN_POLL_MS = 20;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A WebSocket, connecting or open, as a text port. A frame sent before
 * the socket opens waits for that; a frame sent while the socket holds
 * more than `maxBufferedBytes` unwritten waits until it does not, since
 * `send` only queues and a slow reader is felt nowhere else.
 */
export function webSocketOf(socket: WebSocketLike, options: WebSocketOptions = {}): Port {
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const opened =
    socket.readyState === CONNECTING
      ? new Promise<void>((resolve) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("close", () => resolve());
        })
      : Promise.resolve();
  return {
    transport: "text",
    async send(data) {
      await opened;
      if (socket.readyState !== OPEN) return;
      socket.send(data as string);
      while (socket.readyState === OPEN && socket.bufferedAmount > maxBuffered) await pause(DRAIN_POLL_MS);
    },
    listen(handlers) {
      let ended = false;
      socket.addEventListener("message", (event) => handlers.message(event.data));
      socket.addEventListener("close", () => {
        if (ended) return;
        ended = true;
        handlers.close();
      });
    },
    close() {
      socket.close();
    },
  };
}
