import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Fixture } from "./browser/bubble-page.js";
import { browserPath, fixturePage } from "./chromium.js";

/**
 * The frame's gestures in a real Chromium with a touch screen: the page in
 * `test/browser/bubble-page.ts`, driven with the DevTools protocol's touch
 * input, so the browser itself decides what a lifted finger clicks.
 */
const HOLD_MS = 700;
const SETTLE_MS = 150;

describe.skipIf(browserPath === undefined)("erasing a message on a touch screen", () => {
  let browser: Browser;
  let tab: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    const { script, css } = await fixturePage("bubble-page.ts", "store-stub.ts");
    browser = await chromium.launch({ executablePath: browserPath });
    const context = await browser.newContext({ viewport: { width: 390, height: 640 }, hasTouch: true, isMobile: true });
    tab = await context.newPage();
    cdp = await context.newCDPSession(tab);
    await tab.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    await tab.addStyleTag({ content: css });
    await tab.addScriptTag({ content: script });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const touch = (type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }] : [] });

  async function center(selector: string): Promise<{ x: number; y: number }> {
    const box = await tab.locator(selector).boundingBox();
    if (box === null) throw new Error(`${selector} has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async function tap(selector: string): Promise<void> {
    await touch("touchStart", await center(selector));
    await touch("touchEnd");
    await tab.waitForTimeout(SETTLE_MS);
  }

  const mount = (fixture: Fixture) => tab.evaluate((fixture) => window.mount(fixture), fixture);
  const sheetOpen = () => tab.evaluate(() => document.querySelector("dialog[open]") !== null);
  const actions = () => tab.evaluate(() => window.actions);

  it.each<[Fixture, string]>([
    ["basic", ".bubble-body"],
    ["retry", "[data-retry]"],
    ["generic", "summary"],
  ])("a held press on a %s message opens the sheet, and lifting that finger presses nothing in it", async (fixture, held) => {
    await mount(fixture);
    await touch("touchStart", await center(held));
    await tab.waitForTimeout(HOLD_MS);
    expect(await sheetOpen()).toBe(true);
    expect(await actions()).toEqual([]);
    await touch("touchEnd");
    await tab.waitForTimeout(SETTLE_MS);
    expect(await sheetOpen()).toBe(true);
    expect(await actions()).toEqual([]);

    await tap("[data-erase]");
    expect(await actions()).toEqual([{ name: "eraseMessage", args: ["message-1"] }]);
    expect(await sheetOpen()).toBe(false);
  });

  it("keys pressed while the finger is still held do not let its lift press Erase", async () => {
    for (const key of ["Shift", "Tab"]) {
      await mount("basic");
      await touch("touchStart", await center(".bubble-body"));
      await tab.waitForTimeout(HOLD_MS);
      expect(await sheetOpen()).toBe(true);
      await tab.keyboard.press(key);
      expect(await actions()).toEqual([]);
      await touch("touchEnd");
      await tab.waitForTimeout(SETTLE_MS);
      expect(await sheetOpen()).toBe(true);
      expect(await actions()).toEqual([]);

      await tap("[data-erase]");
      expect(await actions()).toEqual([{ name: "eraseMessage", args: ["message-1"] }]);
      expect(await sheetOpen()).toBe(false);
    }
  });

  it("a control activated from the keyboard while the finger is still held is honoured", async () => {
    await mount("basic");
    await touch("touchStart", await center(".bubble-body"));
    await tab.waitForTimeout(HOLD_MS);
    expect(await sheetOpen()).toBe(true);
    await tab.keyboard.press("Tab");
    expect(await tab.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Cancel");
    await tab.keyboard.press("Enter");
    expect(await sheetOpen()).toBe(false);
    await touch("touchEnd");
    await tab.waitForTimeout(SETTLE_MS);
    expect(await sheetOpen()).toBe(false);
    expect(await actions()).toEqual([]);
  });

  it.each<[string, string, { name: string; args: string[] }[]]>([
    ["Erase", "[data-erase]", [{ name: "eraseMessage", args: ["message-1"] }]],
    ["Cancel", "[data-cancel]", []],
  ])("%s pressed for longer than a hold, after the sheet was opened some other way, still answers", async (_, control, expected) => {
    await mount("basic");
    const point = await center(".bubble-body");
    await tab.mouse.click(point.x, point.y, { button: "right" });
    expect(await sheetOpen()).toBe(true);
    await touch("touchStart", await center(control));
    await tab.waitForTimeout(HOLD_MS);
    await touch("touchEnd");
    await tab.waitForTimeout(SETTLE_MS);
    expect(await sheetOpen()).toBe(false);
    expect(await actions()).toEqual(expected);
  });

  it("a short tap, or a finger that drifts while held, opens nothing", async () => {
    await mount("basic");
    await tap(".bubble-body");
    expect(await sheetOpen()).toBe(false);

    const point = await center(".bubble-body");
    await touch("touchStart", point);
    await touch("touchMove", { x: point.x, y: point.y - 30 });
    await tab.waitForTimeout(HOLD_MS);
    await touch("touchEnd");
    await tab.waitForTimeout(SETTLE_MS);
    expect(await sheetOpen()).toBe(false);
    expect(await actions()).toEqual([]);
  });

  it("the keyboard reaches a More button, named for assistive technology, that opens the sheet", async () => {
    await mount("basic");
    expect(await tab.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    expect(await tab.locator("body").ariaSnapshot()).toContain('button "More"');
    await tab.keyboard.press("Tab");
    expect(await tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("More");
    const box = await tab.locator("[data-more]").boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await tab.keyboard.press("Enter");
    expect(await sheetOpen()).toBe(true);
    expect(await actions()).toEqual([]);
  });
});
