import { describe, expect, it } from "vitest";

import { isCallError } from "../../src/client/index.js";

describe("isCallError", () => {
  it("narrows a daemon error, whatever its code, and a client error with one of the SDK's codes", () => {
    expect(isCallError({ origin: "daemon", code: "SomethingNew", message: "", effect: "possible", messageId: "m-1" })).toBe(true);
    expect(isCallError({ origin: "daemon", code: "WrongPhase", message: "not now", effect: "none", messageId: null })).toBe(true);
    expect(isCallError({ origin: "client", code: "NotConnected", message: "", effect: "none", messageId: null })).toBe(true);
  });

  it("refuses what is no call error: another origin, a client code the SDK does not raise, a message ID on a client error, an Error", () => {
    expect(isCallError({ origin: "peer", code: "WrongPhase", message: "", effect: "none", messageId: null })).toBe(false);
    expect(isCallError({ origin: "client", code: "WrongPhase", message: "", effect: "none", messageId: null })).toBe(false);
    expect(isCallError({ origin: "client", code: "NotConnected", message: "", effect: "none", messageId: "m-1" })).toBe(false);
    expect(isCallError({ origin: "daemon", code: "", message: "", effect: "none", messageId: null })).toBe(false);
    expect(isCallError({ origin: "daemon", code: "WrongPhase", message: "", effect: "unknown", messageId: null })).toBe(false);
    expect(isCallError(new Error("WrongPhase"))).toBe(false);
    expect(isCallError(null)).toBe(false);
    expect(isCallError("NotConnected")).toBe(false);
  });
});
