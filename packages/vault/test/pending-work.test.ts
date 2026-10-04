import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  EMPTY_CONTENT_CID,
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_EFFECT,
  PING_RESPONSE_TYPE,
  PING_TYPE,
  PROBLEM_REPORT_TYPE,
  PURE_ACK_EFFECT,
  ROTATION_NOTIFICATION_EFFECT,
  automaticIntent,
  automaticMessageId,
  decisionFor,
  effectKey,
  startDidId,
  executionId,
  foldVault,
  kindOf,
  unfinishedWork,
  type MessageId,
  type PendingWork,
} from "../src/index.js";
import { MEDIATED, createdDid, expectOrderFree } from "./fold/helpers.js";
import { IAT, PURE_ACK, automatic, blocked, channel, foldScene, intent, invitation, packageOf, proof, proofFreeReceipt, receipt, receiptCarryingProof, ref, resolved, rotation, shortIssuerProof, vaults, type Local, type Peer } from "./fold/scene.js";

const inputOf = (source: { data: { wireMessageId: string } }, peer: Peer, local: Local) => executionId(peer.did, local.did, source.data.wireMessageId as never);

const workSnapshot = (work: PendingWork) => ({
  outbounds: work.outbounds.map((o) => [o.messageId, o.work.kind]),
  responses: work.responses.map((r) => [r.execution.messageId, r.effectType, r.channel]),
  rotationCandidates: work.rotationCandidates.map((c) => [c.channel, c.sources.map((s) => s.event.cid), c.choice]),
  notifications: work.notifications.map((n) => [n.decision.event.cid, n.channel, n.source?.event.cid ?? null]),
  notificationConflicts: work.notificationConflicts.map((c) => [c.decision.event.cid, c.notification.messageIds]),
  proofs: work.proofs.map((c) => c.source.event.cid),
});

