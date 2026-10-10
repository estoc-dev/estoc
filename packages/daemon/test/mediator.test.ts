import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import type { Lines, Snapshot } from "@estoc/daemon-api/contract";
import { PING_TYPE, PURE_ACK_EFFECT } from "@estoc/vault";

import { mintIdentity } from "../../../mediator/src/identity-core.js";
import { buildServer, type MediatorServer } from "../../../mediator/src/server.js";
import { SqliteStore } from "../../../mediator/src/store/sqlite.js";
import { TEST_CONFIG } from "../../../mediator/test/helpers.js";
import { DEFAULT_MAX_BACKUP_BYTES, createDaemon, type DaemonCore } from "../src/index.js";
import { nodeHost } from "../src/node/index.js";

/**
 * Daemons over the mediator itself, the one `mediator/` deploys, with
 * replica-mediation and blobs on: its HTTP entry and its socket on a
 * loopback port, reached under the public name its `did:web` document
 * gives.
 */

const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const PASSPHRASE = "alice-passes-the-salt";
const PUBLIC = "mediator.test";
const CONFIG = { ...TEST_CONFIG, publicUrl: `https://${PUBLIC}`, maxMessagesPerAccount: 100, maxSharedRecipients: 100, blobMaxBytes: 16 * 1024 * 1024, blobQuotaBytes: 64 * 1024 * 1024 };

const roots: string[] = [];
const daemons: DaemonCore[] = [];
const servers: MediatorServer[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Mediator {
  did: string;
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

async function mediator(): Promise<Mediator> {
  const identity = await mintIdentity(CONFIG.publicUrl, "web");
  const server = buildServer({ identity, store: new SqliteStore(":memory:", CONFIG), config: { ...CONFIG, blobDir: await folder() } });
  servers.push(server);
  const local = `127.0.0.1:${await server.listen()}`;
  const there = (url: string | URL): string => {
    const asked = new URL(url);
    if (asked.host !== PUBLIC) throw new Error(`${asked.host} is not the mediator`);
    asked.protocol = asked.protocol === "wss:" ? "ws:" : "http:";
    asked.host = local;
    return asked.href;
  };
  class Reaching extends WebSocket {
    constructor(url: string | URL) {
      super(there(url));
    }
  }
  return { did: identity.did, fetch: (input, init) => fetch(there(input instanceof Request ? input.url : input), init), WebSocket: Reaching };
}

interface Running {
  daemon: DaemonCore;
  snapshot(): Snapshot;
  lines(): Lines | null;
}

function daemonAt({ fetch, WebSocket }: Mediator, root: string): Running {
  const daemon = createDaemon(nodeHost(root, { fetch, WebSocket }));
  daemons.push(daemon);
  let snapshot: Snapshot | null = null;
  let lines: Lines | null = null;
  daemon.publisher.attach({
    state: ({ value }) => {
      if (value.phase === "open") snapshot = value.snapshot;
    },
    lines: ({ value }) => (lines = value),
    log: () => undefined,
    unavailable: () => undefined,
  });
  return {
    daemon,
    snapshot: () => {
      if (snapshot === null) throw new Error("no vault is shown");
      return snapshot;
    },
    lines: () => lines,
  };
}

async function folder(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "estoc-daemon-"));
  roots.push(root);
  return root;
}

async function person(at: Mediator, name: string): Promise<Running> {
  const running = daemonAt(at, await folder());
  await running.daemon.boot();
  await running.daemon.createIdentity(name, PASSPHRASE);
  await running.daemon.setMediator(at.did);
  return running;
}

