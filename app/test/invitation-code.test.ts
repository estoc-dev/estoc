import { invitationOf, invitationUrl, type Invitation } from "@estoc/agent-core";
import { type Did } from "@estoc/vault";
import { describe, expect, it } from "vitest";

import { invitationIn } from "../src/ui/invitation-code.js";
import { startScan } from "../src/ui/scanner.js";

const invitation = invitationOf("did:peer:4zQmExample" as Did, "oob-1", "Say hi");

describe("a scanned code", () => {
  it("carries the invitation its link holds", () => {
    expect(invitationIn(invitationUrl("https://estoc.net/i", invitation))).toEqual(invitation);
  });

  it("carries nothing when it is text, another link, or a broken invitation", () => {
    expect(invitationIn("hello from a QR code")).toBeNull();
    expect(invitationIn("https://ordinary.invalid/menu")).toBeNull();
    expect(invitationIn("https://ordinary.invalid/?_oob=not-an-invitation")).toBeNull();
  });
});

describe("a scan for an invitation", () => {
  it("reads past text and a broken invitation to the invitation that follows, and stops the camera", async () => {
    const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
    const reads = [["hello from a QR code"], ["https://ordinary.invalid/?_oob=not-an-invitation"], [invitationUrl("https://estoc.net/i", invitation)]];
    let found: Invitation | null = null;
    startScan({
      openCamera: () => Promise.resolve({ getTracks: () => tracks } as unknown as MediaStream),
      video: { srcObject: null, play: () => Promise.resolve() },
      detector: { detect: () => Promise.resolve((reads.shift() ?? []).map((rawValue) => ({ rawValue }))) },
      onCode: (rawValue) => {
        found = invitationIn(rawValue);
        return found !== null;
      },
      onFailure: () => {},
      intervalMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(found).toEqual(invitation);
    expect(reads).toEqual([]);
    expect(tracks[0]!.stopped).toBe(true);
  });
});
