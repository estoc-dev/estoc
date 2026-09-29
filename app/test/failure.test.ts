import type { CallError, ClientErrorCode } from "@estoc/daemon-api/contract";
import { describe, expect, it } from "vitest";

import { explained } from "../src/core/failure.js";

const fromDaemon = (effect: CallError["effect"] = "none"): CallError => ({ origin: "daemon", code: "SomethingRefused", message: "the vault is locked", effect, messageId: null });
const fromClient = (code: ClientErrorCode, effect: CallError["effect"]): CallError => ({ origin: "client", code, message: `sdk: ${code}`, effect, messageId: null });

describe("a call's failure, explained", () => {
  it("passes an ordinary error through and wraps anything else", () => {
    const error = new Error("plain");
    expect(explained(error)).toBe(error);
    expect(explained("text").message).toBe("text");
  });

  it("repeats the daemon's refusal, and adds that part may have gone through when it says so", () => {
    expect(explained(fromDaemon()).message).toBe("the vault is locked");
    expect(explained(fromDaemon("possible")).message).toBe("the vault is locked; part of it may have gone through");
  });

  it("says the outcome is unknown, and that nothing is sent again, when the reply was lost with the connection", () => {
    const message = explained(fromClient("TransportDisconnected", "possible")).message;
    expect(message).toContain("whether this was done is unknown");
    expect(message).toContain("Nothing is sent again");
  });

  it("says nothing was done when no daemon was connected, or the connection went before the call was sent", () => {
    expect(explained(fromClient("NotConnected", "none")).message).toBe("no daemon is connected; nothing was done");
    expect(explained(fromClient("TransportDisconnected", "none")).message).toBe("sdk: TransportDisconnected");
  });
});
