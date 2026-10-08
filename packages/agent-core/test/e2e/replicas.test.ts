import { afterEach, describe, expect, it, test } from "vitest";

import { PING_RESPONSE_EFFECT, PING_TYPE, PROBLEM_REPORT_TYPE, PURE_ACK_EFFECT, ROTATION_NOTIFICATION_EFFECT, type Did, type DidId, type MessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { EXECUTION_REGISTER, EXECUTION_REGISTERED, MESSAGES_RECEIVED, canonicalDid, LocalRecords, type AgentOptions, type Handler } from "../../src/index.js";
import { FORWARD } from "../../src/protocol/spec.js";
import type { FakeMediator } from "../fake-mediator.js";
import { newMediator } from "../helpers.js";
import { LONG, channelOf, foldOf, imported, restart, restoredFrom, run, snapshotOf, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const PING = "019b0000-0000-7000-8000-000000000101" as MessageId;
const REQUESTED = "019b0000-0000-7000-8000-000000000102" as MessageId;

const REQUEST = "https://example.org/echo/1.0/request";
const ECHO = "https://example.org/echo/1.0/response";
const echo: Handler = {
  types: [REQUEST],
  effectTypes: [ECHO],
  respond: async ({ source, readBody }) => [{ effectType: ECHO, content: { type: ECHO, body: (await readBody()) ?? {}, thid: source.event.data.wireMessageId, pleaseAck: null, ack: [] } }],
};

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });
const ping = { type: PING_TYPE, body: { response_requested: true }, pleaseAck: [""] };

const seen = (mediator: FakeMediator, type: string): number => mediator.seenTypes.filter((each) => each === type).length;

const replicaOf = async (running: Running): Promise<Did> => (await foldOf(running)).replicas.replicas.get(running.runtime.author)!.did!;

const leftBy = async (running: Running): Promise<(Did | null)[]> => Promise.all([...(await foldOf(running)).inbound.executions.keys()].map(async (executionId) => (await new LocalRecords(running.runtime.local.options, running.runtime.author).leftTo(executionId))?.responderDid ?? null));

const owed = async (running: Running): Promise<string[]> => (await running.agent.pending()).missingResponses.map(({ effectType }) => effectType);

const toAlice = (alice: Running, bob: Running) => ({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid });

/** Alice on two machines, the second restored from a snapshot of the first and enrolled as a replica of its own, and Bob; `before` runs on Alice before the snapshot is taken. */
async function twoReplicas(options: Partial<AgentOptions>, elsewhereOptions: Partial<AgentOptions> = {}, before: (alice: Running) => Promise<void> = async () => undefined) {
  const mediator = await newMediator();
  const alice = await run(mediator, 1, ALICE, options);
  const bob = await run(mediator, 2, BOB, { privateAddresses: false });
  await before(alice);
  const elsewhere = await restoredFrom(alice, await snapshotOf(alice), { ...options, ...elsewhereOptions });
  return { mediator, alice, elsewhere, bob };
}

/** Resolves once `replicaDid` has told the mediator it handled a pickup batch whole; until then the mediator answers none of that replica's execution registrations. */
function takenWhole(mediator: FakeMediator, replicaDid: Did): Promise<void> {
  let taken = (): void => undefined;
  const whole = new Promise<void>((resolve) => (taken = resolve));
  mediator.intercept = async (msg, from) => {
    if (from === null || canonicalDid(from) !== replicaDid) return undefined;
    if (msg.type === MESSAGES_RECEIVED) taken();
    if (msg.type === EXECUTION_REGISTER) await whole;
    return undefined;
  };
  return whole;
}

