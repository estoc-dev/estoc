import { describe, expect, it } from "vitest";

import { DAEMON_ERROR_CODES, OOB_INVITATION, OUTCOMES, PLAIN_TYP, schemas, type ContactId, type MethodName, type SendTarget } from "../../src/contract/index.js";
import { HEAD_CHANNEL, as, linesState, openState } from "./fixtures.js";

const { methods, METHOD_NAMES, isMethodName, COMMON_ERROR_CODES, sendTarget, invitation, DISPATCH_OUTCOMES, COMPLETION_OUTCOMES, CANCEL_OUTCOMES, SELECT_OUTCOMES } = schemas;

const ok = (name: MethodName, side: "input" | "result", value: unknown) => methods[name][side].safeParse(value).success;

describe("the method table", () => {
  it("names each public operation once, and nothing else is a method", () => {
    expect(METHOD_NAMES).toHaveLength(36);
    expect(new Set(METHOD_NAMES).size).toBe(METHOD_NAMES.length);
    expect(isMethodName("send")).toBe(true);
    expect(isMethodName("boot")).toBe(false);
    expect(isMethodName("close")).toBe(false);
    expect(isMethodName("pending")).toBe(false);
    expect(isMethodName("constructor")).toBe(false);
    expect(isMethodName("__proto__")).toBe(false);
  });

  it("gives every method an input schema, a result schema, known codes and byte slots", () => {
    for (const name of METHOD_NAMES) {
      const method = methods[name];
      expect(typeof method.input.safeParse).toBe("function");
      expect(typeof method.result.safeParse).toBe("function");
      for (const code of method.errors) {
        expect(DAEMON_ERROR_CODES).toContain(code);
        expect(COMMON_ERROR_CODES).not.toContain(code);
      }
      expect(new Set(method.errors).size).toBe(method.errors.length);
      expect(method.bytes.input.every((key) => typeof key === "string")).toBe(true);
    }
  });

  it("lets every method refuse a request over the daemon's bounds", () => {
    expect(COMMON_ERROR_CODES).toContain("ResourceLimit");
    for (const name of METHOD_NAMES) expect([...COMMON_ERROR_CODES, ...methods[name].errors]).toContain("ResourceLimit");
  });

  it.each(["attach", "refresh", "lock", "exportBackup", "explainedRestore", "publishSnapshotLink", "snapshotLinks", "publicDid", "reconnect", "traceLevel"] as const)("%s takes an empty input", (name) => {
    expect(ok(name, "input", {})).toBe(true);
    expect(ok(name, "input", null)).toBe(false);
    expect(ok(name, "input", [])).toBe(false);
  });

  it("returns the attachment baseline as one state and one lines value", () => {
    expect(ok("attach", "result", { state: openState, lines: linesState })).toBe(true);
    expect(ok("attach", "result", { state: openState })).toBe(false);
  });

  it("returns a revision marker from refresh, never a state value", () => {
    expect(ok("refresh", "result", { epoch: "epoch-1", revision: 4 })).toBe(true);
    expect("value" in methods.refresh.result.parse(openState)).toBe(false);
    expect(ok("refresh", "result", null)).toBe(false);
  });

  it("returns null from a method with nothing to say", () => {
    for (const name of ["createIdentity", "unlock", "lock", "forgetIdentity", "explainedRestore", "revokeSnapshotLink", "restoreFromLink", "renameContact", "setContactChannels", "deleteContact", "blockChannels", "eraseMessage", "reconnect"] as const) {
      expect(ok(name, "result", null)).toBe(true);
      expect(ok(name, "result", undefined)).toBe(false);
      expect(ok(name, "result", {})).toBe(false);
    }
  });
});

