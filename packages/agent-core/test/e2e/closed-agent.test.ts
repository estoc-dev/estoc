import { afterEach, describe, expect, it, test } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { PURE_ACK_EFFECT, ROTATION_NOTIFICATION_EFFECT, scanVault, type Did, type DidId, type MessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { FORWARD } from "../../src/protocol/spec.js";
import { ACCOUNT_REGISTERED, Agent, AgentTrace, EXECUTION_REGISTER, LIVE_DELIVERY_CHANGE, STATUS_REQUEST, canonicalDid, createMediation, didcommDocumentOf, mediationOf } from "../../src/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { afterNextCommit, didcomm, freshVault, handTimers, json, newMediator, sealed, webIdentity, type Sealer } from "../helpers.js";
import { LONG, channelOf, foldOf, forwarded, restart, run, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const FIRST = "019b0000-0000-7000-8000-000000000101" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const seen = (mediator: FakeMediator, type: string): number => mediator.seenTypes.filter((each) => each === type).length;

const toAlice = (alice: Running, bob: Running) => ({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid });

const replicaOf = async (running: Running): Promise<Did> => (await foldOf(running)).replicas.replicas.get(running.runtime.author)!.did!;

const owed = async (running: Running): Promise<string[]> => (await running.agent.pending()).missingResponses.map(({ effectType }) => effectType);

/** A hand on one request of the mediator: it waits, once `matches` says so, until released, and the test learns when it began waiting. */
function holdOne(mediator: FakeMediator, matches: (type: string, from: string | null) => boolean): { asked: () => boolean; release: () => void } {
  let asked = false;
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  mediator.intercept = async (msg, from) => {
    if (asked || !matches(msg.type, from)) return undefined;
    asked = true;
    await released;
    return undefined;
  };
  return { asked: () => asked, release };
}

/** The trace of the running party's process, which calls `then` when an entry of `stream` and `what` is about to be written. */
function onEntry(trace: AgentTrace, stream: string, what: string, then: (data: Record<string, unknown> | undefined) => void): void {
  const append = trace.append.bind(trace);
  trace.append = (async (...args: Parameters<typeof append>) => {
    const [entryStream, entryWhat, data] = args;
    if (entryStream === stream && entryWhat === what) then(data as Record<string, unknown> | undefined);
    return append(...args);
  }) as typeof append;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("an agent closed while a request was on its way to the network", () => {
  it("sends none of it: a ritual whose frame was being noted fails without reaching the mediator", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false, liveDelivery: false });
    onEntry(alice.party.trace, "wire", "out", () => alice.agent.close());
    const before = mediator.seenTypes.length;

    await alice.agent.connect();
    expect(mediator.seenTypes).toHaveLength(before);
    expect((await alice.party.trace.read({ type: "wire.error" })).map((entry) => entry.data["error"])).toEqual(["the holder of the link is closed"]);
  });

  it("opens no socket for live delivery once closed during the pickup before it", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const timers = handTimers();
    const opened: string[] = [];
    const Counting = class {
      constructor(url: string) {
        opened.push(url);
        return new mediator.WebSocket(url);
      }
    } as unknown as typeof WebSocket;
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false, timers, WebSocket: Counting });
    const replica = await replicaOf(alice);
    await until("live delivery is on", () => mediator.liveAccounts().length === 1);
    mediator.dropSocket(replica);
    expect(timers.waits).toHaveLength(1);

    const pickup = holdOne(mediator, (type) => type === STATUS_REQUEST);
    timers.waits[0]!.fire();
    await until("the connection asks what waits", pickup.asked);
    const switched = seen(mediator, LIVE_DELIVERY_CHANGE);
    alice.agent.close();
    pickup.release();
    await settle();
    expect(opened).toHaveLength(1);
    expect(mediator.liveAccounts()).toEqual([]);
    expect(seen(mediator, LIVE_DELIVERY_CHANGE)).toBe(switched);
  });

  it("checks no reply of a did:web mediator against its document fetched again: a reply that comes after the close is lost, as on the wire", async () => {
    const alice = await freshVault(4);
    const trace = await AgentTrace.open(alice.runtime.local);
    const web = await webIdentity("did:web:mediator.example", 78, "https://mediator.example/didcomm");
    const { mediationId } = (await createMediation(alice.runtime, alice.keys, web.did as Did)).data;
    const account = mediationOf(await scanVault(alice.runtime.vault, alice.keys), mediationId).me!.did;
    const document = didcommDocumentOf({ presentedDid: web.did as Did, did: web.did as Did, document: web.document });
    const mediator: Sealer = { did: web.did, secrets: web.secrets, resolver: { resolve: async (did) => (did === web.did ? document : resolveDIDCommDoc(did)) } };
    const calls: string[] = [];
    let close = (): void => undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "https://mediator.example/.well-known/did.json") return json(web.document);
      close();
      return new Response(await sealed(mediator, account, { type: ACCOUNT_REGISTERED, body: {} }), { status: 200 });
    };
    const agent = await Agent.open(alice, { didcomm, fetch, trace, liveDelivery: false });
    close = () => agent.close();
    try {
      await expect(agent.enroll(mediationId)).rejects.toThrow();
      expect(calls.at(-1)).toBe("POST https://mediator.example/didcomm");
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
      expect((await scanVault(alice.runtime.vault, alice.keys)).set.of("mediation.granted")).toEqual([]);
    } finally {
      agent.close();
      await alice.runtime.close();
    }
  });
});

