import { describe, expect, it } from "vitest";

import { decisionFor } from "../src/index.js";
import { foldScene, proofFreeReceipt, rotation, vaults } from "./fold/scene.js";

describe("the decision a rotation reuses", () => {
  it("is the one recorded from the local DID in its verified peer-only context: none, one to reuse, one to wait for, or several in conflict", async () => {
    const { scene, keys, a0, a1, a2, b0, b1 } = await vaults();
    let vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toEqual({ status: "none" });

    const source = proofFreeReceipt(scene, a0, b0);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: a1, source });
    const elsewhere = await rotation(scene, keys, { from: a0, peer: b1, to: a2 });
    vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toEqual({ status: "reuse", decision: vault.channels.decisions.get(decision.cid) });
    expect(decisionFor(vault, a0.did, b1.did)).toEqual({ status: "reuse", decision: vault.channels.decisions.get(elsewhere.cid) });
    expect(decisionFor(vault, a1.did, b0.did)).toEqual({ status: "none" });

    vault = await foldScene(scene, null);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "defer", decision: { event: decision } });

    const fork = await rotation(scene, keys, { from: a0, peer: b0, to: a2, source });
    vault = await foldScene(scene, keys);
    expect(decisionFor(vault, a0.did, b0.did)).toMatchObject({ status: "conflict", decisions: [{ event: decision }, { event: fork }] });
  });
});
