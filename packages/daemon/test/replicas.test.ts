import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, test } from "vitest";

import { schemas, type ApiError, type Hold, type MethodInput, type MethodName, type PublishedSnapshotLink, type ReplicaRecord, type Snapshot, type SnapshotLinkRecord } from "@estoc/daemon-api/contract";
import { Refusal, type Session } from "@estoc/daemon-api/wire";
import { Snapshot as CarSnapshot, type JsonValue, type LocalOptions } from "@estoc/event-store";
import { PING_TYPE, vaultHeldRoots, type Channel, type MediationId, type ReplicaId } from "@estoc/vault";
import { openBlob } from "@estoc/agent-core";
import { v7 as uuidv7 } from "uuid";

import { newMediator } from "../../agent-core/test/helpers.js";
import type { FakeMediator } from "../../agent-core/test/fake-mediator.js";
import { createDaemon, limitsOf, methodsOf, type DaemonCore } from "../src/index.js";
import { nodeHost } from "../src/node/index.js";
import { Receipts, ReplicaRecords } from "../src/replicas.js";
import { keyBytes } from "../src/snapshot-links.js";

const PASSPHRASE = "alice-passes-the-salt";
const LONG = 60_000;
/** A replica takes a link only at an https URL its own mediator serves. */
const MEDIATOR = "https://mediator.test/";

const roots: string[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Call = <Name extends Exclude<MethodName, "attach">>(name: Name, input: MethodInput<Name>) => Promise<unknown>;

interface Over {
  root: string;
  daemon: DaemonCore;
  call: Call;
  refused: (name: Exclude<MethodName, "attach">, input: unknown) => Promise<ApiError>;
}

type Wrap = (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;

/** A booted daemon over a folder of its own, or over `root` where another daemon was, whose transports are the mediator's as `wrap` lets them through; its methods as a view calls them. */
async function daemonOver(mediator: FakeMediator, wrap: Wrap = (fetch) => fetch, root?: string): Promise<Over> {
  if (root === undefined) {
    root = await mkdtemp(path.join(tmpdir(), "estoc-replicas-"));
    roots.push(root);
  }
  const daemon = createDaemon(nodeHost(root, { fetch: wrap(mediator.fetch), WebSocket: mediator.WebSocket }));
  daemons.push(daemon);
  await daemon.boot();
  const methods = methodsOf(daemon, limitsOf("clone")) as unknown as Record<string, (input: unknown, session: Session) => Promise<unknown>>;
  const call = (name: string, input: unknown) => methods[name]!(input, {} as Session);
  return {
    root,
    daemon,
    call: (name, input) => call(name, input),
    refused: async (name, input) => {
      const outcome: unknown = await call(name, input).then(
        (value) => new Error(`answered ${JSON.stringify(value)} instead of refusing`),
        (error: unknown) => error
      );
      if (!(outcome instanceof Refusal)) throw outcome;
      return outcome.error;
    },
  };
}

/** A person's vault over the mediator, under `name`. */
async function person(mediator: FakeMediator, name: string, wrap?: Wrap): Promise<Over> {
  const over = await daemonOver(mediator, wrap);
  await over.daemon.createIdentity(name, PASSPHRASE);
  await over.daemon.setMediator(mediator.did);
  return over;
}

/** A second device of `of`'s vault, restored from the link a new device enrolls from, once the mediator holds it. */
async function newDevice(mediator: FakeMediator, of: Over, wrap?: Wrap): Promise<Over> {
  const before = mediator.replicas.size;
  const { link } = (await of.call("publishSnapshotLink", { part: "seed" })) as PublishedSnapshotLink;
  const device = await daemonOver(mediator, wrap);
  await device.call("restoreFromLink", { link, passphrase: PASSPHRASE });
  await until("the new device is a replica at the mediator", () => mediator.replicas.size === before + 1);
  return device;
}

async function until(what: string, condition: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await delay(20);
  }
}

const shown = (daemon: DaemonCore): Snapshot => {
  const { value } = daemon.publisher.current.state;
  if (value.phase !== "open") throw new Error(`the daemon is ${value.phase}`);
  return value.snapshot;
};

/** The replicas a daemon shows of its selected arrangement; none while it was shown no listing. */
const replicasOf = (daemon: DaemonCore): ReplicaRecord[] => shown(daemon).mediations.find((mediation) => mediation.selected)?.replicas?.replicas ?? [];

const other = (daemon: DaemonCore): ReplicaRecord => {
  const others = replicasOf(daemon).filter((replica) => !replica.self);
  if (others.length !== 1) throw new Error(`${others.length} other replicas are shown`);
  return others[0]!;
};

const petnames = (daemon: DaemonCore) => shown(daemon).conversations.flatMap((conversation) => (conversation.petname === null ? [] : [conversation.petname])).sort();

const channel = (peer: string): Channel => ({ localDid: `did:peer:4zQmAnna${peer}`, peerDid: `did:peer:4zQm${peer}` }) as Channel;

const gone = () => Promise.resolve(new Response("gone", { status: 404 }));

/** A device's reads of snapshots at the mediator once armed: the first held until released and then answered as `first` says, each later one as `later` says. */
function snapshotReads(first: "read" | "gone", later: "read" | "gone" = "read") {
  let armed = false;
  let reads = 0;
  let reached!: () => void;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached: new Promise<void>((resolve) => (reached = resolve)),
    arm: () => void (armed = true),
    release,
    wrap: ((fetch) => async (input, init) => {
      if (!armed || !String(input).startsWith(`${MEDIATOR}b/`)) return fetch(input, init);
      reads += 1;
      if (reads > 1) return later === "read" ? fetch(input, init) : gone();
      reached();
      await released;
      return first === "read" ? fetch(input, init) : gone();
    }) satisfies Wrap,
  };
}

