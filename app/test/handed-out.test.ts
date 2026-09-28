import { describe, expect, it, vi } from "vitest";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));

import { handedOutDid } from "../src/core/store.js";
import type { Did, DidId, Snapshot } from "../src/core/types.js";

const did = (n: number, over: Partial<Snapshot["dids"][number]> & Record<string, unknown> = {}) => ({
  didId: `019b0000-0000-7000-8000-0000000000d${n}` as DidId,
  did: `did:peer:4zD${n}` as Did,
  longFormDid: `did:peer:4zD${n}:zLong${n}` as Did,
  live: true,
  retired: null,
  disclosures: [],
  faults: [],
  ...over,
});

const snapshot = (dids: unknown[]) => ({ dids }) as unknown as Snapshot;

describe("the DID handed out, read from a snapshot", () => {
  it("is the live one disclosed directly for many uses, in its long form", () => {
    expect(handedOutDid(snapshot([did(1), did(2, { disclosures: [{ as: "oob", uses: "one" }] }), did(3, { disclosures: [{ as: "direct", uses: "many" }] })]))).toEqual({ did: "did:peer:4zD3:zLong3", known: true });
  });

  it("is null before one is minted, and null with no snapshot at all", () => {
    expect(handedOutDid(snapshot([did(1)]))).toEqual({ did: null, known: true });
    expect(handedOutDid(snapshot([]))).toEqual({ did: null, known: true });
    expect(handedOutDid(null)).toEqual({ did: null, known: true });
  });

  it("passes over one retired, however it was disclosed", () => {
    expect(handedOutDid(snapshot([did(1, { live: false, retired: "rotated", disclosures: [{ as: "direct", uses: "many" }] })]))).toEqual({ did: null, known: true });
  });

  it("is unknown when a daemon from before reports `disclosed` in place of disclosures, rather than failing", () => {
    const { disclosures: _dropped, longFormDid: _none, ...older } = did(1);
    expect(handedOutDid(snapshot([{ ...older, disclosed: true }]))).toEqual({ did: null, known: false });
  });
});
