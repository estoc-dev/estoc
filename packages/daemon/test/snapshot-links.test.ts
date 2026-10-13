import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { Snapshot as CarSnapshot, exportSnapshot, restoreSnapshot } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import type { ApiError, MethodInput, MethodName, Snapshot } from "@estoc/daemon-api/contract";
import { Refusal, type Session } from "@estoc/daemon-api/wire";
import { unlockSeedKeystore } from "@estoc/keystore";
import { ENROLLMENT_EVENT_TYPES, Keys, vaultDraft, vaultHeldRoots, type Channel, type Did } from "@estoc/vault";

import { BLOB_DELETE, BLOB_PUT, REPLICA_ADD, SEAL_OVERHEAD, blobName, openBlob, openRestoredVault, type VaultSession } from "@estoc/agent-core";
import { newMediator } from "../../agent-core/test/helpers.js";
import type { FakeMediator } from "../../agent-core/test/fake-mediator.js";
import { createDaemon, limitsOf, methodsOf, type DaemonCore } from "../src/index.js";
import { nodeHost } from "../src/node/index.js";
import { keyBytes } from "../src/snapshot-links.js";

const PASSPHRASE = "alice-passes-the-salt";

/** A did:peer:4 short form spelled from a name: the shape a channel end has, with no document behind it. */
const shortForm = (name: string): string => `did:peer:4zQm${name.padEnd(44, "1")}`;
const LONG = 60_000;

const roots: string[] = [];
const daemons: DaemonCore[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-links-"));
  roots.push(root);
  return root;
}

const session = {} as Session;

type Call = <Name extends Exclude<MethodName, "attach">>(name: Name, input: MethodInput<Name>) => Promise<unknown>;

/** A daemon over `root` whose transports are the mediator's, as `wrap` lets them through; its methods as a view calls them, under a backup bound of `maxBackupBytes` and a seed bound of `maxSeedBytes`. */
function daemonOver(root: string, mediator: FakeMediator, options: { wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch; maxBackupBytes?: number; maxSeedBytes?: number } = {}): { daemon: DaemonCore; call: Call; refused: (name: Exclude<MethodName, "attach">, input: unknown) => Promise<ApiError>; fetched: string[] } {
  const fetched: string[] = [];
  const reach = options.wrap?.(mediator.fetch) ?? mediator.fetch;
  const host = nodeHost(root, {
    fetch: (input, init) => {
      fetched.push(`${init?.method ?? "GET"} ${String(input)}`);
      return reach(input, init);
    },
    WebSocket: mediator.WebSocket,
  });
  const daemon = createDaemon(host, options.maxSeedBytes === undefined ? {} : { maxSeedBytes: options.maxSeedBytes });
  daemons.push(daemon);
  const methods = methodsOf(daemon, limitsOf("clone", options.maxBackupBytes)) as unknown as Record<string, (input: unknown, session: Session) => Promise<unknown>>;
  const call = (name: string, input: unknown) => methods[name]!(input, session);
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
    fetched,
  };
}

/** A person's daemon with a vault over the mediator, and a contact in it. */
async function alice(mediator: FakeMediator, options: Parameters<typeof daemonOver>[2] = {}) {
  const root = await folder();
  const over = daemonOver(root, mediator, options);
  await over.daemon.boot();
  await over.daemon.createIdentity("Alice", PASSPHRASE);
  await over.daemon.setMediator(mediator.did);
  await over.daemon.createContact("Bob", [{ localDid: shortForm("Anna"), peerDid: shortForm("Bob") } as Channel]);
  return { root, ...over };
}

/** A person's daemon copied whole and run apart from the original, each writing since under the one replica ID, and a backup of the original: merging it makes the copy take a fresh replica ID. */
async function apart(mediator: FakeMediator, options: Parameters<typeof daemonOver>[2] = {}) {
  const original = await alice(mediator);
  await original.daemon.close();
  const copy = await folder();
  await cp(path.join(original.root, ".estoc"), path.join(copy, ".estoc"), { recursive: true });

  const here = daemonOver(original.root, mediator);
  await here.daemon.boot();
  await here.daemon.unlock(PASSPHRASE);
  await here.daemon.createContact("Carmen", [{ localDid: shortForm("Anna"), peerDid: shortForm("Carmen") } as Channel]);
  const backup = await here.daemon.exportBackup();

  const there = daemonOver(copy, mediator, options);
  await there.daemon.boot();
  await there.daemon.unlock(PASSPHRASE);
  await there.daemon.createContact("Dave", [{ localDid: shortForm("Anna"), peerDid: shortForm("Dave") } as Channel]);
  return { there, backup };
}

