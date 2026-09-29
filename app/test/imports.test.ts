import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

// the files that make the daemon run inside the page; everything else is a view over the API
const HOSTS = new Set(["daemon/worker.ts", "daemon/keycache.ts", "daemon/places.ts", "didcomm/wasm.ts", "declarations.d.ts"]);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(ts|vue)$/.test(entry.name)) yield path;
  }
}

const imported = (source: string) => [...source.matchAll(/from\s+"(@estoc\/[^"]+)"/g)].map((m) => m[1]!);

describe("the view", () => {
  it("reaches the daemon only through the API package", () => {
    const offenders: string[] = [];
    for (const path of sources(SRC)) {
      const file = relative(SRC, path);
      if (HOSTS.has(file)) continue;
      for (const specifier of imported(readFileSync(path, "utf8"))) {
        if (!specifier.startsWith("@estoc/daemon-api/")) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names every host file it exempts", () => {
    const files = new Set([...sources(SRC)].map((path) => relative(SRC, path)));
    for (const host of HOSTS) expect(files.has(host), host).toBe(true);
  });
});
