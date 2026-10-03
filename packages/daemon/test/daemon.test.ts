import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, test } from "vitest";

import { SqliteVault, exportVault, openPortable, restoreVault, type SqliteDriver } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { unlockSeedKeystore } from "@estoc/keystore";
import { EMPTY_MESSAGE_TYPE, Keys, PING_TYPE, PURE_ACK_EFFECT, canonicalDidOf, vaultDraft, vaultHeldRoots, type Channel, type Did, type DidId, type ExecutionId, type MediationId, type MintedDid } from "@estoc/vault";

import { ACCOUNT_REGISTER, PROFILE, RECIPIENT_ADD, STATUS_REQUEST, decide } from "@estoc/agent-core";
import { connect, type Client } from "@estoc/daemon-api/client";
import type { Hold, Lines, Phase, Snapshot, State } from "@estoc/daemon-api/contract";
import { indexSnapshot } from "@estoc/daemon-api/views";
import { webSocketOf } from "@estoc/daemon-api/wire";
import { FORWARD } from "../../agent-core/src/protocol/spec.js";
import { issuerRecovered, newMediator, peerSealer, proofOfSuccession, sealed, type Addressed, type DirectParty } from "../../agent-core/test/helpers.js";
import type { FakeMediator } from "../../agent-core/test/fake-mediator.js";
import { channelOf, forwarded, run, stopAll } from "../../agent-core/test/e2e/running.js";
import { createDaemon, type DaemonCore, type DaemonHost } from "../src/index.js";
import { nodeHost, serveDaemon } from "../src/node/index.js";
import { channelIdOf, channelOf as pairOf } from "../src/channels.js";
import { published } from "./snapshots.js";

const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const PASSPHRASE = "alice-passes-the-salt";
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const LONG = 300_000;

const roots: string[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await stopAll();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
  roots.push(root);
  return root;
}

/** What one subscriber of the publisher was told, in order, and the latest of each. */
interface Told {
  /** `phase` for a state that shows no runtime, `opened` for a runtime's first read and `changed` for the reads after it, `lines` while a runtime is shown, `log`, and `unavailable` for a read that failed */
  events: [string, ...unknown[]][];
  phases(): string[];
  /** the hold the last state carried */
  hold(): Hold | null;
  /** the last open state's snapshot */
  snapshot(): Snapshot;
  lines(): Lines | null;
}

/** A subscriber attached to the daemon's publisher now, told of everything published from here on; refused while the state is stale. */
function listening(daemon: DaemonCore): Told {
  const events: [string, ...unknown[]][] = [];
  let hold: Hold | null = null;
  let shown = false;
  daemon.publisher.attach({
    state: ({ revision, value }) => {
      hold = value.hold;
      shown = value.phase === "open";
      if (value.phase === "open") events.push([revision === 1 ? "opened" : "changed", value.snapshot, value.hold]);
      else events.push(["phase", value.phase, value.detail, value.hold]);
    },
    lines: ({ value }) => {
      if (shown) events.push(["lines", value]);
    },
    log: ({ line }) => events.push(["log", line]),
    unavailable: (error) => events.push(["unavailable", error]),
  });
  const last = (...names: string[]) => events.filter(([name]) => names.includes(name)).at(-1);
  return {
    events,
    phases: () => events.filter(([name]) => name === "phase").map(([, phase]) => phase as string),
    hold: () => hold,
    snapshot: () => last("opened", "changed")![1] as Snapshot,
    lines: () => (last("lines")?.[1] as Lines | undefined) ?? null,
  };
}

/** What a view attaching now is handed, and no more: the state and the lines published. */
function handed(daemon: DaemonCore): { snapshot: Snapshot | null; lines: Lines } {
  const nobody = { state: () => undefined, lines: () => undefined, log: () => undefined, unavailable: () => undefined };
  const { state, lines } = daemon.publisher.attach(nobody);
  daemon.publisher.detach(nobody);
  return { snapshot: state.value.phase === "open" ? state.value.snapshot : null, lines: lines.value };
}

async function until(what: string, condition: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not, after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A daemon over a folder, its agent's transports the mediator's when there is one. */
function daemonOver(root: string, mediator?: FakeMediator, agentOptions: Partial<NonNullable<DaemonHost["agentOptions"]>> = {}): { daemon: DaemonCore; heard: Told } {
  const host = nodeHost(root, mediator === undefined ? {} : { fetch: mediator.fetch, WebSocket: mediator.WebSocket });
  const daemon = createDaemon({ ...host, agentOptions: { ...host.agentOptions!, ...agentOptions } });
  daemons.push(daemon);
  return { daemon, heard: listening(daemon) };
}

const vaultFile = (root: string) => path.join(root, ".estoc", "vault.sqlite");

async function person(mediator: FakeMediator, name: string): Promise<{ root: string; daemon: DaemonCore; heard: Told }> {
  const root = await folder();
  const { daemon, heard } = daemonOver(root, mediator);
  await daemon.boot();
  await daemon.createIdentity(name, PASSPHRASE);
  await daemon.setMediator(mediator.did);
  return { root, daemon, heard };
}

/** The conversations of a snapshot's contacts, which carry a contact's petname and channels. */
const contactsOf = (snapshot: Snapshot) => snapshot.conversations.filter((conversation) => conversation.contactId !== null);

/** The pair a channel's continuity leads on to. */
const headOf = (channel: Snapshot["channels"][number]): Channel => pairOf(channel.headChannelId!);

/** A view over the socket: the SDK's client, and every state it was shown, the baseline first. */
interface View {
  client: Client;
  daemon: Client["daemon"];
  states: State[];
  phases(): Phase[];
  hold(): Hold | null;
  /** the last open state shown */
  snapshot(): Snapshot;
  /** how many epochs an open state was shown in */
  opened(): number;
}

async function view(url: string): Promise<View> {
  const client = connect(webSocketOf(new globalThis.WebSocket(url)));
  const states: State[] = [];
  client.onState((state) => states.push(state));
  await client.connected();
  const open = () => states.filter((state) => state.value.phase === "open");
  return {
    client,
    daemon: client.daemon,
    states,
    phases: () => states.map((state) => state.value.phase),
    hold: () => states.at(-1)!.value.hold,
    snapshot: () => {
      const last = open().at(-1)!.value;
      return last.phase === "open" ? last.snapshot : (undefined as never);
    },
    opened: () => new Set(open().map((state) => state.epoch)).size,
  };
}

async function frameClient(url: string): Promise<{ say(text: string): void; next(): Promise<unknown>; closed: Promise<number> }> {
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
    say: (text) => ws.send(text),
    next: () => (received.length > 0 ? Promise.resolve(received.shift()) : new Promise((resolve) => waiting.push(resolve))),
    closed,
  };
}

const HELLO = JSON.stringify({ kind: "hello", wire: 1, apis: [1] });
const call = (id: number, method: string, input: unknown = {}) => JSON.stringify({ kind: "call", id, method, input });

