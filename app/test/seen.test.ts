import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../src/core/types.js";

const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
});

const ONE = "did:key:z6MkOne";
const OTHER = "did:key:z6MkOther";

const vaultOf = (anchor: string, channelIds: string[]): Snapshot => ({ anchor, channels: channelIds.map((channelId) => ({ channelId })) }) as unknown as Snapshot;

async function device() {
  vi.resetModules();
  return import("../src/core/seen.js");
}

describe("what this device remembers of exporting a backup", () => {
  beforeEach(() => stored.clear());
  afterEach(() => vi.resetModules());

  it("is kept by the identity exported, and shown to no other", async () => {
    const seen = await device();
    seen.markExported(ONE, "2026-09-29T00:00:00.000Z");
    expect(seen.exportedAt(ONE)).toBe("2026-09-29T00:00:00.000Z");
    expect(seen.exportedAt(OTHER)).toBeNull();
  });

  it("is there again for the same identity when the page comes up anew", async () => {
    (await device()).markExported(ONE, "2026-09-29T00:00:00.000Z");
    const again = await device();
    expect(again.exportedAt(ONE)).toBe("2026-09-29T00:00:00.000Z");
    expect(again.exportedAt(OTHER)).toBeNull();
  });

  it("does not give a date remembered for no identity in particular to whichever vault stands", async () => {
    stored.set("estoc.device", JSON.stringify({ seen: { "channel:kept": "2026-09-28T00:00:00.000Z" }, exportedAt: "2026-09-28T00:00:00.000Z" }));
    const seen = await device();
    expect(seen.exportedAt(ONE)).toBeNull();
    expect(seen.exportedAt(OTHER)).toBeNull();
  });

  it("goes with the identity forgotten, and no other's goes with it", async () => {
    const seen = await device();
    seen.markExported(ONE, "2026-09-29T00:00:00.000Z");
    seen.markExported(OTHER, "2026-09-29T01:00:00.000Z");
    seen.forgetRemembered(vaultOf(ONE, []));
    expect(seen.exportedAt(ONE)).toBeNull();
    expect(seen.exportedAt(OTHER)).toBe("2026-09-29T01:00:00.000Z");
  });
});

describe("what this device remembers of a conversation being open", () => {
  beforeEach(() => stored.clear());
  afterEach(() => vi.resetModules());

  it("is forgotten with the vault whose channels it showed, and kept for channels of another", async () => {
    const seen = await device();
    const mine = { channels: [{ channelId: "channel:mine" }] } as unknown as Parameters<typeof seen.markSeen>[0];
    const theirs = { channels: [{ channelId: "channel:theirs" }] } as unknown as Parameters<typeof seen.markSeen>[0];
    seen.markSeen(mine, "2026-09-29T00:00:00.000Z");
    seen.markSeen(theirs, "2026-09-29T00:00:00.000Z");
    seen.forgetRemembered(vaultOf(ONE, ["channel:mine"]));
    expect(seen.seenAt(mine)).toBeNull();
    expect(seen.seenAt(theirs)).toBe("2026-09-29T00:00:00.000Z");
  });
});
