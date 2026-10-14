import { WebSocket as PeerSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { connect } from "../../src/client/index.js";
import { API_VERSION, WIRE_VERSION, type Baseline, type CallError, type Hello, type Limits, type State } from "../../src/contract/index.js";
import { messagePortOf, ownFrame, readBootstrap, readFrame, serveApi, webSocketOf, writeBootstrap, writeFrame, type MethodHandlers, type Port, type ServeOptions, type Session } from "../../src/wire/index.js";
import { handlers } from "../client/daemons.js";
import { linesState, openState } from "../contract/fixtures.js";
import { cbor } from "./ports.js";

const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };
const baseline: Baseline = { state: openState, lines: linesState };
const limits: Limits = { maxFrameBytes: 100_000, maxBackupBytes: 100 };
const noMethods = {} as MethodHandlers;

const attach = () => writeFrame(ownFrame({ kind: "call", id: 1, method: "attach", input: {} }));

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

const outcome = <T>(promise: Promise<T>): Promise<T | CallError> => promise.then((value) => value, (error: CallError) => error);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("a session over Node's message channel", () => {
  it("ends, and tells the host, when the view's end of the channel closes", async () => {
    const channel = new MessageChannel();
    const session = serveApi(messagePortOf(channel.port1), { methods: noMethods, limits, implementation: "test", attach: () => baseline });
    let closed = 0;
    session.onClose(() => closed++);
    const view = inbox((listener) => channel.port2.addEventListener("message", listener));
    channel.port2.start();
    channel.port2.postMessage(writeBootstrap(hello));
    expect(readBootstrap(await view.next())).toMatchObject({ kind: "welcome" });
    channel.port2.postMessage(attach());
    expect(readFrame(await view.next())).toMatchObject({ kind: "result", id: 1 });
    expect(session.attached).toBe(true);
    channel.port2.close();
    await until(() => session.closed);
    expect(closed).toBe(1);
  });

  it("takes a frame's buffer to the other end rather than copying it", async () => {
    const channel = new MessageChannel();
    const view = inbox((listener) => channel.port2.addEventListener("message", listener));
    channel.port2.start();
    const port = messagePortOf(channel.port1);
    port.listen({ message() {}, close() {} });
    const frame = writeBootstrap(hello);
    await port.send(frame);
    expect(frame.buffer.byteLength).toBe(0);
    expect(readBootstrap(await view.next())).toEqual(hello);
    port.close();
  });
});