describe("an agent closed while a send was readied", () => {
  it("makes no call and spends no action: the message stays prepared, and a retry by hand sends it", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    const forwards = seen(mediator, FORWARD);
    afterNextCommit(bob.runtime, "message.prepared", () => bob.agent.close());

    const sent = await bob.agent.send(toAlice(alice, bob), hello("hello"), { messageId: FIRST });
    expect(sent.dispatched).toEqual({ outcome: "none", messageId: FIRST, because: "closed before the call" });
    expect(sent.action.spent).toBe(false);
    expect(seen(mediator, FORWARD)).toBe(forwards);
    expect((await bob.agent.outbounds()).map(({ outbound, waiting }) => [outbound.messageId, outbound.outcome.status, waiting])).toEqual([[FIRST, "prepared", null]]);

    await restart(bob);
    expect(await bob.agent.manual.retry(FIRST)).toMatchObject({ outcome: "submitted" });
    await until("alice has the message", () => alice.inbounds.length === 1);
  });
});

describe("an agent closed on a delivery it was taking", () => {
  it("hands it to no receipt once closed before the receipt was called: nothing is recorded, the mediator keeps it, and the next agent takes it", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    let closeAlice = (): void => undefined;
    const admit = (): null => {
      queueMicrotask(() => closeAlice());
      return null;
    };
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false, admit });
    closeAlice = () => alice.agent.close();
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    const replica = await replicaOf(alice);

    await bob.agent.send(toAlice(alice, bob), hello("hello"), { messageId: FIRST });
    await until("the delivery is left queued", () => alice.log.some((line) => line.includes("leaving it queued: the receiver is closed")));
    expect((await foldOf(alice)).set.of("message.in")).toEqual([]);
    expect(mediator.queues.get(replica)).toHaveLength(1);

    await restart(alice, { admit: undefined });
    await until("alice has the message", () => alice.inbounds.length === 1);
    expect(alice.inbounds[0]!.received).toMatchObject({ outcome: "received" });
    expect(mediator.queues.get(replica)).toEqual([]);
  });

  it("tells no ending of one closed on before it was found terminal: nothing is discarded, the mediator keeps it, and the next agent discards it", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const replica = await replicaOf(alice);
    onEntry(alice.party.trace, "envelope", "error", () => alice.agent.close());
    const envelope = JSON.parse(await sealed(null, alice.party.longFormDid)) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;

    await forwarded(mediator, alice.party.did, JSON.stringify(envelope));
    await until("the delivery is left queued", () => alice.log.some((line) => line.includes("leaving it queued: the receiver is closed")));
    expect(alice.agent.discardedDeliveries()).toEqual([]);
    expect((await alice.party.trace.read({ type: "diag.receive" })).filter((entry) => entry.data["outcome"] === "terminal")).toEqual([]);
    expect(mediator.queues.get(replica)).toHaveLength(1);

    await restart(alice);
    expect(alice.agent.discardedDeliveries()).toMatchObject([{ reason: expect.stringContaining("the envelope does not open") }]);
    expect(mediator.queues.get(replica)).toEqual([]);
  });
});

