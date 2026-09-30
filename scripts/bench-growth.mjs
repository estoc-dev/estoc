// What one message costs a daemon whose vault already holds a history: two
// daemons over a mediator in this process write to each other until the
// history is as long as asked, and a send, its receipt, an acknowledged send
// and a retried one are then measured in full: from the call, through the
// intent committed, the transport call answered and the acceptance committed,
// to each state published by the daemon and consumed by a view over a port.
// Afterwards the sender's vault is started by a daemon in a process of its
// own, and read in another: the open's own scan, which decodes everything for
// the first time, timed by function, and each step of a read after it timed
// on what that scan left remembered. Run from the root, after `pnpm build`:
//   node scripts/bench-growth.mjs --messages 1000
// The result is one JSON document on stdout, or in the file `--out` names;
// progress goes to stderr. Times are of this machine; the counts are not.
//   node scripts/bench-growth.mjs --corpus packages/daemon/test/corpus --messages 12 --conversations 2
// measures nothing: it writes the sender's vault after a short history of
// every kind of step, and what a read of it from nothing makes of it, as the
// fixture the tests hold every other way of reading to.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { calls } from "./bench/loading.mjs";

const { FakeMediator } = await import("../packages/agent-core/test/fake-mediator.ts");
const { countingDriver, noReads } = await import("../packages/event-store/test/counting.ts");
const { SqliteVault } = await import("../packages/event-store/dist/index.js");
const { openNodeSqlite } = await import("../packages/event-store/dist/node.js");
const { deriveIdentity, importSeed } = await import("../packages/keystore/dist/index.js");
const { VaultEventSet, foldMediations, foldRoutes, foldVault, objectReader, verifyDidKeys, verifyMediationKeys, verifyProofs, verifyResolutions } = await import("../packages/vault/dist/index.js");
const { BUILT_IN_HANDLERS, MAX_CONTENT_BYTES, effectTypesOf, openVault, recorder } = await import("../packages/agent-core/dist/index.js");
const { schemas } = await import("../packages/daemon-api/dist/contract/index.js");
const { connect } = await import("../packages/daemon-api/dist/client/index.js");
const { indexSnapshot } = await import("../packages/daemon-api/dist/views/index.js");
const { serveApi } = await import("../packages/daemon-api/dist/wire/index.js");
const { attachTo, createDaemon, limitsOf, methodsOf } = await import("../packages/daemon/dist/index.js");
const { nodeHost } = await import("../packages/daemon/dist/node/index.js");
const { channelOf } = await import("../packages/daemon/dist/channels.js");
const { localDidRecords, mediationRecords, project } = await import("../packages/daemon/dist/projection.js");

const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const PASSPHRASE = "a passphrase for a benchmark";
const VAULT = path.join(".estoc", "vault.sqlite");
const SCAN = { effectTypes: effectTypesOf(BUILT_IN_HANDLERS) };

const { values: flags } = parseArgs({
  options: {
    messages: { type: "string", default: "100" },
    conversations: { type: "string", default: "1" },
    "body-bytes": { type: "string", default: "64" },
    // views of the sender over a port each: the first is the one whose consumption of each state is timed
    views: { type: "string", default: "1" },
    "slow-views": { type: "string", default: "1" },
    "slow-ms": { type: "string", default: "250" },
    samples: { type: "string", default: "20" },
    reads: { type: "string", default: "5" },
    out: { type: "string" },
    corpus: { type: "string" },
    // What the script asks of itself in a process of its own, over the folder of a vault: `start` or `read`.
    alone: { type: "string" },
    folder: { type: "string" },
  },
});
const count = (name, least) => {
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < least) throw new Error(`--${name} takes a whole number, ${least} or more`);
  return value;
};
const asked = {
  messages: count("messages", 0),
  conversations: count("conversations", 1),
  bodyBytes: count("body-bytes", 1),
  views: count("views", 1),
  slowViews: count("slow-views", 0),
  slowMs: count("slow-ms", 0),
  samples: count("samples", 1),
  reads: count("reads", 2),
};

