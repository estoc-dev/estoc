import { afterEach, describe, expect, test } from "vitest";

import { canonicalize, parseStrict, type CommitObject } from "@estoc/event-store";
import { PURE_ACK_EFFECT, ROTATION_NOTIFICATION_EFFECT, type DidId, type EventReference, type MessageId } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { EXECUTION_REGISTER } from "../../src/protocol/replica-mediation.js";
import { FORWARD } from "../../src/protocol/spec.js";
import type { FakeMediator } from "../fake-mediator.js";
import { afterNextCommit, newMediator, refuseCommits, refuseSubmissions } from "../helpers.js";
import { LONG, channelOf, dieAt, foldOf, restart, run, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const HELLO = "019b0000-0000-7000-8000-000000000101" as MessageId;
const ANSWER = "019b0000-0000-7000-8000-000000000102" as MessageId;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;

const queuedFor = (mediator: FakeMediator, party: Running): number => mediator.queues.get(party.party.replica.did)?.length ?? 0;

async function pair(): Promise<{ mediator: FakeMediator; alice: Running; bob: Running }> {
  const mediator = await newMediator();
  const alice = await run(mediator, 1, ALICE);
  const bob = await run(mediator, 2, BOB);
  return { mediator, alice, bob };
}

describe("a process that dies", () => {
  test("after an input was recorded and before its mediator heard so: the delivery comes again as no live input, and the reply no step had decided by then is listed and sent only by a completion", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    dieAt(alice, "unacknowledged");
    mediator.intercept = async (msg) => {
      if (msg.type === EXECUTION_REGISTER) await until("alice died telling the mediator of the delivery", () => alice.dead);
      return undefined;
    };
    await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, { ...hello("hello"), pleaseAck: [""] }, { messageId: HELLO });
    await until("alice died telling the mediator of the delivery", () => alice.dead);
    expect(queuedFor(mediator, alice)).toBe(1);

    const sentBefore = forwardsSeen(mediator);
    mediator.intercept = null;
    await restart(alice);
    await until("the delivery came again", () => alice.inbounds.some(({ received }) => received.outcome === "received" && !received.live));
    expect(queuedFor(mediator, alice)).toBe(0);
    const recovered = await foldOf(alice);
    expect(recovered.inbound.executions.size).toBe(1);
    expect(recovered.set.of("message.in")).toHaveLength(2);
    expect(forwardsSeen(mediator)).toBe(sentBefore);

    expect(await alice.agent.outbounds()).toEqual([]);
    const owed = (await alice.agent.pending()).missingResponses;
    expect(owed).toMatchObject([{ effectType: PURE_ACK_EFFECT, entries: ["completeResponse"] }]);
    expect(await alice.agent.manual.completeResponse(owed[0]!.executionId, PURE_ACK_EFFECT)).toMatchObject({ outcome: "created", action: { kind: "manual" }, dispatched: { outcome: "submitted" } });
    await until("bob has the acknowledgement", () => bob.inbounds.length === 1);
    expect((await foldOf(bob)).outbound.outbounds.get(HELLO)).toMatchObject({ acknowledged: true });
  });

  test("after a preparation was recorded and before any call was made for it: the action that was to send it is gone with the process, nothing is sent on open, a trace cleared before another open sends nothing either, and a retry sends that very envelope", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { liveDelivery: false });
    const bob = await run(mediator, 2, BOB, { liveDelivery: false });
    const recorded: CommitObject[] = [];
    afterNextCommit(bob.runtime, "message.prepared", (objects) => recorded.push(...objects));
    dieAt(bob, "prepared");
    const calls = bob.calls;
    const sent = await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: HELLO });
    expect(sent.dispatched).toMatchObject({ outcome: "threw" });
    expect([bob.dead, sent.action.spent, bob.calls - calls, recorded.length]).toEqual([true, false, 0, 1]);

    await restart(bob);
    expect([forwardsSeen(mediator), queuedFor(mediator, alice)]).toEqual([0, 0]);
    await bob.runtime.local.clearCaches();
    await restart(bob);
    expect([forwardsSeen(mediator), queuedFor(mediator, alice)]).toEqual([0, 0]);
    const open = await bob.agent.outbounds();
    expect(open.map(({ outbound, waiting }) => [outbound.messageId, outbound.outcome.status, outbound.preparations[0]!.event.data.envelopeCid, waiting])).toEqual([[HELLO, "prepared", recorded[0]!.cid, null]]);

    expect(await bob.agent.manual.retry(HELLO)).toMatchObject({ outcome: "submitted", preparationEventCid: open[0]!.outbound.preparations[0]!.event.cid });
    const [queued] = mediator.queues.get(alice.party.replica.did)!;
    expect(Buffer.from(canonicalize(parseStrict(queued!.packed))).equals(recorded[0]!.source as Uint8Array)).toBe(true);
    expect(await bob.agent.outbounds()).toEqual([]);
  });

  test("inside the call that was to carry a preparation's envelope, which the mediator never took: nothing is sent on open, and a retry sends that envelope", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    dieAt(bob, "unsent");
    await expect(bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: HELLO })).resolves.toMatchObject({ dispatched: { outcome: "uncertain" }, action: { spent: true } });
    expect(bob.dead).toBe(true);

    const sentBefore = forwardsSeen(mediator);
    await restart(bob);
    expect(forwardsSeen(mediator)).toBe(sentBefore);
    const open = await bob.agent.outbounds();
    expect(open.map(({ outbound, waiting }) => [outbound.messageId, outbound.outcome.status, waiting])).toEqual([[HELLO, "prepared", null]]);
    expect(alice.inbounds).toEqual([]);

    expect(await bob.agent.manual.retry(HELLO)).toMatchObject({ outcome: "submitted", preparationEventCid: open[0]!.outbound.preparations[0]!.event.cid });
    await until("alice has the message", () => alice.inbounds.length === 1);
    expect(await bob.agent.outbounds()).toEqual([]);
  });

  test("after the mediator took an envelope and before that was recorded: the outbound stays open, and the retry the user makes is observed by the peer as the same input again", { timeout: LONG }, async () => {
    const { alice, bob } = await pair();
    dieAt(bob, "unrecorded");
    await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: HELLO });
    expect(bob.dead).toBe(true);
    await until("alice has the message", () => alice.inbounds.length === 1);

    await restart(bob);
    expect((await bob.agent.outbounds()).map(({ outbound }) => [outbound.messageId, outbound.outcome.status])).toEqual([[HELLO, "prepared"]]);
    expect(await bob.agent.manual.retry(HELLO)).toMatchObject({ outcome: "submitted" });
    await until("alice has it again", () => alice.inbounds.length === 2);
    expect(alice.inbounds[1]).toMatchObject({ received: { outcome: "received", live: null }, reacted: null, address: null });
    const ofAlice = await foldOf(alice);
    expect(ofAlice.set.of("message.in")).toHaveLength(2);
    expect(ofAlice.inbound.executions.size).toBe(1);
  });

  test("after the mediator took an envelope and the disk would not record that: the acceptance is kept as owed, and the next open records it and sends nothing", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    refuseSubmissions(bob.runtime, 1);
    const sent = await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: HELLO });
    expect(sent.dispatched).toMatchObject({ outcome: "threw" });
    await until("alice has the message", () => alice.inbounds.length === 1);
    expect((await foldOf(bob)).outbound.outbounds.get(HELLO)).toMatchObject({ submitted: false, outcome: { status: "prepared" } });

    const sentBefore = forwardsSeen(mediator);
    await restart(bob);
    expect(forwardsSeen(mediator)).toBe(sentBefore);
    const outbound = (await foldOf(bob)).outbound.outbounds.get(HELLO)!;
    expect(outbound).toMatchObject({ submitted: true, outcome: { status: "submitted" } });
    expect(outbound.submissions.map(({ event }) => [event.author, event.data.preparationEventCid])).toEqual([[bob.runtime.author, outbound.preparations[0]!.event.cid]]);
    expect(await bob.agent.outbounds()).toEqual([]);
    expect(alice.inbounds).toHaveLength(1);
  });

  test("after the mediator took an envelope and the disk would not record that, then an identity reset: what the old identity kept is not read, the outcome is unknown, and only the user's retry carries the same envelope", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    refuseSubmissions(bob.runtime, 1);
    await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: HELLO });
    await until("alice has the message", () => alice.inbounds.length === 1);
    const [preparation] = (await foldOf(bob)).outbound.outbounds.get(HELLO)!.preparations;

    const sentBefore = forwardsSeen(mediator);
    await restart(bob, {}, { resetIdentity: true });
    expect(forwardsSeen(mediator)).toBe(sentBefore);
    expect((await bob.agent.outbounds()).map(({ outbound }) => [outbound.messageId, outbound.outcome.status])).toEqual([[HELLO, "prepared"]]);
    expect((await bob.agent.pending()).pendingOutbounds).toMatchObject([{ messageId: HELLO, candidates: [preparation!.event.cid], selected: null, entries: ["retry", "cancel"] }]);

    expect(await bob.agent.manual.retry(HELLO)).toMatchObject({ outcome: "submitted", preparationEventCid: preparation!.event.cid });
    await until("alice has it again", () => alice.inbounds.length === 2);
    expect(alice.inbounds[1]).toMatchObject({ received: { outcome: "received", live: null } });
  });

  test("after a rotation was decided and before its notification was recorded: the notification is listed as owed, and completing it announces the successor", { timeout: LONG }, async () => {
    const { mediator, alice, bob } = await pair();
    await bob.agent.send({ channel: channelOf(bob.party.did, alice.party.did), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: HELLO });
    await until("alice has the message", () => alice.inbounds.length === 1);
    await alice.agent.send({ channel: channelOf(alice.party.did, bob.party.did) }, hello("hello yourself"), { messageId: ANSWER });
    await until("bob has the answer", () => bob.inbounds.length === 1);

    refuseCommits(alice.runtime, "message.out", 1);
    const rotated = await alice.agent.manual.rotate({ localDidId: ALICE, peerDid: bob.party.did });
    expect(rotated.notification).toMatchObject({ effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "refused" });
    const sentBefore = forwardsSeen(mediator);
    await restart(alice);
    expect(forwardsSeen(mediator)).toBe(sentBefore);

    const { missingNotifications } = await alice.agent.pending();
    expect(missingNotifications).toMatchObject([{ rotationEventCid: rotated.decision.cid, entries: ["completeNotification"] }]);
    expect(await alice.agent.manual.completeNotification(missingNotifications[0]!.rotationEventCid as EventReference<"did.rotationSelected">)).toMatchObject({ outcome: "created", action: { kind: "manual" }, dispatched: { outcome: "submitted" } });
    await until("bob has the notification", () => bob.inbounds.length === 2);
    expect(bob.inbounds[1]).toMatchObject({ after: { proof: { status: "verified" } } });
    const successor = (await foldOf(alice)).dids.entities.get(rotated.successor)!.created!.did;
    expect((await foldOf(bob)).continuity.head(channelOf(bob.party.did, alice.party.did))).toEqual(channelOf(bob.party.did, successor));
    expect((await alice.agent.pending()).missingNotifications).toEqual([]);
  });
});
