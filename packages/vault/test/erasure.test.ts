import type { MemoryVault } from "@estoc/event-store";
import { describe, expect, it, test } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { closeErasures, eraseMessage, erasureClosure, scanVault, type Cid, type MessageId } from "../src/index.js";
import { cidOf, vaultOf } from "./fold/helpers.js";
import { intent, preparationOf, receipt, resolved, vaults } from "./fold/scene.js";

const encoder = new TextEncoder();

const has = (vault: MemoryVault, cid: Cid) => vault.vault.objects.has(cid);

describe("erasing a message", () => {
  it("releases every root the message's events and preparations still name in one erase, collects what nothing else holds, and erases nothing twice", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const attachment = cidOf("attachment");
    const out = intent(scene, a0, b0, { attachmentCids: [attachment] });
    const pkg = preparationOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, envelope: "envelope" });
    const other = intent(scene, a0, b0, { bodyCid: out.data.bodyCid });
    const vault = await vaultOf(scene, [`body ${out.data.messageId}`, "attachment", "envelope"]);
    expect(await has(vault, attachment)).toBe(true);

    const { events, collected } = await eraseMessage(vault, keys, out.data.messageId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ messageId: out.data.messageId, dropCids: [attachment, out.data.bodyCid, pkg.data.envelopeCid].sort(), because: "user" });
    expect(events[0]!.roots).toEqual([]);
    expect(collected.removed.sort()).toEqual([attachment, pkg.data.envelopeCid].sort());
    expect(await has(vault, out.data.bodyCid)).toBe(true);
    expect(await has(vault, attachment)).toBe(false);
    const fold = await scanVault(vault.vault, keys);
    expect(fold.held.has(out.data.bodyCid)).toBe(true);
    expect(fold.retained.filter((edge) => edge.cid === other.cid)).toEqual([{ cid: other.cid, root: out.data.bodyCid }]);

    const again = await eraseMessage(vault, keys, out.data.messageId);
    expect(again.events).toEqual([]);
    expect(again.collected.removed).toEqual([]);
    expect((await eraseMessage(vault, keys, uuidv7() as MessageId)).events).toEqual([]);
  });

  test("the closure erases what an event learned later names under the same message, with the first erasure's reason", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const first = receipt(scene, { local: a0, peer: b0, resolution: root });
    const before = scene.events.length;
    const attachment = cidOf("late attachment");
    const duplicate = receipt(scene, { local: a0, peer: b0, resolution: root, wire: first.data.wireMessageId, overrides: { attachmentCids: [attachment] } });
    expect(duplicate.data.messageId).toBe(first.data.messageId);
    const late = scene.events.splice(before);
    const vault = await vaultOf(scene, [`body ${first.data.wireMessageId}`]);

    const erased = await eraseMessage(vault, keys, first.data.messageId, "contact-deleted");
    expect(erased.events.map((event) => event.data)).toEqual([{ messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "contact-deleted" }]);
    expect(erased.collected.removed).toEqual([first.data.bodyCid]);
    scene.add("message.erased", { messageId: first.data.messageId, dropCids: [first.data.bodyCid], because: "user" });

    await vault.stores.objects.putObject(attachment, encoder.encode("late attachment"));
    await vault.ingest(late);
    let fold = await scanVault(vault.vault, keys);
    expect(fold.held.has(attachment)).toBe(true);
    const owed = erasureClosure(fold);
    expect(owed.map((draft) => draft.data)).toEqual([{ messageId: first.data.messageId, dropCids: [attachment], because: "contact-deleted" }]);
    const closed = await closeErasures(vault, keys);
    expect(closed.events.map((event) => event.data)).toEqual(owed.map((draft) => draft.data));
    expect(closed.collected.removed).toEqual([attachment]);
    fold = await scanVault(vault.vault, keys);
    expect(erasureClosure(fold)).toEqual([]);
    expect((await closeErasures(vault, keys)).events).toEqual([]);
  });
});
