import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { connect, type Client } from "@estoc/daemon-api/client";
import type { Snapshot } from "@estoc/daemon-api/contract";
import { webSocketOf } from "@estoc/daemon-api/wire";
import type { Channel } from "@estoc/vault";

import { channelIdOf } from "../src/channels.js";
import type { DaemonCore, DaemonHost } from "../src/index.js";
import { TOKEN_FILE, nodeHost, runDaemon, serveDaemon, type Served } from "../src/node/index.js";

const PASSPHRASE = "alice-passes-the-salt";

const roots: string[] = [];
const served: Served[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await Promise.all(served.splice(0).map((server) => server.close()));
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-socket-"));
  roots.push(root);
  return root;
}

async function serve(host: DaemonHost, options: Partial<Parameters<typeof serveDaemon>[0]> = {}): Promise<Served> {
  const server = await serveDaemon({ host, port: 0, token: "t0k3n", ...options });
  served.push(server);
  return server;
}

async function connected(url: string): Promise<Client> {
  const client = connect(webSocketOf(new globalThis.WebSocket(url)));
  await client.connected();
  return client;
}

async function frameClient(url: string): Promise<{ say(frame: unknown): void; text(data: string | Buffer): void; next(): Promise<unknown>; closed: Promise<number>; close(): void }> {
  const ws = new WebSocket(url);
  const received: unknown[] = [];
  const waiting: ((frame: unknown) => void)[] = [];
  ws.on("message", (data) => {
    const frame: unknown = JSON.parse(data.toString());
    const waiter = waiting.shift();
    if (waiter === undefined) received.push(frame);
    else waiter(frame);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    say: (frame) => ws.send(JSON.stringify(frame)),
    text: (data) => ws.send(data, { binary: false }),
    next: () => (received.length > 0 ? Promise.resolve(received.shift()) : new Promise((resolve) => waiting.push(resolve))),
    closed,
    close: () => ws.close(),
  };
}

const HELLO = { kind: "hello", wire: 1, apis: [1] };

async function until(what: string, condition: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not, after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pairWith = (peer: string): Channel => ({ localDid: "did:peer:4zQmAnna", peerDid: `did:peer:4zQm${peer}` }) as Channel;

const snapshotOf = (client: Client): Snapshot => {
  const { value } = client.state!;
  if (value.phase !== "open") throw new Error(`the state is ${value.phase}`);
  return value.snapshot;
};

describe("the endpoint", () => {
  it("negotiates and attaches while the files are another daemon's, and shows that", async () => {
    const root = await folder();
    const owner = await serve(nodeHost(root));
    await owner.daemon.boot();
    const other = await serve(nodeHost(root));
    const waiting = other.daemon.boot();
    const client = await connected(other.url);
    await until("the view is shown the wait", () => client.state?.value.phase === "elsewhere");
    expect(client.connection).toMatchObject({ state: "connected", limits: { maxBackupBytes: 512 * 1024 * 1024, maxDepth: 64 } });
    expect(client.lines).toMatchObject({ value: { connections: [], waiting: [], discarded: [] } });
    await expect(client.daemon.createIdentity({ name: "Mallory", passphrase: PASSPHRASE })).rejects.toMatchObject({ code: "WrongPhase", message: "the vault is held elsewhere", effect: "none" });
    await other.close();
    served.splice(served.indexOf(other), 1);
    await waiting;
    await until("the view is told the connection ended", () => client.connection.state === "disconnected");
  });

  it("refuses a restore over the backup bound before touching the destination, on the daemon's side as well as the view's", async () => {
    const root = await folder();
    const server = await serve(nodeHost(root), { maxBackupBytes: 64 });
    await server.daemon.boot();
    const client = await connected(server.url);
    expect(client.connection).toMatchObject({ state: "connected", limits: { maxBackupBytes: 64, maxValueBytes: 64 + 64 * 1024, maxFrameBytes: Math.ceil((64 * 4) / 3) + 64 * 1024 } });
    await expect(client.daemon.restoreIdentity({ backup: new Uint8Array(65), passphrase: PASSPHRASE })).rejects.toMatchObject({ origin: "client", code: "ResourceLimit", effect: "none" });

    const raw = await frameClient(server.url);
    raw.say(HELLO);
    await raw.next();
    raw.say({ kind: "call", id: 1, method: "attach", input: {} });
    await raw.next();
    const backup = { encoding: "base64", data: Buffer.alloc(65, 1).toString("base64") };
    raw.say({ kind: "call", id: 2, method: "restoreIdentity", input: { backup, passphrase: PASSPHRASE } });
    expect(await raw.next()).toEqual({ kind: "error", id: 2, error: { code: "ResourceLimit", message: expect.stringMatching(/backup decodes to 65 bytes, over 64/) as string, effect: "none", messageId: null } });
    raw.say({ kind: "call", id: 3, method: "mergeBackup", input: { backup } });
    expect(await raw.next()).toMatchObject({ kind: "error", id: 3, error: { code: "ResourceLimit", effect: "none" } });
    expect(client.state?.value.phase).toBe("onboarding");
    await expect(stat(path.join(root, ".estoc", "vault.sqlite"))).rejects.toThrow();
    expect((await readdir(path.join(root, ".estoc"))).filter((name) => !/^owner\.sqlite/.test(name))).toEqual([]);
    raw.close();
  });

  it("lets in a bounded number of sockets that have not attached, and closes the one over it at once", async () => {
    const server = await serve(nodeHost(await folder()));
    await server.daemon.boot();
    const idle = [];
    for (let i = 0; i < 16; i++) idle.push(await frameClient(server.url));
    const over = await frameClient(server.url);
    expect(await over.closed).toBe(1013);
    const attached = await connected(server.url).catch((error: unknown) => error);
    expect(attached).toMatchObject({ origin: "client", code: "TransportDisconnected" });

    idle[0]!.say(HELLO);
    await idle[0]!.next();
    idle[0]!.say({ kind: "call", id: 1, method: "attach", input: {} });
    expect(await idle[0]!.next()).toMatchObject({ kind: "result", id: 1 });
    const room = await connected(server.url);
    expect(room.connection.state).toBe("connected");
    for (const talk of idle) talk.close();
  });

  it("closes the socket a frame it will not take came over, and goes on serving the rest", async () => {
    const server = await serve(nodeHost(await folder()), { maxBackupBytes: 64 });
    await server.daemon.boot();
    const oversized = await frameClient(server.url);
    oversized.text("x".repeat(Math.ceil((64 * 4) / 3) + 64 * 1024 + 1));
    expect(await oversized.closed).toBe(1009);
    const garbled = await frameClient(server.url);
    garbled.text(Buffer.from([0xff]));
    expect(await garbled.closed).toBe(1007);

    const client = await connected(server.url);
    expect(client.state?.value.phase).toBe("onboarding");
    const idle = [];
    for (let i = 0; i < 16; i++) idle.push(await frameClient(server.url));
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const talk of idle) expect(await Promise.race([talk.closed, "open"])).toBe("open");
    for (const talk of idle) talk.close();
  });

  it("ends every attached session as unavailable when a read fails, refuses one that joins meanwhile, and takes the next once a read is through", async () => {
    const root = await folder();
    const server = await serve(nodeHost(root));
    const { publisher } = server.daemon;
    let failing = 0;
    const opening = publisher.open.bind(publisher);
    publisher.open = (hold, source) =>
      opening(hold, {
        capture: async (cut) => {
          const snapshot = await source.capture(cut);
          if (failing-- > 0) throw new Error("the disk went away");
          return snapshot;
        },
      });
    await server.daemon.boot();
    const first = await connected(server.url);
    await first.daemon.createIdentity({ name: "Alice", passphrase: PASSPHRASE });

    failing = 1;
    await expect(first.daemon.createContact({ petname: "Bob", channelIds: [channelIdOf(pairWith("Bob"))] })).rejects.toMatchObject({ origin: "client", code: "TransportDisconnected", effect: "possible" });
    expect(first.connection).toEqual({ state: "disconnected", because: { origin: "daemon", code: "StateUnavailable", message: expect.any(String) as string, effect: "none", messageId: null } });
    expect(snapshotOf(first).contacts).toEqual([]);

    // The read the joining view asks for is made, and succeeds: the view after it is taken.
    const joining = await connected(server.url).catch((error: unknown) => error);
    expect(joining).toMatchObject({ origin: "daemon", code: "StateUnavailable" });
    await until("the state is fit to attach to again", () => publisher.unavailable === null);
    const next = await connected(server.url);
    expect(snapshotOf(next).contacts).toHaveLength(1);
  });
});

describe("the token of a folder", () => {
  const tokenOf = (lines: string[]): string | undefined => lines.find((line) => line.startsWith("socket:"))?.match(/token=([^&\s]+)/)?.[1];

  it("is minted once for two daemons that start on a fresh folder at once, and kept to its owner", async () => {
    const root = await folder();
    const logs: [string[], string[]] = [[], []];
    const starts = logs.map((lines, index) => runDaemon({ root, port: 0, appDir: null, log: (line) => lines.push(line) }).then((server) => ({ index, server })));
    await until("both daemons listen", () => logs.every((lines) => tokenOf(lines) !== undefined));
    expect(tokenOf(logs[0])).toBe(tokenOf(logs[1]));
    expect(tokenOf(logs[0])).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const file = path.join(root, ".estoc", TOKEN_FILE);
    expect(await readFile(file, "utf8")).toBe(tokenOf(logs[0]));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(path.join(root, ".estoc"))).filter((name) => name.startsWith(TOKEN_FILE))).toEqual([TOKEN_FILE]);

    const { index, server: first } = await Promise.race(starts);
    await first.close();
    const second = (await starts[1 - index]!).server;
    expect(await readFile(file, "utf8")).toBe(tokenOf(logs[0]));
    await second.close();
  });

  it("is not opened under a file that holds no token, and leaves the file as it is", async () => {
    for (const held of ["", "not a token!\n", "\n"]) {
      const root = await folder();
      const dir = path.join(root, ".estoc");
      await rm(dir, { recursive: true, force: true });
      await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
      const file = path.join(dir, TOKEN_FILE);
      await writeFile(file, held);
      const lines: string[] = [];
      await expect(runDaemon({ root, port: 0, appDir: null, log: (line) => lines.push(line) })).rejects.toThrow(/does not hold a token/);
      expect(lines).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(held);
      expect(await readdir(dir)).toEqual([TOKEN_FILE]);
    }
  });
});