describe("an agent closed while a connection failed", () => {
  it("sets no wait to try it again", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const timers = handTimers();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false, timers });
    const replica = await replicaOf(alice);
    await until("live delivery is on", () => mediator.liveAccounts().length === 1);
    mediator.dropSocket(replica);
    expect(timers.waits).toHaveLength(1);

    let fail = (): void => undefined;
    const failing = new Promise<void>((resolve) => (fail = resolve));
    let asked = false;
    mediator.intercept = async (msg) => {
      if (msg.type !== STATUS_REQUEST) return undefined;
      asked = true;
      await failing;
      throw new Error("the mediator fell over");
    };
    timers.waits[0]!.fire();
    await until("the connection asks what waits", () => asked);
    alice.agent.close();
    fail();
    await settle();
    expect(timers.waits).toHaveLength(1);
    expect(timers.waits[0]!.cleared).toBe(false);
  });
});

describe("an agent closed while it answered a live input to a disclosed address", () => {
  async function disclosedTo(mediator: FakeMediator) {
    const alice = await run(mediator, 1, ALICE, { liveDelivery: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false, liveDelivery: false });
    const { invitation } = await alice.agent.disclose(ALICE, { as: "oob" });
    const sent = await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: invitation!.from }, { ...hello("hello"), pthid: invitation!.id, pleaseAck: [""] }, { messageId: FIRST });
    expect(sent.dispatched).toMatchObject({ outcome: "submitted" });
    return { alice, bob };
  }

  test("before the notification began, makes neither the notification nor the acknowledgement: the address is told unannounced, and both are listed for the user", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const { alice } = await disclosedTo(mediator);
    const replica = await replicaOf(alice);
    const registration = holdOne(mediator, (type, from) => type === EXECUTION_REGISTER && from !== null && canonicalDid(from) === replica);

    await alice.agent.connect();
    await until("alice registers for the input", registration.asked);
    alice.agent.close();
    registration.release();
    await alice.agent.settled();
    expect(alice.inbounds).toHaveLength(1);
    expect(alice.inbounds[0]).toMatchObject({ responder: { status: "self" }, reacted: null, address: { outcome: "rotated", rotation: { notification: { effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "none", because: "the agent closed before the input was answered" } } } });
    expect((await foldOf(alice)).set.of("message.out")).toEqual([]);
    expect(await owed(alice)).toEqual([PURE_ACK_EFFECT]);
    expect((await alice.agent.pending()).missingNotifications).toHaveLength(1);
  });

  test("once the notification was posted, records what its answer said and makes no acknowledgement: the notification is submitted, and the acknowledgement listed for the user", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const { alice } = await disclosedTo(mediator);
    const notification = holdOne(mediator, (type) => type === FORWARD);

    await alice.agent.connect();
    await until("alice posts the notification", notification.asked);
    alice.agent.close();
    notification.release();
    await alice.agent.settled();
    expect(alice.inbounds).toHaveLength(1);
    expect(alice.inbounds[0]).toMatchObject({ responder: { status: "self" }, reacted: null, address: { outcome: "rotated", rotation: { notification: { effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "created", dispatched: { outcome: "submitted" } } } } });
    const outputs = [...(await foldOf(alice)).outbound.outbounds.values()];
    expect(outputs.map((output) => [output.intents[0]!.data.effectType, output.outcome.status])).toEqual([[ROTATION_NOTIFICATION_EFFECT, "submitted"]]);
    expect(await owed(alice)).toEqual([PURE_ACK_EFFECT]);
  });
});
