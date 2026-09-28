import { describe, expect, it } from "vitest";

import { schemas } from "../../src/contract/index.js";
import { BASIC_MESSAGE, PROFILE, basicMessage, profileMessage } from "../../src/views/index.js";

describe("message content for a command", () => {
  it("preserves basic message text exactly, without adding a target, identity or time", () => {
    const text = "  <hello>\r\n雨 👋\u2028  ";
    expect(basicMessage(text)).toEqual({ type: BASIC_MESSAGE, body: { content: text } });
    expect(schemas.messageContent.parse(basicMessage(text))).toEqual(basicMessage(text));
    expect(basicMessage("").body).toEqual({ content: "" });
  });

  it("formats our name as profile content without reading peer claims", () => {
    expect(profileMessage("Ada 👋")).toEqual({ type: PROFILE, body: { profile: { displayName: "Ada 👋" } } });
    expect(schemas.messageContent.parse(profileMessage(""))).toEqual(profileMessage(""));
  });

  it("returns fresh content for each call", () => {
    const first = basicMessage("hello");
    first.body["content"] = "edited";
    expect(basicMessage("hello").body["content"]).toBe("hello");
    const profile = profileMessage("Ada");
    profile.body["profile"] = null;
    expect(profileMessage("Ada").body["profile"]).toEqual({ displayName: "Ada" });
  });
});
