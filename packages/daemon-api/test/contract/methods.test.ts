import { describe, expect, it } from "vitest";

import { DAEMON_ERROR_CODES, OOB_INVITATION, OUTCOMES, PLAIN_TYP, schemas, type MethodName } from "../../src/contract/index.js";
import { HEAD_CHANNEL, linesState, openState } from "./fixtures.js";

const { methods, METHOD_NAMES, isMethodName, COMMON_ERROR_CODES, sendTarget, invitation, DISPATCH_OUTCOMES, COMPLETION_OUTCOMES, CANCEL_OUTCOMES } = schemas;

const ok = (name: MethodName, side: "input" | "result", value: unknown) => methods[name][side].safeParse(value).success;

describe("the method table", () => {
  it("names each public operation once, and nothing else is a method", () => {
    expect(METHOD_NAMES).toHaveLength(31);
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

  it.each(["attach", "refresh", "lock", "exportBackup", "explainedRestore", "publicDid", "reconnect", "traceLevel"] as const)("%s takes an empty input", (name) => {
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
    for (const name of ["createIdentity", "unlock", "lock", "forgetIdentity", "explainedRestore", "renameContact", "setContactChannels", "deleteContact", "blockChannels", "eraseMessage", "reconnect"] as const) {
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
    expect(new Set([...DISPATCH_OUTCOMES, ...COMPLETION_OUTCOMES, ...CANCEL_OUTCOMES])).toEqual(new Set(OUTCOMES));
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

  it("let a completion find an intent already there or refuse one", () => {
    for (const name of ["completeResponse", "completeNotification"] as const) {
      for (const outcome of COMPLETION_OUTCOMES) expect(ok(name, "result", { outcome, because: null })).toBe(true);
      expect(ok(name, "result", { outcome: "cancelled", because: null })).toBe(false);
    }
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
    expect(ok("createInvitation", "input", { uses: "one" })).toBe(true);
    expect(ok("createInvitation", "input", { uses: "many", goal: "let's talk" })).toBe(true);
    expect(ok("createInvitation", "input", { uses: "some" })).toBe(false);
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
