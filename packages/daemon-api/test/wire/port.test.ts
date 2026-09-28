import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messagePortOf, webSocketOf, type MessagePortLike, type WebSocketLike } from "../../src/wire/index.js";

type Listener = (event: { data: unknown }) => void;

const fakeMessagePort = () => {
  const listeners: Record<string, Listener[]> = {};
  const target: MessagePortLike & { posted: unknown[]; started: number; closed: number; fire(type: string, data?: unknown): void } = {
    posted: [],
    started: 0,
    closed: 0,
    postMessage(message) {
      this.posted.push(message);
    },
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    start() {
      this.started++;
    },
    close() {
      this.closed++;
    },
    fire(type, data) {
      for (const listener of listeners[type] ?? []) listener({ data });
    },
  };
  return target;
};

describe("a message port as a port", () => {
  it("posts values as they are, starts the port once listening, and closes both ways", async () => {
    const target = fakeMessagePort();
    const port = messagePortOf(target);
    const received: unknown[] = [];
    let closed = 0;
    port.listen({ message: (data) => received.push(data), close: () => closed++ });
    expect(target.started).toBe(1);
    const value = { bytes: new Uint8Array([1]) };
    await port.send(value);
    expect(target.posted[0]).toBe(value);
    target.fire("message", { kind: "call" });
    expect(received).toEqual([{ kind: "call" }]);
    port.close();
    expect(target.closed).toBe(1);
    expect(closed).toBe(1);
    port.close();
    expect(closed).toBe(1);
    await port.send("late");
    expect(target.posted).toHaveLength(1);
    target.fire("message", "after");
    expect(received).toHaveLength(1);
  });

  it("closes on a message that could not be deserialized", () => {
    const target = fakeMessagePort();
    const port = messagePortOf(target);
    let closed = 0;
    port.listen({ message: () => {}, close: () => closed++ });
    target.fire("messageerror");
    expect(closed).toBe(1);
    expect(target.closed).toBe(1);
  });

  it("closes when the target says its other end is gone", () => {
    const target = fakeMessagePort();
    const port = messagePortOf(target);
    let closed = 0;
    port.listen({ message: () => {}, close: () => closed++ });
    target.fire("close");
    expect(closed).toBe(1);
    target.fire("close");
    port.close();
    expect(closed).toBe(1);
  });

  it("takes a target with neither start nor close", async () => {
    const posted: unknown[] = [];
    const port = messagePortOf({ postMessage: (message) => posted.push(message), addEventListener() {} });
    port.listen({ message() {}, close() {} });
    await port.send(1);
    expect(posted).toEqual([1]);
    port.close();
  });
});

const fakeSocket = (readyState: number) => {
  const listeners: Record<string, Listener[]> = {};
  const socket: WebSocketLike & { readyState: number; bufferedAmount: number; sent: string[]; closes: number; fire(type: string, data?: unknown): void; drain(bytes: number): void } = {
    readyState,
    bufferedAmount: 0,
    sent: [],
    closes: 0,
    send(data) {
      this.sent.push(data);
      this.bufferedAmount += data.length;
    },
    drain(bytes) {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    },
    close() {
      this.closes++;
      this.readyState = 3;
      this.fire("close");
    },
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    fire(type, data) {
      for (const listener of listeners[type] ?? []) listener({ data });
    },
  };
  return socket;
};

describe("a WebSocket as a port", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is a text port that hands frames on and closes once", () => {
    const socket = fakeSocket(1);
    const port = webSocketOf(socket);
    expect(port.transport).toBe("text");
    const received: unknown[] = [];
    let closed = 0;
    port.listen({ message: (data) => received.push(data), close: () => closed++ });
    socket.fire("message", '{"kind":"call"}');
    socket.fire("message", new Uint8Array(1));
    expect(received).toEqual(['{"kind":"call"}', new Uint8Array(1)]);
    port.close();
    socket.fire("close");
    expect(closed).toBe(1);
    expect(socket.closes).toBe(1);
  });

  it("holds a frame sent while connecting until the socket opens", async () => {
    const socket = fakeSocket(0);
    const port = webSocketOf(socket);
    port.listen({ message() {}, close() {} });
    const sent = port.send("first");
    expect(socket.sent).toEqual([]);
    socket.readyState = 1;
    socket.fire("open");
    await sent;
    expect(socket.sent).toEqual(["first"]);
  });

  it("drops a frame for a socket that closed before opening, without hanging", async () => {
    const socket = fakeSocket(0);
    const port = webSocketOf(socket);
    port.listen({ message() {}, close() {} });
    const sent = port.send("never");
    socket.close();
    await sent;
    expect(socket.sent).toEqual([]);
  });

  it("holds a send while the socket has more than its bound unwritten, until it drains or closes", async () => {
    const socket = fakeSocket(1);
    const port = webSocketOf(socket, { maxBufferedBytes: 100 });
    port.listen({ message() {}, close() {} });
    let taken = 0;
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(50);
    };
    void port.send("x".repeat(80)).then(() => taken++);
    await settle();
    expect(taken).toBe(1);
    void port.send("y".repeat(80)).then(() => taken++);
    await settle();
    expect(taken).toBe(1);
    expect(socket.bufferedAmount).toBe(160);
    socket.drain(100);
    await settle();
    expect(taken).toBe(2);
    void port.send("z".repeat(200)).then(() => taken++);
    await settle();
    expect(taken).toBe(2);
    socket.close();
    await settle();
    expect(taken).toBe(3);
  });

  it("takes a send at once while the socket holds no more than its bound", async () => {
    const socket = fakeSocket(1);
    const port = webSocketOf(socket, { maxBufferedBytes: 100 });
    port.listen({ message() {}, close() {} });
    await port.send("x".repeat(100));
    expect(socket.sent).toHaveLength(1);
  });
});