/** The lines `daemon` logs from now on. */
function logged(daemon: DaemonCore): string[] {
  const lines: string[] = [];
  daemon.publisher.attach({ state: () => undefined, lines: () => undefined, log: ({ line }) => void lines.push(line), unavailable: () => undefined });
  return lines;
}

/** A backup is exported in the files' turn, so whatever was waiting on that turn before it is done. */
const turnTaken = async (daemon: DaemonCore) => {
  await daemon.exportBackup();
  await daemon.refresh();
};

describe("the replicas of a vault", () => {
  it(
    "are listed by each device once it is connected, and again when asked, each with whether it is that device's own",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await until("the first device lists itself", () => replicasOf(a.daemon).length === 1);
      expect(replicasOf(a.daemon)).toEqual([{ replicaId: expect.any(String) as string, did: expect.stringMatching(/^did:peer:4/) as string, self: true, state: "active", addedAt: expect.any(String) as string, removedAt: null, sent: null }]);

      const b = await newDevice(mediator, a);
      await until("the new device lists both", () => replicasOf(b.daemon).length === 2);
      expect(await a.call("refreshReplicas", {})).toBeNull();
      expect(replicasOf(a.daemon).map(({ self, state }) => ({ self, state }))).toEqual([
        { self: true, state: "active" },
        { self: false, state: "active" },
      ]);
      expect(replicasOf(b.daemon).map(({ replicaId, self }) => ({ replicaId, self: !self }))).toEqual(replicasOf(a.daemon).map(({ replicaId, self }) => ({ replicaId, self })));
    },
    LONG
  );

  it(
    "are shown as last listed while the mediator is out of reach",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      let offline = false;
      const a = await person(mediator, "Alice", (fetch) => (input, init) => (offline ? Promise.reject(new TypeError("the network is down")) : fetch(input, init)));
      await newDevice(mediator, a);
      await a.call("refreshReplicas", {});
      const listed = shown(a.daemon).mediations[0]!.replicas;
      expect(listed?.replicas).toHaveLength(2);

      offline = true;
      await expect(a.call("refreshReplicas", {})).rejects.toThrow();
      expect(shown(a.daemon).mediations[0]!.replicas).toEqual(listed);
    },
    LONG
  );

  it(
    "list one the mediator removed as removed, and send it no history, named or not",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await newDevice(mediator, a);
      await a.call("refreshReplicas", {});
      const { replicaId, did } = other(a.daemon);
      mediator.replicas.get(did)!.removedTime = 1_790_000_000;

      await a.call("refreshReplicas", {});
      expect(other(a.daemon)).toMatchObject({ replicaId, state: "removed", removedAt: "2026-09-21T14:13:20.000Z" });
      const links = mediator.blobs.size;
      expect(await a.refused("sync", {})).toEqual({ code: "OperationFailed", message: "the mediator holds no other replica of this vault", effect: "none", messageId: null });
      expect(await a.refused("sync", { replicaId })).toEqual({ code: "OperationFailed", message: `the mediator holds no other replica ${replicaId} of this vault`, effect: "none", messageId: null });
      expect(mediator.blobs.size).toBe(links);
    },
    LONG
  );

  it(
    "are asked of the mediator again when the agent connects again",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await until("the first device lists itself", () => replicasOf(a.daemon).length === 1);
      await newDevice(mediator, a);
      expect(replicasOf(a.daemon)).toHaveLength(1);

      expect(await a.call("reconnect", {})).toBeNull();
      await until("the first device lists the new one", () => replicasOf(a.daemon).length === 2);
    },
    LONG
  );

  it(
    "show a time the mediator gave as none where its year runs past four digits",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await newDevice(mediator, a);
      await a.call("refreshReplicas", {});
      const { did } = other(a.daemon);
      const removedAt = async (seconds: number) => {
        mediator.replicas.get(did)!.removedTime = seconds;
        await a.call("refreshReplicas", {});
        expect(schemas.snapshot.safeParse(shown(a.daemon)).success).toBe(true);
        return other(a.daemon).removedAt;
      };

      expect(await removedAt(253_402_300_799)).toBe("9999-12-31T23:59:59.000Z");
      expect(await removedAt(253_402_300_800)).toBeNull();
      expect(await removedAt(-62_167_219_200)).toBe("0000-01-01T00:00:00.000Z");
      expect(await removedAt(-62_167_219_201)).toBeNull();
    },
    LONG
  );
});

