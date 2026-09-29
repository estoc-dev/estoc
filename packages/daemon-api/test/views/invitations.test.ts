import { describe, expect, it } from "vitest";

import { GOAL_CONNECT, OOB_INVITATION, PLAIN_TYP, schemas } from "../../src/contract/index.js";
import { invitationOf, invitationUrl, parseInvitation } from "../../src/views/index.js";

const invitation = invitationOf("did:peer:4zQmExample:zLong", "oob-1", "Say hi ☕");

describe("an invitation", () => {
  it("is issued as the daemon issues one, and passes the contract's schema", () => {
    expect(invitation).toEqual({ type: OOB_INVITATION, id: "oob-1", typ: PLAIN_TYP, from: "did:peer:4zQmExample:zLong", body: { goal_code: GOAL_CONNECT, goal: "Say hi ☕", accept: ["didcomm/v2"] } });
    expect(schemas.invitation.parse(invitation)).toEqual(invitation);
    expect(invitationOf("did:peer:4zQmExample:zLong", "oob-2", null).body).toEqual({ goal_code: GOAL_CONNECT, accept: ["didcomm/v2"] });
  });

  it("rides a link as base64url in `_oob`, and is read back from the link, the parameter alone, or the plaintext", () => {
    const link = invitationUrl("https://estoc.example/app/?x=1", invitation);
    const url = new URL(link);
    const param = url.searchParams.get("_oob")!;
    expect(url.origin + url.pathname).toBe("https://estoc.example/app/");
    expect(url.searchParams.get("x")).toBe("1");
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseInvitation(link)).toEqual(invitation);
    expect(parseInvitation(`  ${param}\n`)).toEqual(invitation);
    expect(parseInvitation(JSON.stringify(invitation))).toEqual(invitation);
  });

  it("supplies the plaintext's defaults, and keeps only the body fields it knows, as they are", () => {
    const read = parseInvitation(JSON.stringify({ type: OOB_INVITATION, id: "oob-3", from: "did:peer:4zQmOther", body: { goal_code: "request-mediate", extra: true, accept: ["didcomm/v2", 7] } }));
    expect(read).toEqual({ type: OOB_INVITATION, id: "oob-3", typ: PLAIN_TYP, from: "did:peer:4zQmOther", body: { goal_code: "request-mediate" } });
    expect(parseInvitation(JSON.stringify({ type: OOB_INVITATION, id: "oob-4", from: "did:peer:4zQmOther" })).body).toEqual({});
  });

  it("refuses what is no invitation, with the reason", () => {
    expect(() => parseInvitation("  ")).toThrow("nothing to read");
    expect(() => parseInvitation("did:peer:4zQmSomeone")).toThrow("a DID, not an invitation");
    expect(() => parseInvitation("https://ordinary.invalid/menu")).toThrow("carries no _oob");
    expect(() => parseInvitation("https://ordinary.invalid/?_oob=not*base64url")).toThrow("does not decode");
    expect(() => parseInvitation("https://ordinary.invalid/?_oob=_w")).toThrow("does not decode");
    expect(() => parseInvitation("bm90IGpzb24")).toThrow("not decode to a JSON message");
    expect(() => parseInvitation(JSON.stringify({ type: "https://didcomm.org/basicmessage/2.0/message", id: "m", from: "did:peer:4zQm" }))).toThrow("not an out-of-band");
    expect(() => parseInvitation(JSON.stringify({ type: OOB_INVITATION, id: "oob", from: "nobody" }))).toThrow("names no DID");
    expect(() => parseInvitation(JSON.stringify({ type: OOB_INVITATION, id: "", from: "did:peer:4zQm" }))).toThrow("has no id");
    expect(() => parseInvitation("[1]")).toThrow("does not decode");
  });
});
