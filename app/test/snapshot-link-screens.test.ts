import type { DisplayTime, ReplicaRecord } from "@estoc/daemon-api/contract";
import { snapshotLinkUrl } from "@estoc/daemon-api/views";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Given, Screen } from "./browser/snapshot-page.js";
import type { ShownVault } from "./browser/snapshot-store-stub.js";
import { browserPath, fixturePage } from "./chromium.js";

/**
 * Where a vault is restored from a link, and where links are made, in a
 * real Chromium: the page in `test/browser/snapshot-page.ts`, over a store
 * and a camera of the test's.
 */
const link = snapshotLinkUrl("http://app.test/", { url: "https://mediator.test/b/blob-1", hash: "bciqblobhash", key: "k".repeat(43) });

/** What the daemon refuses a link of the wrong part with, and one past the bound a link to add a device is read to. */
const OVER_SEED = "the snapshot at that link is over the 1048576 bytes this device takes from a link to add a device: restore from a backup file exported from the vault instead";
const NO_SEED = "that snapshot is a vault's history and carries no seed to restore a vault from: import it into a vault that is open";
const NO_CONTENT = "that snapshot is for adding a device and carries no history to import: restore a new device from it";

const device = (id: string, about: Partial<ReplicaRecord>): ReplicaRecord => ({ replicaId: `0199c3a0-7e1d-7000-8000-00000000${id}` as ReplicaRecord["replicaId"], did: `did:peer:4zQm${id}`, self: false, state: "active", addedAt: "2026-10-01T08:00:00.000Z" as DisplayTime, removedAt: null, sent: null, ...about });
const self = device("00a1", { self: true });
const joined = device("00b2", { addedAt: "2026-10-12T08:30:00.000Z" as DisplayTime });
const older = device("00c3", { addedAt: "2026-09-01T08:00:00.000Z" as DisplayTime, sent: { at: "2026-10-02T08:00:00.000Z" as DisplayTime, outcome: "failed", because: "the mediator answered 500 to the forward" } });
const gone = device("00d4", { state: "removed", removedAt: "2026-10-05T08:00:00.000Z" as DisplayTime });

/** A vault whose mediator listed `replicas`, holding `conversations` conversations, sent no history yet. */
const listing = (replicas: ReplicaRecord[], conversations = 1): ShownVault => ({
  mediations: [{ mediationId: "med-1" as never, mediatorDid: "did:web:mediator.test", selected: true, usable: true, retired: null, diagnostics: [], replicas: { listedAt: "2026-10-12T09:00:00.000Z" as DisplayTime, replicas } }],
  historyReceived: null,
  conversations: Array.from({ length: conversations }, () => ({}) as ShownVault["conversations"][number]),
});