describe("history sent to another replica", () => {
  it(
    "is imported by the new device as it arrives, and sent again brings nothing",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await a.daemon.createContact("Bob", [{ localDid: "did:peer:4zQmAnna", peerDid: "did:peer:4zQmBob" } as Channel]);
      const b = await newDevice(mediator, a);
      await until("the new device is live", () => replicasOf(b.daemon).length === 2);
      expect(petnames(b.daemon)).toEqual([]);

      await a.call("refreshReplicas", {});
      const to = other(a.daemon).replicaId;
      expect(await a.call("sync", { replicaId: to })).toEqual({ told: [to] });
      expect(other(a.daemon).sent).toEqual({ at: expect.any(String) as string, outcome: "sent" });
      const { links } = (await a.call("snapshotLinks", {})) as { links: SnapshotLinkRecord[] };
      expect(links.map((record) => record.part)).toEqual(["seed", "content"]);
      const put = links.find((record): record is PublishedSnapshotLink => record.status === "published" && record.part === "content")!;
      const sealed = [...mediator.blobs.values()].find((blob) => blob.hash === put.hash)!.bytes!;
      const sent = await CarSnapshot.read(await openBlob(sealed, { hash: put.hash, key: keyBytes(put.link.key) }), { heldRoots: vaultHeldRoots(null) });
      expect(sent.seed).toBeUndefined();
      expect(sent.content?.replica).toBe(replicasOf(a.daemon).find((replica) => replica.self)!.replicaId);
      await until("the new device imported the history", () => shown(b.daemon).historyReceived?.status === "imported");
      const first = shown(b.daemon).historyReceived!;
      expect(first).toMatchObject({ from: replicasOf(b.daemon).find((replica) => !replica.self)!.replicaId, status: "imported", merged: { renewed: false } });
      expect(first.status === "imported" && first.merged.added).toBeGreaterThan(0);
      expect(petnames(b.daemon)).toEqual(["Bob"]);

      expect(await a.call("sync", {})).toEqual({ told: [to] });
      await until("the new device imported the history again", () => shown(b.daemon).historyReceived !== first && shown(b.daemon).historyReceived?.status === "imported");
      expect(shown(b.daemon).historyReceived).toMatchObject({ status: "imported", merged: { added: 0, objects: 0 } });
    },
    LONG
  );

  it(
    "brings the mail the new device let go of before it held the history to open it with",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      const aliceDid = (await a.daemon.publicDid()).did;
      const b = await newDevice(mediator, a);
      await until("the new device is live", () => replicasOf(b.daemon).length === 2);

      const bob = await person(mediator, "Bob");
      expect((await bob.daemon.addContactByDid(aliceDid, "Alice")).outcome).toBe("submitted");
      const ping = (snapshot: Snapshot) => snapshot.messages.some((message) => message.direction === "in" && message.headers?.type === PING_TYPE);
      await until("the first device holds bob's Ping", () => ping(shown(a.daemon)));
      expect(ping(shown(b.daemon))).toBe(false);

      expect(await a.call("sync", {})).toEqual({ told: [other(a.daemon).replicaId] });
      await until("the new device imported the history", () => shown(b.daemon).historyReceived?.status === "imported");
      expect(ping(shown(b.daemon))).toBe(true);
    },
    LONG
  );

  it(
    "says why it was not imported when its snapshot cannot be read, and the vault takes nothing",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      let gone = false;
      const b = await newDevice(mediator, a, (fetch) => (input, init) => (gone && String(input).startsWith(`${MEDIATOR}b/`) ? Promise.resolve(new Response("gone", { status: 404 })) : fetch(input, init)));
      await until("the new device is live", () => replicasOf(b.daemon).length === 2);
      gone = true;
      const before = shown(b.daemon).messages.length;

      expect(await a.call("sync", {})).toEqual({ told: [other(a.daemon).replicaId] });
      await until("the new device gave up the history", () => shown(b.daemon).historyReceived?.status === "failed");
      expect(shown(b.daemon).historyReceived).toMatchObject({ status: "failed", because: "no snapshot is at that link any more: it was revoked, or the mediator has let it go" });
      expect(shown(b.daemon).messages).toHaveLength(before);
      expect(petnames(b.daemon)).toEqual([]);
    },
    LONG
  );

  it.each([
    ["was not imported", "gone", "failed"],
    ["was imported", "read", "imported"],
  ] as const)(
    "is shown as received when history sent before it ends after it, though what that brings is merged, where the later one %s",
    async (_, later, status) => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await a.daemon.createContact("First", [channel("First")]);
      const reads = snapshotReads("read", later);
      const b = await newDevice(mediator, a, reads.wrap);
      await until("the new device is live", () => replicasOf(b.daemon).length === 2);
      const lines = logged(b.daemon);
      reads.arm();

      await a.call("sync", {});
      await reads.reached;
      await a.daemon.createContact("Second", [channel("Second")]);
      await a.call("sync", {});
      await until("the later history is over", () => shown(b.daemon).historyReceived?.status === status);
      const shownLater = shown(b.daemon).historyReceived;

      reads.release();
      await until("the earlier history is over", () => lines.some((line) => line.includes("sent before the one shown")));
      await turnTaken(b.daemon);
      expect(lines.filter((line) => line.includes("sent before the one shown"))).toEqual([expect.stringMatching(later === "gone" ? /was imported too, adding [1-9]\d* events$/ : /was imported too, adding 0 events$/)]);
      expect(shown(b.daemon).historyReceived).toEqual(shownLater);
      expect(petnames(b.daemon)).toEqual(later === "gone" ? ["First"] : ["First", "Second"]);
    },
    LONG
  );

  it.each([
    ["it was read", "read", "the vault was let go of before the snapshot could be merged into it"],
    ["it could not be read", "gone", "no snapshot is at that link any more: it was revoked, or the mediator has let it go"],
  ] as const)(
    "is shown as not imported once the vault is unlocked, where it was locked before the import was over and %s",
    async (_, first, because) => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await a.daemon.createContact("Bob", [channel("Bob")]);
      const reads = snapshotReads(first);
      const b = await newDevice(mediator, a, reads.wrap);
      await until("the new device is live", () => replicasOf(b.daemon).length === 2);
      reads.arm();

      await a.call("sync", {});
      await reads.reached;
      await until("the import is shown under way", () => shown(b.daemon).historyReceived?.status === "importing");
      await b.daemon.lock();
      reads.release();
      await b.daemon.unlock(PASSPHRASE);
      await until("the import is over", () => shown(b.daemon).historyReceived?.status !== "importing");
      expect(shown(b.daemon).historyReceived).toMatchObject({ status: "failed", because });
      expect(petnames(b.daemon)).toEqual([]);
    },
    LONG
  );

  it(
    "is shown as not imported when the daemon importing it stopped before the import was over",
    async () => {
      const mediator = await newMediator(200, MEDIATOR);
      const a = await person(mediator, "Alice");
      await a.daemon.createContact("Bob", [channel("Bob")]);
      const reads = snapshotReads("read");
      const b = await newDevice(mediator, a, reads.wrap);
      await until("the new device is live", () => replicasOf(b.daemon).length === 2);
      reads.arm();

      await a.call("sync", {});
      await reads.reached;
      await until("the import is shown under way", () => shown(b.daemon).historyReceived?.status === "importing");
      const { from, at } = shown(b.daemon).historyReceived!;
      await b.daemon.close();
      reads.release();

      const again = await daemonOver(mediator, undefined, b.root);
      await again.daemon.unlock(PASSPHRASE);
      expect(shown(again.daemon).historyReceived).toEqual({ from, at, status: "failed", because: "the daemon stopped before the import was over" });
      expect(petnames(again.daemon)).toEqual([]);
    },
    LONG
  );
});

