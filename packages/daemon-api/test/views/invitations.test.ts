import { describe, expect, it } from "vitest";

import { schemas, type Invitation } from "../../src/contract/index.js";
import { GOAL_CONNECT, OOB_INVITATION, PLAIN_TYP, invitationOf, invitationUrl, parseInvitation } from "../../src/views/index.js";

const invitation: Invitation = { type: OOB_INVITATION, id: "oob-1", typ: PLAIN_TYP, from: "did:peer:4zQmExample", body: { goal_code: GOAL_CONNECT, goal: "Say hi 👋 雨", accept: ["didcomm/v2"] } };
// A fixed UTF-8/base64url vector, independent of the helper's encoder.
const encoded = "eyJ0eXBlIjoiaHR0cHM6Ly9kaWRjb21tLm9yZy9vdXQtb2YtYmFuZC8yLjAvaW52aXRhdGlvbiIsImlkIjoib29iLTEiLCJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLXBsYWluK2pzb24iLCJmcm9tIjoiZGlkOnBlZXI6NHpRbUV4YW1wbGUiLCJib2R5Ijp7ImdvYWxfY29kZSI6ImNvbm5lY3QiLCJnb2FsIjoiU2F5IGhpIPCfkYsg6ZuoIiwiYWNjZXB0IjpbImRpZGNvbW0vdjIiXX19";

describe("invitation presentation", () => {
  it("formats an already disclosed DID and ID using the API's invitation shape", () => {
    expect(invitationOf(invitation.from, invitation.id, invitation.body.goal)).toEqual(invitation);
    expect(invitationOf(invitation.from, invitation.id).body).toEqual({ goal_code: GOAL_CONNECT, accept: ["didcomm/v2"] });
    expect(schemas.invitation.parse(invitationOf(invitation.from, invitation.id))).toEqual(invitationOf(invitation.from, invitation.id));
  });

  it("reads the same Unicode invitation from JSON, base64url and a URL, without consulting the host", () => {
    for (const input of [JSON.stringify(invitation), encoded, `https://unrelated.invalid/?_oob=${encoded}`, `estoc:open?_oob=${encoded}`]) {
      expect(parseInvitation(` \n${input}\t `)).toEqual(invitation);
    }
  });

  it("replaces _oob while keeping the other query parameters and fragment", () => {
    expect(invitationUrl("https://example.invalid/i?lang=en&_oob=old#scan", invitation)).toBe(`https://example.invalid/i?lang=en&_oob=${encoded}#scan`);
    expect(invitation.body.goal).toBe("Say hi 👋 雨");
  });

  it("round-trips all padding lengths and the URL-safe alphabet", () => {
    for (const goal of ["", "a", "ab", "😀𐀀\uFFFF"]) {
      const value = invitationOf(invitation.from, invitation.id, goal);
      const link = invitationUrl("https://example.invalid/", value);
      const bare = link.split("_oob=")[1]!;
      expect(bare).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parseInvitation(bare)).toEqual(value);
      expect(parseInvitation(bare.padEnd(Math.ceil(bare.length / 4) * 4, "="))).toEqual(value);
      expect(parseInvitation(link)).toEqual(value);
    }
  });

  it("supplies only omitted plaintext defaults and ignores unknown optional fields", () => {
    expect(parseInvitation(JSON.stringify({ type: OOB_INVITATION, id: "i", from: invitation.from, extra: 1 }))).toEqual({ type: OOB_INVITATION, id: "i", typ: PLAIN_TYP, from: invitation.from, body: {} });
    expect(parseInvitation(JSON.stringify({ ...invitation, extra: "ignored", body: { ...invitation.body, extra: 1 } }))).toEqual(invitation);
  });

  it("refuses invalid UTF-8 inside otherwise valid JSON instead of replacing the damaged text", () => {
    const json = JSON.stringify({ ...invitation, body: { goal: "\xff" } });
    const damaged = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => parseInvitation(damaged)).toThrow();
  });

  it.each(["", "did:peer:4zQmExample", "https://example.invalid/", "https://example.invalid/?_oob=", "hello", "A", "AA=", "AA===", "AB", "AAB", "_w", "e30$", "e3 0", "e30\n=", "e30+", "e30/", "bnVsbA", "W10", "{"])("refuses malformed pasted input %j", (input) => {
    expect(() => parseInvitation(input)).toThrow();
  });

  it.each([
    { type: "https://didcomm.org/basicmessage/2.0/message" },
    { id: "" },
    { from: "https://example.invalid" },
    { from: "did:" },
    { typ: "application/didcomm-encrypted+json" },
    { typ: null },
    { body: null },
    { body: [] },
    { body: { goal_code: 1 } },
    { body: { goal: [] } },
    { body: { accept: ["didcomm/v2", 1] } },
    { body: { accept: "didcomm/v2" } },
  ])("refuses malformed present fields %j", (fields) => {
    expect(() => parseInvitation(JSON.stringify({ ...invitation, ...fields }))).toThrow();
  });

  it("checks invitations it formats as well as those it reads", () => {
    expect(() => invitationOf("not-a-did", "id")).toThrow();
    expect(() => invitationOf(invitation.from, "")).toThrow();
    expect(() => invitationUrl("https://example.invalid/", { ...invitation, id: "" })).toThrow();
    expect(() => invitationUrl("relative", invitation)).toThrow();
  });
});