describe("the replicas of one account taking the same input", () => {
  it("leave its automatic outputs to the replica the mediator registered first, whichever picked it up first: the others keep that they left it, and list none of its replies as their work", { timeout: LONG }, async () => {
    const { mediator, alice, elsewhere, bob } = await twoReplicas({ privateAddresses: false, handlers: [echo] });
    const first = await replicaOf(elsewhere);
    const second = await replicaOf(alice);
    mediator.intercept = async (msg, from) => {
      if (msg.type !== EXECUTION_REGISTER || from === null || canonicalDid(from) !== second) return undefined;
      const executionId = (msg.body as { execution_id: string }).execution_id;
      await until("the replica elsewhere has registered first", () => [...mediator.executions.values()].some((registrations) => registrations.get(executionId)?.replicas[0] === first));
      return undefined;
    };
    const forwards = seen(mediator, FORWARD);

    await bob.agent.send(toAlice(alice, bob), ping, { messageId: PING });
    await bob.agent.send(toAlice(alice, bob), { type: REQUEST, body: { echo: "this" } }, { messageId: REQUESTED });
    await until("both replicas have both", () => alice.inbounds.length === 2 && elsewhere.inbounds.length === 2);
    await Promise.all([alice.agent.settled(), elsewhere.agent.settled()]);
    await until("bob has the receipt and both replies", () => bob.inbounds.length === 3);
    await bob.agent.settled();

    const outputs = ({ responder, reacted }: Running["inbounds"][number]) => [responder?.status, reacted?.effects.map((effect) => [effect.effectType, effect.outcome]) ?? null];
    expect(elsewhere.inbounds.map(outputs)).toEqual([
      ["self", [[PURE_ACK_EFFECT, "created"], [PING_RESPONSE_EFFECT, "created"]]],
      ["self", [[ECHO, "created"]]],
    ]);
    expect(alice.inbounds.map(outputs)).toEqual([
      ["other", null],
      ["other", null],
    ]);
    expect(alice.inbounds.map(({ responder }) => responder)).toMatchObject([
      { registration: { replicas: [first, second] } },
      { registration: { replicas: [first, second] } },
    ]);
    expect([seen(mediator, FORWARD) - forwards, bob.inbounds.length]).toEqual([2 + 3, 3]);

    expect((await foldOf(alice)).set.of("message.out")).toEqual([]);
    expect([await leftBy(alice), await leftBy(elsewhere)]).toEqual([
      [first, first],
      [null, null],
    ]);
    expect(await alice.agent.pending()).toEqual({ pendingOutbounds: [], missingResponses: [], rotationCandidates: [], missingNotifications: [], notificationConflicts: [], pendingProofs: [] });
    const shown = await (await alice.agent.records()).channel(channelOf(alice.party.did, bob.party.did));
    expect(shown.messages.filter((message) => message.direction === "in").map(({ manualAction, completes }) => [manualAction, completes])).toEqual([
      ["none", []],
      ["none", []],
    ]);
  });

  it("each record the rotation the input selects, and only the replica answering it announces it: another opens what the peer then writes to the successor, even in the batch that brought the input", { timeout: LONG }, async () => {
    let invitation: { id: string; from: string } | null = null;
    const { mediator, alice, elsewhere, bob } = await twoReplicas({}, { liveDelivery: false }, async (alice) => {
      invitation = (await alice.agent.disclose(ALICE, { as: "oob" })).invitation as { id: string; from: string };
    });
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    const aliceReplica = await replicaOf(alice);

    await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: invitation!.from as Did }, { ...hello("hello"), pthid: invitation!.id });
    await until("alice has selected a private address", () => alice.inbounds.length === 1);
    const selected = alice.inbounds[0]!.address!;
    if (selected.outcome !== "rotated") throw new Error(`alice did not rotate: ${JSON.stringify(selected)}`);
    expect(selected.rotation.notification).toMatchObject({ outcome: "created", dispatched: { outcome: "submitted" } });
    await until("bob has the notification", () => bob.inbounds.length === 1);
    const a1 = (await foldOf(alice)).dids.entities.get(selected.rotation.successor)!.created!.did;
    expect((await foldOf(bob)).continuity.head(channelOf(b0, a0))).toEqual(channelOf(b0, a1));
    await bob.agent.send({ channel: channelOf(b0, a1) }, hello("to the successor"));
    const forwards = seen(mediator, FORWARD);

    // What waits for the replica elsewhere is the input, Bob's receipt of the notification and his message, each to the successor but the first.
    const batch = takenWhole(mediator, await replicaOf(elsewhere));
    expect(await elsewhere.agent.connect()).toMatchObject([{ drained: { acked: 3, ended: "empty" } }]);
    await batch;
    await elsewhere.agent.settled();
    expect(elsewhere.inbounds.map(({ received, responder }) => [received.outcome, responder?.status ?? null])).toEqual([
      ["received", "other"],
      ["received", null],
      ["received", null],
    ]);
    const [input] = elsewhere.inbounds;
    expect(input).toMatchObject({ responder: { registration: { replicas: [aliceReplica, await replicaOf(elsewhere)] } }, reacted: null });
    expect(input!.address).toMatchObject({ outcome: "rotated", rotation: { successor: selected.rotation.successor, notification: { effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "none", because: "another replica answers the input" } } });

    const fold = await foldOf(elsewhere);
    expect(fold.set.of("did.rotationSelected").map(({ data }) => data.toDidId)).toEqual([selected.rotation.successor]);
    const shown = await (await elsewhere.agent.records()).channel(channelOf(a1, b0));
    expect(shown.messages.filter((message) => message.direction === "in" && message.kind === "application").map((message) => (message.body.state === "available" ? message.body.body : message.body.state))).toEqual([{ content: "to the successor" }]);
    expect((await elsewhere.agent.pending()).missingNotifications).toEqual([]);
    expect([seen(mediator, FORWARD), bob.inbounds.length]).toEqual([forwards, 1]);
  });
});