describe("unfinished work", () => {
  it("lists the outbounds still to prepare or dispatch, the reply candidates of established inputs under the built-in address rule, and the proofs waiting for issuer material", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b2, b3 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const queued = intent(scene, a0, b0);
    const prepared = intent(scene, a0, b0);
    const pkg = packageOf(scene, prepared, { sender: a0.didId, recipient: b0, resolution: root });
    const sent = intent(scene, a0, b0);
    scene.add("delivery.submitted", { messageId: sent.data.messageId, packageId: packageOf(scene, sent, { sender: a0.didId, recipient: b0, resolution: root }).data.packageId });
    const asking = receipt(scene, { local: a0, peer: b0, resolution: root, overrides: { pleaseAck: [""] } });
    const ping = receipt(scene, { local: a0, peer: b0, resolution: root, overrides: { msgType: PING_TYPE, pleaseAck: [""] } });
    const answered = receipt(scene, { local: a0, peer: b0, resolution: root, overrides: { pleaseAck: [""] } });
    automatic(scene, a0, b0, answered, inputOf(answered, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, thid: answered.data.wireMessageId, ack: [answered.data.wireMessageId] });
    const ackOfAnswered = scene.events.at(-1)!.data as { messageId: MessageId };
    const silent = receipt(scene, { local: a0, peer: b0, resolution: root });
    const erasedPing = receipt(scene, { local: a0, peer: b0, resolution: root, overrides: { msgType: PING_TYPE, pleaseAck: [""] } });
    scene.add("message.erased", { messageId: erasedPing.data.messageId, dropCids: [erasedPing.data.bodyCid], because: "user" });
    const waiting = receipt(scene, { local: a1, peer: b3, resolution: resolved(scene, a1.didId, b3), fromPrior: await shortIssuerProof(peerKeys, b2, b3) });
    const vault = await foldScene(scene, keys);
    expect(vault.channels.carriers.get(waiting.cid)!.proof).toEqual({ status: "pending-proof" });
    const work = unfinishedWork(vault);
    expect(workSnapshot(work)).toEqual({
      outbounds: [
        [prepared.data.messageId, "dispatch"],
        [queued.data.messageId, "prepare"],
        [ackOfAnswered.messageId, "prepare"],
      ].sort(([a], [b]) => (a! < b! ? -1 : 1)),
      responses: [asking, ping, erasedPing]
        .map((event) => event.data.messageId)
        .sort()
        .flatMap((messageId) => (messageId === ping.data.messageId ? [PURE_ACK_EFFECT, PING_RESPONSE_EFFECT] : [PURE_ACK_EFFECT]).map((effectType) => [messageId, effectType, channel(a0, b0)])),
      rotationCandidates: [],
      notifications: [],
      notificationConflicts: [],
      proofs: [waiting.cid],
    });
    expect(work.outbounds.find((o) => o.messageId === prepared.data.messageId)!.work).toMatchObject({ kind: "dispatch", package: { event: pkg } });
    expect(vault.inbound.ofMessage(silent.data.messageId)).not.toBeNull();
    const draft = automaticIntent(vault, vault.inbound.ofMessage(asking.data.messageId)!, PURE_ACK_EFFECT);
    expect(draft).toMatchObject({ executionId: inputOf(asking, b0, a0), effectType: PURE_ACK_EFFECT, existing: null });
    expect(automaticIntent(vault, vault.inbound.ofMessage(answered.data.messageId)!, PURE_ACK_EFFECT).existing).not.toBeNull();
    expectOrderFree(scene.events, (set) => workSnapshot(unfinishedWork(foldVault(set, vault.checks))));
  });

  it("lists a pure ACK for an input requesting its own receipt, whatever else it names, none for one requesting only another's, and none once the tuple has an intent", async () => {
    const { scene, keys, peerKeys, a0, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const first = receipt(scene, { local: a0, peer: b0, resolution: root });
    const asking = receipt(scene, { local: a0, peer: b0, resolution: root, overrides: { pleaseAck: [first.data.wireMessageId, ""] } });
    const namingFirst = receipt(scene, { local: a0, peer: b0, resolution: root, overrides: { pleaseAck: [first.data.wireMessageId] } });
    let vault = await foldScene(scene, keys);
    expect(vault.outbound.ackTarget(asking.cid)).toEqual({ status: "eligible", wireMessageId: asking.data.wireMessageId });
    expect(vault.outbound.ackTarget(namingFirst.cid)).toEqual({ status: "none", because: "the carrier requests no receipt of itself" });
    expect(workSnapshot(unfinishedWork(vault)).responses).toEqual([[asking.data.messageId, PURE_ACK_EFFECT, channel(a0, b0)]]);

    automatic(scene, a0, b0, asking, inputOf(asking, b0, a0), PURE_ACK, { bodyCid: EMPTY_CONTENT_CID, thid: asking.data.wireMessageId, ack: [asking.data.wireMessageId] });
    const ack = scene.events.at(-1)!.data as { messageId: MessageId };
    vault = await foldScene(scene, keys);
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ outbounds: [[ack.messageId, "prepare"]], responses: [] });

    const fromSuccessor = receipt(scene, { local: a0, peer: b1, resolution: resolved(scene, a0.didId, b1), fromPrior: await proof(peerKeys, b0, b1), overrides: { pleaseAck: [first.data.wireMessageId, ""] } });
    vault = await foldScene(scene, keys);
    expect(vault.outbound.ackTarget(fromSuccessor.cid)).toEqual({ status: "eligible", wireMessageId: fromSuccessor.data.wireMessageId });
    expect(workSnapshot(unfinishedWork(vault)).responses).toEqual([[fromSuccessor.data.messageId, PURE_ACK_EFFECT, channel(a0, b1)]]);
    expectOrderFree(scene.events, (set) => workSnapshot(unfinishedWork(foldVault(set, vault.checks))));
  });

  it("lists the rotation a disclosed entry's established application inputs call for, one per intent with every input, ready with the start it would select, blocked where the pair is denied, and taken over by the decision once one is recorded", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2, b3 } = await vaults();
    invitation(scene, a0);
    const first = proofFreeReceipt(scene, a0, b0);
    const second = proofFreeReceipt(scene, a0, b0);
    proofFreeReceipt(scene, a1, b0);
    const unrelated = proofFreeReceipt(scene, a0, b2);
    const control = receipt(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b0), overrides: { msgType: EMPTY_MESSAGE_TYPE, ack: [first.data.wireMessageId] } });
    const unadmitted = receipt(scene, { local: a0, peer: b3, resolution: resolved(scene, a0.didId, b3), admitted: false });
    let vault = await foldScene(scene, keys);
    expect(kindOf(control.data)).not.toBe("application");
    expect(vault.admissions.admitted(unadmitted.cid)).toBe(false);
    const ready = (local: Local, binding: Peer, support: string[] = []) => ({ status: "ready", recipe: { kind: "start", predecessor: local.did, binding: binding.did }, support });
    expect(workSnapshot(unfinishedWork(vault)).rotationCandidates).toEqual([
      [channel(a0, b2), [unrelated.cid], ready(a0, b2)],
      [channel(a0, b0), [first.cid, second.cid], ready(a0, b0)],
    ]);
    expectOrderFree(scene.events, (set) => workSnapshot(unfinishedWork(foldVault(set, vault.checks))).rotationCandidates);

    const moved = await receiptCarryingProof(scene, peerKeys, a0, b0, b1);
    blocked(scene, a0, b2);
    vault = await foldScene(scene, keys);
    expect(workSnapshot(unfinishedWork(vault)).rotationCandidates).toEqual([
      [channel(a0, b2), [unrelated.cid], { status: "blocked", because: "the channel is denied" }],
      [channel(a0, b1), [first.cid, second.cid, moved.cid], ready(a0, b0, [`receipt:${moved.cid}:transition`])],
    ]);

    const successor: Local = await createdDid(scene, keys, startDidId(a0.did, b0.did), MEDIATED, { kind: "start", profile: "v1", predecessor: a0.did, binding: b0.did });
    const decision = await rotation(scene, keys, { from: a0, peer: b1, to: successor, source: moved });
    vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b1.did).status).toBe("candidate");
    const work = workSnapshot(unfinishedWork(vault));
    expect(work.rotationCandidates).toEqual([[channel(a0, b2), [unrelated.cid], { status: "blocked", because: "the channel is denied" }]]);
    expect(work.notifications).toEqual([[decision.cid, channel(successor, b1), moved.cid]]);
  });

  it("lists the notification a verified decision permits while its source stays eligible, reuses one already recorded, and reports several as a conflict", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const manual = await rotation(scene, keys, { from: a1, peer: b1, to: a0 });
    proofFreeReceipt(scene, a1, b1);
    let vault = await foldScene(scene, keys);
    expect(vault.continuity.status(decision.cid)).toEqual({ status: "verified" });
    expect(vault.continuity.status(manual.cid)).toEqual({ status: "verified" });
    expect(workSnapshot(unfinishedWork(vault)).notifications).toEqual([
      [decision.cid, channel(a1, b0), source.cid],
      [manual.cid, channel(a0, b1), null],
    ]);

    const notification = automatic(scene, a1, b0, source, inputOf(source, b0, a0), ROTATION_NOTIFICATION_EFFECT, { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], thid: source.data.wireMessageId, rotationEventCid: ref(decision) });
    vault = await foldScene(scene, keys);
    expect(workSnapshot(unfinishedWork(vault)).notifications).toEqual([[manual.cid, channel(a0, b1), null]]);
    expect(unfinishedWork(vault).outbounds.map((o) => o.messageId)).toEqual([notification.data.messageId]);

    await receiptCarryingProof(scene, peerKeys, a0, b0, b1);
    const manualForm = intent(scene, a1, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""], rotationEventCid: ref(decision) });
    vault = await foldScene(scene, keys);
    const work = workSnapshot(unfinishedWork(vault));
    expect(work.notifications).toEqual([]);
    expect(work.notificationConflicts).toEqual([[decision.cid, [notification.data.messageId, manualForm.data.messageId].sort()]]);
  });

  it("tracks one notification per record: two records of one intent over different inputs, or manual under different message IDs, each have their own and none conflicts; two records over one input derive one message ID, and their notification intents collide", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const first = proofFreeReceipt(scene, a0, b0);
    const second = proofFreeReceipt(scene, a0, b0);
    const overFirst = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: first });
    const overSecond = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: second, fromPrior: await proof(keys, a0, a1, IAT + 1) });
    let vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: overFirst }, group: { records: [{ event: overFirst }, { event: overSecond }] } });
    expect(workSnapshot(unfinishedWork(vault)).notifications).toEqual([
      [overFirst.cid, channel(a1, b0), first.cid],
      [overSecond.cid, channel(a1, b0), second.cid],
    ]);
    const content = { bodyCid: EMPTY_CONTENT_CID, pleaseAck: [""] };
    const ofFirst = automatic(scene, a1, b0, first, inputOf(first, b0, a0), ROTATION_NOTIFICATION_EFFECT, { ...content, thid: first.data.wireMessageId, rotationEventCid: ref(overFirst) });
    const ofSecond = automatic(scene, a1, b0, second, inputOf(second, b0, a0), ROTATION_NOTIFICATION_EFFECT, { ...content, thid: second.data.wireMessageId, rotationEventCid: ref(overSecond) });
    vault = await foldScene(scene, keys);
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ notifications: [], notificationConflicts: [] });
    expect(vault.outbound.notificationFor(overFirst.cid)).toEqual({ status: "selected", messageId: ofFirst.data.messageId });
    expect(vault.outbound.notificationFor(overSecond.cid)).toEqual({ status: "selected", messageId: ofSecond.data.messageId });
    expect(unfinishedWork(vault).outbounds.map((o) => [o.messageId, o.work.kind])).toEqual([[ofFirst.data.messageId, "prepare"], [ofSecond.data.messageId, "prepare"]].sort(([a], [b]) => (a! < b! ? -1 : 1)));

    proofFreeReceipt(scene, a0, b1);
    const manual = await rotation(scene, keys, { from: a0, peer: b1, to: a1 });
    const manualAgain = await rotation(scene, keys, { from: a0, peer: b1, to: a1, fromPrior: await proof(keys, a0, a1, IAT + 2) });
    vault = await foldScene(scene, keys);
    expect(workSnapshot(unfinishedWork(vault)).notifications).toEqual([
      [manual.cid, channel(a1, b1), null],
      [manualAgain.cid, channel(a1, b1), null],
    ]);
    intent(scene, a1, b1, { msgType: EMPTY_MESSAGE_TYPE, ...content, rotationEventCid: ref(manual) });
    intent(scene, a1, b1, { msgType: EMPTY_MESSAGE_TYPE, ...content, rotationEventCid: ref(manualAgain) });
    vault = await foldScene(scene, keys);
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ notifications: [], notificationConflicts: [] });

    const third = proofFreeReceipt(scene, a0, b0);
    const overThird = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: third, fromPrior: await proof(keys, a0, a1, IAT + 3) });
    const overThirdAgain = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: third, fromPrior: await proof(keys, a0, a1, IAT + 4) });
    const input = inputOf(third, b0, a0);
    automatic(scene, a1, b0, third, input, ROTATION_NOTIFICATION_EFFECT, { ...content, thid: third.data.wireMessageId, rotationEventCid: ref(overThird) });
    automatic(scene, a1, b0, third, input, ROTATION_NOTIFICATION_EFFECT, { ...content, thid: third.data.wireMessageId, rotationEventCid: ref(overThirdAgain) });
    vault = await foldScene(scene, keys);
    const collided = automaticMessageId(effectKey(input, ROTATION_NOTIFICATION_EFFECT));
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: overFirst }, group: { records: [{ event: overFirst }, { event: overSecond }, { event: overThird }, { event: overThirdAgain }] } });
    expect(vault.outbound.outbounds.get(collided)!.intent).toEqual({ status: "conflict", because: "the intents recorded under one message ID disagree" });
    for (const record of [overThird, overThirdAgain]) expect(vault.outbound.notificationFor(record.cid)).toEqual({ status: "selected", messageId: collided });
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ notifications: [], notificationConflicts: [] });
    expect(unfinishedWork(vault).outbounds.map((o) => o.messageId)).not.toContain(collided);
  });

  it("lists no notification for a verified decision a control input triggered: a pure ACK, another Empty, a ping response or a problem report", async () => {
    const { scene, keys, a0, a1, b0, b1, b2, b3 } = await vaults();
    const controls = [
      proofFreeReceipt(scene, a0, b0, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, ack: [uuidv7()] }),
      proofFreeReceipt(scene, a0, b1, { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID }),
      proofFreeReceipt(scene, a0, b2, { msgType: PING_RESPONSE_TYPE }),
      proofFreeReceipt(scene, a0, b3, { msgType: PROBLEM_REPORT_TYPE }),
    ];
    const decisions = [];
    for (const [index, peer] of [b0, b1, b2, b3].entries()) decisions.push(await rotation(scene, keys, { from: a0, peer, to: a1, source: controls[index] }));
    const vault = await foldScene(scene, keys);
    expect(controls.map((source) => kindOf(source.data))).toEqual(["pure-ack", "empty", "ping-response", "error"]);
    for (const decision of decisions) expect(vault.continuity.status(decision.cid)).toEqual({ status: "verified" });
    expect(workSnapshot(unfinishedWork(vault))).toMatchObject({ notifications: [], notificationConflicts: [] });
  });
});