/** The daemon's backup restored elsewhere, there an arrangement with `mediatorDid` recorded registered and selected, and that replica exported: a backup that makes the arrangement preferred once merged, though the daemon's replica is no member of it. */
async function backupPreferring(backup: Uint8Array, mediatorDid: string): Promise<Uint8Array> {
  const root = await folder();
  let seedKey!: Awaited<ReturnType<typeof unlockSeedKeystore>>;
  const restored = await restoreSnapshot(await CarSnapshot.read(backup, { heldRoots: vaultHeldRoots(null) }), () => openNodeSqlite(path.join(root, "replica.sqlite"), { mode: "create" }), {
    anchor: async (wrapped) => {
      seedKey = await unlockSeedKeystore(wrapped, PASSPHRASE);
      return Keys.anchorOf(seedKey);
    },
  });
  const vault: VaultSession = await openRestoredVault(restored.runtime, seedKey);
  try {
    const { mediationId } = (await vault.createMediation(mediatorDid as Did)).data;
    await vault.decide(() => [vaultDraft("mediation.granted", { mediationId, routingDid: mediatorDid as Did })]);
    await vault.selectMediation(mediationId);
    return await exportSnapshot(vault.runtime, { parts: "both", heldRoots: vaultHeldRoots(null) });
  } finally {
    await vault.runtime.close();
  }
}

async function newcomer(mediator: FakeMediator, options: Parameters<typeof daemonOver>[2] = {}) {
  const root = await folder();
  const over = daemonOver(root, mediator, options);
  await over.daemon.boot();
  return { root, ...over };
}

type Link = { url: string; hash: string; key: string };
type Published = { status: "published"; hash: string; part: "seed" | "content"; placedAt: string; retainUntil: string; revocable: boolean; link: Link };

function latch(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false
  );

const vaultFile = (root: string) => path.join(root, ".estoc", "vault.sqlite");

/** What the snapshot `bytes` carries, read from a copy of them: the parts, the anchor, and its events and objects. */
async function eventsOf(bytes: Uint8Array): Promise<{ seed: boolean; content: boolean; anchor: string; cids: string[]; types: Set<string>; objects: number }> {
  const source = await CarSnapshot.read(bytes.slice(), { heldRoots: vaultHeldRoots(null) });
  const cids: string[] = [];
  const types = new Set<string>();
  for await (const event of source.vault.events.scan()) {
    cids.push(event.cid);
    types.add(event.type);
  }
  return { seed: source.seed !== undefined, content: source.content !== undefined, anchor: source.metadata.anchor, cids: cids.sort(), types, objects: source.objects };
}

/** The files the daemon at `root` keeps: its vault and the database it owns the folder by, with what SQLite keeps beside the vault, and nothing else. */
async function files(root: string): Promise<string[]> {
  return (await readdir(path.join(root, ".estoc"))).filter((name) => !/^(vault|owner)\.sqlite-/.test(name)).sort();
}

/** `response` with its body handed out a piece at a time as it is pulled, `pulled` told of each, and no length announced: what a read that stops early leaves unread. */
async function piecemeal(response: Response, pulled: (bytes: number) => void): Promise<Response> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let at = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        const piece = bytes.slice(at, at + 256);
        at += piece.length;
        pulled(piece.length);
        controller.enqueue(piece);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, { status: response.status });
}

/** The snapshot a link names, as the mediator holds it, opened. */
function linked(mediator: FakeMediator, link: Link): Promise<Uint8Array> {
  const sealed = [...mediator.blobs.values()].find((blob) => blob.hash === link.hash)?.bytes;
  if (sealed == null) throw new Error(`the mediator holds no bytes of ${link.hash}`);
  return openBlob(sealed, { hash: link.hash, key: keyBytes(link.key) });
}

async function until(what: string, condition: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await delay(20);
  }
}

/** The replica DIDs the mediator added for the account a daemon's arrangement registered. */
const replicasOf = (mediator: FakeMediator, account: string): string[] => [...mediator.replicas.values()].filter((replica) => replica.account === account).map((replica) => replica.replicaDid);