describe("that a replica left an input to another", () => {
  test("stays with its runtime, through a restart and a clearing of its caches; no snapshot carries it either way, and a runtime with another replica lists the input's outputs again and makes none of them", { timeout: LONG }, async () => {
    const down: Handler = { ...echo, respond: async () => Promise.reject(new Error("the echo is down")) };
    const options = { liveDelivery: false, privateAddresses: false, handlers: [down] };
    const mediator = await newMediator();
    const first = await run(mediator, 1, ALICE, options);
    const second = await restoredFrom(first, await snapshotOf(first), options);
    const bob = await run(mediator, 2, BOB, { liveDelivery: false, privateAddresses: false });

    await bob.agent.send(toAlice(first, bob), { type: REQUEST, body: { echo: "this" }, pleaseAck: null }, { messageId: REQUESTED });
    for (const replica of [first, second]) {
      await replica.agent.connect();
      await replica.agent.settled();
    }
    expect([first, second].map(({ inbounds }) => inbounds.map(({ responder, reacted }) => [responder?.status, reacted?.effects.map((effect) => effect.outcome) ?? null]))).toEqual([[["self", ["refused"]]], [["other", null]]]);
    expect([await owed(first), await owed(second), await leftBy(second)]).toEqual([[ECHO], [], [await replicaOf(first)]]);

    await imported(first, await snapshotOf(second));
    await imported(second, await snapshotOf(first));
    await Promise.all([first.agent.localStateChanged(), second.agent.localStateChanged()]);
    expect([await owed(first), await owed(second)]).toEqual([[ECHO], []]);

    await restart(second, options);
    await second.runtime.local.clearCaches();
    expect(await owed(second)).toEqual([]);

    const registrations = seen(mediator, EXECUTION_REGISTER);
    const elsewhere = await restoredFrom(second, await snapshotOf(second), options);
    await restart(second, options, { resetIdentity: true });
    for (const runtime of [elsewhere, second]) expect([await owed(runtime), await leftBy(runtime), (await foldOf(runtime)).set.of("message.out")]).toEqual([[ECHO], [null], []]);
    expect(seen(mediator, EXECUTION_REGISTER)).toBe(registrations);
  });
});