describe("a session over a real WebSocket", () => {
  it("holds no more than its bound for a view that stops reading, and ends when what it owes no longer fits", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const connected = new Promise<PeerSocket>((resolve) => server.on("connection", resolve));
    const peer = new PeerSocket(`ws://127.0.0.1:${server.address().port}`);
    const socket = await connected;
    try {
      if (peer.readyState !== PeerSocket.OPEN) await new Promise<void>((resolve) => peer.addEventListener("open", () => resolve()));
      const maxBufferedBytes = 64 * 1024;
      const session = serveApi(webSocketOf(socket, { maxBufferedBytes }), { methods: noMethods, limits, implementation: "test", attach: () => baseline, maxQueuedFrames: 2 });
      const view = inbox((listener) => peer.addEventListener("message", listener));
      peer.send(writeBootstrap(hello));
      expect(readBootstrap(await view.next())).toMatchObject({ kind: "welcome" });
      peer.send(attach());
      expect(readFrame(await view.next())).toMatchObject({ kind: "result" });
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

const MiB = 1 << 20;
const large: Limits = { maxFrameBytes: 8 * MiB + 64 * 1024, maxBackupBytes: 8 * MiB };

const backupOf = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
};

/** The first index at which the two differ, or -1; arrays this large are slow to compare whole. */
const mismatch = (a: Uint8Array, b: Uint8Array): number => {
  if (a.byteLength !== b.byteLength) return Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return i;
  return -1;
};

const kinds = ["message channel", "WebSocket"] as const;

interface Served {
  /** the view's end */
  view: Port;
  /** the view's socket, on a WebSocket */
  socket: WebSocket | null;
  session: Session;
  /** the backups `restoreIdentity` was handed */
  restored: Uint8Array[];
  /** how many messages the session's port handed it */
  heard(): number;
}

/** A session over a real port of `kind`, behind a daemon that takes backups and locks. */
async function served(kind: (typeof kinds)[number], bounds: Limits): Promise<Served> {
  const restored: Uint8Array[] = [];
  let heard = 0;
  const counted = (port: Port): Port => ({
    ...port,
    listen: (installed) =>
      port.listen({
        message(data) {
          heard++;
          installed.message(data);
        },
        close: () => installed.close(),
      }),
  });
  const options: ServeOptions = {
    methods: handlers({
      restoreIdentity: (input) => {
        restored.push(input.backup);
        return null;
      },
      lock: () => null,
    }),
    limits: bounds,
    implementation: "test",
    attach: () => baseline,
  };
  if (kind === "message channel") {
    const channel = new MessageChannel();
    const session = serveApi(counted(messagePortOf(channel.port1)), options);
    cleanups.push(async () => {
      channel.port1.close();
      channel.port2.close();
    });
    return { view: messagePortOf(channel.port2), socket: null, session, restored, heard: () => heard };
  }
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: bounds.maxFrameBytes });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const accepted = new Promise<PeerSocket>((resolve) => server.on("connection", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const peer = await accepted;
  // A message over `maxPayload` is an error on the server's socket, which closes it; unheard, the error would end the process.
  peer.on("error", () => undefined);
  const session = serveApi(counted(webSocketOf(peer)), options);
  cleanups.push(async () => {
    socket.close();
    peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { view: webSocketOf(socket), socket, session, restored, heard: () => heard };
}

/** The view's end listened to frame by frame, said hello and attached. */
async function attached(s: Served) {
  const frames: Uint8Array[] = [];
  let closed = false;
  s.view.listen({ message: (data) => frames.push(data), close: () => (closed = true) });
  await s.view.send(writeBootstrap(hello));
  await s.view.send(attach());
  await until(() => frames.length === 2);
  return { frames, closed: () => closed, read: () => frames.map((data) => readFrame(data) ?? readBootstrap(data)) };
}

describe.each(kinds)("an 8 MiB backup over a real %s", (kind) => {
  it("arrives byte for byte through the client, and is answered", async () => {
    const s = await served(kind, large);
    const client = connect(s.view);
    await client.connected();
    expect(await client.daemon.restoreIdentity({ backup: backupOf(8 * MiB), passphrase: "p" })).toBeNull();
    expect(s.restored).toHaveLength(1);
    expect(mismatch(s.restored[0]!, backupOf(8 * MiB))).toBe(-1);
    client.close();
  });

  it("over the backup bound, in a frame within the frame bound, is refused unread and the next call is answered", async () => {
    const s = await served(kind, large);
    const view = await attached(s);
    const frame = cbor({ kind: "call", id: 2, method: "restoreIdentity", input: { backup: new Uint8Array(large.maxBackupBytes + 1), passphrase: "p" } });
    expect(frame.byteLength).toBeLessThanOrEqual(large.maxFrameBytes);
    await s.view.send(frame);
    await s.view.send(writeFrame(ownFrame({ kind: "call", id: 3, method: "lock", input: {} })));
    await until(() => view.frames.length === 4);
    expect(view.read().slice(2)).toEqual([
      { kind: "error", id: 2, error: { code: "ResourceLimit", message: expect.stringMatching(/over 8388608/) as string, effect: "none", messageId: null } },
      { kind: "result", id: 3, value: null },
    ]);
    expect(s.restored).toEqual([]);
    expect(s.session.closed).toBe(false);
  });

  it("in a frame over the frame bound is refused by the client once written, nothing sent, and the next call goes", async () => {
    const s = await served(kind, { ...large, maxFrameBytes: 4 * MiB });
    const client = connect(s.view);
    await client.connected();
    const heard = s.heard();
    expect(await outcome(client.daemon.restoreIdentity({ backup: backupOf(8 * MiB), passphrase: "p" }))).toEqual({ origin: "client", code: "ResourceLimit", message: expect.stringMatching(/4194304 bytes/) as string, effect: "none", messageId: null });
    expect(await client.daemon.lock({})).toBeNull();
    expect(s.heard()).toBe(heard + 1);
    expect(s.restored).toEqual([]);
    client.close();
  });
});

describe("a frame over the frame bound sent past the client", () => {
  const oversized = () => cbor({ kind: "call", id: 2, method: "restoreIdentity", input: { backup: new Uint8Array(large.maxFrameBytes), passphrase: "p" } });

  it("over a message channel ends the session with a ResourceLimit fault, its call unread", async () => {
    const s = await served("message channel", large);
    const view = await attached(s);
    await s.view.send(oversized());
    await until(() => view.closed());
    expect(view.read().slice(2)).toEqual([{ kind: "fault", error: { code: "ResourceLimit", message: expect.any(String) as string, effect: "none", messageId: null } }]);
    expect(s.session.closed).toBe(true);
    expect(s.restored).toEqual([]);
  });

  it("over a WebSocket is closed by the socket with 1009, before the session hears it", async () => {
    const s = await served("WebSocket", large);
    let code: number | undefined;
    s.socket!.addEventListener("close", (event) => (code = event.code));
    const view = await attached(s);
    const heard = s.heard();
    await s.view.send(oversized());
    await until(() => view.closed());
    expect(code).toBe(1009);
    expect(s.heard()).toBe(heard);
    expect(s.restored).toEqual([]);
    await until(() => s.session.closed);
  });
});
