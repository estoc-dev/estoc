import type { MemoryVault } from "@estoc/event-store";
import { describe, expect, it } from "vitest";

import { collectGarbage, rawCidOfBytes, vaultHeldRoots, type Cid } from "../src/index.js";
import { vaultOf } from "./fold/helpers.js";
import { intent, preparationOf, resolved, vaults } from "./fold/scene.js";

const encoder = new TextEncoder();

const has = (vault: MemoryVault, cid: Cid) => vault.vault.objects.has(cid);

describe("the retention handed to the event store", () => {
  it("is the same for collection, export and validation", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const out = intent(scene, a0, b0);
    const pkg = preparationOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, envelope: "envelope" });
    scene.add("message.erased", { messageId: out.data.messageId, dropCids: [pkg.data.envelopeCid], because: "user" });
    const stray = rawCidOfBytes(encoder.encode("stray"));
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, "envelope", "stray"]);
    expect(new Set(await vaultHeldRoots(keys)(vault.vault))).toEqual(new Set([root.data.documentCid, out.data.bodyCid]));
    const collected = await collectGarbage(vault, keys);
    expect(collected.removed.sort()).toEqual([pkg.data.envelopeCid, stray].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
  });
});