describe("byte slots", () => {
  it("are the three places a backup crosses", () => {
    const slots = METHOD_NAMES.flatMap((name) => [...methods[name].bytes.input.map((key) => `${name}.input.${key}`), ...methods[name].bytes.result.map((key) => `${name}.result.${key}`)]);
    expect(slots.sort()).toEqual(["exportBackup.result.bytes", "mergeBackup.input.backup", "restoreIdentity.input.backup"]);
  });

  it("take a byte array and nothing standing in for one", () => {
    const backup = new Uint8Array([1, 2, 3]);
    expect(ok("restoreIdentity", "input", { backup, passphrase: "pw" })).toBe(true);
    expect(ok("mergeBackup", "input", { backup })).toBe(true);
    expect(ok("exportBackup", "result", { name: "ada.estoc", bytes: backup })).toBe(true);
    for (const standIn of [{ encoding: "base64", data: "AQID" }, "AQID", [1, 2, 3], null]) {
      expect(ok("restoreIdentity", "input", { backup: standIn, passphrase: "pw" })).toBe(false);
      expect(ok("mergeBackup", "input", { backup: standIn })).toBe(false);
      expect(ok("exportBackup", "result", { name: "ada.estoc", bytes: standIn })).toBe(false);
    }
  });

  it("name members the schema requires", () => {
    expect(ok("restoreIdentity", "input", { passphrase: "pw" })).toBe(false);
    expect(ok("mergeBackup", "input", {})).toBe(false);
    expect(ok("exportBackup", "result", { name: "ada.estoc" })).toBe(false);
  });
});

describe("procedure outcomes", () => {
  it("together cover the whole vocabulary and no more", () => {
    expect(new Set([...DISPATCH_OUTCOMES, ...COMPLETION_OUTCOMES, ...CANCEL_OUTCOMES, ...SELECT_OUTCOMES])).toEqual(new Set(OUTCOMES));
  });

  it("restrict a send to what one transport call can come to", () => {
    for (const outcome of DISPATCH_OUTCOMES) expect(ok("send", "result", { outcome, because: null, messageId: "m-1", channelId: HEAD_CHANNEL })).toBe(true);
    for (const outcome of ["cancelled", "existing", "refused", "threw", "created"]) expect(ok("send", "result", { outcome, because: null, messageId: "m-1", channelId: HEAD_CHANNEL })).toBe(false);
    expect(ok("send", "result", { outcome: "submitted", because: null, messageId: "m-1" })).toBe(false);
  });

  it("restrict a retry the same way, and a cancel to cancelled or none", () => {
    for (const outcome of DISPATCH_OUTCOMES) expect(ok("retry", "result", { outcome, because: "why" })).toBe(true);
    expect(ok("retry", "result", { outcome: "cancelled", because: null })).toBe(false);
    for (const outcome of CANCEL_OUTCOMES) expect(ok("cancel", "result", { outcome, because: null })).toBe(true);
    for (const outcome of ["submitted", "pending", "failed"]) expect(ok("cancel", "result", { outcome, because: null })).toBe(false);
  });

  it("let a completion find an intent already there, refuse one or find the operation owes none", () => {
    for (const name of ["completeResponse", "completeNotification"] as const) {
      for (const outcome of COMPLETION_OUTCOMES) expect(ok(name, "result", { outcome, because: null })).toBe(true);
      expect(ok(name, "result", { outcome: "cancelled", because: null })).toBe(false);
    }
  });

  it("let a choice of preparation select it or take none, and name the preparation it is asked for", () => {
    for (const outcome of SELECT_OUTCOMES) expect(ok("selectPreparation", "result", { outcome, because: null })).toBe(true);
    for (const outcome of ["submitted", "pending", "cancelled"]) expect(ok("selectPreparation", "result", { outcome, because: null })).toBe(false);
    expect(ok("selectPreparation", "input", { messageId: "m-1", preparationEventCid: "bafyprep" })).toBe(true);
    expect(ok("selectPreparation", "input", { messageId: "m-1" })).toBe(false);
  });

  it("return the successor channel from a rotation with its notification's outcome", () => {
    expect(ok("rotate", "result", { outcome: "existing", because: null, channelId: HEAD_CHANNEL })).toBe(true);
    expect(ok("rotate", "result", { outcome: "submitted", because: null })).toBe(false);
    expect(ok("rotate", "result", { outcome: "cancelled", because: null, channelId: HEAD_CHANNEL })).toBe(false);
  });

  it("return the contact with the channel and the ping's outcome from reaching a stranger", () => {
    const reached = { outcome: "pending", because: "no mediator answers", messageId: "m-1", channelId: HEAD_CHANNEL, contactId: "c-1" };
    expect(ok("acceptInvitation", "result", reached)).toBe(true);
    expect(ok("addContactByDid", "result", reached)).toBe(true);
    expect(ok("acceptInvitation", "result", { ...reached, contactId: undefined })).toBe(false);
  });
});

