import { describe, expect, it } from "vitest";

import { decisionFor, decisionGroups, rotationIntent, senderGate, type DidId, type EventReference } from "../src/index.js";
import { AUTHOR2, cidOf } from "./fold/helpers.js";
import { IAT, channel, foldScene, proof, proofFreeReceipt, receiptCarryingProof, rotation, vaults } from "./fold/scene.js";

const UNKNOWN_PREDECESSOR = "019b7000-0000-7000-8000-000000000c00" as DidId;

describe("the rotation intent a rotation reuses", () => {
  it("is the one recorded from the local DID in its verified same-local context: none, one candidate, one still pending, or two successors in conflict", async () => {
    const { scene, keys, a0, a1, a2, b0, b1 } = await vaults();
    let vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toEqual({ status: "none" });

    const source = proofFreeReceipt(scene, a0, b0);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const elsewhere = await rotation(scene, keys, { from: a0, peer: b1, to: a2 });
    vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: decision }, group: { fromDidId: a0.didId, toDidId: a1.didId, context: [channel(a0, b0)], records: [{ event: decision }] } });
    expect(decisionFor(vault, a0.did, b1.did)).toMatchObject({ status: "candidate", candidate: { event: elsewhere }, group: { records: [{ event: elsewhere }] } });
    expect(decisionFor(vault, a1.did, b0.did)).toEqual({ status: "none" });

    vault = await foldScene(scene, null);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "pending", record: { event: decision } });

    const fork = await rotation(scene, keys, { from: a0, peer: b0, to: a2, source });
    vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "conflict", records: [{ event: decision }, { event: fork }] });
  });

  it("reads several records of one predecessor, successor and context as one intent, whatever their authors and proofs: the first candidate in canonical order stands for it, a record whose source is missing stays pending beside it, and the pair it leaves is closed while the successor's is open", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0);
    const first = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const second = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await proof(keys, a0, a1, IAT + 1) }, { author: AUTHOR2 });
    let vault = await foldScene(scene, keys);
    expect(first.data.fromPrior).not.toBe(second.data.fromPrior);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: first }, group: { fromDidId: a0.didId, toDidId: a1.didId, context: [channel(a0, b0)], records: [{ event: first }, { event: second }] } });
    expect(vault.continuity.conflicts).toEqual([]);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b0));
    for (const record of [first, second]) expect(vault.continuity.status(record.cid)).toEqual({ status: "verified" });

    const missing = cidOf("a receipt not here") as unknown as EventReference<"message.in">;
    const third = await rotation(scene, keys, { from: a0, peer: b0, to: a1, fromPrior: await proof(keys, a0, a1, IAT + 2), overrides: { sourceEventCid: missing } });
    vault = await foldScene(scene, keys);
    expect(vault.channels.decisions.get(third.cid)!.status).toEqual({ status: "pending", because: "the source it names is not here" });
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: first }, group: { records: [{ event: first }, { event: second }, { event: third }] } });
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b0));
    expect(senderGate(vault, channel(a0, b0))).toEqual({ status: "closed", because: "a rotation of the local DID here waits for its evidence" });
    expect(senderGate(vault, channel(a1, b0))).toEqual({ status: "open" });

    vault = await foldScene(scene, null);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "pending", record: { event: first } });
  });

  it("keeps the same successor from two predecessors, or from one predecessor in two contexts, as intents of their own, and a record whose predecessor is not here apart from any group", async () => {
    const { scene, keys, a0, a1, a2, b0, b1 } = await vaults();
    proofFreeReceipt(scene, a0, b0);
    proofFreeReceipt(scene, a1, b1);
    const fromA0 = await rotation(scene, keys, { from: a0, peer: b0, to: a2 });
    const fromA1 = await rotation(scene, keys, { from: a1, peer: b1, to: a2 });
    const unplaced = await rotation(scene, keys, { from: a0, peer: b0, to: a2, overrides: { fromDidId: UNKNOWN_PREDECESSOR } });
    const vault = await foldScene(scene, keys);
    const records = [fromA0, fromA1, unplaced].map((event) => vault.channels.decisions.get(event.cid)!);
    expect(records[2]).toMatchObject({ channel: null, status: { status: "pending", because: "the predecessor entity has no consistent creation here" } });
    expect(decisionGroups(vault, records)).toMatchObject({
      groups: [
        { fromDidId: a0.didId, toDidId: a2.didId, context: [channel(a0, b0)], records: [{ event: fromA0 }] },
        { fromDidId: a1.didId, toDidId: a2.didId, context: [channel(a1, b1)], records: [{ event: fromA1 }] },
      ],
      unresolved: [{ event: unplaced }],
    });
    expect(rotationIntent(vault, records)).toMatchObject({ status: "conflict", records, because: "3 rotations here are not one intent" });
    expect(rotationIntent(vault, records.slice(0, 2))).toMatchObject({ status: "conflict", because: "2 rotations here are not one intent" });
    expect(rotationIntent(vault, [records[0]!, records[2]!])).toMatchObject({ status: "conflict", because: "2 rotations here are not one intent" });
    expect(rotationIntent(vault, [records[2]!])).toMatchObject({ status: "pending", record: { event: unplaced }, because: `the rotation ${unplaced.cid} is pending: the predecessor entity has no consistent creation here` });
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: fromA0 } });
    expect(decisionFor(vault, a1.did, b1.did)).toMatchObject({ status: "candidate", candidate: { event: fromA1 } });
  });

  it("regroups as context evidence arrives: records toward the peer's two addresses are intents of their own until the peer's rotation between them verifies, then one, the records unchanged", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const source = proofFreeReceipt(scene, a0, b0);
    const towardOld = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const towardNew = await rotation(scene, keys, { from: a0, peer: b1, to: a1, fromPrior: await proof(keys, a0, a1, IAT + 1) }, { author: AUTHOR2 });
    let vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "candidate", candidate: { event: towardOld }, group: { context: [channel(a0, b0)], records: [{ event: towardOld }] } });
    expect(decisionFor(vault, a0.did, b1.did)).toMatchObject({ status: "candidate", candidate: { event: towardNew }, group: { context: [channel(a0, b1)], records: [{ event: towardNew }] } });
    expect(vault.continuity.conflicts).toEqual([]);

    await receiptCarryingProof(scene, peerKeys, a0, b0, b1);
    vault = await foldScene(scene, keys);
    const joined = { status: "candidate", candidate: { event: towardOld }, group: { fromDidId: a0.didId, toDidId: a1.didId, context: [channel(a0, b0), channel(a0, b1)], records: [{ event: towardOld }, { event: towardNew }] } };
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject(joined);
    expect(decisionFor(vault, a0.did, b1.did)).toMatchObject(joined);
    expect(vault.continuity.conflicts).toEqual([]);
    expect(vault.continuity.head(channel(a0, b0))).toEqual(channel(a1, b1));
  });
});