const shown = (daemon: DaemonCore): Snapshot => {
  const { value } = daemon.publisher.current.state;
  if (value.phase !== "open") throw new Error(`the daemon is ${value.phase}`);
  return value.snapshot;
};

describe("a snapshot link", () => {
  it(
    "of the seed restores the vault on a daemon with none: the anchor and every event the seed carries, under the passphrase the link does not carry",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const published = (await a.call("publishSnapshotLink", { part: "seed" })) as Published;
      const carried = await eventsOf(await linked(mediator, published.link));
      expect(published).toEqual({ status: "published", hash: published.link.hash, part: "seed", placedAt: expect.any(String) as string, retainUntil: expect.any(String) as string, revocable: true, link: { url: expect.stringMatching(/^https?:\/\//) as string, hash: published.hash, key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string } });
      expect(Date.parse(published.retainUntil)).toBeGreaterThan(Date.parse(published.placedAt));

      const b = await newcomer(mediator);
      expect(await b.refused("restoreFromLink", { link: published.link, passphrase: "not the passphrase" })).toEqual({ code: "OperationFailed", message: "that passphrase does not open this backup", effect: "none", messageId: null });
      expect(await exists(vaultFile(b.root))).toBe(false);
      expect(b.daemon.publisher.current.state.value.phase).toBe("onboarding");

      expect(await b.call("restoreFromLink", { link: published.link, passphrase: PASSPHRASE })).toBeNull();
      expect(shown(b.daemon).anchor).toBe(shown(a.daemon).anchor);
      expect(shown(b.daemon).restoreUnexplained).toBe(true);
      const restored = await eventsOf((await b.daemon.exportBackup()).bytes);
      expect(restored.anchor).toBe(carried.anchor);
      expect(restored.cids).toEqual(expect.arrayContaining(carried.cids));
      expect(await files(b.root)).toEqual(["owner.sqlite", "vault.sqlite"]);
    },
    LONG
  );

  it(
    "is listed by the daemon that put it, with what it carries, until revoked, again once that daemon is reopened, and reads nothing once revoked",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const first = (await a.call("publishSnapshotLink", { part: "seed" })) as Published;
      const second = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      expect([first.part, second.part]).toEqual(["seed", "content"]);
      expect(second.hash).not.toBe(first.hash);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [first, second] });

      await a.daemon.close();
      const reopened = daemonOver(a.root, mediator);
      await reopened.daemon.boot();
      await reopened.daemon.unlock(PASSPHRASE);
      expect(await reopened.call("snapshotLinks", {})).toEqual({ links: [first, second] });

      expect(await reopened.call("revokeSnapshotLink", { hash: first.hash })).toBeNull();
      expect(await reopened.call("snapshotLinks", {})).toEqual({ links: [second] });
      expect([...mediator.blobs.values()].map((blob) => blob.hash)).toEqual([second.hash]);
      expect(await reopened.refused("revokeSnapshotLink", { hash: first.hash })).toEqual({ code: "OperationFailed", message: `no snapshot ${first.hash} was put from here`, effect: "none", messageId: null });

      const b = await newcomer(mediator);
      expect(await b.refused("restoreFromLink", { link: first.link, passphrase: PASSPHRASE })).toEqual({ code: "OperationFailed", message: "no snapshot is at that link any more: it was revoked, or the mediator has let it go", effect: "none", messageId: null });
      expect(await exists(vaultFile(b.root))).toBe(false);
    },
    LONG
  );

  it(
    "whose bytes failed to upload stays pending, with no link and with the mediator's retention, until it is revoked, which frees what the mediator holds",
    async () => {
      const mediator = await newMediator();
      const failing = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => (input, init) => (init?.method === "PUT" ? Promise.resolve(new Response("the disk is full", { status: 507 })) : fetch(input, init));
      const a = await alice(mediator, { wrap: failing });
      await expect(a.call("publishSnapshotLink", { part: "content" })).rejects.toMatchObject({ name: "BlobTransferFailed", status: 507 });
      const [blob] = [...mediator.blobs.values()];
      expect(blob).toMatchObject({ bytes: null });
      const { links } = (await a.call("snapshotLinks", {})) as { links: unknown[] };
      expect(links).toEqual([{ status: "pending", hash: blob!.hash, part: "content", placedAt: expect.any(String) as string, retainUntil: expect.any(String) as string }]);

      expect(await a.call("revokeSnapshotLink", { hash: blob!.hash })).toBeNull();
      expect(mediator.blobs.size).toBe(0);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });
    },
    LONG
  );

  it(
    "is published when the upload is answered as a browser answers it, a 204 with an empty body",
    async () => {
      const mediator = await newMediator();
      const asABrowser = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) => {
        const response = await fetch(input, init);
        if (response.status !== 204) return response;
        const empty = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
        return new Proxy(response, {
          get: (target, key) => {
            if (key === "body") return empty;
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        });
      };
      const a = await alice(mediator, { wrap: asABrowser });
      await expect(a.call("publishSnapshotLink", { part: "content" })).resolves.toMatchObject({ status: "published" });
    },
    LONG
  );

  it(
    "whose put the mediator never answered stays pending with no retention known, and revoking it asks the mediator to delete it all the same",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      mediator.intercept = (msg) => (msg.type === BLOB_PUT ? null : undefined);
      await expect(a.call("publishSnapshotLink", { part: "content" })).rejects.toThrow();
      mediator.intercept = null;
      const { links } = (await a.call("snapshotLinks", {})) as { links: { hash: string }[] };
      expect(links).toEqual([{ status: "pending", hash: expect.any(String) as string, part: "content", placedAt: expect.any(String) as string, retainUntil: null }]);
      expect(mediator.blobs.size).toBe(0);

      expect(await a.call("revokeSnapshotLink", { hash: links[0]!.hash })).toBeNull();
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });
    },
    LONG
  );

  it(
    "revoked while its put is under way is deleted at the mediator only once that put has settled: the link then reads nothing, and the put writes nothing back",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const put = latch();
      const answer = latch();
      const deleted = latch();
      mediator.intercept = async (msg) => {
        if (msg.type === BLOB_DELETE) deleted.release();
        if (msg.type !== BLOB_PUT) return undefined;
        put.release();
        await answer.reached;
        return undefined;
      };
      const publishing = a.call("publishSnapshotLink", { part: "content" }) as Promise<Published>;
      await put.reached;
      const { links } = (await a.call("snapshotLinks", {})) as { links: { hash: string }[] };
      expect(links).toEqual([{ status: "pending", hash: expect.any(String) as string, part: "content", placedAt: expect.any(String) as string, retainUntil: null }]);
      const revoking = a.call("revokeSnapshotLink", { hash: links[0]!.hash });
      const deletedEarly = await Promise.race([deleted.reached.then(() => true), delay(300).then(() => false)]);
      answer.release();
      expect(deletedEarly).toBe(false);

      const published = await publishing;
      expect(published.hash).toBe(links[0]!.hash);
      expect(await revoking).toBeNull();
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });
      expect(mediator.blobs.size).toBe(0);
      expect((await mediator.fetch(published.link.url)).status).toBe(404);
    },
    LONG
  );

  it(
    "put before its daemon took a fresh replica ID stays listed once published, as not revocable, and revoking it is refused with its record kept; one whose upload failed is dropped, and one put since revokes as before",
    async () => {
      const mediator = await newMediator();
      let failing = false;
      const flaky = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => (input, init) => (failing && init?.method === "PUT" ? Promise.resolve(new Response("the disk is full", { status: 507 })) : fetch(input, init));
      const { there, backup } = await apart(mediator, { wrap: flaky });
      const before = (await there.call("publishSnapshotLink", { part: "content" })) as Published;
      failing = true;
      await expect(there.call("publishSnapshotLink", { part: "content" })).rejects.toMatchObject({ name: "BlobTransferFailed", status: 507 });
      failing = false;
      expect(((await there.call("snapshotLinks", {})) as { links: unknown[] }).links).toHaveLength(2);

      expect(await there.daemon.mergeBackup(backup.bytes)).toMatchObject({ renewed: true });
      const kept = { links: [{ ...before, revocable: false }] };
      expect(await there.call("snapshotLinks", {})).toEqual(kept);
      expect(await there.refused("revokeSnapshotLink", { hash: before.hash })).toEqual({ code: "OperationFailed", message: `snapshot ${before.hash} was put under a replica ID this runtime has given up since, and only that replica may delete it at the mediator, which keeps it until ${before.retainUntil}`, effect: "none", messageId: null });
      expect(await there.call("snapshotLinks", {})).toEqual(kept);
      expect((await mediator.fetch(before.link.url)).status).toBe(200);

      const since = (await there.call("publishSnapshotLink", { part: "content" })) as Published;
      expect(since.revocable).toBe(true);
      expect(await there.call("revokeSnapshotLink", { hash: since.hash })).toBeNull();
      expect((await mediator.fetch(since.link.url)).status).toBe(404);
      expect(await there.call("snapshotLinks", {})).toEqual(kept);
    },
    LONG
  );

  it(
    "whose put the mediator refuses is not kept: there is nothing there to revoke",
    async () => {
      const mediator = await newMediator();
      mediator.blobLimits = { ...mediator.blobLimits!, quotaBytes: 1 };
      const a = await alice(mediator);
      expect(await a.refused("publishSnapshotLink", { part: "content" })).toEqual({ code: "OperationFailed", message: expect.stringMatching(/^the mediator refused the snapshot: put was refused: e\.p\.blob\.quota/) as string, effect: "none", messageId: null });
      expect(mediator.blobs.size).toBe(0);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });
    },
    LONG
  );

  it(
    "is refused whole when the snapshot comes to more than a blob at the mediator holds once sealed: nothing is put or kept",
    async () => {
      const mediator = await newMediator();
      mediator.blobLimits = { ...mediator.blobLimits!, maxBytes: 4096 };
      const a = await alice(mediator);
      expect(await a.refused("publishSnapshotLink", { part: "content" })).toEqual({ code: "ResourceLimit", message: expect.stringMatching(new RegExp(`^the snapshot comes to at least \\d+ bytes, over the ${4096 - SEAL_OVERHEAD} a blob at the mediator holds once sealed$`)) as string, effect: "none", messageId: null });
      expect(mediator.blobs.size).toBe(0);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });

      mediator.blobLimits = null;
      expect(await a.refused("publishSnapshotLink", { part: "content" })).toEqual({ code: "OperationFailed", message: "the mediator keeps no blobs", effect: "none", messageId: null });
    },
    LONG
  );

  it(
    "is published at once after its daemon took a fresh replica ID, the new replica added at the preferred arrangement before the put",
    async () => {
      const mediator = await newMediator();
      const { there, backup } = await apart(mediator);
      const asked = mediator.seenTypes.length;
      expect(await there.daemon.mergeBackup(backup.bytes)).toMatchObject({ renewed: true });
      expect(await there.call("publishSnapshotLink", { part: "content" })).toMatchObject({ status: "published", revocable: true });
      const since = mediator.seenTypes.slice(asked);
      expect(since).toContain(REPLICA_ADD);
      expect(since.indexOf(REPLICA_ADD)).toBeLessThan(since.indexOf(BLOB_PUT));
    },
    LONG
  );

  it(
    "is published after its daemon took a fresh replica ID whose adding the mediator refused, the replica in the vault added at the preferred arrangement again before the put",
    async () => {
      const mediator = await newMediator();
      const { there, backup } = await apart(mediator);
      let refusing = true;
      const refused = latch();
      mediator.intercept = (msg, from) => {
        if (!refusing || msg.type !== REPLICA_ADD) return undefined;
        refused.release();
        return mediator.reply(`${REPLICA_ADD}ed`, from as string, { replica_did: shortForm("Someone"), state: "active" }, msg.id);
      };
      expect(await there.daemon.mergeBackup(backup.bytes)).toMatchObject({ renewed: true });
      await refused.reached;
      refusing = false;
      const asked = mediator.seenTypes.length;
      expect(await there.call("publishSnapshotLink", { part: "content" })).toMatchObject({ status: "published", revocable: true });
      const since = mediator.seenTypes.slice(asked);
      expect(since.filter((type) => type === REPLICA_ADD)).toHaveLength(1);
      expect(since.indexOf(REPLICA_ADD)).toBeLessThan(since.indexOf(BLOB_PUT));
    },
    LONG
  );

  it(
    "is refused while the preferred arrangement is another than its replica's, which stays where it is, and nothing is asked of the preferred mediator",
    async () => {
      const mediator = await newMediator();
      const elsewhere = await newMediator(201, "https://elsewhere.example/");
      const a = await alice(mediator);
      expect(await a.daemon.mergeBackup(await backupPreferring((await a.daemon.exportBackup()).bytes, elsewhere.did))).toMatchObject({ renewed: false });
      expect(await a.refused("publishSnapshotLink", { part: "content" })).toEqual({ code: "OperationFailed", message: expect.stringMatching(new RegExp(`is already recorded as something else: a member of the arrangement with ${mediator.did}$`)) as string, effect: "none", messageId: null });
      expect(mediator.blobs.size).toBe(0);
      expect(elsewhere.seenTypes).toEqual([]);
      expect(a.fetched.filter((request) => request.includes(elsewhere.http))).toEqual([]);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });
    },
    LONG
  );

  it(
    "is refused while no mediator was ever set, and nothing is asked of one",
    async () => {
      const mediator = await newMediator();
      const a = await newcomer(mediator);
      await a.daemon.createIdentity("Alice", PASSPHRASE);
      expect(await a.refused("publishSnapshotLink", { part: "content" })).toEqual({ code: "OperationFailed", message: "no mediator is set", effect: "none", messageId: null });
      expect(a.fetched).toEqual([]);
    },
    LONG
  );
});