describe.skipIf(browserPath === undefined)("snapshot links on screen", () => {
  let browser: Browser;
  let tab: Page;

  beforeAll(async () => {
    const { script, css } = await fixturePage("snapshot-page.ts", "snapshot-store-stub.ts");
    browser = await chromium.launch({ executablePath: browserPath });
    tab = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await tab.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    await tab.addStyleTag({ content: css });
    await tab.addScriptTag({ content: script });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const mount = (screen: Screen, given: Given = {}) => tab.evaluate(({ screen, given }) => window.snapshotFixture.mount(screen, given), { screen, given });
  const tracks = () => tab.evaluate(() => window.snapshotFixture.camera.tracks.map((track) => ({ ...track })));
  const hold = (codes: string[]) => tab.evaluate((codes) => window.snapshotFixture.camera.codes.splice(0, Infinity, ...codes), codes);
  const called = () => tab.evaluate(() => window.snapshotFixture.daemon.calls.map((call) => call.name));
  const publishedParts = () => tab.evaluate(() => window.snapshotFixture.daemon.calls.filter((call) => call.name === "publishSnapshotLink").map((call) => call.args));

  describe("a scan for a link on the first-run screen", () => {
    it("stops the camera when New identity is chosen, and is not running when Restore is chosen again", async () => {
      await mount("onboarding");
      await tab.click("[data-tab-restore]");
      await tab.click("[data-scan-snapshot-link]");
      await tab.waitForFunction(() => window.snapshotFixture.camera.tracks.length === 1);
      expect(await tab.locator("video").count()).toBe(1);

      await tab.click("[data-tab-create]");
      expect(await tracks()).toEqual([{ stopped: true }]);
      expect(await tab.locator("video").count()).toBe(0);

      await tab.click("[data-tab-restore]");
      expect(await tab.locator("[data-scan-snapshot-link]").textContent()).toContain("Scan its QR code");
      expect(await tab.locator("video").count()).toBe(0);
      expect(await tracks()).toEqual([{ stopped: true }]);
    });

    it("takes a code that is a snapshot link into the field and lets the camera go, passing over one that is not", async () => {
      await mount("onboarding");
      await tab.click("[data-tab-restore]");
      await hold(["https://elsewhere.test/#other=1"]);
      await tab.click("[data-scan-snapshot-link]");
      await tab.waitForTimeout(700);
      expect(await tracks()).toEqual([{ stopped: false }]);
      expect(await tab.locator("[data-snapshot-link-input]").inputValue()).toBe("");

      await hold([link]);
      await tab.waitForFunction(() => document.querySelector("video") === null);
      expect(await tab.locator("[data-snapshot-link-input]").inputValue()).toBe(link);
      expect(await tracks()).toEqual([{ stopped: true }]);
      expect(await tab.locator("[data-scan-snapshot-link]").textContent()).toContain("Scan its QR code");
    });
  });

  describe("a page opened with a link that cannot be used", () => {
    it("opens on Restore and says so, with nothing in the field to restore from", async () => {
      await mount("onboarding", { opened: { unreadable: "the snapshot link does not decode" } });
      expect(await tab.locator("[data-tab-restore]").getAttribute("class")).toContain("active");
      expect(await tab.locator("[data-snapshot-link-input]").inputValue()).toBe("");
      expect(await tab.locator(".error-text").textContent()).toContain("The link this page was opened with cannot be used: the snapshot link does not decode");
    });

    it("takes the place of the link the page was opened with before, which is then not restored from", async () => {
      await mount("onboarding", { opened: { link } });
      expect(await tab.locator("[data-snapshot-link-input]").inputValue()).toBe(link);

      await tab.evaluate(() => window.snapshotFixture.open({ unreadable: "the snapshot link does not decode" }));
      await tab.locator(".error-text").waitFor();
      expect(await tab.locator("[data-snapshot-link-input]").inputValue()).toBe("");
      await tab.fill("[data-backup-passphrase]", "the passphrase");
      await tab.click("[data-restore]");
      expect(await tab.locator(".error-text").textContent()).toContain("Choose the backup file, or paste the link");
      expect(await called()).toEqual([]);
    });
  });

  describe("a restore from a link that is not one for a new device", () => {
    it("says what the daemon found, a link past the bound or one to a history, and asks for nothing but the restore", async () => {
      await mount("onboarding", { opened: { link }, unrestored: OVER_SEED });
      await tab.fill("[data-backup-passphrase]", "the passphrase");
      await tab.click("[data-restore]");
      await tab.waitForFunction((over) => document.querySelector("form .error-text")?.textContent === over, OVER_SEED);

      await tab.evaluate((noSeed) => (window.snapshotFixture.daemon.unrestored = noSeed), NO_SEED);
      await tab.click("[data-restore]");
      await tab.waitForFunction((noSeed) => document.querySelector("form .error-text")?.textContent === noSeed, NO_SEED);
      expect(await called()).toEqual(["restoreFromLink", "restoreFromLink"]);
      expect(await tab.locator("[data-snapshot-link-input]").inputValue()).toBe(link);
    });
  });

  describe("the sheet a device is added from", () => {
    it("makes a link for a new device only, and lists each link made here by the part it carries", async () => {
      await mount("add-device", { links: [{ status: "pending", hash: "bciqhistory", part: "content", placedAt: "2026-10-09T12:00:00.000Z" as DisplayTime, retainUntil: null }] });
      expect(await tab.locator("[data-add-device-sheet] button.btn").count()).toBe(1);
      expect(await tab.locator("[data-make-copy-link]").count()).toBe(0);

      await tab.click("[data-make-snapshot-link]");
      await tab.locator('[data-shown-part="seed"]').waitFor();
      expect(await publishedParts()).toEqual([["seed"]]);
      await tab.click("[data-snapshot-done]");
      expect(await tab.locator("[data-snapshot-link] .row-main > span:first-child").allTextContents()).toEqual(["A link for a new device", "A copy of your history, unfinished"]);
    });

    it("offers a backup file instead when the link cannot be made, and exports one when asked", async () => {
      const over = "the seed and the events a new device enrolls from come to at least 1048600 bytes, over the 1048576 a link to add a device holds";
      await mount("add-device");
      expect(await tab.locator("[data-add-device-export]").count()).toBe(0);

      await tab.evaluate((over) => (window.snapshotFixture.daemon.unpublished = over), over);
      await tab.click("[data-make-snapshot-link]");
      await tab.locator("[data-add-device-export]").waitFor();
      expect(await tab.locator("[data-add-device-error]").textContent()).toBe(over);

      await tab.click("[data-add-device-export]");
      await tab.waitForFunction(() => window.snapshotFixture.daemon.calls.some((call) => call.name === "downloadBackup"));
      expect(await publishedParts()).toEqual([["seed"]]);
    });
  });

  describe("the history put on a link from the vault's page", () => {
    it("goes without the seed, and is shown with where it is listed to revoke", async () => {
      await mount("copy-link", { phase: "open" });
      await tab.click("[data-make-copy-link]");
      await tab.locator('[data-copy-link-sheet] [data-shown-part="content"]').waitFor();
      expect(await publishedParts()).toEqual([["content"]]);
      expect(await tab.locator("[data-copy-link-sheet]").textContent()).toContain("It is listed under You › Add a device, to show again or revoke.");

      await tab.click("[data-snapshot-done]");
      await tab.locator("[data-copy-link-sheet]").waitFor({ state: "detached" });
    });

    it("says why when it could not be put", async () => {
      await mount("copy-link", { phase: "open", unpublished: "the mediator keeps no blobs" });
      await tab.click("[data-make-copy-link]");
      await tab.locator("[data-copy-link-note]").waitFor();
      expect(await tab.locator("[data-copy-link-note]").textContent()).toBe("the mediator keeps no blobs");
      expect(await tab.locator("[data-copy-link-sheet]").count()).toBe(0);
    });
  });

  describe("the links listed where they are made", () => {
    it("show the pending link a failed publish left behind, which can be revoked there and then", async () => {
      await mount("add-device", { unpublished: "the upload was cut short" });
      await tab.click("[data-make-snapshot-link]");
      await tab.locator('[data-snapshot-link="pending"]').waitFor();
      expect(await tab.locator("[data-add-device-error]").textContent()).toContain("the upload was cut short");

      await tab.click("[data-revoke-snapshot-link]");
      await tab.locator("[data-snapshot-link]").waitFor({ state: "detached" });
      expect(await called()).toEqual(["snapshotLinks", "publishSnapshotLink", "snapshotLinks", "revokeSnapshotLink", "snapshotLinks"]);
    });

    it("say when they could not be read, and are read again when asked", async () => {
      await mount("add-device", { unlistable: "the daemon is not answering" });
      expect(await tab.locator("[data-snapshot-links-unread]").textContent()).toContain("could not be read: the daemon is not answering");

      await tab.evaluate(() => {
        window.snapshotFixture.daemon.unlistable = null;
        window.snapshotFixture.daemon.links = [{ status: "pending", hash: "bciqleft", part: "content", placedAt: "2026-10-10T12:00:00.000Z" as DisplayTime, retainUntil: null }];
      });
      await tab.click("[data-reload-snapshot-links]");
      await tab.locator('[data-snapshot-link="pending"]').waitFor();
      expect(await tab.locator("[data-snapshot-links-unread]").count()).toBe(0);
    });
  });

  describe("a link imported from the vault's page", () => {
    it("asks nothing of the daemon until a link is pasted, then imports it and says what it brought", async () => {
      await mount("import-link", { phase: "open" });
      await tab.click("[data-import-link-open]");
      await tab.click("[data-import-link]");
      expect(await tab.locator("[data-import-link-note]").textContent()).toContain("Paste the link your other device made");
      expect(await called()).toEqual([]);

      await tab.fill("[data-import-link-input]", link);
      await tab.click("[data-import-link]");
      await tab.locator("[data-import-link-input]").waitFor({ state: "detached" });
      expect(await tab.locator("[data-import-link-note]").textContent()).toBe("Merged 3 new events and 0 objects.");
      expect(await tab.evaluate(() => window.snapshotFixture.daemon.calls.map((call) => call.args))).toEqual([[link]]);
    });

    it("keeps the link in the field and says why when the import fails", async () => {
      await mount("import-link", { phase: "open", unmerged: "that snapshot is of another vault, and is not merged into this one" });
      await tab.click("[data-import-link-open]");
      await tab.fill("[data-import-link-input]", link);
      await tab.click("[data-import-link]");
      await tab.locator("[data-import-link-note].error-text").waitFor();
      expect(await tab.locator("[data-import-link-note]").textContent()).toContain("that snapshot is of another vault");
      expect(await tab.locator("[data-import-link-input]").inputValue()).toBe(link);
    });
  });

  describe("a page opened with a link where a vault is held", () => {
    it("offers to import what it holds, and once asked imports it, says what it brought and lets the link go", async () => {
      await mount("opened-link", { opened: { link }, phase: "open" });
      await tab.click("[data-import-opened-link]");
      await tab.locator("[data-opened-link-outcome]").waitFor();
      expect(await tab.locator("[data-opened-link-outcome] span").textContent()).toBe("Merged 3 new events and 0 objects.");
      expect(await tab.evaluate(() => [window.snapshotFixture.daemon.calls.map((call) => call.args), window.snapshotFixture.state.pendingSnapshotLink])).toEqual([[[link]], null]);
    });

    it("waits for the vault to be unlocked before it offers the import", async () => {
      await mount("opened-link", { opened: { link }, phase: "locked" });
      await tab.locator("[data-opened-link-locked]").waitFor();
      expect(await tab.locator("[data-import-opened-link]").count()).toBe(0);
      await tab.evaluate(() => (window.snapshotFixture.state.vault.phase = "open"));
      await tab.locator("[data-import-opened-link]").waitFor();
      expect(await called()).toEqual([]);
    });

    it("keeps a link it is opened with again during an import, and offers it once that import is told, failed or not", async () => {
      const later = snapshotLinkUrl("http://app.test/", { url: "https://mediator.test/b/blob-2", hash: "bciqlaterhash", key: "l".repeat(43) });
      for (const unmerged of [undefined, "no snapshot is at that link any more"]) {
        await mount("opened-link", { opened: { link }, phase: "open", unmerged });
        await tab.evaluate(() => window.snapshotFixture.holdImports());
        await tab.click("[data-import-opened-link]");
        await tab.locator("[data-opened-link-importing]").waitFor();
        await tab.evaluate((later) => window.snapshotFixture.open({ link: later }), later);
        await tab.evaluate(() => window.snapshotFixture.releaseImports());
        await tab.locator("[data-opened-link-outcome]").waitFor();
        expect(await tab.evaluate(() => window.snapshotFixture.state.pendingSnapshotLink)).toEqual({ link: later });

        await tab.click("[data-opened-link-outcome] button");
        await tab.click("[data-import-opened-link]");
        await tab.locator("[data-opened-link-outcome]").waitFor();
        expect(await tab.evaluate(() => window.snapshotFixture.daemon.calls.map((call) => call.args))).toEqual([[link], [later]]);
        expect(await tab.evaluate(() => window.snapshotFixture.state.pendingSnapshotLink)).toBeNull();
      }
    });

    it("says a link for a new device holds no history to import, and asks for nothing but the import", async () => {
      await mount("opened-link", { opened: { link }, phase: "open", unmerged: NO_CONTENT });
      await tab.click("[data-import-opened-link]");
      await tab.locator("[data-opened-link-outcome].alarm").waitFor();
      expect(await tab.locator("[data-opened-link-outcome] span").textContent()).toBe(`That link was not imported: ${NO_CONTENT}`);
      expect(await called()).toEqual(["importFromLink"]);
    });

    it("says why the import failed, and lets the link go", async () => {
      await mount("opened-link", { opened: { link }, phase: "open", unmerged: "that snapshot is of another vault, and is not merged into this one" });
      await tab.click("[data-import-opened-link]");
      await tab.locator("[data-opened-link-outcome].alarm").waitFor();
      expect(await tab.locator("[data-opened-link-outcome] span").textContent()).toBe("That link was not imported: that snapshot is of another vault, and is not merged into this one");
      expect(await tab.evaluate(() => window.snapshotFixture.state.pendingSnapshotLink)).toBeNull();
    });
  });

  describe("the vault's devices", () => {
    const sent = () => tab.evaluate(() => window.snapshotFixture.daemon.calls.filter((call) => call.name === "sendHistory").map((call) => call.args));

    it("are listed as the mediator listed them, the one that joined since and was sent nothing marked new and sent history from its own row, every other from Sync now", async () => {
      await mount("devices", { phase: "open", vault: listing([self, joined, older, gone]) });
      expect(await tab.locator("[data-device]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-device")))).toEqual(["self", "active", "active", "removed"]);
      expect(await tab.locator("[data-device]").evaluateAll((rows) => rows.map((row) => row.querySelector("[data-device-new]") !== null))).toEqual([false, true, false, false]);
      expect(await tab.locator('[data-device="active"]').nth(1).locator(".row-sub").textContent()).toContain("history not sent");
      expect(await tab.locator('[data-device="removed"]').getAttribute("class")).toContain("gone");
      expect(await tab.locator("[data-devices-empty]").count()).toBe(0);

      await tab.click("[data-send-history]");
      await tab.locator("[data-devices-note]").waitFor();
      expect(await tab.locator("[data-devices-note]").textContent()).toBe("Sent the history to Device 00B2; each takes it in as it arrives.");
      await tab.evaluate((told) => (window.snapshotFixture.daemon.told = told), [joined.replicaId]);
      await tab.click("[data-sync-now]");
      await tab.waitForFunction(() => window.snapshotFixture.daemon.calls.filter((call) => call.name === "sendHistory").length === 2);
      expect(await sent()).toEqual([[joined.replicaId], [null]]);
      expect(await tab.locator("[data-devices-note]").textContent()).toContain("It did not go to every one");
    });

    it("are asked of the mediator as they come into view and as the sheet a device is added from closes, so that one that joined shows up with nothing pressed", async () => {
      const asked = () => tab.evaluate(() => window.snapshotFixture.daemon.calls.filter((call) => call.name === "refreshReplicas").length);
      await mount("devices", { phase: "open", vault: listing([self]) });
      await tab.waitForFunction(() => window.snapshotFixture.daemon.calls.length === 1);
      expect(await asked()).toBe(1);
      expect(await tab.locator("[data-sync-now]").count()).toBe(0);

      await tab.evaluate((replicas) => (window.snapshotFixture.daemon.relisted = replicas), [self, joined]);
      await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await tab.locator("[data-device-new]").waitFor();
      expect(await asked()).toBe(2);
      expect(await tab.locator("[data-device]").count()).toBe(2);

      await tab.click("[data-add-device]");
      await tab.locator("[data-add-device-sheet]").waitFor();
      expect(await asked()).toBe(2);
      await tab.click("[data-add-device-close]");
      await tab.waitForFunction(() => window.snapshotFixture.daemon.calls.filter((call) => call.name === "refreshReplicas").length === 3);
      expect(await tab.locator("[data-add-device-sheet]").count()).toBe(0);
    });

    it("are shown as last listed where the mediator cannot be asked, with why", async () => {
      await mount("devices", { phase: "open", vault: listing([self, older]), unasked: "the network is down" });
      await tab.waitForFunction(() => document.querySelector("[data-devices-listed]")?.textContent?.includes("could not be asked") === true);
      expect(await tab.locator("[data-devices-listed]").textContent()).toMatch(/^As the mediator listed them .+\. It could not be asked just now: the network is down$/);
      expect(await tab.locator("[data-device]").count()).toBe(2);

      await tab.evaluate(() => (window.snapshotFixture.daemon.unasked = null));
      await tab.click("[data-list-devices]");
      await tab.waitForFunction(() => document.querySelector("[data-devices-listed]")?.textContent?.includes("could not be asked") === false);
      expect(await tab.locator("[data-device]").count()).toBe(2);
    });

    it("say so when history went to none of them", async () => {
      await mount("devices", { phase: "open", vault: listing([self, older]) });
      await tab.evaluate(() => (window.snapshotFixture.daemon.told = []));
      await tab.click("[data-sync-now]");
      await tab.locator("[data-devices-note].error-text").waitFor();
      expect(await tab.locator("[data-devices-note]").textContent()).toBe("The history did not go: what stopped it is beside each device.");
    });

    it("tell a device holding nothing yet where its history comes from, and then how the history sent it is taken in", async () => {
      await mount("devices", { phase: "open", vault: listing([device("00b2", {}), device("00e5", { self: true, addedAt: "2026-10-12T08:30:00.000Z" as DisplayTime })], 0) });
      expect(await tab.locator("[data-devices-empty]").textContent()).toContain("This device holds none of your conversations yet");
      expect(await tab.locator("[data-device-new]").count()).toBe(0);

      const from = { from: joined.replicaId, at: "2026-10-12T09:30:00.000Z" };
      await tab.evaluate((from) => (window.snapshotFixture.state.snapshot!.historyReceived = { ...from, status: "importing" } as never), from);
      await tab.locator("[data-history-received]").waitFor();
      expect(await tab.locator("[data-history-received]").textContent()).toBe("Importing the history Device 00B2 sent…");
      expect(await tab.locator("[data-devices-empty]").count()).toBe(0);

      await tab.evaluate((from) => (window.snapshotFixture.state.snapshot!.historyReceived = { ...from, status: "imported", merged: { added: 3, duplicates: 7, objects: 0, repaired: 0, renewed: false } } as never), from);
      await tab.waitForFunction(() => document.querySelector("[data-history-received]")?.textContent?.includes("Merged") === true);
      expect(await tab.locator("[data-history-received]").textContent()).toContain(": Merged 3 new events and 0 objects.");

      await tab.evaluate((from) => (window.snapshotFixture.state.snapshot!.historyReceived = { ...from, status: "failed", because: "no snapshot is at that link any more" } as never), from);
      await tab.locator("[data-history-received].error-text").waitFor();
      expect(await tab.locator("[data-history-received]").textContent()).toContain("was not imported: no snapshot is at that link any more");
    });
  });
});
