import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiError, MethodInput, MethodName, PublishedSnapshotLink, ReplicaRecord, Snapshot } from "@estoc/daemon-api/contract";
import { Refusal, type Session } from "@estoc/daemon-api/wire";
import { PING_TYPE, type Channel } from "@estoc/vault";

import { newMediator } from "../../agent-core/test/helpers.js";
import type { FakeMediator } from "../../agent-core/test/fake-mediator.js";
import { createDaemon, limitsOf, methodsOf, type DaemonCore } from "../src/index.js";
import { nodeHost } from "../src/node/index.js";

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
  daemon: DaemonCore;
  call: Call;
  refused: (name: Exclude<MethodName, "attach">, input: unknown) => Promise<ApiError>;
}

/** A booted daemon over a folder of its own, whose transports are the mediator's as `wrap` lets them through; its methods as a view calls them. */
async function daemonOver(mediator: FakeMediator, wrap: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch = (fetch) => fetch): Promise<Over> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-replicas-"));
  roots.push(root);
  const daemon = createDaemon(nodeHost(root, { fetch: wrap(mediator.fetch), WebSocket: mediator.WebSocket }));
  daemons.push(daemon);
  await daemon.boot();
  const methods = methodsOf(daemon, limitsOf("clone")) as unknown as Record<string, (input: unknown, session: Session) => Promise<unknown>>;
  const call = (name: string, input: unknown) => methods[name]!(input, {} as Session);
  return {
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
async function person(mediator: FakeMediator, name: string, wrap?: Parameters<typeof daemonOver>[1]): Promise<Over> {
  const over = await daemonOver(mediator, wrap);
  await over.daemon.createIdentity(name, PASSPHRASE);
  await over.daemon.setMediator(mediator.did);
  return over;
}

/** A second device of `of`'s vault, restored from the link a new device enrolls from, once the mediator holds it. */
async function newDevice(mediator: FakeMediator, of: Over, wrap?: Parameters<typeof daemonOver>[1]): Promise<Over> {
  const before = mediator.replicas.size;
  const { link } = (await of.call("publishSnapshotLink", { selection: "enrollment" })) as PublishedSnapshotLink;
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

const petnames = (daemon: DaemonCore) => shown(daemon).conversations.flatMap((conversation) => (conversation.petname === null ? [] : [conversation.petname]));

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
});
