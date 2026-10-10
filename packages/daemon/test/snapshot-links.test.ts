import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import { openPortable } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import type { ApiError, MethodInput, MethodName, Snapshot } from "@estoc/daemon-api/contract";
import { Refusal, type Session } from "@estoc/daemon-api/wire";
import type { Channel } from "@estoc/vault";

import { BLOB_DELETE, BLOB_PUT, SEAL_OVERHEAD, blobName } from "@estoc/agent-core";
import { newMediator } from "../../agent-core/test/helpers.js";
import type { FakeMediator } from "../../agent-core/test/fake-mediator.js";
import { createDaemon, limitsOf, methodsOf, type DaemonCore } from "../src/index.js";
import { nodeHost } from "../src/node/index.js";

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

/** A daemon over `root` whose transports are the mediator's, as `wrap` lets them through; its methods as a view calls them, under a backup bound of `maxBackupBytes`. */
function daemonOver(root: string, mediator: FakeMediator, options: { wrap?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch; maxBackupBytes?: number } = {}): { daemon: DaemonCore; call: Call; refused: (name: Exclude<MethodName, "attach">, input: unknown) => Promise<ApiError>; fetched: string[] } {
  const fetched: string[] = [];
  const reach = options.wrap?.(mediator.fetch) ?? mediator.fetch;
  const host = nodeHost(root, {
    fetch: (input, init) => {
      fetched.push(`${init?.method ?? "GET"} ${String(input)}`);
      return reach(input, init);
    },
    WebSocket: mediator.WebSocket,
  });
  const daemon = createDaemon(host);
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

/** A daemon over an empty folder, booted to onboarding. */
async function newcomer(mediator: FakeMediator, options: Parameters<typeof daemonOver>[2] = {}) {
  const root = await folder();
  const over = daemonOver(root, mediator, options);
  await over.daemon.boot();
  return { root, ...over };
}

type Published = { status: "published"; hash: string; placedAt: string; retainUntil: string; revocable: boolean; link: { url: string; hash: string; key: string } };

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

/** The anchor and the event CIDs of a portable snapshot's bytes. */
async function eventsOf(bytes: Uint8Array): Promise<{ anchor: string; cids: string[] }> {
  const file = path.join(await folder(), "snapshot.sqlite");
  await writeFile(file, bytes);
  const source = openPortable(openNodeSqlite(file, { mode: "readonly" }));
  try {
    const cids: string[] = [];
    for await (const event of source.vault.events.scan()) cids.push(event.cid);
    return { anchor: source.metadata.anchor, cids: cids.sort() };
  } finally {
    source.close();
  }
}

const shown = (daemon: DaemonCore): Snapshot => {
  const { value } = daemon.publisher.current.state;
  if (value.phase !== "open") throw new Error(`the daemon is ${value.phase}`);
  return value.snapshot;
};

describe("a snapshot link", () => {
  it(
    "restores the vault on a daemon with none: the anchor and every event the snapshot held, under the passphrase the link does not carry",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const published = (await a.call("publishSnapshotLink", {})) as Published;
      const held = await eventsOf((await a.daemon.exportBackup()).bytes);
      expect(published).toEqual({ status: "published", hash: published.link.hash, placedAt: expect.any(String) as string, retainUntil: expect.any(String) as string, revocable: true, link: { url: expect.stringMatching(/^https?:\/\//) as string, hash: published.hash, key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string } });
      expect(Date.parse(published.retainUntil)).toBeGreaterThan(Date.parse(published.placedAt));

      const b = await newcomer(mediator);
      expect(await b.refused("restoreFromLink", { link: published.link, passphrase: "not the passphrase" })).toEqual({ code: "OperationFailed", message: "that passphrase does not open this backup", effect: "none", messageId: null });
      expect(await exists(vaultFile(b.root))).toBe(false);
      expect(b.daemon.publisher.current.state.value.phase).toBe("onboarding");

      expect(await b.call("restoreFromLink", { link: published.link, passphrase: PASSPHRASE })).toBeNull();
      expect(shown(b.daemon).anchor).toBe(shown(a.daemon).anchor);
      expect(shown(b.daemon).restoreUnexplained).toBe(true);
      expect(shown(b.daemon).conversations.map((conversation) => conversation.petname)).toEqual(["Bob"]);
      const restored = await eventsOf((await b.daemon.exportBackup()).bytes);
      expect(restored.anchor).toBe(held.anchor);
      expect(restored.cids).toEqual(expect.arrayContaining(held.cids));
    },
    LONG
  );

  it(
    "is listed by the daemon that put it until revoked, again once that daemon is reopened, and reads nothing once revoked",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const first = (await a.call("publishSnapshotLink", {})) as Published;
      const second = (await a.call("publishSnapshotLink", {})) as Published;
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
      await expect(a.call("publishSnapshotLink", {})).rejects.toMatchObject({ name: "BlobTransferFailed", status: 507 });
      const [blob] = [...mediator.blobs.values()];
      expect(blob).toMatchObject({ bytes: null });
      const { links } = (await a.call("snapshotLinks", {})) as { links: unknown[] };
      expect(links).toEqual([{ status: "pending", hash: blob!.hash, placedAt: expect.any(String) as string, retainUntil: expect.any(String) as string }]);

      expect(await a.call("revokeSnapshotLink", { hash: blob!.hash })).toBeNull();
      expect(mediator.blobs.size).toBe(0);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });
    },
    LONG
  );

  it(
    "whose put the mediator never answered stays pending with no retention known, and revoking it asks the mediator to delete it all the same",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      mediator.intercept = (msg) => (msg.type === BLOB_PUT ? null : undefined);
      await expect(a.call("publishSnapshotLink", {})).rejects.toThrow();
      mediator.intercept = null;
      const { links } = (await a.call("snapshotLinks", {})) as { links: { hash: string }[] };
      expect(links).toEqual([{ status: "pending", hash: expect.any(String) as string, placedAt: expect.any(String) as string, retainUntil: null }]);
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
      const publishing = a.call("publishSnapshotLink", {}) as Promise<Published>;
      await put.reached;
      const { links } = (await a.call("snapshotLinks", {})) as { links: { hash: string }[] };
      expect(links).toEqual([{ status: "pending", hash: expect.any(String) as string, placedAt: expect.any(String) as string, retainUntil: null }]);
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
      const original = await alice(mediator);
      await original.daemon.close();
      const copy = await folder();
      await cp(path.join(original.root, ".estoc"), path.join(copy, ".estoc"), { recursive: true });

      const here = daemonOver(original.root, mediator);
      await here.daemon.boot();
      await here.daemon.unlock(PASSPHRASE);
      await here.daemon.createContact("Carmen", [{ localDid: shortForm("Anna"), peerDid: shortForm("Carmen") } as Channel]);
      const backup = await here.daemon.exportBackup();

      const there = daemonOver(copy, mediator, { wrap: flaky });
      await there.daemon.boot();
      await there.daemon.unlock(PASSPHRASE);
      await there.daemon.createContact("Dave", [{ localDid: shortForm("Anna"), peerDid: shortForm("Dave") } as Channel]);
      const before = (await there.call("publishSnapshotLink", {})) as Published;
      failing = true;
      await expect(there.call("publishSnapshotLink", {})).rejects.toMatchObject({ name: "BlobTransferFailed", status: 507 });
      failing = false;
      expect(((await there.call("snapshotLinks", {})) as { links: unknown[] }).links).toHaveLength(2);

      expect(await there.daemon.mergeBackup(backup.bytes)).toMatchObject({ renewed: true });
      const kept = { links: [{ ...before, revocable: false }] };
      expect(await there.call("snapshotLinks", {})).toEqual(kept);
      expect(await there.refused("revokeSnapshotLink", { hash: before.hash })).toEqual({ code: "OperationFailed", message: `snapshot ${before.hash} was put under a replica ID this runtime has given up since, and only that replica may delete it at the mediator, which keeps it until ${before.retainUntil}`, effect: "none", messageId: null });
      expect(await there.call("snapshotLinks", {})).toEqual(kept);
      expect((await mediator.fetch(before.link.url)).status).toBe(200);

      const since = (await there.call("publishSnapshotLink", {})) as Published;
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
      expect(await a.refused("publishSnapshotLink", {})).toEqual({ code: "OperationFailed", message: expect.stringMatching(/^the mediator refused the snapshot: put was refused: e\.p\.blob\.quota/) as string, effect: "none", messageId: null });
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
      expect(await a.refused("publishSnapshotLink", {})).toEqual({ code: "ResourceLimit", message: expect.stringMatching(new RegExp(`^the snapshot's events and objects come to \\d+ bytes, over the ${4096 - SEAL_OVERHEAD} a blob at the mediator holds once sealed$`)) as string, effect: "none", messageId: null });
      expect(mediator.blobs.size).toBe(0);
      expect(await a.call("snapshotLinks", {})).toEqual({ links: [] });

      mediator.blobLimits = null;
      expect(await a.refused("publishSnapshotLink", {})).toEqual({ code: "OperationFailed", message: "the mediator keeps no blobs", effect: "none", messageId: null });
    },
    LONG
  );
});

describe("a restore from a link", () => {
  it(
    "writes nothing when the snapshot runs over this daemon's bound, its bytes are not the ones named, or the key does not open them",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", {})) as Published;
      const sealed = [...mediator.blobs.values()][0]!.bytes!;

      const small = await newcomer(mediator, { maxBackupBytes: 1024 });
      expect(await small.refused("restoreFromLink", { link, passphrase: PASSPHRASE })).toEqual({ code: "ResourceLimit", message: "the snapshot is over the 1024 bytes this daemon restores", effect: "none", messageId: null });

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
    "is refused before anything is read where a vault stands already",
    async () => {
      const mediator = await newMediator();
      const a = await alice(mediator);
      const { link } = (await a.call("publishSnapshotLink", {})) as Published;
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
      const { link } = (await a.call("publishSnapshotLink", {})) as Published;
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
