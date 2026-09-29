import { describe, expect, it, vi } from "vitest";

import type { StateValue } from "@estoc/daemon-api/contract";

import type { Hold, Snapshot } from "../src/core/types.js";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));
// the store is brought up on a daemon of this test's: it publishes what the test says, and answers a call when the test does
const fake = vi.hoisted(() => {
  const waiting = new Map<string, ((value: unknown) => void)[]>();
  let publish: (state: { epoch: string; value: StateValue }) => void = () => undefined;
  const daemon = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        () =>
          new Promise((resolve) => waiting.set(method, [...(waiting.get(method) ?? []), resolve])),
    }
  );
  return {
    daemon,
    publishState: (epoch: string, value: StateValue) => publish({ epoch, value }),
    pendingCount: (method: string) => waiting.get(method)?.length ?? 0,
    answerOldest: (method: string, value: unknown) => {
      const [first, ...rest] = waiting.get(method) ?? [];
      if (first === undefined) throw new Error(`no ${method} was asked`);
      waiting.set(method, rest);
      first(value);
    },
    client: {
      onState: (listener: typeof publish) => {
        publish = listener;
        return () => undefined;
      },
      onConnection: () => () => undefined,
      onLines: () => () => undefined,
      onLog: () => () => undefined,
      refresh: () => Promise.resolve(),
    },
  };
});
vi.mock("../src/daemon/client.js", () => ({ daemonSocket: () => null, startDaemon: () => ({ ...fake.client, daemon: fake.daemon }) }));
// Vue's DOM runtime looks at the document once as it loads, and the store listens on it: loaded first, listened on after
await import("vue");
vi.stubGlobal("window", { addEventListener: () => undefined });
vi.stubGlobal("document", { addEventListener: () => undefined });
vi.stubGlobal("location", { search: "", pathname: "/", hash: "", href: "http://app.test/" });
vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve({}) } });

const { addContactByDid, boot, heldNow, setTraceLevel, state } = await import("../src/core/store.js");
await boot();

const NONE: StateValue = { phase: "onboarding", hold: null, detail: null };
const locked = (hold: string): StateValue => ({ phase: "locked", hold: hold as Hold, detail: null });
const open = (hold: string): StateValue => ({
  phase: "open",
  hold: hold as Hold,
  snapshot: { anchor: `did:key:${hold}`, label: hold, dids: [], channels: [], contacts: [], conversations: [], messages: [], observations: [], invitations: [] } as unknown as Snapshot,
});
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("work begun in what stood", () => {
  it("does not go on once a vault stood and went where none had", () => {
    fake.publishState("e1", NONE);
    const held = heldNow();
    fake.publishState("e1", NONE);
    expect(held()).toBe(true);
    fake.publishState("e2", locked("first"));
    expect(held()).toBe(false);
    fake.publishState("e3", NONE);
    expect(held()).toBe(false);
  });

  it("goes on while its vault stands, across a reconnection", () => {
    fake.publishState("e4", locked("second"));
    const held = heldNow();
    fake.publishState("e5", locked("second"));
    expect(held()).toBe(true);
  });

  it("does not show the level it set for the vault that replaced its own", async () => {
    fake.publishState("e6", open("third"));
    fake.answerOldest("traceLevel", { level: "normal" });
    await settled();
    const setting = setTraceLevel("verbose");
    fake.publishState("e7", NONE);
    fake.publishState("e8", open("fourth"));
    fake.answerOldest("traceLevel", { level: "normal" });
    fake.answerOldest("setTraceLevel", { level: "verbose" });
    await setting;
    expect(state.traceLevel).toBe("normal");
  });

  it("does not show the level read of a vault that was replaced before it answered", async () => {
    fake.publishState("e9", open("fifth"));
    fake.publishState("e10", NONE);
    fake.publishState("e11", open("sixth"));
    fake.answerOldest("traceLevel", { level: "verbose" });
    await settled();
    expect(state.traceLevel).toBe("normal");
    fake.answerOldest("traceLevel", { level: "normal" });
    await settled();
  });

  it("neither introduces the contact it made nor names its conversation in the vault that replaced its own", async () => {
    fake.publishState("e12", open("seventh"));
    fake.answerOldest("traceLevel", { level: "normal" });
    const adding = addContactByDid("did:peer:someone", "Someone");
    fake.publishState("e13", NONE);
    fake.publishState("e14", open("eighth"));
    fake.answerOldest("traceLevel", { level: "normal" });
    fake.answerOldest("addContactByDid", { contactId: "contact-1", messageId: "message-1", channelId: "channel-1", outcome: "submitted", because: null });
    expect(await adding).toBeNull();
    expect(fake.pendingCount("send")).toBe(0);
  });
});