describe("the daemon over a folder", () => {
  it("lands on the screen the folder dictates, keeps the vault to itself while it holds it, and hands every record over a socket as it is", async () => {
    const root = await folder();
    const served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    daemons.push(served.daemon);
    await served.daemon.boot();
    const ui = await view(served.url);
    expect(ui.phases()).toEqual(["onboarding"]);

    await ui.daemon.createIdentity({ name: "Alice", passphrase: PASSPHRASE });
    expect(ui.snapshot()).toMatchObject({ label: "Alice", restoreUnexplained: false, mediations: [], dids: [], contacts: [], channels: [], invitations: [] });
    await stat(path.join(root, ".estoc", "vault.sqlite"));

    const late = await view(served.url);
    expect(late.snapshot().label).toBe("Alice");
    expect(late.states).toEqual([ui.states.at(-1)]);
    expect(ui.opened()).toBe(1);

    const backup = await ui.daemon.exportBackup({});
    expect(backup.bytes).toBeInstanceOf(Uint8Array);
    expect(backup.name).toMatch(/^Alice-.*\.estoc\.sqlite$/);
    expect(new TextDecoder().decode(backup.bytes.subarray(0, 15))).toBe("SQLite format 3");

    const elsewhere = createDaemon(nodeHost(root));
    daemons.push(elsewhere);
    const other = listening(elsewhere);
    const waiting = elsewhere.boot();
    await until("the second daemon says the vault is held elsewhere", () => other.phases().includes("elsewhere"));

    await ui.daemon.lock({});
    expect(ui.phases().at(-1)).toBe("locked");
    await expect(ui.daemon.unlock({ passphrase: "wrong" })).rejects.toEqual({ origin: "daemon", code: "OperationFailed", message: "wrong passphrase", effect: "none", messageId: null });
    await expect(ui.daemon.send({ target: { contactId: "018f0000-0000-7000-8000-000000000000" as never }, content: { type: BASIC_MESSAGE, body: { content: "hi" } } })).rejects.toEqual({ origin: "daemon", code: "WrongPhase", message: "no open vault", effect: "none", messageId: null });
    await ui.daemon.unlock({ passphrase: PASSPHRASE });
    expect(ui.opened()).toBe(2);
    expect(ui.snapshot().label).toBe("Alice");

    await served.close();
    await waiting;
    expect(other.phases().at(-1)).toBe("locked");
  });

  it("closes a socket whose first frame is no hello, answers a call of what is no method of the API as none, and goes on serving", async () => {
    const served = await serveDaemon({ host: nodeHost(await folder()), port: 0, token: "t0k3n" });
    try {
      await served.daemon.boot();
      for (const first of ['{"kind":"call","id":1,"method":"send","args":[{"$bytes":"not base64!"}]}', "junk", '{"kind":"hello","wire":2,"apis":[1]}', '{"kind":"welcome","wire":1,"api":1}']) {
        const raw = await frameClient(served.url);
        raw.say(first);
        await raw.closed;
      }

      const raw = await frameClient(served.url);
      raw.say(HELLO);
      expect(await raw.next()).toMatchObject({ kind: "welcome", wire: 1, api: 1, implementation: expect.stringMatching(/^estoc-daemon \d/) });
      raw.say(call(1, "attach"));
      expect(await raw.next()).toMatchObject({ kind: "result", id: 1, value: { state: { value: { phase: "onboarding" } } } });
      let id = 1;
      for (const method of ["boot", "close", "constructor", "__proto__", "publisher"]) {
        raw.say(call(++id, method));
        expect(await raw.next()).toEqual({ kind: "error", id, error: { code: "NoSuchMethod", message: expect.any(String), effect: "none", messageId: null } });
      }
      raw.say(call(++id, "send", { target: { contactId: "c" }, content: { type: BASIC_MESSAGE } }));
      expect(await raw.next()).toMatchObject({ kind: "error", id, error: { code: "InvalidArgument", effect: "none", messageId: null } });
      raw.say(JSON.stringify({ kind: "result", id: 99, value: null }));
      await raw.closed;

      const ui = await view(served.url);
      expect(ui.phases()).toEqual(["onboarding"]);
    } finally {
      await served.close();
    }
  });

  it("reads no folder-format vault, and leaves it as it is", async () => {
    const root = await folder();
    await mkdir(path.join(root, ".estoc"));
    await writeFile(path.join(root, ".estoc", "config.json"), '{"format":"estoc","version":2}');
    const daemon = createDaemon(nodeHost(root));
    daemons.push(daemon);
    const heard = listening(daemon);
    await daemon.boot();
    expect(heard.events).toEqual([["phase", "foreign", expect.stringMatching(/folder format/), null]]);
    await expect(daemon.createIdentity("Alice", PASSPHRASE)).rejects.toThrow();
    await stat(path.join(root, ".estoc", "config.json"));
    expect(await readdir(path.join(root, ".estoc"))).toEqual(["config.json"]);
  });

  it("does not open a vault written under another schema version, says which, leaves it as it is, and removes it only when asked", async () => {
    const root = await folder();
    const first = daemonOver(root);
    await first.daemon.boot();
    await first.daemon.createIdentity("Alice", PASSPHRASE);
    await first.daemon.close();
    const db = new DatabaseSync(vaultFile(root));
    try {
      db.exec("PRAGMA user_version = 1");
    } finally {
      db.close();
    }
    const writtenBytes = (await stat(vaultFile(root))).size;

    const { daemon, heard } = daemonOver(root);
    await daemon.boot();
    expect(heard.events).toEqual([["phase", "unreadable", expect.stringMatching(/^schema version 1 is not supported/), expect.any(String)]]);
    await expect(daemon.unlock(PASSPHRASE)).rejects.toThrow("nothing to unlock");
    await expect(daemon.createIdentity("Another", PASSPHRASE)).rejects.toThrow("a vault already exists here");
    expect((await stat(vaultFile(root))).size).toBe(writtenBytes);

    await daemon.forgetIdentity(heard.hold()!);
    expect(heard.events.at(-1)).toEqual(["phase", "onboarding", null, null]);
    await daemon.createIdentity("Another", PASSPHRASE);
    expect(heard.snapshot()).toMatchObject({ label: "Another" });
  });

  it("removes the vault a removal names and no other: one confirmed about a vault since removed and remade leaves the new one standing", async () => {
    const root = await folder();
    const served = await serveDaemon({ host: nodeHost(root), port: 0, token: "t0k3n" });
    daemons.push(served.daemon);
    await served.daemon.boot();
    const ui = await view(served.url);
    await expect(ui.daemon.forgetIdentity({ hold: "019b0000-0000-7000-8000-0000000000aa" as never })).rejects.toMatchObject({ code: "WrongPhase", message: "there is no vault here to remove", effect: "none" });
    await ui.daemon.createIdentity({ name: "Alice", passphrase: PASSPHRASE });
    const alice = ui.hold()!;
    await ui.daemon.lock({});
    expect(ui.states.at(-1)!.value).toEqual({ phase: "locked", hold: alice, detail: null });
    await expect(ui.daemon.forgetIdentity({} as never)).rejects.toMatchObject({ origin: "client", code: "InvalidArgument", effect: "none" });
    await stat(vaultFile(root));

    const second = await view(served.url);
    expect(second.hold()).toBe(alice);
    await second.daemon.forgetIdentity({ hold: alice as never });
    await second.daemon.createIdentity({ name: "Replacement", passphrase: PASSPHRASE });
    const replacement = second.hold()!;
    expect(replacement).not.toBe(alice);
    await until("the first UI is shown the replacement", () => ui.hold() === replacement);

    await expect(ui.daemon.forgetIdentity({ hold: alice as never })).rejects.toMatchObject({ code: "StaleHold", message: expect.stringMatching(/^that vault is gone already/), effect: "none" });
    await stat(vaultFile(root));
    await ui.client.refresh();
    expect(ui.snapshot()).toMatchObject({ label: "Replacement" });
    await ui.daemon.forgetIdentity({ hold: replacement as never });
    expect(ui.states.at(-1)!.value).toEqual({ phase: "onboarding", hold: null, detail: null });
    await expect(stat(vaultFile(root))).rejects.toThrow();
    await served.close();
  });
});