describe("a restore from a link", () => {
  it(
    "writes nothing when the snapshot runs over the bound of a link to add a device, its bytes are not the ones named, or the key does not open them; past the bound nothing more of it is read",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const sealed = [...mediator.blobs.values()][0]!.bytes!;

      let read = 0;
      const small = await newcomer(mediator, { maxSeedBytes: 1024, wrap: (fetch) => async (input, init) => (String(input) === link.url ? piecemeal(await fetch(input, init), (n) => (read += n)) : fetch(input, init)) });
      expect(await small.refused("restoreFromLink", { link, passphrase: PASSPHRASE })).toEqual({
        code: "OperationFailed",
        message: "the snapshot at that link is over the 1024 bytes this device takes from a link to add a device: restore from a backup file exported from the vault instead",
        effect: "none",
        messageId: null,
      });
      expect(read).toBeLessThan(sealed.length);

      const b = await newcomer(mediator);
      expect(await b.refused("restoreFromLink", { link: { ...link, hash: await blobName(new Uint8Array([1])) }, passphrase: PASSPHRASE })).toEqual({ code: "OperationFailed", message: "the bytes at that link are not the snapshot it names", effect: "none", messageId: null });
      const otherKey = link.key.startsWith("A") ? `B${link.key.slice(1)}` : `A${link.key.slice(1)}`;
      expect(await b.refused("restoreFromLink", { link: { ...link, key: otherKey }, passphrase: PASSPHRASE })).toEqual({ code: "OperationFailed", message: "the link's key does not open the snapshot", effect: "none", messageId: null });
      expect(await b.refused("restoreFromLink", { link: { ...link, url: `${link.url}-gone` }, passphrase: PASSPHRASE })).toEqual({ code: "OperationFailed", message: "no snapshot is at that link any more: it was revoked, or the mediator has let it go", effect: "none", messageId: null });

      for (const { root, daemon } of [small, b]) {
        expect(await exists(vaultFile(root))).toBe(false);
        expect(daemon.publisher.current.state.value.phase).toBe("onboarding");
      }
      expect(sealed.length).toBeGreaterThan(1024 + SEAL_OVERHEAD);
    },
    LONG
  );

  it(
    "of content is refused once it is opened, as history for a vault that is open, and writes nothing",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const b = await newcomer(mediator);
      expect(await b.refused("restoreFromLink", { link, passphrase: PASSPHRASE })).toEqual({
        code: "OperationFailed",
        message: "that snapshot is a vault's history and carries no seed to restore a vault from: import it into a vault that is open",
        effect: "none",
        messageId: null,
      });
      expect(await exists(vaultFile(b.root))).toBe(false);
      expect(b.daemon.publisher.current.state.value.phase).toBe("onboarding");
    },
    LONG
  );

  it(
    "is refused before anything is read where a vault stands already",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const reads = a.fetched.length;
      expect(await a.refused("restoreFromLink", { link, passphrase: PASSPHRASE })).toEqual({ code: "WrongPhase", message: "a vault already exists here", effect: "none", messageId: null });
      expect(a.fetched.slice(reads).filter((request) => request.includes("/b/"))).toEqual([]);
    },
    LONG
  );

  it(
    "follows no redirect: the link's URL is the one address it reads",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", { part: "seed" })) as Published;
      const redirects: (RequestRedirect | undefined)[] = [];
      const b = await newcomer(mediator, {
        wrap: (fetch) => (input, init) => {
          if (String(input) === link.url) redirects.push(init?.redirect);
          return fetch(input, init);
        },
      });
      await b.call("restoreFromLink", { link, passphrase: PASSPHRASE });
      expect(redirects).toEqual(["error"]);
    },
    LONG
  );
});

