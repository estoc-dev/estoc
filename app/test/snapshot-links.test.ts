import { describe, expect, it, vi } from "vitest";

import type { CallError, SnapshotLink, SnapshotLinkRecord } from "@estoc/daemon-api/contract";
import { parseSnapshotLink, snapshotLinkUrl } from "@estoc/daemon-api/views";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));
// a daemon of this test's: each call is written down and answered, or refused, as the test says
const fake = vi.hoisted(() => {
  const calls: { method: string; input: unknown }[] = [];
  const answers = new Map<string, () => Promise<unknown>>();
  const daemon = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (input: unknown) => {
          calls.push({ method, input });
          return answers.get(method)?.() ?? new Promise(() => undefined);
        },
    }
  );
  const listeners = new Map<string, () => void>();
  const page = { href: "", origin: "", hash: "", search: "", pathname: "/" };
  return {
    daemon,
    calls,
    answers,
    listeners,
    page,
    replaced: [] as string[],
    client: {
      onState: () => () => undefined,
      onConnection: () => () => undefined,
      onLines: () => () => undefined,
      onLog: () => () => undefined,
      refresh: () => Promise.resolve(),
    },
  };
});
vi.mock("../src/daemon/client.js", () => ({ daemonSocket: () => null, startDaemon: () => ({ ...fake.client, daemon: fake.daemon }) }));
await import("vue");

const link: SnapshotLink = { url: "https://mediator.test/b/blob-1", hash: "bciqblobhash", key: "k".repeat(43) };

/** The page's address as a browser has it after `href` was opened or pasted over it. */
function opened(href: string): void {
  const url = new URL(href);
  Object.assign(fake.page, { href, origin: url.origin, hash: url.hash, search: url.search, pathname: url.pathname });
}

vi.stubGlobal("window", { addEventListener: (type: string, listener: () => void) => fake.listeners.set(type, listener) });
vi.stubGlobal("document", { addEventListener: () => undefined });
vi.stubGlobal("location", fake.page);
vi.stubGlobal("history", {
  state: null,
  replaceState: (_state: unknown, _unused: string, url: string) => {
    fake.replaced.push(url);
    opened(new URL(url, "http://app.test").href);
  },
});
vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve({}), persist: () => Promise.resolve(false) } });

opened(snapshotLinkUrl("http://app.test/?lang=en", link));
const { boot, createIdentity, importFromLink, publishSnapshotLink, refreshReplicas, restoreFromLink, sendHistory, snapshotLinkOf, snapshotLinks, state } = await import("../src/core/store.js");
await boot();

const heldLink = (): SnapshotLink | null => {
  const opened = state.pendingSnapshotLink;
  return opened !== null && "link" in opened ? parseSnapshotLink(opened.link) : null;
};

const refused = (code: string, message: string): CallError => ({ origin: "daemon", code, message, effect: "none", messageId: null }) as CallError;

describe("a page opened with a snapshot link", () => {
  it("holds the link for the restore and takes it off the address, keeping the query", () => {
    expect(heldLink()).toEqual(link);
    expect(fake.replaced).toEqual(["/?lang=en"]);
    expect(fake.page.hash).toBe("");
  });

  it("takes what is pasted over its address the same way, holding why a fragment that is not a link cannot be used in place of the link before it", () => {
    opened("http://app.test/#snapshot=not-a-link");
    fake.listeners.get("hashchange")?.();
    expect(state.pendingSnapshotLink).toEqual({ unreadable: expect.stringContaining("the snapshot link") });
    expect(fake.page.hash).toBe("");
    const another = { ...link, hash: "bciqanother" };
    opened(snapshotLinkUrl("http://app.test/", another));
    fake.listeners.get("hashchange")?.();
    expect(heldLink()).toEqual(another);
  });

  it("lets go of what it held once a vault is minted here instead", async () => {
    state.pendingSnapshotLink = { unreadable: "the snapshot link does not decode" };
    fake.answers.set("createIdentity", () => Promise.resolve(null));
    await createIdentity("Alice", "the passphrase");
    expect(state.pendingSnapshotLink).toBeNull();
  });
});

describe("a restore from a link", () => {
  it("hands the daemon the link read from the text and lets go of the one the page was opened with", async () => {
    state.pendingSnapshotLink = { link: snapshotLinkUrl("http://app.test/", link) };
    fake.answers.set("restoreFromLink", () => Promise.resolve(null));
    await restoreFromLink(`  ${snapshotLinkUrl("https://elsewhere.test/", link)}\n`, "the passphrase");
    expect(fake.calls.at(-1)).toEqual({ method: "restoreFromLink", input: { link, passphrase: "the passphrase" } });
    expect(state.pendingSnapshotLink).toBeNull();
  });

  it("asks nothing of the daemon for text that holds no link", async () => {
    const before = fake.calls.length;
    await expect(restoreFromLink("https://elsewhere.test/#other=1", "the passphrase")).rejects.toThrow("that URL carries no snapshot link");
    expect(fake.calls.length).toBe(before);
  });
});

