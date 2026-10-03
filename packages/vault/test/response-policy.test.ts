import { describe, expect, it } from "vitest";

import { responseChannel, unfinishedWork } from "../src/index.js";
import { blocked, channel, foldScene, proofFreeReceipt, receiptCarryingProof, rotation, vaults } from "./fold/scene.js";

describe("the channel a built-in reply goes to", () => {
  it("is the carrier channel while its local DID sends there, else the unique verified local successor keeping the peer, and none through denial, conflict or a peer that moved on", async () => {
    const { scene, keys, a0, a1, a2, b0 } = await vaults();
    const asking = proofFreeReceipt(scene, a0, b0, { pleaseAck: [""] });
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source: asking });
    let vault = await foldScene(scene, keys);
    const execution = () => vault.inbound.ofMessage(asking.data.messageId)!;
    expect(vault.continuity.status(decision.cid)).toEqual({ status: "verified" });
    expect(responseChannel(vault, execution())).toEqual({ status: "selected", channel: channel(a1, b0) });

    scene.add("did.retired", { didId: a0.didId, because: "rotated" });
    vault = await foldScene(scene, keys);
    expect(responseChannel(vault, execution())).toEqual({ status: "selected", channel: channel(a1, b0) });
    expect(unfinishedWork(vault).responses.map((r) => [r.execution.messageId, r.channel])).toEqual([[asking.data.messageId, channel(a1, b0)]]);

    const fork = await rotation(scene, keys, { from: a0, peer: b0, to: a2, source: asking });
    vault = await foldScene(scene, keys);
    expect(vault.continuity.status(fork.cid).status).toBe("conflict");
    expect(responseChannel(vault, execution())).toEqual({ status: "none", because: "the channel's continuity is in conflict" });

    const { scene: other, keys: otherKeys, peerKeys: otherPeerKeys, a0: c0, b0: d0, b1: d1 } = await vaults();
    const old = proofFreeReceipt(other, c0, d0, { pleaseAck: [""] });
    await receiptCarryingProof(other, otherPeerKeys, c0, d0, d1);
    vault = await foldScene(other, otherKeys);
    expect(responseChannel(vault, vault.inbound.ofMessage(old.data.messageId)!)).toEqual({ status: "none", because: "the peer has replaced its DID" });
    expect(unfinishedWork(vault).responses).toEqual([]);

    const { scene: third, keys: thirdKeys, a0: e0, a1: e1, b0: f0 } = await vaults();
    const asked = proofFreeReceipt(third, e0, f0, { pleaseAck: [""] });
    await rotation(third, thirdKeys, { from: e0, peer: f0, to: e1, source: asked });
    third.add("did.retired", { didId: e0.didId, because: "rotated" });
    blocked(third, e1, f0);
    vault = await foldScene(third, thirdKeys);
    expect(responseChannel(vault, vault.inbound.ofMessage(asked.data.messageId)!)).toEqual({ status: "none", because: "the local DID cannot send: retired: rotated, and its successor cannot reply: the channel is denied" });
    blocked(third, e0, f0);
    vault = await foldScene(third, thirdKeys);
    expect(responseChannel(vault, vault.inbound.ofMessage(asked.data.messageId)!)).toEqual({ status: "none", because: "the channel is denied" });
  });
});