const said = (line) => process.stderr.write(`${line}\n`);
const now = () => performance.now();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms) => Math.round(ms * 10) / 10;
const body = (n) => ({ type: BASIC_MESSAGE, body: { content: `${n} `.padEnd(asked.bodyBytes, "x") } });
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value));

function spread(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
  return { p50: round(at(0.5)), p95: round(at(0.95)), least: round(sorted[0]), most: round(sorted.at(-1)) };
}

/** Each number of `totals` as one sample's share, to one decimal. */
const perSample = (totals, samples) => Object.fromEntries(Object.entries(totals).map(([name, total]) => [name, Math.round((total / samples) * 10) / 10]));

/** How long each runtime's writer lock was waited for and held, by the anchor of the vault it is over. */
const locks = new Map();
/** The moment each message's intent, and its acceptance by the endpoint called, was committed: the transaction done, the lock still held. */
const committed = { intents: new Map(), acceptances: new Map() };
let commitsRecorded = false;
function recordCommits(held) {
  if (commitsRecorded) return;
  commitsRecorded = true;
  let owner = Object.getPrototypeOf(held);
  while (!Object.hasOwn(owner, "commit")) owner = Object.getPrototypeOf(owner);
  const commit = owner.commit;
  owner.commit = async function (objects, drafts) {
    const events = await commit.call(this, objects, drafts);
    const at = now();
    for (const { type, data } of events) {
      if (type === "message.out") committed.intents.set(data.messageId, at);
      else if (type === "delivery.submitted") committed.acceptances.set(data.messageId, at);
    }
    return events;
  };
}
{
  let owner = SqliteVault.prototype;
  while (!Object.hasOwn(owner, "locked")) owner = Object.getPrototypeOf(owner);
  const locked = owner.locked;
  owner.locked = function (op) {
    const { anchor } = this.metadata;
    const lock = locks.get(anchor) ?? { taken: 0, waitedMs: 0, heldMs: 0, longestHeldMs: 0 };
    locks.set(anchor, lock);
    const askedAt = now();
    return locked.call(this, async (held) => {
      recordCommits(held);
      const takenAt = now();
      lock.taken += 1;
      lock.waitedMs += takenAt - askedAt;
      try {
        return await op(held);
      } finally {
        const heldMs = now() - takenAt;
        lock.heldMs += heldMs;
        lock.longestHeldMs = Math.max(lock.longestHeldMs, heldMs);
      }
    });
  };
}

/** A daemon started over the vault in `folder`: from the passphrase to its first state published. */
async function startApart(folder) {
  const daemon = createDaemon(nodeHost(folder, { fetch: () => Promise.reject(new Error("no network here")), WebSocket: undefined }));
  try {
    await daemon.boot();
    const began = now();
    await daemon.unlock(PASSPHRASE);
    return { unlockToOpenMs: round(now() - began) };
  } finally {
    await daemon.close();
  }
}

if (flags.alone !== undefined) {
  process.stdout.write(JSON.stringify(flags.alone === "start" ? await startApart(flags.folder) : await readApart(flags.folder)));
  process.exit(0);
}

/** What this script answers when run alone over `folder`. */
async function alone(what, folder) {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--alone", what, "--folder", folder, "--reads", String(asked.reads)], { maxBuffer: 1 << 26 });
  return JSON.parse(stdout);
}

const root = await mkdtemp(path.join(tmpdir(), "estoc-bench-"));
const mediator = new FakeMediator(await deriveIdentity(await importSeed(new Uint8Array(32).fill(200)), "anchor"));

/** What one source shows of the vault, snapshot by snapshot: how many so far, the last, and who waits for one. */
const watching = (name) => ({ name, states: 0, last: null, waiting: new Set() });
function saw(watch, snapshot) {
  const at = now();
  watch.states += 1;
  watch.last = snapshot;
  for (const waiter of watch.waiting) if (waiter.met(snapshot)) waiter.resolve(at);
}

