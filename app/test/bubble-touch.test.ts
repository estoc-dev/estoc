import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { type Browser, type CDPSession, chromium, type Page } from "playwright-core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Fixture } from "./browser/bubble-page.js";

/**
 * The frame's gestures in a real Chromium with a touch screen: the page in
 * `test/browser/bubble-page.ts` is built with the app's own toolchain and
 * driven with the DevTools protocol's touch input, so the browser itself
 * decides what a lifted finger clicks. Skipped, loudly, when no Chromium
 * is found; `ESTOC_BROWSER=/path/to/chrome` names one.
 */
const browserPath = [process.env["ESTOC_BROWSER"], process.env["CHROME_BIN"], "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(
  (candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate),
);
if (browserPath === undefined) {
  console.warn("touch cases in Chromium skipped: no Chromium found (set ESTOC_BROWSER to a Chrome or Chromium binary)");
}

const HOLD_MS = 700;
const SETTLE_MS = 150;

async function page(): Promise<{ script: string; css: string }> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const built = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [vue()],
    resolve: { alias: [{ find: /^\.\.\/core\/store\.js$/, replacement: fileURLToPath(new URL("browser/store-stub.ts", import.meta.url)) }] },
    build: { write: false, minify: false, modulePreload: false, cssCodeSplit: false, rollupOptions: { input: fileURLToPath(new URL("browser/bubble-page.ts", import.meta.url)), output: { format: "iife" } } },
  });
  const output = (Array.isArray(built) ? built[0] : "output" in built ? built : null)?.output ?? [];
  const script = output.find((item) => item.type === "chunk");
  const css = output.find((item) => item.type === "asset" && item.fileName.endsWith(".css"));
  if (script === undefined || script.type !== "chunk" || css === undefined || css.type !== "asset") throw new Error("the fixture page did not build");
  return { script: script.code, css: typeof css.source === "string" ? css.source : new TextDecoder().decode(css.source) };
}

describe.skipIf(browserPath === undefined)("erasing a message on a touch screen", () => {
  let browser: Browser;
  let tab: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    const { script, css } = await page();
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
