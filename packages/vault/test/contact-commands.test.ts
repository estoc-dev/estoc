import { describe, expect, it } from "vitest";

import { blockChannels, blockDrafts, compareChannels, deleteContact, deleteContactDrafts, scanVault, type ContactId } from "../src/index.js";
import { vaultOf } from "./fold/helpers.js";
import { blocked, channel, foldScene, intent, preparationOf, receipt, resolved, vaults } from "./fold/scene.js";

const CONTACT = "019b7100-0000-7000-8000-000000000c01" as ContactId;



describe("denying channels and deleting a contact", () => {
  it("denies each pair once, to no lesser extent than it already is, and the tombstone takes the denials and erasures the product chose with it", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const root = resolved(scene, a0.didId, b0);
    const inbound = receipt(scene, { local: a0, peer: b0, resolution: root });
    const out = intent(scene, a0, b0);
    const pkg = preparationOf(scene, out, { sender: a0.didId, recipient: b0, resolution: root, envelope: "envelope" });
    const elsewhere = intent(scene, a1, b1);
    blocked(scene, a1, b1);
    scene.add("contact.created", { contactId: CONTACT, because: "user" });
    scene.add("contact.channelsSet", { contactId: CONTACT, channels: [channel(a0, b0), channel(a1, b1)].sort(compareChannels) });
    const vault = await foldScene(scene, keys);
    expect(blockDrafts(vault, [channel(a1, b1), channel(a0, b0), channel(a0, b0)], false).map((d) => d.data)).toEqual([{ localDid: a0.did, peerDid: b0.did, includeSuccessors: false }]);
    expect(blockDrafts(vault, [channel(a1, b1)], true).map((d) => d.data)).toEqual([{ localDid: a1.did, peerDid: b1.did, includeSuccessors: true }]);
    expect(deleteContactDrafts(vault, CONTACT).map((d) => d.data)).toEqual([{ contactId: CONTACT }]);
    expect(deleteContactDrafts(vault, "019b7100-0000-7000-8000-0000000000ff" as ContactId)).toEqual([]);
    const drafts = deleteContactDrafts(vault, CONTACT, { block: { includeSuccessors: true }, erase: "contact-deleted" });
    expect(drafts.map((d) => [d.type, d.data])).toEqual([
      ["contact.deleted", { contactId: CONTACT }],
      ...[channel(a0, b0), channel(a1, b1)].sort(compareChannels).map((c) => ["channel.blocked", { ...c, includeSuccessors: true }]),
      ...[
        ["message.erased", { messageId: inbound.data.messageId, dropCids: [inbound.data.bodyCid], because: "contact-deleted" }],
        ["message.erased", { messageId: out.data.messageId, dropCids: [out.data.bodyCid, pkg.data.envelopeCid].sort(), because: "contact-deleted" }],
        ["message.erased", { messageId: elsewhere.data.messageId, dropCids: [elsewhere.data.bodyCid], because: "contact-deleted" }],
      ].sort(([, a], [, b]) => ((a as { messageId: string }).messageId < (b as { messageId: string }).messageId ? -1 : 1)),
    ]);

    const memory = await vaultOf(scene, [`body ${out.data.messageId}`, "envelope"]);
    const events = await blockChannels(memory, keys, [channel(a0, b0)], false);
    expect(events.map((e) => e.data)).toEqual([{ localDid: a0.did, peerDid: b0.did, includeSuccessors: false }]);
    expect(await blockChannels(memory, keys, [channel(a0, b0)], false)).toEqual([]);
    const deleted = await deleteContact(memory, keys, CONTACT, { block: { includeSuccessors: true }, erase: "contact-deleted" });
    expect(deleted.events.map((e) => e.type)).toEqual(["contact.deleted", "channel.blocked", "channel.blocked", "message.erased", "message.erased", "message.erased"]);
    expect(deleted.collected.removed.sort()).toEqual([out.data.bodyCid, pkg.data.envelopeCid].sort());
    const after = await scanVault(memory.vault, keys);
    expect(after.contacts.contacts.get(CONTACT)!.deleted).toBe(true);
    expect(after.continuity.blocked(channel(a0, b0)).map((d) => d.data.includeSuccessors)).toEqual([false, true]);
    expect((await deleteContact(memory, keys, CONTACT, { block: { includeSuccessors: true }, erase: "contact-deleted" })).events).toEqual([]);
  });
});
