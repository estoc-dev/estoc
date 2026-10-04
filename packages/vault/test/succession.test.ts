import { describe, expect, it } from "vitest";

import { channelOf, generationOf, recipeDidId, startDidId, successorDidId, successorRecipe, type Did, type DidGeneration, type DidId, type Keys } from "../src/index.js";
import { ENTRY, MEDIATED, type Scene, createdDid } from "./fold/helpers.js";
import { channel, foldScene, proofFreeReceipt, receiptCarryingProof, rotation, vaults, type Local } from "./fold/scene.js";

const start = (predecessor: Did, binding: Did): [DidId, DidGeneration] => [startDidId(predecessor, binding), { kind: "start", profile: "v1", predecessor, binding }];
const next = (predecessor: Did): [DidId, DidGeneration] => [successorDidId(predecessor), { kind: "next", profile: "v1", predecessor }];
const made = (scene: Scene, keys: Keys, [didId, generation]: [DidId, DidGeneration]): Promise<Local> => createdDid(scene, keys, didId, MEDIATED, generation);

describe("the successor's recipe", () => {
  it("derives the entity ID and the generation of a recipe under this version's profile", () => {
    const [startId, startGeneration] = start("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd" as Did, "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP" as Did);
    const [nextId, nextGeneration] = next("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd" as Did);
    const { profile: _, ...startRecipe } = startGeneration as Extract<DidGeneration, { kind: "start" }>;
    const { profile: __, ...nextRecipe } = nextGeneration as Extract<DidGeneration, { kind: "next" }>;
    expect([recipeDidId(startRecipe), generationOf(startRecipe)]).toEqual([startId, startGeneration]);
    expect([recipeDidId(nextRecipe), generationOf(nextRecipe)]).toEqual([nextId, nextGeneration]);
  });

  it("is a start of an entry bound to the peer's start, the pair's own peer or the address the usable replacements lead back to, and blocked where a fork leaves the start undecidable", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1, b2 } = await vaults();
    proofFreeReceipt(scene, a0, b0);
    const carried = await receiptCarryingProof(scene, peerKeys, a0, b0, b1);
    await receiptCarryingProof(scene, peerKeys, a1, b1, b2);
    await receiptCarryingProof(scene, peerKeys, a1, b1, b2);
    let fold = await foldScene(scene, keys);
    expect(successorRecipe(fold, channel(a0, b0))).toEqual({ status: "ready", recipe: { kind: "start", predecessor: a0.did, binding: b0.did }, support: [] });
    expect(successorRecipe(fold, channel(a0, b1))).toEqual({ status: "ready", recipe: { kind: "start", predecessor: a0.did, binding: b0.did }, support: [`receipt:${carried.cid}:transition`] });
    expect(successorRecipe(fold, channel(a1, b2))).toMatchObject({ status: "ready", recipe: { kind: "start", predecessor: a1.did, binding: b1.did } });
    expect(successorRecipe(fold, channel(a1, b0))).toEqual({ status: "ready", recipe: { kind: "start", predecessor: a1.did, binding: b0.did }, support: [] });
    expect(successorRecipe(fold, channel(b0, a0))).toEqual({ status: "blocked", because: `${b0.did} is no consistent DID of ours` });

    await receiptCarryingProof(scene, peerKeys, a1, b1, b0);
    fold = await foldScene(scene, keys);
    expect(fold.continuity.conflicted(channel(a1, b2))).toBe(true);
    expect(successorRecipe(fold, channel(a1, b2))).toMatchObject({ status: "blocked", because: /^the peer's start is not decidable: / });
    expect(successorRecipe(fold, channel(a0, b1))).toMatchObject({ status: "ready" });
  });

  it("is a next of a branch address once the usable history leads from the branch's anchor to the pair, waits while it does not, and is blocked by a conflict on the way", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2, b3 } = await vaults();
    const first: Local = await made(scene, keys, start(a0.did, b0.did));
    const second: Local = await made(scene, keys, next(first.did));
    proofFreeReceipt(scene, a0, b0);
    const decision = await rotation(scene, keys, { from: a0, peer: b0, to: first });
    proofFreeReceipt(scene, first, b0);
    const moved = await receiptCarryingProof(scene, peerKeys, first, b0, b1);
    proofFreeReceipt(scene, second, b2);
    let fold = await foldScene(scene, keys);
    expect(fold.continuity.status(decision.cid)).toEqual({ status: "verified" });
    const anchor = channel(a0, b0);
    const supportOf = (pair: ReturnType<typeof channel>): readonly string[] => {
      const path = fold.continuity.model.path(anchor, pair);
      if (path.status !== "path") throw new Error(`no path to ${pair.peerDid}: ${path.status}`);
      return path.support;
    };
    expect(supportOf(channel(first, b0))).toContain(`decision:${decision.cid}`);
    expect(successorRecipe(fold, channel(first, b0))).toEqual({ status: "ready", recipe: { kind: "next", predecessor: first.did }, support: supportOf(channel(first, b0)) });
    expect(supportOf(channel(first, b1))).toEqual(expect.arrayContaining([`decision:${decision.cid}`, `receipt:${moved.cid}:transition`]));
    expect(successorRecipe(fold, channel(first, b1))).toEqual({ status: "ready", recipe: { kind: "next", predecessor: first.did }, support: supportOf(channel(first, b1)) });
    expect(successorRecipe(fold, channel(second, b2))).toEqual({ status: "waiting", because: `no usable history leads from the branch's anchor, ${a0.did} toward ${b0.did}, to the pair` });
    expect(successorRecipe(fold, channel(second, b0))).toMatchObject({ status: "waiting" });

    const onward = await rotation(scene, keys, { from: first, peer: b1, to: second });
    proofFreeReceipt(scene, second, b1);
    fold = await foldScene(scene, keys);
    expect(fold.continuity.status(onward.cid)).toEqual({ status: "verified" });
    expect(supportOf(channel(second, b1))).toEqual(expect.arrayContaining([`decision:${decision.cid}`, `decision:${onward.cid}`, `receipt:${moved.cid}:transition`]));
    expect(successorRecipe(fold, channel(second, b1))).toEqual({ status: "ready", recipe: { kind: "next", predecessor: second.did }, support: supportOf(channel(second, b1)) });
    expect(successorRecipe(fold, channel(second, b2))).toMatchObject({ status: "waiting" });

    await receiptCarryingProof(scene, peerKeys, second, b1, b2);
    await receiptCarryingProof(scene, peerKeys, second, b1, b3);
    fold = await foldScene(scene, keys);
    expect(successorRecipe(fold, channel(second, b2))).toMatchObject({ status: "blocked", because: /^the history from the branch's anchor to the pair is in conflict at / });
  });

  it("waits while the generation of the address waits, and is blocked where it is invalid or under another profile", async () => {
    const { scene, keys, a0, b0, b3 } = await vaults();
    const [firstId] = start(a0.did, b0.did);
    const [, firstGeneration] = start(a0.did, b0.did);
    const elsewhere = await made(scene, keys, [firstId, { ...firstGeneration, profile: "v9" }]);
    const under: Local = await made(scene, keys, next(elsewhere.did));
    const nobody = b3.did;
    const [orphanId, orphanGeneration] = next(nobody);
    const orphan = await made(scene, keys, [orphanId, orphanGeneration]);
    for (const local of [elsewhere, under, orphan]) proofFreeReceipt(scene, local, b0);
    const fold = await foldScene(scene, keys);
    expect(successorRecipe(fold, channel(elsewhere, b0))).toEqual({ status: "blocked", because: `${elsewhere.did} was made under profile v9, which this version does not continue` });
    expect(successorRecipe(fold, channel(under, b0))).toEqual({ status: "blocked", because: `the generation of ${under.did} is invalid: its predecessor ${elsewhere.did} is under profile v9, not v1` });
    expect(successorRecipe(fold, channel(orphan, b0))).toEqual({ status: "waiting", because: `the generation of ${orphan.did} waits: the creation of its predecessor ${nobody} is not here` });
    expect(ENTRY).toEqual({ kind: "entry", profile: "v1" });
    expect(channelOf(a0.did, b0.did)).toEqual(channel(a0, b0));
  });
});
