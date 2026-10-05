import { indexSnapshot } from "@estoc/daemon-api/views";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { ConversationId, Hold, Invitation, Snapshot } from "../src/core/types.js";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));
// navigation reads the browser's history and media queries, which a test has none of
vi.stubGlobal("window", { addEventListener: () => undefined });
const pushState = vi.fn();
vi.stubGlobal("history", { state: null, pushState, replaceState: () => undefined, back: () => undefined });
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined }));

const { nextTick } = await import("vue");
const { state } = await import("../src/core/store.js");
const { go, screen } = await import("../src/ui/nav.js");

const OLD = "channel:old" as ConversationId;
const HEAD = "channel:head" as ConversationId;

const showing = (anchor: string, conversations: Record<string, string[]>): Snapshot =>
  ({
    anchor,
    channels: [...new Set(Object.values(conversations).flat())].map((channelId) => ({ channelId })),
    messages: [],
    observations: [],
    contacts: [],
    conversations: Object.entries(conversations).map(([id, channelIds]) => ({
      id,
      channels: channelIds.map((channelId) => ({ channelId, selected: false })),
      messageIds: [],
      unadmittedObservationIds: [],
    })),
  }) as unknown as Snapshot;

async function open(hold: string, snapshot: Snapshot) {
  state.vault = { phase: "open", hold: hold as Hold, index: indexSnapshot(snapshot) };
  await nextTick();
}

describe("where the person is, across snapshots", () => {
  it("follows a conversation whose ID moved, by the channels it showed", async () => {
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    go({ kind: "chat", key: OLD });
    await nextTick();
    await open("hold-1", showing("did:key:z6MkOne", { [HEAD]: ["head", "old"] }));
    expect(screen.value).toEqual({ kind: "chat", key: HEAD });
  });

  it("leaves for the list when the vault locks", async () => {
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    go({ kind: "chat", key: OLD });
    await nextTick();
    state.vault = { phase: "locked", hold: "hold-1" as Hold, detail: null };
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

describe("an invitation this page was opened with", () => {
  const locked = async () => {
    state.vault = { phase: "locked", hold: "hold-1" as Hold, detail: null };
    await nextTick();
  };
  const offered = async (id: string) => {
    state.pendingInvitation = { id } as Invitation;
    await nextTick();
  };

  afterAll(() => {
    state.pendingInvitation = null;
  });

  it("is offered once the vault opens", async () => {
    await locked();
    await offered("invitation-1");
    expect(screen.value).toEqual({ kind: "list" });
    await open("hold-1", showing("did:key:z6MkOne", {}));
    expect(screen.value).toEqual({ kind: "new" });
  });

  it("is not offered again by a newer snapshot of the same vault after the person has left it", async () => {
    go({ kind: "you" });
    await nextTick();
    pushState.mockClear();
    await open("hold-1", showing("did:key:z6MkOne", { [OLD]: ["old"] }));
    expect(screen.value).toEqual({ kind: "you" });
    expect(pushState).not.toHaveBeenCalled();
  });

  it("is offered again when the vault opens anew", async () => {
    await locked();
    await open("hold-1", showing("did:key:z6MkOne", {}));
    expect(screen.value).toEqual({ kind: "new" });
  });

  it("is offered when another arrives while the vault is open", async () => {
    go({ kind: "you" });
    await nextTick();
    await offered("invitation-2");
    expect(screen.value).toEqual({ kind: "new" });
  });
});