describe("a replica closed while it finds who answers its inputs", () => {
  test("asks for no registration once closed and answers nothing, keeping who it found answers each input, and leaves the inputs it took to a replica still open, which answers those it did not register for", { timeout: LONG }, async () => {
    const options = { liveDelivery: false, privateAddresses: false };
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, options);
    const elsewhere = await restoredFrom(alice, await snapshotOf(alice), options);
    const bob = await run(mediator, 2, BOB, options);
    const aliceReplica = await replicaOf(alice);
    let answer = (): void => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    mediator.intercept = async (msg, from) => {
      if (msg.type === EXECUTION_REGISTER && from !== null && canonicalDid(from) === aliceReplica) await answered;
      return undefined;
    };

    await bob.agent.send(toAlice(alice, bob), { ...hello("first"), pleaseAck: [""] });
    await bob.agent.send(toAlice(alice, bob), { ...hello("second"), pleaseAck: [""] });
    expect(await alice.agent.connect()).toMatchObject([{ drained: { acked: 2, ended: "empty" } }]);
    await until("alice registers for the first", () => seen(mediator, EXECUTION_REGISTER) === 1);
    alice.agent.close();
    answer();
    await alice.agent.settled();
    expect(seen(mediator, EXECUTION_REGISTER)).toBe(1);
    expect(alice.inbounds.map(({ responder, reacted }) => [responder, reacted])).toEqual([
      [{ status: "self", registration: expect.objectContaining({ replicas: [aliceReplica] }) }, null],
      [{ status: "unknown", because: "the holder of the link is closed" }, null],
    ]);
    expect([(await foldOf(alice)).set.of("message.out"), await owed(alice)]).toEqual([[], [PURE_ACK_EFFECT, PURE_ACK_EFFECT]]);

    await elsewhere.agent.connect();
    await elsewhere.agent.settled();
    expect(elsewhere.inbounds.map(({ responder, reacted }) => [responder?.status, reacted?.effects.map((effect) => [effect.effectType, effect.outcome]) ?? null])).toEqual([
      ["other", null],
      ["self", [[PURE_ACK_EFFECT, "created"]]],
    ]);
    expect(await bob.agent.connect()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    await bob.agent.settled();
    expect(bob.inbounds.map(({ received }) => received.outcome)).toEqual(["received"]);
  });

  test("asks no more for a registration lost on the way", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    let lose = (): void => undefined;
    const lost = new Promise<void>((resolve) => (lose = resolve));
    mediator.intercept = async (msg) => {
      if (msg.type !== EXECUTION_REGISTER) return undefined;
      await lost;
      throw new Error("the mediator fell over");
    };

    await bob.agent.send(toAlice(alice, bob), ping, { messageId: PING });
    await until("alice registers for the Ping", () => seen(mediator, EXECUTION_REGISTER) === 1);
    alice.agent.close();
    lose();
    await alice.agent.settled();
    expect([seen(mediator, EXECUTION_REGISTER), alice.inbounds.map(({ responder, reacted }) => [responder, reacted])]).toEqual([1, [[{ status: "unknown", because: "the holder of the link is closed" }, null]]]);
    expect(await owed(alice)).toEqual([PING_RESPONSE_EFFECT, PURE_ACK_EFFECT]);
  });
});

