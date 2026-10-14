import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messagePortOf, webSocketOf, type MessagePortLike, type WebSocketLike } from "../../src/wire/index.js";

type Listener = (event: { data: unknown }) => void;

const fakeMessagePort = () => {
  const listeners: Record<string, Listener[]> = {};
  const target: MessagePortLike & { posted: unknown[]; transferred: unknown[][]; started: number; closed: number; fire(type: string, data?: unknown): void } = {
    posted: [],
    transferred: [],
    started: 0,
    closed: 0,
    postMessage(message, transfer) {
      this.posted.push(message);
      this.transferred.push(transfer);
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
  it("posts a frame with its buffer transferred, starts the port once listening, and closes both ways", async () => {
    const target = fakeMessagePort();
    const port = messagePortOf(target);
    const received: Uint8Array[] = [];
    let closed = 0;
    port.listen({ message: (data) => received.push(data), close: () => closed++ });
    expect(target.started).toBe(1);
    const frame = new Uint8Array([1, 2]);
    await port.send(frame);
    expect(target.posted[0]).toBe(frame);
    expect(target.transferred[0]).toEqual([frame.buffer]);
    target.fire("message", new Uint8Array([3]));
    expect(received).toEqual([new Uint8Array([3])]);
    port.close();
    expect(target.closed).toBe(1);
    expect(closed).toBe(1);
    port.close();
    expect(closed).toBe(1);
    await port.send(new Uint8Array([4]));
    expect(target.posted).toHaveLength(1);
    target.fire("message", new Uint8Array([5]));
    expect(received).toHaveLength(1);
  });

  it("closes on a message that is no byte array, a frame of the old structured-clone port among them", () => {
    for (const data of [{ kind: "call", id: 1, method: "attach", input: {} }, '{"kind":"hello"}', new Uint8Array(2).buffer, [1, 2]]) {
      const target = fakeMessagePort();
      const port = messagePortOf(target);
      const received: unknown[] = [];
      let closed = 0;
      port.listen({ message: (frame) => received.push(frame), close: () => closed++ });
      target.fire("message", data);
      target.fire("message", new Uint8Array(1));
      expect(received).toEqual([]);
      expect(closed).toBe(1);
      expect(target.closed).toBe(1);
    }
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
    await port.send(new Uint8Array([1]));
    expect(posted).toEqual([new Uint8Array([1])]);
    port.close();
  });
});

const fakeSocket = (readyState: number) => {
  const listeners: Record<string, Listener[]> = {};
  const socket: WebSocketLike & { readyState: number; bufferedAmount: number; sent: Uint8Array[]; closes: number; fire(type: string, data?: unknown): void; drain(bytes: number): void } = {
    readyState,
    bufferedAmount: 0,
    binaryType: "blob",
    sent: [],
    closes: 0,
    send(data) {
      this.sent.push(data);
      this.bufferedAmount += data.byteLength;
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

  it("takes binary messages as array buffers, hands each on as bytes, and closes once", () => {
    const socket = fakeSocket(1);
    const port = webSocketOf(socket);
    expect(socket.binaryType).toBe("arraybuffer");
    const received: Uint8Array[] = [];
    let closed = 0;
    port.listen({ message: (data) => received.push(data), close: () => closed++ });
    socket.fire("message", new Uint8Array([1, 2]).buffer);
    expect(received).toEqual([new Uint8Array([1, 2])]);
    port.close();
    socket.fire("close");
    expect(closed).toBe(1);
    expect(socket.closes).toBe(1);
  });

  it("closes on a text message, a frame of the old text port among them, and hands on nothing after it", () => {
    const socket = fakeSocket(1);
    const port = webSocketOf(socket);
    const received: Uint8Array[] = [];
    let closed = 0;
    port.listen({ message: (data) => received.push(data), close: () => closed++ });
    socket.fire("message", '{"kind":"hello","wire":1,"apis":[1]}');
    socket.fire("message", new Uint8Array([1]).buffer);
    expect(received).toEqual([]);
    expect(socket.closes).toBe(1);
    expect(closed).toBe(1);
  });

  it("holds a frame sent while connecting until the socket opens", async () => {
    const socket = fakeSocket(0);
    const port = webSocketOf(socket);
    port.listen({ message() {}, close() {} });
    const sent = port.send(new Uint8Array([1]));
    expect(socket.sent).toEqual([]);
    socket.readyState = 1;
    socket.fire("open");
    await sent;
    expect(socket.sent).toEqual([new Uint8Array([1])]);
  });

  it("drops a frame for a socket that closed before opening, without hanging", async () => {
    const socket = fakeSocket(0);
    const port = webSocketOf(socket);
    port.listen({ message() {}, close() {} });
    const sent = port.send(new Uint8Array([1]));
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
    void port.send(new Uint8Array(80)).then(() => taken++);
    await settle();
    expect(taken).toBe(1);
    void port.send(new Uint8Array(80)).then(() => taken++);
    await settle();
    expect(taken).toBe(1);
    expect(socket.bufferedAmount).toBe(160);
    socket.drain(100);
    await settle();
    expect(taken).toBe(2);
    void port.send(new Uint8Array(200)).then(() => taken++);
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
    await port.send(new Uint8Array(100));
    expect(socket.sent).toHaveLength(1);
  });
});