describe("a link of the seed", () => {
  it(
    "carries the seed with the vault's name, arrangements and replicas and no object, and restores a vault that enrolls at the mediator and holds no contact",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const [account] = mediator.replicaAccounts;
      expect(replicasOf(mediator, account!)).toHaveLength(1);
      const enrollment = (await a.call("publishSnapshotLink", { part: "seed" })) as Published;
      expect(enrollment.part).toBe("seed");
      const carried = await eventsOf(await linked(mediator, enrollment.link));
      const whole = await eventsOf((await a.daemon.exportBackup()).bytes);
      expect([carried.seed, carried.content, whole.seed, whole.content]).toEqual([true, false, true, true]);
      expect([...carried.types].every((type) => ENROLLMENT_EVENT_TYPES.has(type as never))).toBe(true);
      expect(carried.types).toContain("replica.created");
      expect(carried.objects).toBe(0);
      expect(whole.cids).toEqual(expect.arrayContaining(carried.cids));
      expect(whole.cids.length).toBeGreaterThan(carried.cids.length);

      const b = await newcomer(mediator);
      expect(await b.call("restoreFromLink", { link: enrollment.link, passphrase: PASSPHRASE })).toBeNull();
      expect(b.daemon.publisher.current.state.value.phase).toBe("open");
      expect(shown(b.daemon)).toMatchObject({ anchor: shown(a.daemon).anchor, label: "Alice", restoreUnexplained: true, conversations: [] });
      await until("the restored runtime is a replica at the mediator", () => replicasOf(mediator, account!).length === 2);
    },
    LONG
  );

  it(
    "past the daemon's bound is refused at publishing, nothing put, and the backup file restores the new device instead",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator, { maxSeedBytes: 512 });
      expect(await a.refused("publishSnapshotLink", { part: "seed" })).toEqual({
        code: "OperationFailed",
        message: expect.stringMatching(/^the seed and the events a new device enrolls from come to at least \d+ bytes, over the 512 a link to add a device holds: export a backup, and restore the new device from that file$/) as string,
        effect: "none",
        messageId: null,
      });
      expect(mediator.blobs.size).toBe(0);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });

      const { name, bytes } = await a.daemon.exportBackup();
      expect(name).toMatch(/^Alice-\d{4}-\d{2}-\d{2}\.estoc\.car$/);
      const b = await newcomer(mediator, { maxSeedBytes: 512 });
      await b.daemon.restoreIdentity(bytes, PASSPHRASE);
      expect(shown(b.daemon)).toMatchObject({ anchor: shown(a.daemon).anchor, label: "Alice", restoreUnexplained: true });
      expect(shown(b.daemon).conversations.map((conversation) => conversation.petname)).toEqual(["Bob"]);
    },
    LONG
  );
});

