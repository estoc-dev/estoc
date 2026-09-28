import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

import { API_VERSION, WIRE_VERSION, type Baseline, type Hello, type Limits, type State } from "../../src/contract/index.js";
import { messagePortOf, serveApi, webSocketOf, writeBootstrap, writeFrame, type MethodHandlers, type Transport } from "../../src/wire/index.js";
import { linesState, openState } from "../contract/fixtures.js";

const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };
const baseline: Baseline = { state: openState, lines: linesState };
const limits: Limits = { maxFrameBytes: 100_000, maxBackupBytes: 100, maxValueBytes: 50_000, maxDepth: 8 };
const noMethods = {} as MethodHandlers;

const attach = (transport: Transport) => writeFrame({ kind: "call", id: 1 as never, method: "attach", input: {} }, transport);

/** What one side of a real port receives, taken one at a time. */
const inbox = (listen: (listener: (event: { data?: unknown }) => void) => void) => {
  const queue: unknown[] = [];
  const waiting: ((data: unknown) => void)[] = [];
  listen((event) => {
    const take = waiting.shift();
    if (take === undefined) queue.push(event.data);
    else take(event.data);
  });
  return { next: (): Promise<unknown> => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve))) };
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !condition(); i++) await wait(10);
  expect(condition()).toBe(true);
};

describe("a session over Node's message channel", () => {
  it("ends, and tells the host, when the view's end of the channel closes", async () => {
    const channel = new MessageChannel();
    const session = serveApi(messagePortOf(channel.port1), { methods: noMethods, limits: { ...limits, maxFrameBytes: null }, implementation: "test", attach: () => baseline });
    let closed = 0;
    session.onClose(() => closed++);
    const view = inbox((listener) => channel.port2.addEventListener("message", listener));
    channel.port2.start();
    channel.port2.postMessage(writeBootstrap(hello, "clone"));
    expect(await view.next()).toMatchObject({ kind: "welcome" });
    channel.port2.postMessage(attach("clone"));
    expect(await view.next()).toMatchObject({ kind: "result", id: 1 });
    expect(session.attached).toBe(true);
    channel.port2.close();
    await until(() => session.closed);
    expect(closed).toBe(1);
  });
});

describe("a session over a real WebSocket", () => {
  it("holds no more than its bound for a view that stops reading, and ends when what it owes no longer fits", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const connected = new Promise<WebSocket>((resolve) => server.on("connection", resolve));
    const peer = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const socket = await connected;
    try {
      if (peer.readyState !== WebSocket.OPEN) await new Promise<void>((resolve) => peer.addEventListener("open", () => resolve()));
      const maxBufferedBytes = 64 * 1024;
      const session = serveApi(webSocketOf(socket, { maxBufferedBytes }), { methods: noMethods, limits, implementation: "test", attach: () => baseline, maxQueuedFrames: 2 });
      const view = inbox((listener) => peer.addEventListener("message", listener));
      peer.send(writeBootstrap(hello, "text") as string);
      expect(await view.next()).toMatch(/"kind":"welcome"/);
      peer.send(attach("text") as string);
      expect(await view.next()).toMatch(/"kind":"result"/);
      peer.pause();

      const open = openState.value as Extract<State["value"], { phase: "open" }>;
      const frameBytes = 256 * 1024;
      const state = (epoch: string, revision: number): State => ({ ...openState, epoch: epoch as never, revision: revision as never, value: { ...open, snapshot: { ...open.snapshot, label: "x".repeat(frameBytes) } } });
      let most = 0;
      for (let revision = 2; revision < 66; revision++) {
        session.event("state", state("epoch-1", revision));
        await wait(5);
        most = Math.max(most, socket.bufferedAmount);
      }
      expect(most).toBeLessThanOrEqual(maxBufferedBytes + frameBytes + 1024);
      expect(session.closed).toBe(false);

      for (let epoch = 2; epoch < 6; epoch++) session.event("state", state(`epoch-${epoch}`, 1));
      await until(() => session.closed);
      expect(socket.bufferedAmount).toBeLessThanOrEqual(maxBufferedBytes + frameBytes + 1024);
    } finally {
      peer.terminate();
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
