/**
 * The CAR snapshot over `node:sqlite`: the cross-platform snapshot
 * cases on files.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

import { openNodeSqlite } from "../../src/node.js";
import type { ExportHarness } from "./export-cases.js";
import { snapshotCases } from "./snapshot-cases.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-snapshot-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the snapshot cases on node:sqlite files", () => {
  const harness: ExportHarness = {
    fresh: () => path.join(dir, `vault-${n++}.sqlite`),
    open: async (target, mode) => openNodeSqlite(target, { mode }),
    fileBytes: async (target) => new Uint8Array(await readFile(target)),
    remove: (target) => rm(target, { force: true }),
  };
  for (const c of snapshotCases) {
    test(c.name, async () => {
      const note = await c.run(harness);
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});
