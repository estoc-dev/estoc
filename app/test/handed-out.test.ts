import { describe, expect, it, vi } from "vitest";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));

import { handedOutDid } from "../src/core/store.js";
import type { Snapshot } from "../src/core/types.js";

type LocalDid = Snapshot["dids"][number];

const did = (n: number, over: Partial<LocalDid> = {}): LocalDid => ({
  didId: `019b0000-0000-7000-8000-0000000000d${n}` as LocalDid["didId"],
  did: `did:peer:4zD${n}`,
  longFormDid: `did:peer:4zD${n}:zLong${n}`,
  live: true,
  retired: null,
  disclosures: [],
  diagnostics: [],
  ...over,
});

const snapshot = (dids: LocalDid[]) => ({ dids }) as Snapshot;

describe("the DID handed out, read from a snapshot", () => {
  it("is the live one disclosed directly for many uses, in its long form", () => {
    expect(handedOutDid(snapshot([did(1), did(2, { disclosures: [{ as: "oob", uses: "one" }] }), did(3, { disclosures: [{ as: "direct", uses: "many" }] })]))).toBe("did:peer:4zD3:zLong3");
  });

  it("is null before one is minted, and null with no snapshot at all", () => {
    expect(handedOutDid(snapshot([did(1)]))).toBeNull();
    expect(handedOutDid(snapshot([]))).toBeNull();
    expect(handedOutDid(null)).toBeNull();
  });

  it("passes over one retired, however it was disclosed", () => {
    expect(handedOutDid(snapshot([did(1, { live: false, retired: "rotated", disclosures: [{ as: "direct", uses: "many" }] })]))).toBeNull();
  });
});