describe("what a runtime keeps of its replicas", () => {
  const optionsOf = (kept: Record<string, JsonValue> = {}): LocalOptions => {
    const values = new Map(Object.entries(kept));
    return {
      get: async (key) => values.get(key),
      set: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
      keys: async () => [...values.keys()],
    };
  };
  const mediationId = "mediation" as MediationId;
  const hold = "hold" as Hold;
  const merged = { added: 3, duplicates: 0, objects: 0, repaired: 0, renewed: false };

  test("a time kept whose year runs past four digits is read as none", async () => {
    const replicaId = uuidv7() as ReplicaId;
    const options = optionsOf({
      [`daemon.replicas.${mediationId}`]: { listedAt: 1_790_000_000_000, replicas: [{ replicaId, did: "did:peer:4zQmA", state: "removed", addedAt: 253_402_300_800_000, removedAt: -62_167_219_201_000 }] },
      [`daemon.historySent.${replicaId}`]: { at: 8_640_000_000_000_000, outcome: "sent" },
      "daemon.historyReceived": { from: replicaId, at: -8_640_000_000_000_000, status: "importing" },
    });
    const records = new ReplicaRecords(options);

    const listing = await records.listing(mediationId, replicaId);
    expect(listing).toEqual({ listedAt: "2026-09-21T14:13:20.000Z", replicas: [{ replicaId, did: "did:peer:4zQmA", self: true, state: "removed", addedAt: null, removedAt: null, sent: null }] });
    expect(schemas.replicaListing.safeParse(listing).success).toBe(true);
    expect(await records.received()).toBeNull();
  });

  test("history received later stays shown when history received before it ends after it", async () => {
    const options = optionsOf();
    const receipts = new Receipts();
    const [first, second] = [uuidv7() as ReplicaId, uuidv7() as ReplicaId];
    const earlier = receipts.begin(hold, first);
    await receipts.keep(hold, options);
    const later = receipts.begin(hold, second);
    await receipts.keep(hold, options);

    expect(later.end({ status: "failed", because: "gone" })).toBe(true);
    await receipts.keep(hold, options);
    expect(earlier.end({ status: "imported", merged })).toBe(false);
    await receipts.keep(hold, options);
    expect(await new ReplicaRecords(options).received()).toMatchObject({ from: second, status: "failed", because: "gone" });
  });

  test("history received into one vault file is written into no other", async () => {
    const receipts = new Receipts();
    receipts.begin(hold, uuidv7() as ReplicaId).end({ status: "imported", merged });
    const options = optionsOf();
    await receipts.keep("another" as Hold, options);
    expect(await options.keys()).toEqual([]);
  });
});
