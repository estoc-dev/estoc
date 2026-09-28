import { describe, expect, it } from "vitest";

import { BASIC_MESSAGE, PROFILE } from "@estoc/agent-core";

import { summaryOf } from "../src/summaries.js";

describe("a message's summary", () => {
  it("is a basic message's content, on one line", () => {
    expect(summaryOf(BASIC_MESSAGE, { content: "hello" })).toBe("hello");
    expect(summaryOf(BASIC_MESSAGE, { content: "one\r\ntwo\rthree\nfour five six" })).toBe("one two three four five six");
  });

  it("is the name a profile announces, and nothing for a profile that announces none", () => {
    expect(summaryOf(PROFILE, { profile: { displayName: "Bob" } })).toBe("name: Bob");
    expect(summaryOf(PROFILE, { profile: { displayName: "" } })).toBeNull();
    expect(summaryOf(PROFILE, { profile: {} })).toBeNull();
  });

  it("is nothing for a basic message whose content is no string, and for a type it has no line for", () => {
    expect(summaryOf(BASIC_MESSAGE, { content: 7 })).toBeNull();
    expect(summaryOf(BASIC_MESSAGE, {})).toBeNull();
    expect(summaryOf("https://didcomm.org/trust-ping/2.0/ping", { response_requested: true })).toBeNull();
  });
});