describe("method inputs", () => {
  it("address a send to exactly one of a channel or a contact", () => {
    expect(sendTarget.safeParse({ channelId: HEAD_CHANNEL }).success).toBe(true);
    expect(sendTarget.safeParse({ contactId: "c-1" }).success).toBe(true);
    expect(sendTarget.safeParse({}).success).toBe(false);
    expect(sendTarget.safeParse({ channel: { localDid: "a", peerDid: "b" } }).success).toBe(false);
  });

  it("refuse a send naming both a channel and a contact rather than choosing one", () => {
    expect(sendTarget.safeParse({ channelId: HEAD_CHANNEL, contactId: "c-1" }).success).toBe(false);
    expect(sendTarget.safeParse({ channelId: HEAD_CHANNEL, contactId: 3 }).success).toBe(false);
    expect(sendTarget.safeParse({ channelId: 3, contactId: "c-1" }).success).toBe(false);
    expect(sendTarget.parse({ channelId: HEAD_CHANNEL, contactId: undefined })).toEqual({ channelId: HEAD_CHANNEL });
    const content = { type: "https://didcomm.org/basicmessage/2.0/message", body: { content: "hi" } };
    expect(ok("send", "input", { target: { channelId: HEAD_CHANNEL, contactId: "c-1" }, content })).toBe(false);
    // @ts-expect-error one target names one selector
    const both: SendTarget = { channelId: HEAD_CHANNEL, contactId: as<ContactId>("c-1") };
    expect(sendTarget.safeParse(both).success).toBe(false);
  });

  it("keep a __proto__ key of a send's body at every level as data", () => {
    const body = JSON.parse('{"__proto__":{"kept":"outer"},"nested":{"__proto__":{"kept":"inner"}},"constructor":"ordinary"}');
    const parsed = methods.send.input.parse({ target: { contactId: "c-1" }, content: { type: "https://example.test/custom", body } });
    expect(parsed.content.body).toEqual(body);
    expect(Object.hasOwn(parsed.content.body, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed.content.body.nested as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed.content.body)).toBe(Object.prototype);
  });

  it("take a send's content with its body kept whole", () => {
    const content = { type: "https://didcomm.org/basicmessage/2.0/message", body: { content: "hi", $tagged: { encoding: "base64", data: "AA==" } } };
    const parsed = methods.send.input.parse({ target: { contactId: "c-1" }, content });
    expect(parsed.content.body).toEqual(content.body);
    expect(ok("send", "input", { target: { contactId: "c-1" }, content: { type: "t" } })).toBe(false);
  });

  it("take an invitation only in its plaintext shape", () => {
    const plaintext = { type: OOB_INVITATION, id: "inv-1", typ: PLAIN_TYP, from: "did:peer:4zQmInviter", body: { goal_code: "connect", accept: ["didcomm/v2"] } };
    expect(invitation.parse(plaintext)).toEqual(plaintext);
    expect(invitation.safeParse({ ...plaintext, type: "https://didcomm.org/out-of-band/1.0/invitation" }).success).toBe(false);
    expect(invitation.safeParse("https://app.example/?_oob=...").success).toBe(false);
    expect(ok("acceptInvitation", "input", { invitation: plaintext, petname: "Ada" })).toBe(true);
  });

  it("let an invitation be created with or without a goal", () => {
    expect(ok("createInvitation", "input", {})).toBe(true);
    expect(ok("createInvitation", "input", { goal: "let's talk" })).toBe(true);
    expect(ok("createInvitation", "input", { goal: 1 })).toBe(false);
  });

  it("take channel selections and block targets as channel ID lists", () => {
    expect(ok("setContactChannels", "input", { contactId: "c-1", channelIds: [HEAD_CHANNEL] })).toBe(true);
    expect(ok("setContactChannels", "input", { contactId: "c-1", channelIds: [{ localDid: "a", peerDid: "b" }] })).toBe(false);
    expect(ok("blockChannels", "input", { channelIds: [HEAD_CHANNEL], includeSuccessors: false })).toBe(true);
    expect(ok("blockChannels", "input", { channelIds: [HEAD_CHANNEL] })).toBe(false);
  });

  it("spell a contact deletion's side effects out, null for none", () => {
    expect(ok("deleteContact", "input", { contactId: "c-1", block: null, erase: null })).toBe(true);
    expect(ok("deleteContact", "input", { contactId: "c-1", block: { includeSuccessors: true }, erase: "gone" })).toBe(true);
    expect(ok("deleteContact", "input", { contactId: "c-1" })).toBe(false);
  });

  it("select a rotation's predecessor by channel ID", () => {
    expect(ok("rotate", "input", { channelId: HEAD_CHANNEL })).toBe(true);
    expect(ok("rotate", "input", { localDidId: "did-1", peerDid: "did:peer:4zQmPeer" })).toBe(false);
  });

  it("take the trace level from a closed list", () => {
    expect(ok("setTraceLevel", "input", { level: "verbose" })).toBe(true);
    expect(ok("setTraceLevel", "input", { level: "debug" })).toBe(false);
    expect(ok("traceLevel", "result", { level: "off" })).toBe(true);
  });

  it("require the captured hold to forget an identity", () => {
    expect(ok("forgetIdentity", "input", { hold: "hold-1" })).toBe(true);
    expect(ok("forgetIdentity", "input", { hold: null })).toBe(false);
    expect(ok("forgetIdentity", "input", {})).toBe(false);
  });
});