describe("a daemon's files, one operation at a time", () => {
  const settledAs = (results: PromiseSettledResult<unknown>[]) => results.map((result) => (result.status === "fulfilled" ? "fulfilled" : String((result.reason as Error).message)));

  it("makes one vault of two asked for at once, whichever way they are made: the one refused takes nothing of the other's", async () => {
    const source = daemonOver(await folder());
    await source.daemon.boot();
    await source.daemon.createIdentity("Alice", PASSPHRASE);
    const backup = await source.daemon.exportBackup();

    const occupied = /a vault already exists here/;
    const races: [string, (daemon: DaemonCore) => Promise<unknown>[]][] = [
      ["Alice", (daemon) => [daemon.createIdentity("Alice", PASSPHRASE), daemon.createIdentity("Bob", PASSPHRASE)]],
      ["Alice", (daemon) => [daemon.restoreIdentity(backup.bytes, PASSPHRASE), daemon.createIdentity("Bob", PASSPHRASE)]],
      ["Bob", (daemon) => [daemon.createIdentity("Bob", PASSPHRASE), daemon.restoreIdentity(backup.bytes, PASSPHRASE)]],
    ];
    for (const [label, race] of races) {
      const root = await folder();
      const { daemon, heard } = daemonOver(root);
      await daemon.boot();
      expect(settledAs(await Promise.allSettled(race(daemon)))).toEqual(["fulfilled", expect.stringMatching(occupied)]);
      expect(heard.events.filter(([name]) => name === "opened").map(([, snapshot]) => (snapshot as Snapshot).label)).toEqual([label]);
      await stat(vaultFile(root));
      expect((await daemon.exportBackup()).bytes.length).toBeGreaterThan(0);
    }
  });

  it("neither forgets nor makes a vault in a folder another daemon holds, and a daemon closed while it waits for one asks no more", async () => {
    const root = await folder();
    const owner = daemonOver(root);
    await owner.daemon.boot();
    await owner.daemon.createIdentity("Alice", PASSPHRASE);

    const other = daemonOver(root);
    const waiting = other.daemon.boot();
    await until("the second daemon says the folder is held elsewhere", () => other.heard.phases().includes("elsewhere"));
    const elsewhere = /held elsewhere/;
    await expect(other.daemon.forgetIdentity("019b0000-0000-7000-8000-0000000000aa" as Hold)).rejects.toThrow(elsewhere);
    await expect(other.daemon.createIdentity("Mallory", PASSPHRASE)).rejects.toThrow(elsewhere);
    await expect(other.daemon.lock()).rejects.toThrow(elsewhere);
    await stat(vaultFile(root));
    expect((await owner.daemon.exportBackup()).bytes.length).toBeGreaterThan(0);

    const closed = other.daemon.close();
    expect(other.daemon.close()).toBe(closed);
    await closed;
    await waiting;
    const saidByClose = other.heard.events.length;
    await expect(other.daemon.unlock(PASSPHRASE)).rejects.toThrow(/the daemon is closed/);

    // The owner gone, the folder is free at once: nothing of the closed daemon comes back for it.
    await owner.daemon.close();
    const next = daemonOver(root);
    await next.daemon.boot();
    expect(next.heard.phases()).toEqual(["locked"]);
    expect(other.heard.events).toHaveLength(saidByClose);
    expect(other.heard.phases()).toEqual(["elsewhere"]);
  });

  it("stays locked when locked again, by one UI or by two at once", async () => {
    const { daemon, heard } = daemonOver(await folder());
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    await daemon.lock();
    await daemon.lock();
    await Promise.all([daemon.lock(), daemon.lock()]);
    expect(heard.phases()).toEqual(["onboarding", "locked"]);
    await daemon.unlock(PASSPHRASE);
    await Promise.all([daemon.lock(), daemon.lock()]);
    expect(heard.phases()).toEqual(["onboarding", "locked", "locked"]);
    await daemon.unlock(PASSPHRASE);
    expect(heard.snapshot().label).toBe("Alice");
  });

  it("carries exports and merges asked for at once each to its own end, a merge that fails among them, and leaves no snapshot behind", async () => {
    const root = await folder();
    const { daemon } = daemonOver(root);
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    const backup = await daemon.exportBackup();
    const noSnapshot = new TextEncoder().encode("no database at all");

    const results = await Promise.allSettled([daemon.exportBackup(), daemon.mergeBackup(backup.bytes), daemon.exportBackup(), daemon.mergeBackup(noSnapshot), daemon.mergeBackup(backup.bytes), daemon.exportBackup()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"]);
    for (const index of [1, 4]) expect((results[index] as PromiseFulfilledResult<unknown>).value).toMatchObject({ added: 0 });
    // An export is whole if it validates as a snapshot, which a merge does before it takes anything from one.
    for (const index of [0, 2, 5]) {
      const exported = (results[index] as PromiseFulfilledResult<{ bytes: Uint8Array }>).value;
      expect(await daemon.mergeBackup(exported.bytes)).toMatchObject({ added: 0 });
    }

    // A close lets the operation under way finish and refuses the one still waiting behind it.
    const underWay = daemon.exportBackup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const behind = daemon.mergeBackup(backup.bytes);
    const closed = daemon.close();
    expect(settledAs(await Promise.allSettled([underWay, behind]))).toEqual(["fulfilled", expect.stringMatching(/the daemon is closed/)]);
    await closed;
    expect((await readdir(path.join(root, ".estoc"))).filter((name) => !/^(vault|owner)\.sqlite/.test(name))).toEqual([]);
  });
});

/** A channel to write a contact over: what the daemon takes for one is two short forms, whoever holds them. */
const pairWith = (peer: string): Channel[] => [{ localDid: "did:peer:4zQmAnna", peerDid: `did:peer:4zQm${peer}` }] as Channel[];

describe("a vault whose history is damaged", () => {
  /** One accepted event's bytes cut short in the vault's file, which no daemon holds meanwhile. */
  function damageAnEvent(root: string): void {
    const db = new DatabaseSync(vaultFile(root));
    try {
      const { cid, canonical } = db.prepare("SELECT cid, canonical FROM events ORDER BY cid DESC LIMIT 1").get() as { cid: string; canonical: Uint8Array };
      db.prepare("UPDATE events SET canonical = ? WHERE cid = ?").run(canonical.slice(0, -3), cid);
    } finally {
      db.close();
    }
  }

  it("is not run: the daemon that finds it locked says it is damaged and why, shows no records short of what was lost, leaves the file as it is, and makes room for a restore only when asked", async () => {
    const root = await folder();
    const first = daemonOver(root);
    await first.daemon.boot();
    await first.daemon.createIdentity("Alice", PASSPHRASE);
    const backup = await first.daemon.exportBackup();
    await first.daemon.createContact("Bob", pairWith("Bob"));
    await first.daemon.close();
    damageAnEvent(root);
    const damagedBytes = (await stat(vaultFile(root))).size;

    const { daemon, heard } = daemonOver(root);
    await daemon.boot();
    expect(heard.phases()).toEqual(["damaged"]);
    expect(heard.events.at(-1)).toEqual(["phase", "damaged", expect.stringMatching(/^events\/.* is damaged/), expect.any(String)]);
    expect(heard.events.some(([name]) => name === "opened" || name === "changed")).toBe(false);
    await expect(daemon.unlock(PASSPHRASE)).rejects.toThrow("nothing to unlock");
    await expect(daemon.createIdentity("Another", PASSPHRASE)).rejects.toThrow("a vault already exists here");
    expect((await stat(vaultFile(root))).size).toBe(damagedBytes);

    await daemon.forgetIdentity(heard.hold()!);
    expect(heard.phases().at(-1)).toBe("onboarding");
    await daemon.restoreIdentity(backup.bytes, PASSPHRASE);
    expect(heard.snapshot()).toMatchObject({ label: "Alice", contacts: [], restoreUnexplained: true });
  });

  it("with its seed at hand is no more run than locked: the daemon that would have opened it says damaged, and nothing of it is shown", async () => {
    const root = await folder();
    const host = nodeHost(root);
    const first = createDaemon(host);
    daemons.push(first);
    await first.boot();
    await first.createIdentity("Alice", PASSPHRASE);
    await first.close();
    damageAnEvent(root);

    const daemon = createDaemon(host);
    daemons.push(daemon);
    const heard = listening(daemon);
    expect(await host.cachedSeedKey()).not.toBeNull();
    await daemon.boot();
    expect(heard.events).toEqual([["phase", "damaged", expect.stringMatching(/^events\/.* is damaged/), expect.any(String)]]);
  });

  /** A host whose daemon's own connection to the vault, the one way to the file while it holds it, cuts an accepted event's bytes short. */
  function damageable(root: string): { host: DaemonHost; damageAnEvent(): void } {
    const host = nodeHost(root);
    let held: SqliteDriver | null = null;
    return {
      host: {
        ...host,
        async storage() {
          const storage = await host.storage();
          return { ...storage, open: async (name, mode, kind) => (held = await storage.open(name, mode, kind)) };
        },
      },
      damageAnEvent() {
        const last = held!.prepare("SELECT cid, canonical FROM events ORDER BY cid DESC LIMIT 1");
        const { cid, canonical } = last.get() as { cid: string; canonical: Uint8Array };
        last.finalize();
        const cut = held!.prepare("UPDATE events SET canonical = ? WHERE cid = ?");
        cut.run(canonical.slice(0, -3), cid);
        cut.finalize();
      },
    };
  }

  it("met by a read while the vault runs, stops it there: no records short of the damaged event are shown, the daemon goes from open to damaged and lets the vault go", async () => {
    const root = await folder();
    const running = damageable(root);
    const daemon = createDaemon(running.host);
    daemons.push(daemon);
    const heard = listening(daemon);
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    await daemon.createContact("Bob", pairWith("Bob"));
    const shown = heard.events.length;

    running.damageAnEvent();

    // Nothing was committed since the last read, so a refresh reads nothing and the damage waits for the next read: the one the next commit makes.
    expect(await daemon.refresh()).toEqual(await daemon.refresh());
    expect(heard.events).toHaveLength(shown);
    await expect(daemon.createContact("Carmen", pairWith("Carmen"))).rejects.toThrow(/damaged/);
    await until("the daemon says damaged", () => heard.phases().at(-1) === "damaged");
    expect(heard.events.slice(shown).filter(([name]) => name === "changed")).toEqual([]);
    await expect(daemon.createContact("Dora", pairWith("Dora"))).rejects.toThrow("no open vault");
    await daemon.close();
    const next = daemonOver(root);
    await next.daemon.boot();
    expect(next.heard.phases()).toEqual(["damaged"]);
  });

  it("is shown as it was published to a UI that joins, since joining reads nothing; the read that meets the damage stops the vault for both", async () => {
    const root = await folder();
    const running = damageable(root);
    const failures: unknown[] = [];
    const served = await serveDaemon({ host: running.host, port: 0, token: "t0k3n", failed: (error) => failures.push(error) });
    daemons.push(served.daemon);
    await served.daemon.boot();
    const ui = await view(served.url);
    await ui.daemon.createIdentity({ name: "Alice", passphrase: PASSPHRASE });
    await ui.daemon.createContact({ petname: "Bob", channelIds: pairWith("Bob").map(channelIdOf) });

    running.damageAnEvent();

    const late = await view(served.url);
    expect(late.states).toEqual([ui.states.at(-1)]);

    const damaged = { phase: "damaged", detail: expect.stringMatching(/^events\/.* is damaged/), hold: ui.hold() };
    // What the daemon threw stays with the host: the view is told of a failure, and the damage as the phase that follows.
    await expect(ui.daemon.createContact({ petname: "Carmen", channelIds: pairWith("Carmen").map(channelIdOf) })).rejects.toEqual({ origin: "daemon", code: "OperationFailed", message: expect.not.stringMatching(/damaged/), effect: "possible", messageId: null });
    expect(failures.map((error) => (error as Error).message)).toEqual([expect.stringMatching(/damaged/)]);
    await until("the UI already there is told", () => ui.phases().at(-1) === "damaged");
    await until("the UI that joined is told", () => late.phases().at(-1) === "damaged");
    expect(ui.states.at(-1)!.value).toEqual(damaged);
    expect(late.states.at(-1)!.value).toEqual(damaged);
    expect(late.states.filter((state) => state.value.phase === "open")).toHaveLength(1);
    expect([ui.client.connection.state, late.client.connection.state]).toEqual(["connected", "connected"]);
    await expect(ui.daemon.createContact({ petname: "Dora", channelIds: pairWith("Dora").map(channelIdOf) })).rejects.toMatchObject({ code: "WrongPhase", message: "no open vault" });
    await served.close();
  });
});

/** The reads of the runtime the daemon opens next, each handed to `wrap` once the vault's lock is let go of, to be held back or made to fail. */
function readsOf(daemon: DaemonCore, wrap: (read: Promise<Snapshot>) => Promise<Snapshot>): void {
  const { publisher } = daemon;
  const opening = publisher.open.bind(publisher);
  publisher.open = (hold, source) => opening(hold, { capture: (cut) => wrap(source.capture(cut)) });
}

describe("a vault let go of while a read of it is under way", () => {
  for (const ending of ["lock", "forgetIdentity", "close"] as const) {
    it(`by ${ending}: the call whose read it is settles, the vault is let go of, and nothing of the read is shown`, async () => {
      const root = await folder();
      const { daemon, heard } = daemonOver(root);
      let holding = false;
      let held: (() => void) | null = null;
      readsOf(daemon, async (read) => {
        const snapshot = await read;
        if (holding) await new Promise<void>((resolve) => (held = resolve));
        return snapshot;
      });
      await daemon.boot();
      await daemon.createIdentity("Alice", PASSPHRASE);
      const hold = heard.hold()!;

      holding = true;
      const creating = daemon.createContact("Bob", pairWith("Bob"));
      await until("the read is held", () => held !== null);
      await (ending === "forgetIdentity" ? daemon.forgetIdentity(hold) : daemon[ending]());
      await creating;
      const shown = heard.events.length;
      if (ending !== "close") expect(heard.phases().at(-1)).toBe(ending === "lock" ? "locked" : "onboarding");

      holding = false;
      held!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(heard.events.slice(shown)).toEqual([]);
      if (ending === "lock") {
        await daemon.unlock(PASSPHRASE);
        expect(heard.snapshot().contacts).toHaveLength(1);
      }
    });
  }
});

describe("a read of the vault that fails", () => {
  it("leaves the state as it was and says so, refuses a UI joining meanwhile, and is made again by the next call", async () => {
    const root = await folder();
    const { daemon, heard } = daemonOver(root);
    let failing = 0;
    readsOf(daemon, async (read) => {
      const snapshot = await read;
      if (failing-- > 0) throw new Error("the disk went away");
      return snapshot;
    });
    await daemon.boot();
    await daemon.createIdentity("Alice", PASSPHRASE);
    const before = heard.snapshot();
    const shown = heard.events.length;

    // the read the commit makes is the one the call waits for before it answers, and it fails
    failing = 1;
    await daemon.createContact("Bob", pairWith("Bob"));
    expect(heard.events.slice(shown).filter(([name]) => name !== "lines").map(([name, error]) => [name, (error as Error).message])).toEqual([["unavailable", "the disk went away"]]);
    expect(heard.snapshot()).toBe(before);
    expect(() => listening(daemon)).toThrow("the disk went away");

    await daemon.refresh();
    expect(heard.snapshot().contacts).toHaveLength(1);
    expect(handed(daemon).snapshot).toEqual(heard.snapshot());
  });
});

describe("two copies of one runtime, both written to", () => {
  it("merge once the one merged into has taken a replica ID of its own: nothing of either history is lost or rewritten, the merge says it renewed, and the next one does not", async () => {
    const original = await folder();
    const first = daemonOver(original);
    await first.daemon.boot();
    await first.daemon.createIdentity("Alice", PASSPHRASE);
    await first.daemon.close();
    const copy = await folder();
    await cp(path.join(original, ".estoc"), path.join(copy, ".estoc"), { recursive: true });

    const here = daemonOver(original);
    await here.daemon.boot();
    await here.daemon.unlock(PASSPHRASE);
    await here.daemon.createContact("Bob", pairWith("Bob"));
    const fromHere = await here.daemon.exportBackup();

    const there = daemonOver(copy);
    await there.daemon.boot();
    await there.daemon.unlock(PASSPHRASE);
    await there.daemon.createContact("Carmen", pairWith("Carmen"));

    const merged = await there.daemon.mergeBackup(fromHere.bytes);
    expect(merged).toMatchObject({ renewed: true });
    expect(merged.added).toBeGreaterThan(0);
    expect(there.heard.phases()).not.toContain("unreadable");
    expect(contactsOf(there.heard.snapshot()).map((contact) => contact.petname).sort()).toEqual(["Bob", "Carmen"]);
    expect(await there.daemon.mergeBackup(fromHere.bytes)).toMatchObject({ renewed: false, added: 0 });
    await there.daemon.createContact("Dave", pairWith("Dave"));

    const back = await here.daemon.mergeBackup((await there.daemon.exportBackup()).bytes);
    expect(back.renewed).toBe(true);
    expect(contactsOf(here.heard.snapshot()).map((contact) => contact.petname).sort()).toEqual(["Bob", "Carmen", "Dave"]);
    await here.daemon.createContact("Erin", pairWith("Erin"));
    expect(await there.daemon.mergeBackup((await here.daemon.exportBackup()).bytes)).toMatchObject({ renewed: false, added: 3 });
  });

  it(
    "asks the mediator nothing between the two merges: an address only the backup knows stays registered, the merged daemon is a replica of its own, and what waited for the address is received by the daemon over the folder it was made in",
    async () => {
      const mediator = await newMediator();
      const first = await person(mediator, "Alice");
      await first.daemon.close();
      const copy = await folder();
      await cp(path.join(first.root, ".estoc"), path.join(copy, ".estoc"), { recursive: true });

      let merges = 0;
      let secondMergeReached = false;
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      const host = nodeHost(copy, { fetch: mediator.fetch, WebSocket: mediator.WebSocket });
      const there = createDaemon({
        ...host,
        async storage() {
          const storage = await host.storage();
          return {
            ...storage,
            async importFile(name, bytes) {
              if (name === "merge-source.sqlite" && ++merges === 2) {
                secondMergeReached = true;
                await released;
              }
              return storage.importFile(name, bytes);
            },
          };
        },
      });
      daemons.push(there);
      const heard = listening(there);
      await there.boot();
      await there.unlock(PASSPHRASE);
      await there.reconnect();
      await there.createContact("Carmen", pairWith("Carmen"));
      const [replica] = mediator.liveAccounts() as [string];

      const here = daemonOver(first.root, mediator);
      await here.daemon.boot();
      await here.daemon.unlock(PASSPHRASE);
      const { didId, invitation } = await here.daemon.createInvitation();
      const invited = here.heard.snapshot().dids.find((did) => did.didId === (didId as string))!.did! as Did;
      const backup = await here.daemon.exportBackup();
      await here.daemon.close();
      const bob = await person(mediator, "Bob");
      expect(await bob.daemon.acceptInvitation(invitation, "Alice")).toMatchObject({ outcome: "submitted" });
      await bob.daemon.close();
      expect(mediator.sharedRecipients.has(invited)).toBe(true);

      const asked = mediator.seenTypes.length;
      const opened = heard.events.filter(([name]) => name === "opened").length;
      const merging = there.mergeBackup(backup.bytes);
      try {
        await until("the second merge is reached", () => secondMergeReached);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(mediator.seenTypes.slice(asked)).toEqual([]);
        expect(heard.events.filter(([name]) => name === "opened")).toHaveLength(opened);
        // No runtime is shown between the merges: a refresh answers with what was published last and reads nothing.
        const said = heard.events.length;
        expect(await there.refresh()).toEqual(await there.refresh());
        expect(heard.events).toHaveLength(said);
      } finally {
        release();
      }
      expect(await merging).toMatchObject({ renewed: true });
      // Renewed by the merge, this daemon is a replica of its own: the Ping, queued for the replica both folders were, waits for the daemon over the original folder.
      await until("the merged daemon is enrolled as a replica of its own", () => mediator.replicas.size === 3);
      expect(mediator.sharedRecipients.has(invited)).toBe(true);
      expect(heard.snapshot().messages.filter((message) => message.direction === "in")).toEqual([]);
      expect(mediator.queues.get(replica)).toHaveLength(1);

      const again = daemonOver(first.root, mediator);
      await again.daemon.boot();
      await again.daemon.unlock(PASSPHRASE);
      await until("what waited for the backup's address is received", () => again.heard.snapshot().messages.some((message) => message.direction === "in" && message.headers?.type === PING_TYPE));
      await until("the Ping is acknowledged to the mediator", () => mediator.queues.get(replica)?.length === 0);
      expect(heard.lines()?.discarded ?? []).toEqual([]);
    },
    LONG
  );
});

describe("a mediator set", () => {
  it("is enrolled with as a replica-mediation account, and setting it again selects the arrangement that stands rather than making another", async () => {
    const mediator = await newMediator();
    const alice = daemonOver(await folder(), mediator);
    await alice.daemon.boot();
    await alice.daemon.createIdentity("Alice", PASSPHRASE);
    const shown = () => alice.heard.snapshot().mediations.map(({ mediationId, mediatorDid, selected, usable }) => ({ mediationId, mediatorDid, selected, usable }));

    const enrolled = await alice.daemon.setMediator(mediator.did);
    expect(shown()).toEqual([{ mediationId: enrolled, mediatorDid: mediator.did, selected: true, usable: true }]);
    expect([mediator.replicaAccounts.size, mediator.replicas.size]).toEqual([1, 1]);

    expect(await alice.daemon.setMediator(mediator.did)).toBe(enrolled);
    expect(shown()).toEqual([{ mediationId: enrolled, mediatorDid: mediator.did, selected: true, usable: true }]);
    expect([mediator.replicaAccounts.size, mediator.replicas.size]).toEqual([1, 1]);
  });

  it("is free to be another one after the first refused to register the account, and is so still once reopened", async () => {
    const refusing = await newMediator();
    const mediator = await newMediator();
    const root = await folder();
    const alice = daemonOver(root, refusing);
    await alice.daemon.boot();
    await alice.daemon.createIdentity("Alice", PASSPHRASE);
    refusing.intercept = (msg) => {
      if (msg.type === ACCOUNT_REGISTER) throw new Error("out of service");
      return undefined;
    };
    await expect(alice.daemon.setMediator(refusing.did)).rejects.toThrow();
    expect(alice.heard.snapshot().mediations.filter(({ selected }) => selected)).toEqual([]);
    await alice.daemon.close();

    const reopened = daemonOver(root, mediator);
    await reopened.daemon.boot();
    await reopened.daemon.unlock(PASSPHRASE);
    const enrolled = await reopened.daemon.setMediator(mediator.did);
    expect(reopened.heard.snapshot().mediations.filter(({ selected }) => selected)).toMatchObject([{ mediationId: enrolled, mediatorDid: mediator.did, usable: true }]);
    expect(mediator.replicas.size).toBe(1);
  });
});

describe("a daemon whose mediator drops the socket", () => {
  it("shows the connection as not live without a call or a commit, the same to the UI there and to one that joins, and the records unchanged", async () => {
    const mediator = await newMediator();
    const alice = await person(mediator, "Alice");
    await until("the line is live", () => alice.heard.lines()?.connections[0]?.live === true);
    const shown = alice.heard.events.length;
    const [account] = mediator.liveAccounts();

    mediator.dropSocket(account!);
    await until("the drop is shown", () => alice.heard.lines()?.connections[0]?.live === false);
    const told = alice.heard.events.slice(shown).map(([name]) => name);
    expect(told.filter((name) => name !== "log")).toEqual(["lines"]);
    expect(mediator.liveAccounts()).toEqual([]);

    expect(handed(alice.daemon)).toEqual({ snapshot: alice.heard.snapshot(), lines: alice.heard.lines() });
  });
});

describe("a backup merged that retires the only mediator", () => {
  /** The daemon's backup restored elsewhere, its one mediation retired there, and that replica exported: a backup with one event to merge. */
  async function backupRetiring(backup: Uint8Array, mediationId: MediationId): Promise<Uint8Array> {
    const root = await folder();
    await writeFile(path.join(root, "backup.sqlite"), backup);
    const source = openPortable(openNodeSqlite(path.join(root, "backup.sqlite"), { mode: "readonly" }));
    let runtime: SqliteVault;
    let seedKey!: Awaited<ReturnType<typeof unlockSeedKeystore>>;
    try {
      const restored = await restoreVault(source, (mode) => openNodeSqlite(path.join(root, "replica.sqlite"), { mode }), {
        heldRoots: vaultHeldRoots(null),
        anchor: async (wrapped) => {
          seedKey = await unlockSeedKeystore(wrapped, PASSPHRASE);
          return Keys.anchorOf(seedKey);
        },
      });
      runtime = new SqliteVault(restored.runtime);
    } finally {
      source.close();
    }
    try {
      const keys = await Keys.open(seedKey, runtime.metadata.anchor);
      await decide(runtime, keys, () => [vaultDraft("mediation.retired", { mediationId, because: "no longer used" })]);
      await exportVault(runtime, (mode) => openNodeSqlite(path.join(root, "retired.sqlite"), { mode }), { heldRoots: vaultHeldRoots(null) });
    } finally {
      await runtime.close();
    }
    return new Uint8Array(await readFile(path.join(root, "retired.sqlite")));
  }

  it("leaves the agent that takes over nothing to connect, and shows its lines empty without a call: the UI there and one that joins see no connection where the old agent's stood", async () => {
    const mediator = await newMediator();
    const root = await folder();
    const alice = daemonOver(root, mediator);
    await alice.daemon.boot();
    await alice.daemon.createIdentity("Alice", PASSPHRASE);
    const mediationId = await alice.daemon.setMediator(mediator.did);
    await until("the line is live", () => alice.heard.lines()?.connections[0]?.live === true);

    const retiring = await backupRetiring((await alice.daemon.exportBackup()).bytes, mediationId);
    const merging = alice.heard.events.length;
    expect(await alice.daemon.mergeBackup(retiring)).toMatchObject({ added: 1, renewed: false });
    await until("the old agent's connection is gone from the UI", () => alice.heard.lines()?.connections.length === 0);
    await until("the mediator has let the socket go", () => mediator.liveAccounts().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alice.heard.lines()).toEqual({ connections: [], waiting: [], discarded: [] });
    expect(alice.heard.events.slice(merging).map(([name]) => name)).toEqual(["changed", "lines"]);

    expect(handed(alice.daemon)).toEqual({ snapshot: alice.heard.snapshot(), lines: { connections: [], waiting: [], discarded: [] } });
  });
});

describe("two daemons over a mediator", () => {
  const stillWaiting = (work: Promise<unknown>) => Promise.race([work.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300))]);

  /** The mediator keeps the first message `held` picks until the release, having received it. */
  function holding(mediator: FakeMediator, held: (message: Parameters<NonNullable<FakeMediator["intercept"]>>[0]) => boolean): { reached(): boolean; release(): void } {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    mediator.intercept = async (message) => {
      if (reached || !held(message)) return undefined;
      reached = true;
      await released;
      return undefined;
    };
    return { reached: () => reached, release };
  }

  it(
    "waits, closing, for the answer a mediator owes it and asks nothing on that answer: the next daemon over the vault keeps what it registers",
    async () => {
      const mediator = await newMediator();
      const { root, daemon, heard } = await person(mediator, "Alice");
      await until("the first connection is through", () => heard.lines()?.connections[0]?.live === true);

      const query = holding(mediator, (message) => message.type === STATUS_REQUEST);
      try {
        const reconnecting = daemon.reconnect();
        await until("the query is with the mediator", query.reached);
        const closing = daemon.close();
        expect(await stillWaiting(closing)).toBe(true);
        await expect(daemon.reconnect()).rejects.toThrow(/no open vault/);
        const seen = mediator.seenTypes.length;
        const said = heard.events.length;
        query.release();
        await closing;
        await reconnecting;
        expect(mediator.seenTypes.slice(seen)).toEqual([]);
        expect(heard.events).toHaveLength(said);

        const next = daemonOver(root, mediator);
        await next.daemon.boot();
        await next.daemon.unlock(PASSPHRASE);
        await next.daemon.createInvitation();
        expect(mediator.sharedRecipients.size).toBe(1);
        expect(mediator.seenTypes.slice(seen).filter((type) => type === RECIPIENT_ADD)).toHaveLength(1);
      } finally {
        query.release();
        mediator.intercept = null;
      }
    },
    LONG
  );

  /** Alice and Bob, contacts of each other by an invitation of Alice's, their Pings through. */
  async function acquainted(mediator: FakeMediator, options: Partial<NonNullable<DaemonHost["agentOptions"]>> = {}) {
    const alice = await person(mediator, "Alice");
    const bobsRoot = await folder();
    const bob = { root: bobsRoot, ...daemonOver(bobsRoot, mediator, options) };
    await bob.daemon.boot();
    await bob.daemon.createIdentity("Bob", PASSPHRASE);
    await bob.daemon.setMediator(mediator.did);
    const { invitation } = await alice.daemon.createInvitation();
    const accepted = await bob.daemon.acceptInvitation(invitation, "Alice");
    await until("bob's Ping is acknowledged", () => bob.heard.snapshot().messages.some((message) => message.messageId === (accepted.messageId as string) && message.acknowledged));
    return { alice, bob, contactId: accepted.contactId };
  }

  const outcomeOf = (snapshot: Snapshot, messageId: string) => snapshot.messages.find((message) => message.messageId === messageId)?.delivery?.status;

  it(
    "publishes what the dispatcher commits on its own timer, with no call of the UI's: the Ping a registration the mediator refused held up",
    async () => {
      const mediator = await newMediator();
      const { alice, bob } = await acquainted(mediator, { retry: { firstWaitMs: 200 } });
      const { invitation } = await alice.daemon.createInvitation();
      // Every registration asked about meanwhile is refused, the one the Ping's address needs among them: the dispatcher tries the Ping again on its own.
      let refusing = true;
      mediator.intercept = async (message) => {
        if (message.type !== RECIPIENT_ADD || !refusing) return undefined;
        throw new Error("not just now");
      };
      try {
        const accepted = await bob.daemon.acceptInvitation(invitation, "Alice again");
        refusing = false;
        expect(accepted.outcome).toBe("pending");
        expect(["queued", "prepared"]).toContain(outcomeOf(bob.heard.snapshot(), accepted.messageId));
        await until("the retry's submission is published", () => outcomeOf(bob.heard.snapshot(), accepted.messageId) === "submitted", 10_000);
      } finally {
        refusing = false;
        mediator.intercept = null;
      }
    },
    LONG
  );

  it(
    "shows the intent a send committed before the network answers to a refresh asked meanwhile, and the submission once it has",
    async () => {
      const mediator = await newMediator();
      const { bob, contactId } = await acquainted(mediator);
      // Only the forward that carries this send is held: the automatic replies still crossing after the acquaintance go to Bob, or left him already.
      await until("bob's earlier sends are through", () => bob.heard.snapshot().messages.every((message) => message.direction !== "out" || !["queued", "prepared"].includes(message.delivery?.status ?? "")));
      const snapshot = bob.heard.snapshot();
      const shown = new Set(snapshot.conversations.filter((conversation) => conversation.contactId === (contactId as string)).flatMap((conversation) => conversation.channels.map((channel) => channel.channelId)));
      const alice = new Set(snapshot.channels.filter((channel) => shown.has(channel.channelId)).map((channel) => channel.peerDid));
      const forward = holding(mediator, (message) => message.type === FORWARD && alice.has((message.body as { next?: string }).next ?? ""));
      try {
        const sending = bob.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "in transit" } });
        await until("the message is with the mediator", forward.reached);
        expect(await stillWaiting(sending)).toBe(true);
        const marker = await bob.daemon.refresh();
        expect(marker.epoch).toBe(bob.daemon.publisher.current.state.epoch);
        const held = bob.heard.snapshot().messages.find((message) => message.direction === "out" && message.body.state === "available" && message.body.body["content"] === "in transit");
        expect(["queued", "prepared"]).toContain(held?.delivery?.status);
        forward.release();
        const sent = await sending;
        expect(sent.outcome).toBe("submitted");
        expect(outcomeOf(bob.heard.snapshot(), sent.messageId)).toBe("submitted");
      } finally {
        forward.release();
        mediator.intercept = null;
      }
    },
    LONG
  );

  test(
    "an invitation accepted becomes a contact on one side and a channel to name on the other; a restored vault receives at once and sends only once the restore is explained",
    async () => {
      const mediator = await newMediator();
      const alice = await person(mediator, "Alice");
      const bob = await person(mediator, "Bob");
      expect(alice.heard.snapshot().mediations).toMatchObject([{ mediatorDid: mediator.did, selected: true, usable: true }]);
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);

      const { invitation, didId } = await alice.daemon.createInvitation();
      expect(alice.heard.snapshot().invitations).toMatchObject([{ oobId: invitation.id, didId, state: { status: "available" } }]);

      const accepted = await bob.daemon.acceptInvitation(invitation, "Alice");
      expect(accepted).toMatchObject({ outcome: "submitted", because: null });
      expect(contactsOf(bob.heard.snapshot())).toMatchObject([{ petname: "Alice", channels: [{ channelId: channelIdOf(accepted.channel), selected: true }] }]);

      await until("alice holds bob's Ping", () => alice.heard.snapshot().messages.some((message) => message.direction === "in" && message.headers?.type === PING_TYPE));
      await until("bob's Ping is acknowledged", () => bob.heard.snapshot().messages.some((message) => message.messageId === (accepted.messageId as string) && message.acknowledged));

      // Bob's first word at a disclosed address has Alice select a private successor toward him: the pair she names is the one she now writes from.
      const moved = (snapshot: Snapshot) => snapshot.channels.find((channel) => channel.headChannelId !== null && pairOf(channel.headChannelId).localDid !== channel.localDid);
      await until("alice's successor is the head of the pair bob wrote in", () => moved(alice.heard.snapshot()) !== undefined);
      const head = headOf(moved(alice.heard.snapshot())!);
      await expect(alice.daemon.createContact("Nobody", [])).rejects.toThrow("at least one channel");
      expect(alice.heard.snapshot().contacts).toEqual([]);
      const contactId = await alice.daemon.createContact("Bob", [head]);
      expect(contactsOf(alice.heard.snapshot())).toMatchObject([{ petname: "Bob", defaultWriteTo: channelIdOf(head) }]);
      // As a view is handed it: the contact's conversation shows the head selected and the pair Bob wrote in reached from it, and no nameless conversation stands for that pair.
      const shown = published(alice.daemon);
      expect(shown.conversations.map(({ id, contactId: of, petname, channels, writeTo, defaultWriteTo }) => ({ id, contactId: of, petname, channels, writeTo, defaultWriteTo }))).toEqual([
        {
          id: `contact:${contactId}`,
          contactId,
          petname: "Bob",
          channels: [
            { channelId: channelIdOf(head), selected: true },
            { channelId: moved(alice.heard.snapshot())!.channelId, selected: false },
          ],
          writeTo: [channelIdOf(head)],
          defaultWriteTo: channelIdOf(head),
        },
      ]);
      expect(shown.channels.map(({ channelId, headChannelId }) => [channelId, headChannelId])).toEqual(
        [
          [moved(alice.heard.snapshot())!.channelId, channelIdOf(head)],
          [channelIdOf(head), channelIdOf(head)],
        ].sort(([a], [b]) => (a! < b! ? -1 : 1))
      );
      await alice.daemon.renameContact(contactId, "Bobby");
      expect(contactsOf(alice.heard.snapshot())[0]!.petname).toBe("Bobby");

      const hello = await alice.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      expect(hello).toMatchObject({ outcome: "submitted", channel: head });
      await until("bob reads the hello", () => bob.heard.snapshot().messages.some((message) => message.body.state === "available" && message.body.body["content"] === "hello"));

      const backup = await alice.daemon.exportBackup();
      await alice.daemon.close();

      const root = await folder();
      const first = daemonOver(root, mediator);
      await first.daemon.boot();
      await expect(first.daemon.restoreIdentity(backup.bytes, "not the passphrase")).rejects.toThrow(/does not open this backup/);
      await expect(stat(path.join(root, ".estoc", "vault.sqlite"))).rejects.toThrow();
      await first.daemon.restoreIdentity(backup.bytes, PASSPHRASE);
      expect(first.heard.snapshot()).toMatchObject({ label: "Alice", restoreUnexplained: true });
      expect(contactsOf(first.heard.snapshot())).toMatchObject([{ petname: "Bobby" }]);

      const closed = /sending opens once what a restore cannot bring back has been explained/;
      const bobsDid = head.peerDid;
      const successor = first.heard.snapshot().dids.find((did) => did.did === head.localDid)!.didId as string as DidId;
      await expect(first.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "too soon" } })).rejects.toThrow(closed);
      await expect(first.daemon.retry(hello.messageId)).rejects.toThrow(closed);
      await expect(first.daemon.rotate(successor, bobsDid)).rejects.toThrow(closed);
      await expect(first.daemon.completeResponse("00000000-0000-5000-8000-000000000000" as never, "pure-ack")).rejects.toThrow(closed);
      await expect(first.daemon.completeNotification("018f0000-0000-7000-8000-000000000000" as never)).rejects.toThrow(closed);
      await expect(first.daemon.acceptInvitation(invitation, "nobody")).rejects.toThrow(closed);
      expect(first.heard.snapshot().messages.filter((message) => message.direction === "out" && message.headers?.type === BASIC_MESSAGE)).toHaveLength(1);

      // Receiving, holding its addresses and what the vault owes on its own wait for no explanation.
      await until("the restored vault's line is live", () => first.heard.lines()?.connections[0]?.live === true);
      const reply = await bob.daemon.send({ contactId: accepted.contactId }, { type: BASIC_MESSAGE, body: { content: "still there?" }, pleaseAck: [""] });
      expect(reply.outcome).toBe("submitted");
      await until("the restored vault reads bob", () => first.heard.snapshot().messages.some((message) => message.body.state === "available" && message.body.body["content"] === "still there?"));
      await until("bob's message is acknowledged by the restored vault", () => bob.heard.snapshot().messages.some((message) => message.messageId === (reply.messageId as string) && message.acknowledged));
      expect(first.heard.snapshot().pending).toMatchObject({ pendingOutbounds: [] });

      // The explanation is owed by this runtime, not by this process: another over the same file owes it still.
      await first.daemon.close();
      const again = daemonOver(root, mediator);
      await again.daemon.boot();
      expect(again.heard.phases()).toEqual(["locked"]);
      await again.daemon.unlock(PASSPHRASE);
      expect(again.heard.snapshot().restoreUnexplained).toBe(true);
      await expect(again.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "too soon" } })).rejects.toThrow(closed);

      await again.daemon.explainedRestore();
      expect(again.heard.snapshot().restoreUnexplained).toBe(false);
      const after = await again.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "back again" } });
      expect(after.outcome).toBe("submitted");
      await until("bob reads the restored vault", () => bob.heard.snapshot().messages.some((message) => message.body.state === "available" && message.body.body["content"] === "back again"));

      // A restored vault never held the envelopes its submitted messages released, and an erasure collects the ones a vault did hold: neither is asked for them again.
      const merged = await again.daemon.mergeBackup(backup.bytes);
      expect(merged).toMatchObject({ added: 0, objects: 0 });
      expect(merged.duplicates).toBeGreaterThan(0);
      await until("the agent over the merged vault is live", () => again.heard.events.at(-1)![0] === "lines" && again.heard.lines()?.connections[0]?.live === true);
      const bobs = await bob.daemon.exportBackup();
      await bob.daemon.eraseMessage(reply.messageId);
      expect(await bob.daemon.mergeBackup(bobs.bytes)).toMatchObject({ added: 0, objects: 0 });

      await again.daemon.forgetIdentity(again.heard.hold()!);
      expect(again.heard.phases().at(-1)).toBe("onboarding");
      await expect(stat(path.join(root, ".estoc", "vault.sqlite"))).rejects.toThrow();
    },
    LONG
  );

  test(
    "a DID handed out on its own is one address for anyone, minted once even when asked for twice at once; a contact added by it is reached like an invitee, introduced by the contact once the peer answers privately, and a DID of one's own is refused",
    async () => {
      const mediator = await newMediator();
      const alice = await person(mediator, "Alice");
      const bob = await person(mediator, "Bob");
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);

      const [handedOut, alongside] = await Promise.all([alice.daemon.publicDid(), alice.daemon.publicDid()]);
      expect(alongside).toEqual(handedOut);
      expect(await alice.daemon.publicDid()).toEqual(handedOut);
      expect(alice.heard.snapshot().dids.filter((did) => did.disclosures.length > 0)).toMatchObject([{ didId: handedOut.didId, longFormDid: handedOut.did, live: true, disclosures: [{ as: "direct" }] }]);
      expect(alice.heard.snapshot().invitations).toEqual([]);
      expect(mediator.sharedRecipients.has(alice.heard.snapshot().dids[0]!.did!)).toBe(true);

      await expect(alice.daemon.addContactByDid(handedOut.did, "me")).rejects.toThrow("an address of your own");
      await expect(bob.daemon.addContactByDid("not a did", "Alice")).rejects.toThrow(/not a DID/);
      expect(bob.heard.snapshot().contacts).toEqual([]);

      const added = await bob.daemon.addContactByDid(handedOut.did, "Alice");
      expect(added).toMatchObject({ outcome: "submitted", because: null });
      expect(contactsOf(bob.heard.snapshot())).toMatchObject([{ petname: "Alice", channels: [{ channelId: channelIdOf(added.channel), selected: true }] }]);
      expect(added.channel.peerDid).toBe(canonicalDidOf(handedOut.did));

      await until("alice holds bob's Ping", () => alice.heard.snapshot().messages.some((message) => message.direction === "in" && message.headers?.type === PING_TYPE && message.headers.pthid === null));
      await until("bob's Ping is acknowledged", () => bob.heard.snapshot().messages.some((message) => message.messageId === (added.messageId as string) && message.acknowledged));

      // The address stays for the next stranger: Alice answers Bob from a private successor and keeps handing out the same DID.
      const moved = (snapshot: Snapshot) => snapshot.channels.find((channel) => channel.headChannelId !== null && pairOf(channel.headChannelId).localDid !== channel.localDid);
      await until("alice's successor is the head of the pair bob wrote in", () => moved(alice.heard.snapshot()) !== undefined);
      expect(await alice.daemon.publicDid()).toEqual(handedOut);
      const head = headOf(moved(alice.heard.snapshot())!);
      const contactId = await alice.daemon.createContact("Bob", [head]);
      const hello = await alice.daemon.send({ contactId }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      expect(hello).toMatchObject({ outcome: "submitted", channel: head });
      await until("bob reads the hello", () => bob.heard.snapshot().messages.some((message) => message.body.state === "available" && message.body.body["content"] === "hello"));

      // Bob's introduction after the Ping goes by the contact, not the Ping's channel: Alice has answered from a replacement, and the address the Ping went to takes nothing more from him.
      await until("bob holds alice's replacement", () => bob.heard.snapshot().channels.some((channel) => channel.headChannelId !== null && pairOf(channel.headChannelId).peerDid !== channel.peerDid));
      const profile = { type: PROFILE, body: { profile: { displayName: "Bob" } } };
      await expect(bob.daemon.send({ channel: added.channel }, profile)).rejects.toThrow("the peer has replaced its DID");
      const introduced = await bob.daemon.send({ contactId: added.contactId }, profile);
      expect(introduced).toMatchObject({ outcome: "submitted", channel: { localDid: added.channel.localDid, peerDid: head.localDid } });
      await until("alice hears bob's name", () => alice.heard.snapshot().channels.some((channel) => channel.peerName?.name === "Bob"));
      const named = published(alice.daemon);
      const claim = named.messages.find((message) => message.summary === "name: Bob")!;
      expect(claim).toMatchObject({ direction: "in", channelId: channelIdOf({ localDid: head.localDid, peerDid: added.channel.localDid }) });
      expect(named.conversations.find((conversation) => (conversation.contactId as string | null) === contactId)).toMatchObject({ claimedName: { name: "Bob", messageId: claim.messageId } });
    },
    LONG
  );
});