describe("a replica that cannot read its registration of an input", () => {
  test("refused makes none of the input's outputs and keeps no leave: they are listed for the user, and a completion makes them", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    mediator.intercept = (msg, from) => (msg.type === EXECUTION_REGISTER ? mediator.reply(PROBLEM_REPORT_TYPE, from as string, { code: "e.estoc.replica-mediation.quota" }, msg.id) : undefined);
    const forwards = seen(mediator, FORWARD);

    await bob.agent.send(toAlice(alice, bob), ping, { messageId: PING });
    await until("alice has the Ping", () => alice.inbounds.length === 1);
    await alice.agent.settled();
    expect(alice.inbounds[0]).toMatchObject({ responder: { status: "unknown", because: expect.stringMatching(/quota/) }, reacted: null });
    expect(seen(mediator, EXECUTION_REGISTER)).toBe(1);
    expect([(await foldOf(alice)).set.of("message.out"), await leftBy(alice), seen(mediator, FORWARD) - forwards]).toEqual([[], [null], 1]);

    const owed = (await alice.agent.pending()).missingResponses;
    expect(owed.map(({ effectType }) => effectType)).toEqual([PING_RESPONSE_EFFECT, PURE_ACK_EFFECT]);
    for (const { executionId, effectType } of owed) expect(await alice.agent.manual.completeResponse(executionId, effectType)).toMatchObject({ outcome: "created", action: { kind: "manual" }, dispatched: { outcome: "submitted" } });
    await until("bob has the receipt and the reply", () => bob.inbounds.length === 2);
  });

  test("lost on the way is asked for once more, and the mediator's answer to the repeat stands", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    let lost = false;
    mediator.intercept = (msg) => {
      if (msg.type !== EXECUTION_REGISTER || lost) return undefined;
      lost = true;
      throw new Error("the mediator fell over");
    };

    await bob.agent.send(toAlice(alice, bob), ping, { messageId: PING });
    await until("alice has the Ping", () => alice.inbounds.length === 1);
    await alice.agent.settled();
    expect(alice.inbounds[0]).toMatchObject({ responder: { status: "self", registration: { replicas: [await replicaOf(alice)] } }, reacted: { effects: [{ outcome: "created" }, { outcome: "created" }] } });
    expect(seen(mediator, EXECUTION_REGISTER)).toBe(2);
  });

  test("answered with a registration not listing it makes none of the input's outputs and keeps no leave", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    mediator.intercept = (msg, from) => {
      if (msg.type !== EXECUTION_REGISTER) return undefined;
      const { execution_id } = msg.body as { execution_id: string };
      return mediator.reply(EXECUTION_REGISTERED, from as string, { execution_id, registration_id: "elsewhere", created_time: 1, retain_until: 2, replicas: [bob.party.replica.did] }, msg.id);
    };

    await bob.agent.send(toAlice(alice, bob), ping, { messageId: PING });
    await until("alice has the Ping", () => alice.inbounds.length === 1);
    await alice.agent.settled();
    expect(alice.inbounds[0]).toMatchObject({ responder: { status: "unknown", because: "execution-registered does not list this replica" }, reacted: null });
    expect([(await foldOf(alice)).set.of("message.out"), await leftBy(alice), (await alice.agent.pending()).missingResponses.length]).toEqual([[], [null], 2]);
  });
});

describe("an input picked up at a replica-mediation mediator", () => {
  test("owed nothing is registered nowhere, and one owed an output holds up neither the pickup nor the mediator's being told of it while its registration is out", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false, liveDelivery: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false, liveDelivery: false });

    await bob.agent.send(toAlice(alice, bob), hello("no receipt asked"));
    await alice.agent.connect();
    await alice.agent.settled();
    expect(alice.inbounds).toMatchObject([{ received: { outcome: "received" }, responder: null, reacted: null }]);
    expect(seen(mediator, EXECUTION_REGISTER)).toBe(0);

    let answer = (): void => undefined;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    mediator.intercept = async (msg) => {
      if (msg.type === EXECUTION_REGISTER) await answered;
      return undefined;
    };
    await bob.agent.send(toAlice(alice, bob), ping, { messageId: PING });
    expect(await alice.agent.connect()).toMatchObject([{ drained: { acked: 1, ended: "empty" } }]);
    expect(mediator.queues.get(alice.party.replica.did)).toEqual([]);
    await until("the registration is out", () => seen(mediator, EXECUTION_REGISTER) === 1);
    expect([alice.inbounds.length, (await foldOf(alice)).set.of("message.out")]).toEqual([1, []]);

    answer();
    await alice.agent.settled();
    expect(alice.inbounds[1]).toMatchObject({ responder: { status: "self" }, reacted: { effects: [{ effectType: PURE_ACK_EFFECT, outcome: "created" }, { effectType: PING_RESPONSE_EFFECT, outcome: "created" }] } });
  });
});