describe("an import from a link", () => {
  it("hands the daemon the link read from the text and answers what the merge brought", async () => {
    const merged = { added: 3, duplicates: 7, objects: 1, repaired: 0, renewed: false };
    fake.answers.set("importFromLink", () => Promise.resolve(merged));
    expect(await importFromLink(`  ${snapshotLinkUrl("https://elsewhere.test/", link)}\n`)).toEqual(merged);
    expect(fake.calls.at(-1)).toEqual({ method: "importFromLink", input: { link } });
  });

  it("asks nothing of the daemon for text that holds no link", async () => {
    const before = fake.calls.length;
    await expect(importFromLink("https://elsewhere.test/#other=1")).rejects.toThrow("that URL carries no snapshot link");
    expect(fake.calls.length).toBe(before);
  });

  it("points to a backup file when the copy is over what the daemon reads from a link", async () => {
    fake.answers.set("importFromLink", () => Promise.reject(refused("ResourceLimit", "the snapshot is over the 100 bytes this daemon reads from a link")));
    await expect(importFromLink(snapshotLinkOf(link))).rejects.toThrow("this daemon reads from a link. Export a backup on the device that made the link");
  });
});

describe("a link made here", () => {
  it("is handed over at this page's address, whatever its query, and reads back as the link", () => {
    const url = snapshotLinkOf(link);
    expect(url.startsWith("http://app.test/#snapshot=")).toBe(true);
    expect(parseSnapshotLink(url)).toEqual(link);
  });

  it("is asked of the daemon with what it carries", async () => {
    const published = { status: "published", hash: link.hash, selection: "enrollment", placedAt: "2026-10-10T12:00:00.000Z", retainUntil: "2026-11-09T12:00:00.000Z", revocable: true, link };
    fake.answers.set("publishSnapshotLink", () => Promise.resolve(published));
    expect(await publishSnapshotLink("enrollment")).toEqual(published);
    expect(fake.calls.at(-1)).toEqual({ method: "publishSnapshotLink", input: { selection: "enrollment" } });
  });

  it("points to a backup file when the vault is too large for one", async () => {
    fake.answers.set("publishSnapshotLink", () => Promise.reject(refused("ResourceLimit", "the snapshot's events and objects come to 120 bytes, over the 100 a blob at the mediator holds once sealed")));
    await expect(publishSnapshotLink("all")).rejects.toThrow("over the 100 a blob at the mediator holds once sealed. A link cannot carry this vault: export a backup");
  });

  it("is listed newest first", async () => {
    const made = (hash: string, placedAt: string): SnapshotLinkRecord => ({ status: "pending", hash, selection: "all", placedAt, retainUntil: null }) as SnapshotLinkRecord;
    fake.answers.set("snapshotLinks", () => Promise.resolve({ links: [made("older", "2026-10-01T00:00:00Z"), made("newer", "2026-10-02T00:00:00Z")] }));
    expect((await snapshotLinks()).map((record) => record.hash)).toEqual(["newer", "older"]);
  });
});

describe("history sent to the vault's other devices", () => {
  it("is asked of the daemon for the one device named, or for every other, and answers those it went to", async () => {
    fake.answers.set("sync", () => Promise.resolve({ told: ["r-2"] }));
    expect(await sendHistory("r-2" as never)).toEqual(["r-2"]);
    expect(fake.calls.at(-1)).toEqual({ method: "sync", input: { replicaId: "r-2" } });
    expect(await sendHistory()).toEqual(["r-2"]);
    expect(fake.calls.at(-1)).toEqual({ method: "sync", input: {} });
  });

  it("points to a backup file when the vault is too large for a link", async () => {
    fake.answers.set("sync", () => Promise.reject(refused("ResourceLimit", "the snapshot's events and objects come to 120 bytes, over the 100 a blob at the mediator holds once sealed")));
    await expect(sendHistory()).rejects.toThrow("over the 100 a blob at the mediator holds once sealed. A link cannot carry this vault: export a backup");
  });

  it("goes to the devices the mediator lists, which are asked of it again on request", async () => {
    fake.answers.set("refreshReplicas", () => Promise.resolve(null));
    await refreshReplicas();
    expect(fake.calls.at(-1)).toEqual({ method: "refreshReplicas", input: {} });
  });
});