async function until(what: string, condition: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not, after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const reads = ({ snapshot }: Running, content: string): boolean => snapshot().messages.some((message) => message.direction === "in" && message.body.state === "available" && message.body.body["content"] === content);
const holdsPing = ({ snapshot }: Running): boolean => snapshot().messages.some((message) => message.direction === "in" && message.headers?.type === PING_TYPE);
const live = ({ lines }: Running): boolean => lines()?.connections.some((connection) => connection.live) === true;
const receiptsTaken = ({ snapshot }: Running): number => snapshot().messages.filter((message) => message.direction === "in" && message.kind === "pure-ack").length;
const receiptsMade = ({ snapshot }: Running): number => snapshot().messages.filter((message) => message.direction === "out" && message.effectType === PURE_ACK_EFFECT).length;

test(
  "two people meet over a replica-mediation arrangement each, and a second runtime of one of them, restored from a backup, is a replica of its own: what is written to her waits for each, and the receipt it asks for is given once, by the replica that registered it first",
  async () => {
    const at = await mediator();
    const alice = await person(at, "Alice");
    const bob = await person(at, "Bob");
    expect(alice.snapshot().mediations).toMatchObject([{ mediatorDid: at.did, selected: true, usable: true }]);
    await until("alice's line is live", () => live(alice));
    expect(alice.lines()?.connections).toMatchObject([{ unreachable: null }]);

    const { invitation } = await alice.daemon.createInvitation();
    const accepted = await bob.daemon.acceptInvitation(invitation, "Alice");
    expect(accepted).toMatchObject({ outcome: "submitted" });
    await until("alice holds bob's Ping", () => holdsPing(alice));
    await until("bob's Ping is acknowledged", () => bob.snapshot().messages.some((message) => message.messageId === (accepted.messageId as string) && message.acknowledged));

    const first = await bob.daemon.send({ contactId: accepted.contactId }, { type: BASIC_MESSAGE, body: { content: "to one" } });
    expect(first).toMatchObject({ outcome: "submitted" });
    await until("alice reads it", () => reads(alice, "to one"));

    const backup = await alice.daemon.exportBackup();
    const elsewhere = daemonAt(at, await folder());
    await elsewhere.daemon.boot();
    await elsewhere.daemon.restoreIdentity(backup.bytes, PASSPHRASE);
    await until("the restored runtime's line is live", () => live(elsewhere));
    expect(elsewhere.lines()?.connections).toMatchObject([{ unreachable: null }]);

    // What waits for one replica is not the other's to take: the copy of the runtime that is away is still there once the other has acknowledged its own.
    const taken = receiptsTaken(bob);
    const made = receiptsMade(elsewhere);
    await elsewhere.daemon.lock();
    for (const content of ["to both", "and again"]) {
      expect(await bob.daemon.send({ contactId: accepted.contactId }, { type: BASIC_MESSAGE, body: { content }, pleaseAck: [""] })).toMatchObject({ outcome: "submitted" });
      await until(`alice reads "${content}" where she was`, () => reads(alice, content));
    }
    await until("bob has a receipt of each", () => receiptsTaken(bob) === taken + 2);
    await elsewhere.daemon.unlock(PASSPHRASE);
    await until("alice reads both where she restored", () => reads(elsewhere, "to both") && reads(elsewhere, "and again"));
    const both = (running: Running) => running.snapshot().messages.filter((message) => message.direction === "in" && message.body.state === "available" && ["to both", "and again"].includes(message.body.body["content"] as string));
    await until("where she restored, both receipts are left to where she was", () => both(elsewhere).length === 2 && both(elsewhere).every((message) => message.manualAction === "none"));
    expect([receiptsMade(elsewhere), receiptsTaken(bob)]).toEqual([made, taken + 2]);
  },
  120_000
);

test(
  "a second runtime of one person, restored from the snapshot link her first runtime put at the mediator, is a replica of its own that reads what is written to her from then on, and once the link is revoked nothing is at its address",
  async () => {
    const at = await mediator();
    const alice = await person(at, "Alice");
    const bob = await person(at, "Bob");
    await until("alice's line is live", () => live(alice));
    const { invitation } = await alice.daemon.createInvitation();
    const accepted = await bob.daemon.acceptInvitation(invitation, "Alice");
    await until("alice holds bob's Ping", () => holdsPing(alice));

    const { link } = await alice.daemon.publishSnapshotLink();
    const elsewhere = daemonAt(at, await folder());
    await elsewhere.daemon.boot();
    await elsewhere.daemon.restoreFromLink(link, PASSPHRASE, DEFAULT_MAX_BACKUP_BYTES);
    await until("the restored runtime's line is live", () => live(elsewhere));
    expect(elsewhere.snapshot().anchor).toBe(alice.snapshot().anchor);
    expect(holdsPing(elsewhere)).toBe(true);

    expect(await bob.daemon.send({ contactId: accepted.contactId }, { type: BASIC_MESSAGE, body: { content: "to both" } })).toMatchObject({ outcome: "submitted" });
    await until("alice reads it where she was and where she restored", () => reads(alice, "to both") && reads(elsewhere, "to both"));

    await alice.daemon.revokeSnapshotLink(link.hash);
    expect((await at.fetch(link.url)).status).toBe(404);
    const late = daemonAt(at, await folder());
    await late.daemon.boot();
    await expect(late.daemon.restoreFromLink(link, PASSPHRASE, DEFAULT_MAX_BACKUP_BYTES)).rejects.toThrow("no snapshot is at that link any more: it was revoked, or the mediator has let it go");
  },
  120_000
);
