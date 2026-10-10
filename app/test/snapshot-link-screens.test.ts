import { snapshotLinkUrl } from "@estoc/daemon-api/views";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SnapshotLinkRecord } from "../src/core/types.js";
import type { Given, Screen } from "./browser/snapshot-page.js";
import { browserPath, fixturePage } from "./chromium.js";

/**
 * Where a vault is restored from a link, and where links are made, in a
 * real Chromium: the page in `test/browser/snapshot-page.ts`, over a store
 * and a camera of the test's.
 */
const link = snapshotLinkUrl("http://app.test/", { url: "https://mediator.test/b/blob-1", hash: "bciqblobhash", key: "k".repeat(43) });

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

  describe("the links listed where they are made", () => {
    it("show the pending link a failed publish left behind, which can be revoked there and then", async () => {
      await mount("add-device");
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
        window.snapshotFixture.daemon.links = [{ status: "pending", hash: "bciqleft", placedAt: "2026-10-10T12:00:00.000Z", retainUntil: null } as SnapshotLinkRecord];
      });
      await tab.click("[data-reload-snapshot-links]");
      await tab.locator('[data-snapshot-link="pending"]').waitFor();
      expect(await tab.locator("[data-snapshot-links-unread]").count()).toBe(0);
    });
  });
});
