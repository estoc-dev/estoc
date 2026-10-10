import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { build } from "vite";

/**
 * A real Chromium for the cases that need one, and the pages it is handed:
 * a module under `test/browser/` built with the app's own toolchain, with
 * the app's store swapped for that page's stub. The cases are skipped,
 * loudly, when no Chromium is found; `ESTOC_BROWSER=/path/to/chrome`
 * names one.
 */
export const browserPath = [process.env["ESTOC_BROWSER"], process.env["CHROME_BIN"], "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(
  (candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate),
);
if (browserPath === undefined) {
  console.warn("cases in Chromium skipped: no Chromium found (set ESTOC_BROWSER to a Chrome or Chromium binary)");
}

export async function fixturePage(page: string, store: string): Promise<{ script: string; css: string }> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const built = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [vue()],
    resolve: { alias: [{ find: /^\.\.\/core\/store\.js$/, replacement: fileURLToPath(new URL(`browser/${store}`, import.meta.url)) }] },
    build: { write: false, minify: false, modulePreload: false, cssCodeSplit: false, rollupOptions: { input: fileURLToPath(new URL(`browser/${page}`, import.meta.url)), output: { format: "iife" } } },
  });
  const output = (Array.isArray(built) ? built[0] : "output" in built ? built : null)?.output ?? [];
  const script = output.find((item) => item.type === "chunk");
  const css = output.find((item) => item.type === "asset" && item.fileName.endsWith(".css"));
  if (script === undefined || script.type !== "chunk" || css === undefined || css.type !== "asset") throw new Error(`the fixture page ${page} did not build`);
  return { script: script.code, css: typeof css.source === "string" ? css.source : new TextDecoder().decode(css.source) };
}