describe("a daemon whose vault records an observation it does not admit", () => {
  const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;
  /** A pair's record with the messages and observations it names, as a view assembles them. */
  const channelIn = (snapshot: Snapshot, channel: Channel) => {
    const index = indexSnapshot(snapshot);
    const record = index.channel(channelIdOf(channel))!;
    return { ...record, messages: record.messageIds.map((messageId) => index.message(messageId)!), observations: record.observationIds.map((sourceEventCid) => index.observation(sourceEventCid)!) };
  };
  const liveAfter = (heard: Told, index: number): boolean => heard.events.slice(index).some(([name, lines]) => name === "lines" && (lines as Lines).connections[0]?.live === true);
  /** The records of a snapshot as the UI is handed them. */
  const recordsOf = (snapshot: Snapshot): unknown => JSON.parse(JSON.stringify({ channels: snapshot.channels, messages: snapshot.messages, observations: snapshot.observations, unplaced: snapshot.unplaced, pending: snapshot.pending }));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test(
    "hands the UI the observation as no message: listed under its channel, ignored, with nothing it carries, claiming no name and earning no acknowledgement; the daemon opened again over the vault, and one restored from before it and merged, read the same records and send nothing",
    async () => {
      const mediator = await newMediator();
      const root = await folder();
      const alice = daemonOver(root, mediator);
      await alice.daemon.boot();
      await alice.daemon.createIdentity("Alice", PASSPHRASE);
      await alice.daemon.setMediator(mediator.did);
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);
      const { invitation, didId } = await alice.daemon.createInvitation();
      const a0 = alice.heard.snapshot().dids.find((did) => did.didId === (didId as string))!.did! as Did;

      // Bob's first word has Alice move to a private address toward him; he writes there before he moves himself.
      const bob = await run(mediator, 2, BOB, { privateAddresses: false });
      const b0 = bob.party.did;
      await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation.from }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      await until("bob holds alice's move", () => bob.inbounds.length === 1);
      const old = headOf(alice.heard.snapshot().channels.find((channel) => channel.localDid === a0)!);
      const a1 = old.localDid;
      await bob.agent.send({ channel: channelOf(b0, a1) }, { type: BASIC_MESSAGE, body: { content: "before I move" } });
      await until("alice reads bob at her new address", () => channelIn(alice.heard.snapshot(), old).messages.some((message) => message.body.state === "available" && message.body.body["content"] === "before I move"));
      expect((await alice.daemon.send({ channel: old }, { type: BASIC_MESSAGE, body: { content: "hello yourself" } })).outcome).toBe("submitted");
      await until("bob reads the answer", () => bob.inbounds.length === 2);
      const before = await alice.daemon.exportBackup();

      await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a1 });
      await until("bob holds alice's acknowledgement of his move", () => bob.inbounds.length === 3);
      await until("alice has the rotation", () => channelIn(alice.heard.snapshot(), old).superseded);

      // Bob's acknowledgement of Alice's move and his word at her new address are admitted there; what he seals by hand from the address he left, a name for himself asking to be acknowledged, is not.
      await forwarded(mediator, a1, await sealed(await peerSealer(bob.party as unknown as DirectParty, b0), a1, { type: PROFILE, body: { profile: { displayName: "Still Bob" } }, please_ack: [""] }));
      const forwards = forwardsSeen(mediator);
      const inbounds = bob.inbounds.length;
      await until("alice holds the observation", () => channelIn(alice.heard.snapshot(), old).observations.length === 3);
      await pause(500);

      const shown = channelIn(alice.heard.snapshot(), old);
      expect(shown.messages.filter(({ direction, headers }) => direction === "in" && headers?.type !== EMPTY_MESSAGE_TYPE).map(({ body }) => (body.state === "available" ? body.body : body.state))).toEqual([{ content: "before I move" }]);
      expect(shown.peerName).toBeNull();
      expect(shown.observations.map(({ standing, disposition, contradicting }) => [standing, disposition, contradicting])).toEqual([
        [{ status: "complete" }, { status: "admitted" }, false],
        [{ status: "complete" }, { status: "admitted" }, false],
        [{ status: "complete" }, { status: "ignored-superseded" }, false],
      ]);
      for (const observation of shown.observations) expect(Object.keys(observation).sort()).toEqual(["at", "channelId", "contradicting", "disposition", "messageId", "sourceEventCid", "standing", "verification"]);
      expect(alice.heard.snapshot()).toMatchObject({ unplaced: { observationIds: [] }, pending: { pendingOutbounds: [], missingResponses: [] } });
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
      const settled = recordsOf(alice.heard.snapshot());
      const after = await alice.daemon.exportBackup();
      await alice.daemon.close();

      const again = daemonOver(root, mediator);
      await again.daemon.boot();
      await again.daemon.unlock(PASSPHRASE);
      await until("the line is live again", () => again.heard.lines()?.connections[0]?.live === true);
      await pause(500);
      expect(recordsOf(again.heard.snapshot())).toEqual(settled);
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
      await again.daemon.close();

      const restored = daemonOver(await folder(), mediator);
      await restored.daemon.boot();
      await restored.daemon.restoreIdentity(before.bytes, PASSPHRASE);
      const merging = restored.heard.events.length;
      expect((await restored.daemon.mergeBackup(after.bytes)).added).toBeGreaterThan(0);
      await until("the merged vault's line is live", () => liveAfter(restored.heard, merging));
      await pause(500);
      expect(recordsOf(restored.heard.snapshot())).toEqual(settled);
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
    },
    LONG
  );
  /** Alice's backup restored on another machine, the issuer's document brought in there, and that replica exported: the evidence comes back as a backup to merge. */
  async function backupHoldingIssuer(backup: Uint8Array, didId: DidId, prior: MintedDid): Promise<Uint8Array> {
    const root = await folder();
    await writeFile(path.join(root, "backup.sqlite"), backup);
    const source = openPortable(openNodeSqlite(path.join(root, "backup.sqlite"), { mode: "readonly" }));
    let runtime: SqliteVault;
    try {
      const restored = await restoreVault(source, (mode) => openNodeSqlite(path.join(root, "replica.sqlite"), { mode }), {
        heldRoots: vaultHeldRoots(null),
        anchor: async (wrapped) => Keys.anchorOf(await unlockSeedKeystore(wrapped, PASSPHRASE)),
      });
      runtime = new SqliteVault(restored.runtime);
    } finally {
      source.close();
    }
    try {
      await issuerRecovered({ runtime, didId } as Addressed, prior);
      await exportVault(runtime, (mode) => openNodeSqlite(path.join(root, "evidence.sqlite"), { mode }), { heldRoots: vaultHeldRoots(null) });
    } finally {
      await runtime.close();
    }
    return new Uint8Array(await readFile(path.join(root, "evidence.sqlite")));
  }

  const inputsOf = (channel: ReturnType<typeof channelIn>) => channel.messages.filter(({ direction, headers }) => direction === "in" && headers?.type !== EMPTY_MESSAGE_TYPE).map(({ body, verification }) => [body.state === "available" ? body.body : body.state, verification.status]);

  test(
    "admits the observation once the evidence its proof waited for is merged in: the UI is handed the message with its content, and the acknowledgement it asks for as work owed, sent only by hand; the daemon opened again over the vault reads the same records and sends nothing",
    async () => {
      const mediator = await newMediator();
      const root = await folder();
      const alice = daemonOver(root, mediator);
      await alice.daemon.boot();
      await alice.daemon.createIdentity("Alice", PASSPHRASE);
      await alice.daemon.setMediator(mediator.did);
      await until("alice's line is live", () => alice.heard.lines()?.connections[0]?.live === true);
      const { invitation, didId } = await alice.daemon.createInvitation();
      const a0 = alice.heard.snapshot().dids.find((did) => did.didId === (didId as string))!.did! as Did;

      const bob = await run(mediator, 2, BOB, { privateAddresses: false });
      const b0 = bob.party.did;
      await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation.from }, { type: BASIC_MESSAGE, body: { content: "hello" } });
      await until("bob holds alice's move", () => bob.inbounds.length === 1);
      const pair = headOf(alice.heard.snapshot().channels.find((channel) => channel.localDid === a0)!);
      const a1 = alice.heard.snapshot().dids.find((did) => did.did === pair.localDid)!.didId as string as DidId;

      // Bob's word at Alice's new address proves his address succeeds one whose document Alice has never held: the observation is recorded, its admission waiting for that document.
      const { prior, proof } = await proofOfSuccession(bob.party, BOB_PRIOR);
      await forwarded(mediator, pair.localDid, await sealed(await peerSealer(bob.party as unknown as DirectParty), pair.localDid, { type: BASIC_MESSAGE, body: { content: "as I was saying" }, from_prior: proof, please_ack: [""] }));
      const forwards = forwardsSeen(mediator);
      const inbounds = bob.inbounds.length;
      await until("alice holds the observation", () => channelIn(alice.heard.snapshot(), pair).observations.some(({ disposition }) => disposition.status === "pending-admission"));
      await pause(500);
      const waiting = channelIn(alice.heard.snapshot(), pair);
      expect(inputsOf(waiting)).toEqual([]);
      expect(waiting.observations.at(-1)).toMatchObject({ standing: { status: "complete" }, verification: { status: "pending-proof" }, disposition: { status: "pending-admission", because: "the source's proof is not yet verified" } });
      expect(alice.heard.snapshot().pending).toMatchObject({ missingResponses: [], pendingProofs: [{ sourceEventCid: waiting.observations.at(-1)!.sourceEventCid, channelId: channelIdOf(pair) }] });

      const evidence = await backupHoldingIssuer((await alice.daemon.exportBackup()).bytes, a1, prior);
      const merging = alice.heard.events.length;
      expect(await alice.daemon.mergeBackup(evidence)).toMatchObject({ added: 1, renewed: false });
      await until("the agent over the merged vault is live", () => liveAfter(alice.heard, merging));
      await pause(500);
      await until("the UI is handed the admission", () => channelIn(alice.heard.snapshot(), pair).observations.at(-1)?.disposition.status === "admitted", 5_000);
      const admitted = channelIn(alice.heard.snapshot(), pair);
      expect(inputsOf(admitted)).toEqual([[{ content: "as I was saying" }, "verified"]]);
      expect(admitted.observations.at(-1)).toMatchObject({ standing: { status: "complete" }, verification: { status: "verified" }, disposition: { status: "admitted" }, contradicting: false });
      expect(alice.heard.snapshot().pending).toMatchObject({ missingResponses: [{ effectType: PURE_ACK_EFFECT, channelId: channelIdOf(pair) }], pendingProofs: [] });
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);
      const settled = recordsOf(alice.heard.snapshot());
      await alice.daemon.close();

      const again = daemonOver(root, mediator);
      await again.daemon.boot();
      await again.daemon.unlock(PASSPHRASE);
      await until("the line is live again", () => again.heard.lines()?.connections[0]?.live === true);
      await pause(500);
      expect(recordsOf(again.heard.snapshot())).toEqual(settled);
      expect([forwardsSeen(mediator), bob.inbounds.length]).toEqual([forwards, inbounds]);

      const { executionId } = again.heard.snapshot().pending.missingResponses[0]!;
      expect(await again.daemon.completeResponse(executionId as string as ExecutionId, PURE_ACK_EFFECT)).toEqual({ outcome: "submitted", because: null, messageId: expect.any(String) as string });
      await until("bob holds the acknowledgement", () => bob.inbounds.length === inbounds + 1);
      expect(forwardsSeen(mediator)).toBe(forwards + 1);
      await until("the acknowledgement is no longer owed", () => again.heard.snapshot().pending.missingResponses.length === 0);
    },
    LONG
  );
});
