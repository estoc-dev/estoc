import { describe, expect, it, vi } from "vitest";

import type { ConversationId, Hold, Snapshot } from "../src/core/types.js";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));
// navigation reads the browser's history and media queries, which a test has none of
vi.stubGlobal("window", { addEventListener: () => undefined });
vi.stubGlobal("history", { state: null, pushState: () => undefined, replaceState: () => undefined, back: () => undefined });
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));

const { nextTick } = await import("vue");
const { state } = await import("../src/core/store.js");
const { go, screen } = await import("../src/ui/nav.js");

const OLD = "channel:old" as ConversationId;
const HEAD = "channel:head" as ConversationId;

const showing = (anchor: string, conversations: Record<string, string[]>): Snapshot =>
  ({
    anchor,
    conversations: Object.entries(conversations).map(([id, channelIds]) => ({ id, channels: channelIds.map((channelId) => ({ channelId, selected: false })) })),
  }) as unknown as Snapshot;

async function open(hold: string, snapshot: Snapshot) {
  state.snapshot = snapshot;
  state.hold = hold as Hold;
  state.phase = "open";
  await nextTick();
}

describe("where the person is, across snapshots", () => {
  it("follows a conversation whose ID moved, by the channels it showed", async () => {
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    go({ kind: "chat", key: OLD });
    await nextTick();
    state.snapshot = showing("did:key:z6MkOne", { [HEAD]: ["head", "old"] });
    await nextTick();
    expect(screen.value).toEqual({ kind: "chat", key: HEAD });
  });

  it("leaves for the list when the vault locks", async () => {
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    go({ kind: "chat", key: OLD });
    await nextTick();
    state.snapshot = null;
    state.phase = "locked";
    await nextTick();
    expect(screen.value).toEqual({ kind: "list" });
  });

  it("leaves for the list when another vault stands in place of the one shown, even one that shows the same ID", async () => {
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    go({ kind: "you" });
    await nextTick();
    await open("hold-2", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    expect(screen.value).toEqual({ kind: "list" });
    go({ kind: "chat", key: OLD });
    await nextTick();
    await open("hold-3", showing("did:key:z6MkTwo", { [OLD]: ["old"] }));
    expect(screen.value).toEqual({ kind: "list" });
  });

  it("does not follow a trail left in the vault before", async () => {
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    go({ kind: "chat", key: OLD });
    await nextTick();
    await open("hold-2", showing("did:key:z6MkOne", { [HEAD]: ["head", "old"] }));
    expect(screen.value).toEqual({ kind: "list" });
  });
});