describe("an import from a link", () => {
  it(
    "merges the snapshot into the open vault and answers what it brought: a whole one over an enrollment restore brings the rest, and again brings nothing",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const enrollment = (await a.call("publishSnapshotLink", { part: "seed" })) as Published;
      const b = await newcomer(mediator);
      await b.call("restoreFromLink", { link: enrollment.link, passphrase: PASSPHRASE });

      const all = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const whole = await eventsOf(await linked(mediator, all.link));
      const carried = await eventsOf(await linked(mediator, enrollment.link));
      const merged = await b.call("importFromLink", { link: all.link });
      expect(merged).toEqual({ added: whole.cids.length - carried.cids.length, duplicates: carried.cids.length, objects: whole.objects, repaired: 0, renewed: false });
      expect(shown(b.daemon).conversations.map((conversation) => conversation.petname)).toEqual(["Bob"]);
      const held = await eventsOf((await b.daemon.exportBackup()).bytes);
      expect(held.cids).toEqual(expect.arrayContaining(whole.cids));

      expect(await b.call("importFromLink", { link: all.link })).toEqual({ added: 0, duplicates: whole.cids.length, objects: 0, repaired: 0, renewed: false });
      expect((await eventsOf((await b.daemon.exportBackup()).bytes)).cids).toEqual(held.cids);
    },
    LONG
  );

  it(
    "is refused, with nothing written, for a seed, which is for a new device",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const before = await eventsOf((await a.daemon.exportBackup()).bytes);
      const { link } = (await a.call("publishSnapshotLink", { part: "seed" })) as Published;
      expect(await a.refused("importFromLink", { link })).toEqual({ code: "OperationFailed", message: "that snapshot is for adding a device and carries no history to import: restore a new device from it", effect: "none", messageId: null });
      expect((await eventsOf((await a.daemon.exportBackup()).bytes)).cids).toEqual(before.cids);
    },
    LONG
  );

  it(
    "is refused, with nothing written, for another vault's snapshot",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const before = await eventsOf((await a.daemon.exportBackup()).bytes);
      const other = await alice(mediator);
      const { link } = (await other.call("publishSnapshotLink", { part: "content" })) as Published;
      expect(await a.refused("importFromLink", { link })).toEqual({ code: "OperationFailed", message: "that snapshot is of another vault, and is not merged into this one", effect: "none", messageId: null });
      expect((await eventsOf((await a.daemon.exportBackup()).bytes)).cids).toEqual(before.cids);
    },
    LONG
  );

  it(
    "reads the snapshot as a restore does, and writes nothing when the read fails",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const small = await alice(mediator, { maxBackupBytes: 1024 });
      const before = await eventsOf((await small.daemon.exportBackup()).bytes);
      expect(await small.refused("importFromLink", { link })).toEqual({ code: "ResourceLimit", message: "the snapshot is over the 1024 bytes this daemon reads from a link", effect: "none", messageId: null });
      expect(await small.refused("importFromLink", { link: { ...link, url: `${link.url}-gone` } })).toEqual({ code: "OperationFailed", message: "no snapshot is at that link any more: it was revoked, or the mediator has let it go", effect: "none", messageId: null });
      expect((await eventsOf((await small.daemon.exportBackup()).bytes)).cids).toEqual(before.cids);
    },
    LONG
  );

  it(
    "is refused before anything is read where no vault is open",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const b = await newcomer(mediator);
      expect(await b.refused("importFromLink", { link })).toEqual({ code: "WrongPhase", message: "no open vault", effect: "none", messageId: null });
      expect(b.fetched).toEqual([]);
    },
    LONG
  );

  it(
    "merges nothing into a vault opened while the snapshot was read, though it is the same vault or one of the same backup",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const early = await a.daemon.exportBackup();
      await a.daemon.createContact("Carmen", [{ localDid: shortForm("Anna"), peerDid: shortForm("Carmen") } as Channel]);
      const { link } = (await a.call("publishSnapshotLink", { part: "content" })) as Published;
      const brought = new Set((await eventsOf(await linked(mediator, link))).cids);
      for (const cid of (await eventsOf(early.bytes)).cids) brought.delete(cid);
      expect(brought.size).toBeGreaterThan(0);

      let reading: { reached: () => void; gate: Promise<void> } | null = null;
      const b = await newcomer(mediator, {
        wrap: (fetch) => async (input, init) => {
          const held = reading;
          if (held !== null && String(input) === link.url) {
            held.reached();
            await held.gate;
          }
          return fetch(input, init);
        },
      });
      await b.daemon.restoreIdentity(early.bytes.slice(), PASSPHRASE);
      /** An import of the link whose read is held until `meanwhile` is done. */
      const importAround = async (meanwhile: () => Promise<void>): Promise<ApiError> => {
        const reached = latch();
        const gate = latch();
        reading = { reached: reached.release, gate: gate.reached };
        const refusal = b.refused("importFromLink", { link });
        await reached.reached;
        try {
          await meanwhile();
        } finally {
          reading = null;
          gate.release();
        }
        return refusal;
      };
      const letGo = { code: "WrongPhase", message: "the vault was let go of before the snapshot could be merged into it", effect: "none", messageId: null };
      const merged = async () => {
        const held = (await eventsOf((await b.daemon.exportBackup()).bytes)).cids;
        return held.filter((cid) => brought.has(cid));
      };

      expect(
        await importAround(async () => {
          const { hold } = b.daemon.publisher.current.state.value;
          await b.daemon.forgetIdentity(hold!);
          await b.daemon.restoreIdentity(early.bytes.slice(), PASSPHRASE);
        })
      ).toEqual(letGo);
      expect(await merged()).toEqual([]);

      expect(
        await importAround(async () => {
          await b.daemon.lock();
          await b.daemon.unlock(PASSPHRASE);
        })
      ).toEqual(letGo);
      expect(await merged()).toEqual([]);
      expect(shown(b.daemon).conversations.map((conversation) => conversation.petname)).toEqual(["Bob"]);
    },
    LONG
  );
});