/** A daemon over a folder of its own, its database's reads counted, every transport call's completion kept, and every state it publishes watched. */
async function person(name) {
  const folder = path.join(root, name);
  const reads = noReads();
  const net = { down: false };
  const transport = [];
  const host = nodeHost(folder, {
    fetch: async (input, init) => {
      if (net.down) throw new Error("the network is down");
      const response = await mediator.fetch(input, init);
      transport.push(now());
      return response;
    },
    WebSocket: mediator.WebSocket,
  });
  const daemon = createDaemon({
    ...host,
    storage: async () => {
      const storage = await host.storage();
      return { ...storage, open: async (file, mode, kind) => countingDriver(await storage.open(file, mode, kind), reads) };
    },
    // A dispatch that failed is tried again by hand here, so that a retry measured is the one asked for.
    agentOptions: { ...host.agentOptions, retry: { firstWaitMs: 3_600_000 } },
  });
  const published = watching(`${name}'s daemon`);
  daemon.publisher.attach({
    state: ({ value }) => {
      if (value.phase === "open") saw(published, value.snapshot);
    },
    lines: () => undefined,
    log: () => undefined,
    unavailable: (error) => said(`${name}: a read failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  await daemon.boot();
  await daemon.createIdentity(name, PASSPHRASE);
  await daemon.setMediator(mediator.did);
  return { name, folder, daemon, reads, net, transport, published, anchor: published.last.anchor };
}

/** The moment `watch` first shows a snapshot `met` holds of, which is now when the last one does. */
function shown(watch, what, met) {
  if (watch.last !== null && met(watch.last)) return Promise.resolve(now());
  return new Promise((resolve, reject) => {
    const waiter = {
      met,
      resolve: (at) => {
        clearTimeout(timer);
        watch.waiting.delete(waiter);
        resolve(at);
      },
    };
    const timer = setTimeout(() => {
      watch.waiting.delete(waiter);
      reject(new Error(`${watch.name} did not show ${what} within two minutes`));
    }, 120_000);
    watch.waiting.add(waiter);
  });
}

/** The moment `who`'s transport last completed a call between `since` and `by`: the one whose acceptance was committed at `by`. */
function transportDone(who, since, by) {
  const at = who.transport.findLast((done) => done >= since && done <= by);
  if (at === undefined) throw new Error(`${who.name} completed no transport call between the call and the acceptance`);
  return at;
}

/** The message among the last of a snapshot: what is looked for was written last. */
const messageOf = (snapshot, messageId) => snapshot.messages.findLast((message) => message.messageId === messageId);
const has = (messageId, holds = () => true) => (snapshot) => {
  const message = messageOf(snapshot, messageId);
  return message !== undefined && holds(message);
};
const submitted = (message) => message.delivery?.status === "submitted";
/** A message known by what it says: a receiver names it by an ID of its own, and a sender has none to give before the send answers. */
const saying = (direction, { body: { content } }, holds = () => true) => (snapshot) => {
  const message = snapshot.messages.findLast((candidate) => candidate.direction === direction && candidate.body.state === "available" && candidate.body.body["content"] === content);
  return message !== undefined && holds(message);
};
const received = (content) => saying("in", content);
const written = (content, holds) => saying("out", content, holds);

/** One more pair of channels between the two, each side's contact selecting its own. */
async function acquainted(alice, bob, n) {
  const known = new Set(alice.published.last.channels.map(({ channelId }) => channelId));
  const { invitation } = await alice.daemon.createInvitation("one");
  const accepted = await bob.daemon.acceptInvitation(invitation, `Alice ${n}`);
  await shown(bob.published, "its Ping acknowledged", has(accepted.messageId, (message) => message.acknowledged));
  const moved = (snapshot) => snapshot.channels.find((channel) => !known.has(channel.channelId) && channel.headChannelId !== null && channelOf(channel.headChannelId).localDid !== channel.localDid);
  await shown(alice.published, "the successor it writes to Bob from", (snapshot) => moved(snapshot) !== undefined);
  const head = channelOf(moved(alice.published.last).headChannelId);
  return { fromAlice: await alice.daemon.createContact(`Bob ${n}`, [head]), fromBob: accepted.contactId };
}

/** Both daemons with nothing left to publish: every commit so far covered, and no state published for a while after. */
async function settled(...people) {
  for (;;) {
    const before = people.map(({ published }) => published.states);
    await Promise.all(people.map(({ daemon }) => daemon.refresh()));
    await pause(150);
    if (people.every(({ published }, i) => published.states === before[i])) return;
  }
}

/** Every one of `views` having consumed what `who`'s daemon has published: its state and its lines, at their revisions of now. */
function caughtUp(who, views) {
  const { state, lines } = who.daemon.publisher.current;
  const reached = (consumed, target) => consumed !== null && consumed.epoch === target.epoch && consumed.revision >= target.revision;
  return Promise.all(
    views.map(
      ({ client }) =>
        new Promise((resolve, reject) => {
          const stops = [];
          const timer = setTimeout(() => {
            for (const stop of stops) stop();
            reject(new Error(`a view of ${who.name} did not catch up with its daemon within two minutes`));
          }, 120_000);
          const check = () => {
            if (!reached(client.state, state) || !reached(client.lines, lines)) return;
            clearTimeout(timer);
            for (const stop of stops) stop();
            resolve();
          };
          stops.push(client.onState(check), client.onLines(check));
          check();
        })
    )
  );
}

/** Both daemons settled and every view of each caught up with it. */
async function quiet(alice, bob, views) {
  await settled(alice, bob);
  await Promise.all([caughtUp(alice, views.sender), caughtUp(bob, views.receiver)]);
}

/** A view of `who` over a port in memory, which hands each frame over `slowMs` after it was written; what the view consumes is watched. */
async function view(who, slowMs) {
  const written = { frames: 0, bytes: 0, slowMs };
  const ends = { served: null, viewed: null };
  const end = (mine, other, sent) => ({
    transport: "text",
    async send(data) {
      sent?.(data);
      if (slowMs > 0) await pause(slowMs);
      ends[other]?.message(data);
    },
    listen: (handlers) => {
      ends[mine] = handlers;
    },
    close() {
      const handlers = [ends.served, ends.viewed];
      ends.served = ends.viewed = null;
      for (const closing of handlers) closing?.close();
    },
  });
  const limits = limitsOf("text");
  serveApi(
    end("served", "viewed", (data) => {
      written.frames += 1;
      written.bytes += Buffer.byteLength(data);
    }),
    { methods: methodsOf(who.daemon, limits), limits, implementation: "bench", attach: (session) => attachTo(who.daemon.publisher, session) }
  );
  const client = connect(end("viewed", "served"));
  const viewed = watching(`${who.name}'s view${slowMs > 0 ? ` of ${slowMs} ms` : ""}`);
  client.onState(({ value }) => {
    if (value.phase === "open") saw(viewed, value.snapshot);
  });
  const began = now();
  await client.connected();
  return { client, written, viewed, attachMs: now() - began, baselineBytes: written.bytes };
}

function counters(alice, bob, views) {
  const taken = (who) => ({ ...who.reads, states: who.published.states, lock: { ...(locks.get(who.anchor) ?? {}) } });
  const frames = (list) => list.map(({ written }) => ({ ...written }));
  return { alice: taken(alice), bob: taken(bob), calls: { counts: { ...calls.counts }, ms: { ...calls.ms } }, views: { sender: frames(views.sender), receiver: frames(views.receiver) } };
}

const minus = (after, before) => Object.fromEntries(Object.entries(after).map(([name, value]) => [name, typeof value === "number" ? value - (before[name] ?? 0) : value]));

/**
 * `flow` run `asked.samples` times, its times spread and what it read
 * and wrote counted per sample. Before and after each, both daemons are
 * settled and every view has consumed what they published, so that a
 * sample's frames are its own: none of a view's lag is carried into the
 * next sample, and none is left uncounted at the end.
 */
async function measured(name, alice, bob, views, flow) {
  const times = {};
  const empty = (list) => list.map(() => ({ frames: 0, bytes: 0 }));
  const total = { sender: noReads(), receiver: noReads(), senderStates: 0, receiverStates: 0, senderLock: {}, receiverLock: {}, calls: {}, callMs: {}, views: { sender: empty(views.sender), receiver: empty(views.receiver) } };
  const add = (into, more) => Object.entries(more).forEach(([key, value]) => (into[key] = (into[key] ?? 0) + value));
  for (let sample = 0; sample < asked.samples; sample += 1) {
    await quiet(alice, bob, views);
    const before = counters(alice, bob, views);
    for (const [mark, ms] of Object.entries(await flow(sample))) (times[mark] ??= []).push(ms);
    await quiet(alice, bob, views);
    const after = counters(alice, bob, views);
    const { states: senderStates, lock: senderLock, ...sender } = minus(after.alice, before.alice);
    const { states: receiverStates, lock: receiverLock, ...receiver } = minus(after.bob, before.bob);
    add(total.sender, sender);
    add(total.receiver, receiver);
    total.senderStates += senderStates;
    total.receiverStates += receiverStates;
    add(total.senderLock, minus(after.alice.lock, before.alice.lock));
    add(total.receiverLock, minus(after.bob.lock, before.bob.lock));
    add(total.calls, minus(after.calls.counts, before.calls.counts));
    add(total.callMs, minus(after.calls.ms, before.calls.ms));
    for (const side of ["sender", "receiver"]) after.views[side].forEach((written, i) => add(total.views[side][i], { frames: written.frames - before.views[side][i].frames, bytes: written.bytes - before.views[side][i].bytes }));
    said(`${name}: sample ${sample + 1} of ${asked.samples}`);
  }
  const lock = ({ longestHeldMs: _, ...sums }) => perSample(sums, asked.samples);
  const perView = (side) => total.views[side].map((written, i) => ({ slowMs: views[side][i].written.slowMs, ...perSample(written, asked.samples) }));
  return {
    ms: Object.fromEntries(Object.entries(times).map(([mark, samples]) => [mark, spread(samples)])),
    perSample: {
      sender: { reads: perSample(total.sender, asked.samples), statesPublished: total.senderStates / asked.samples, writerLock: lock(total.senderLock) },
      receiver: { reads: perSample(total.receiver, asked.samples), statesPublished: total.receiverStates / asked.samples, writerLock: lock(total.receiverLock) },
      // Both daemons run in this process and on these modules: a call is counted whichever of them made it.
      callsOfBoth: perSample(total.calls, asked.samples),
      callMsOfBoth: perSample(total.callMs, asked.samples),
      viewsOfSender: perView("sender"),
      viewsOfReceiver: perView("receiver"),
    },
  };
}

function collected() {
  setFlagsFromString("--expose-gc");
  runInNewContext("gc")();
  const { heapUsed, rss, arrayBuffers } = process.memoryUsage();
  return { heapUsedBytes: heapUsed, rssBytes: rss, arrayBuffersBytes: arrayBuffers };
}

/** `step` run `asked.reads` times: the first sample, taken after the open's own scan has remembered every spelling, and the middle one of the rest. */
async function timed(step) {
  const times = [];
  let result;
  for (let n = 0; n < asked.reads; n += 1) {
    const began = now();
    result = await step();
    times.push(now() - began);
  }
  const [firstAfterOpen, ...rest] = times;
  return { result, ms: { firstAfterOpen: round(firstAfterOpen), later: spread(rest).p50 } };
}

/**
 * One read of the vault in `folder`, as the daemon makes it for a state:
 * the open, whose scan of the whole history is the first in this process
 * and decodes every spelling it names, timed by function; then a read
 * a step at a time on what that scan remembered.
 */
async function readApart(folder) {
  calls.reset();
  const opening = now();
  const { runtime, keys } = await openVault(openNodeSqlite(path.join(folder, VAULT), { mode: "readwrite" }), { passphrase: PASSPHRASE }, SCAN);
  const openMs = now() - opening;
  const firstScan = { ms: Object.fromEntries(Object.entries(calls.ms).map(([name, ms]) => [name, round(ms)])), calls: { ...calls.counts } };
  try {
    return await runtime.locked(async (vault) => {
      const readObject = objectReader(vault.objects);
      const events = await timed(() => VaultEventSet.from(vault.events.scan()));
      const set = events.result;
      const mediationKeys = await timed(() => verifyMediationKeys(keys, foldMediations(set)));
      const mediations = foldMediations(set, { keyChecks: mediationKeys.result });
      const didKeys = await timed(() => verifyDidKeys(keys, foldRoutes(set, mediations)));
      const resolutions = await timed(() => verifyResolutions(set, readObject));
      const proofs = await timed(() => verifyProofs(set, resolutions.result, readObject));
      const checks = { mediationKeys: mediationKeys.result, didKeys: didKeys.result, resolutionChecks: resolutions.result, proofChecks: proofs.result };
      const folded = await timed(() => foldVault(set, checks, SCAN));
      const fold = folded.result;
      const projected = await timed(() =>
        project(recorder(fold, objectReader(vault.objects, MAX_CONTENT_BYTES)), {
          anchor: runtime.metadata.anchor,
          label: fold.label ?? "",
          restoreUnexplained: false,
          mediations: mediationRecords(fold.mediations),
          dids: localDidRecords(fold.routes),
        })
      );
      const snapshot = projected.result;
      const encoded = await timed(() => JSON.stringify(snapshot));
      const parsed = JSON.parse(encoded.result);
      const viewed = await timed(() => schemas.snapshot.parse(parsed));
      const indexed = await timed(() => indexSnapshot(viewed.result));
      return {
        events: set.size,
        records: Object.fromEntries(["mediations", "dids", "contacts", "channels", "messages", "observations", "conversations", "invitations"].map((table) => [table, snapshot[table].length])),
        firstScan,
        ms: {
          openAndFirstScan: round(openMs),
          eventsAndSchema: events.ms,
          mediationKeys: mediationKeys.ms,
          didKeys: didKeys.ms,
          resolutions: resolutions.ms,
          proofs: proofs.ms,
          fold: folded.ms,
          projection: projected.ms,
          encoding: encoded.ms,
          viewSchema: viewed.ms,
          viewIndex: indexed.ms,
        },
        bytes: { snapshot: Buffer.byteLength(encoded.result), pending: bytesOf(snapshot.pending), unplaced: bytesOf(snapshot.unplaced) },
      };
    });
  } finally {
    await runtime.close();
  }
}

/**
 * The steps a plain exchange leaves out, taken once each, and Alice's
 * vault written to `directory` with its fold and its records: a send
 * acknowledged, one that failed and was sent again, one that failed
 * and waits, a message erased, a contact renamed, and a channel rotated
 * with a message each way after it.
 */
async function kept(alice, bob, { fromAlice, fromBob }, directory) {
  const { foldText, hashOf, readCorpus, snapshotText } = await import("../packages/daemon/test/corpus.ts");
  const asking = { ...body("acknowledged"), pleaseAck: [""] };
  await alice.daemon.send({ contactId: fromAlice }, asking);
  await shown(alice.published, "the acknowledgement", written(asking, (message) => message.acknowledged));

  const failing = async (content) => {
    alice.net.down = true;
    try {
      const { messageId } = await alice.daemon.send({ contactId: fromAlice }, content);
      await shown(alice.published, "the send that failed", has(messageId, (message) => message.manualAction === "retry"));
      return messageId;
    } finally {
      alice.net.down = false;
    }
  };
  const again = body("sent again");
  await alice.daemon.retry(await failing(again));
  await shown(bob.published, "the message sent again", received(again));
  await failing(body("waiting"));

  const heard = alice.published.last.messages.findLast((message) => message.direction === "in" && message.body.state === "available" && message.kind !== null);
  await alice.daemon.eraseMessage(heard.messageId);
  await alice.daemon.renameContact(fromAlice, "Bob, renamed");

  await settled(alice, bob);
  const conversation = alice.published.last.conversations.find((candidate) => candidate.contactId === fromAlice);
  const rotated = await alice.daemon.rotateChannel(channelOf(conversation.defaultWriteTo));
  said(`rotated: ${rotated.outcome}`);
  await settled(alice, bob);
  for (const [from, to, contactId, text] of [
    [bob, alice, fromBob, "after the rotation, to the one who rotated"],
    [alice, bob, fromAlice, "after the rotation, from the one who rotated"],
  ]) {
    const content = body(text);
    await from.daemon.send({ contactId }, content);
    await shown(to.published, text, received(content));
  }
  await settled(alice, bob);

  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "vault.sqlite");
  await writeFile(file, (await alice.daemon.exportBackup()).bytes);
  const read = await readCorpus(file, PASSPHRASE);
  await writeFile(path.join(directory, "fold.sha256"), hashOf(foldText(read.fold)));
  await writeFile(path.join(directory, "snapshot.json"), snapshotText(read.snapshot));
  said(`kept in ${directory}: ${read.fold.set.size} events, ${read.snapshot.messages.length} messages`);
}

let result;
try {
  said("two daemons, a mediator, and their first channels");
  const alice = await person("alice");
  const bob = await person("bob");
  const contacts = [];
  for (let n = 0; n < asked.conversations; n += 1) contacts.push(await acquainted(alice, bob, n));

  /** One message sent and shown to both, by the side and in the conversation its number gives it. */
  let sent = 0;
  async function exchanged() {
    const contact = contacts[Math.floor(sent / 2) % contacts.length];
    const [from, to, contactId] = sent % 2 === 0 ? [alice, bob, contact.fromAlice] : [bob, alice, contact.fromBob];
    const content = body(sent);
    const { messageId, outcome, because } = await from.daemon.send({ contactId }, content);
    if (outcome !== "submitted") throw new Error(`message ${sent} was ${outcome}: ${because}`);
    await Promise.all([shown(from.published, "its message submitted", has(messageId, submitted)), shown(to.published, "the message received", received(content))]);
    sent += 1;
  }
  const filling = now();
  while (sent < asked.messages) {
    await exchanged();
    if (sent % 50 === 0) said(`${sent} of ${asked.messages} messages, ${Math.round((now() - filling) / 1000)} s`);
  }
  await settled(alice, bob);
  const fillMs = now() - filling;

  if (flags.corpus !== undefined) {
    await kept(alice, bob, contacts[0], flags.corpus);
    await Promise.all([alice.daemon.close(), bob.daemon.close()]);
    await rm(root, { recursive: true, force: true });
    process.exit(0);
  }

  const views = { sender: [], receiver: [await view(bob, 0)] };
  for (let n = 0; n < asked.views + asked.slowViews; n += 1) views.sender.push(await view(alice, n < asked.views ? 0 : asked.slowMs));
  const [senderView] = views.sender;
  const [receiverView] = views.receiver;
  for (let n = 0; n < 4; n += 1) await exchanged();
  calls.reset();

  const { fromAlice: contactId } = contacts[0];
  /** The moments each stage of a message is shown by the sender's daemon and its first view, and the receipt by the receiver's. */
  const stages = (content) => {
    const bySender = (what, holds) => ({ published: shown(alice.published, what, written(content, holds)), viewed: shown(senderView.viewed, what, written(content, holds)) });
    return {
      intent: bySender("the intent"),
      delivery: bySender("the submission", submitted),
      receipt: { published: shown(bob.published, "the message", received(content)), viewed: shown(receiverView.viewed, "the message", received(content)) },
    };
  };
  /** The spans of a send, from the call at `began` through the intent, the transport, the acceptance and the receipt, each stage as the daemon published it and as the view consumed it. */
  const spans = async (began, answered, messageId, { intent, delivery, receipt }) => {
    const intentCommitted = committed.intents.get(messageId);
    const acceptanceCommitted = committed.acceptances.get(messageId);
    const transportAnswered = transportDone(alice, began, acceptanceCommitted);
    const [intentPublished, intentViewed, deliveryPublished, deliveryViewed, receiptPublished, receiptViewed] = await Promise.all([intent.published, intent.viewed, delivery.published, delivery.viewed, receipt.published, receipt.viewed]);
    return {
      callToIntentCommitted: intentCommitted - began,
      intentCommittedToIntentPublished: intentPublished - intentCommitted,
      intentPublishedToIntentViewed: intentViewed - intentPublished,
      callToIntentViewed: intentViewed - began,
      callToAnswer: answered - began,
      callToTransportAnswered: transportAnswered - began,
      transportAnsweredToAcceptanceCommitted: acceptanceCommitted - transportAnswered,
      acceptanceCommittedToDeliveryPublished: deliveryPublished - acceptanceCommitted,
      deliveryPublishedToDeliveryViewed: deliveryViewed - deliveryPublished,
      callToDeliveryViewed: deliveryViewed - began,
      callToReceiptPublished: receiptPublished - began,
      receiptPublishedToReceiptViewed: receiptViewed - receiptPublished,
      callToReceiptViewed: receiptViewed - began,
    };
  };
  const flows = {};
  flows.send = await measured("send", alice, bob, views, async (sample) => {
    const content = body(`send ${sample}`);
    const staged = stages(content);
    const began = now();
    const { messageId } = await alice.daemon.send({ contactId }, content);
    const answered = now();
    return spans(began, answered, messageId, staged);
  });
  flows.acknowledged = await measured("acknowledged send", alice, bob, views, async (sample) => {
    const content = { ...body(`ack ${sample}`), pleaseAck: [""] };
    const acknowledged = (message) => message.acknowledged;
    const acknowledgementPublished = shown(alice.published, "the acknowledgement", written(content, acknowledged));
    const acknowledgementViewed = shown(senderView.viewed, "the acknowledgement", written(content, acknowledged));
    const began = now();
    await alice.daemon.send({ contactId }, content);
    const answered = now();
    return { callToAnswer: answered - began, callToAcknowledgementPublished: (await acknowledgementPublished) - began, acknowledgementPublishedToAcknowledgementViewed: (await acknowledgementViewed) - (await acknowledgementPublished), callToAcknowledgementViewed: (await acknowledgementViewed) - began };
  });
  flows.retry = await measured("retried send", alice, bob, views, async (sample) => {
    const content = body(`retry ${sample}`);
    alice.net.down = true;
    let messageId;
    try {
      ({ messageId } = await alice.daemon.send({ contactId }, content));
      await shown(alice.published, "the send that failed", has(messageId, (message) => message.manualAction === "retry"));
    } finally {
      alice.net.down = false;
    }
    await quiet(alice, bob, views);
    const staged = stages(content);
    const began = now();
    const { outcome, because } = await alice.daemon.retry(messageId);
    if (outcome !== "submitted") throw new Error(`the retry was ${outcome}: ${because}`);
    const answered = now();
    const { callToIntentCommitted: _intent, intentCommittedToIntentPublished: _published, intentPublishedToIntentViewed: _viewed, callToIntentViewed: _call, ...retried } = await spans(began, answered, messageId, staged);
    return Object.fromEntries(Object.entries(retried).map(([name, ms]) => [name.replace(/^call/, "retry"), ms]));
  });

  await quiet(alice, bob, views);
  const attached = await view(alice, 0);
  const memory = collected();
  const live = { attachMs: round(attached.attachMs), baselineBytes: attached.baselineBytes, memory };
  attached.client.close();
  for (const { client } of [...views.sender, ...views.receiver]) client.close();
  await Promise.all([alice.daemon.close(), bob.daemon.close()]);

  said("the sender's vault, started and read a step at a time");
  const coldStart = await alone("start", alice.folder);
  const read = await alone("read", alice.folder);

  result = {
    at: new Date().toISOString(),
    node: process.version,
    asked,
    history: { messages: sent, events: read.events, records: read.records, vaultFileBytes: (await stat(path.join(alice.folder, VAULT))).size, fillSeconds: Math.round(fillMs / 1000) },
    flows,
    attach: live,
    coldStart,
    read: { firstScan: read.firstScan, ms: read.ms, bytes: read.bytes },
  };
} finally {
  await rm(root, { recursive: true, force: true });
}

const document = `${JSON.stringify(result, null, 2)}\n`;
if (flags.out === undefined) process.stdout.write(document);
else await writeFile(flags.out, document);
process.exit(0);