describe("snapshot links", () => {
  const link = { url: "https://mediator.example/b/1", hash: "bciqexample", key: `${"A".repeat(42)}w` };
  const placedAt = "2026-10-10T12:00:00.000Z";
  const retainUntil = "2026-11-09T12:00:00.000Z";

  it("restore from the link with the passphrase: an HTTP URL, a name, and a key of 32 bytes", () => {
    expect(ok("restoreFromLink", "input", { link, passphrase: "pw" })).toBe(true);
    expect(ok("restoreFromLink", "input", { link })).toBe(false);
    for (const bad of [{ url: "ftp://mediator.example/b/1" }, { url: "/b/1" }, { hash: "" }, { key: "A".repeat(43) + "=" }, { key: "A".repeat(42) }, { key: "A".repeat(42) + "B" }, { key: "+".repeat(43) }]) {
      expect(ok("restoreFromLink", "input", { link: { ...link, ...bad }, passphrase: "pw" })).toBe(false);
    }
  });

  it("are listed pending with no link, answered or not, and published with the link, when the mediator lets it go and whether the daemon can still revoke it", () => {
    const records = [
      { status: "pending", hash: "b1", placedAt, retainUntil: null },
      { status: "pending", hash: "b2", placedAt, retainUntil },
      { status: "published", hash: link.hash, placedAt, retainUntil, revocable: true, link },
      { status: "published", hash: "b3", placedAt, retainUntil, revocable: false, link: { ...link, hash: "b3" } },
    ];
    expect(ok("snapshotLinks", "result", { links: records })).toBe(true);
    expect(ok("snapshotLinks", "result", { links: [{ status: "published", hash: link.hash, placedAt, retainUntil: null, revocable: true, link }] })).toBe(false);
    expect(ok("snapshotLinks", "result", { links: [{ status: "published", hash: link.hash, placedAt, retainUntil, link }] })).toBe(false);
    expect(ok("snapshotLinks", "result", { links: [{ status: "revoked", hash: link.hash, placedAt, retainUntil }] })).toBe(false);
    expect(ok("publishSnapshotLink", "result", records[2])).toBe(true);
    expect(ok("publishSnapshotLink", "result", records[1])).toBe(false);
    expect(ok("publishSnapshotLink", "result", { ...records[2], placedAt: "2026-10-10" })).toBe(false);
  });

  it("are revoked by hash alone", () => {
    expect(ok("revokeSnapshotLink", "input", { hash: link.hash })).toBe(true);
    expect(ok("revokeSnapshotLink", "input", { hash: "" })).toBe(false);
    expect(ok("revokeSnapshotLink", "input", { link })).toBe(false);
  });
});
