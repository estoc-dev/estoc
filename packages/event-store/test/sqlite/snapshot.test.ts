/**
 * The CAR snapshot over `node:sqlite`: the cross-platform snapshot and
 * export cases on files.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";

import { openNodeSqlite } from "../../src/node.js";
import { exportCases, type ExportHarness } from "./export-cases.js";
import { heldOnNode } from "./node-memory.js";
import { snapshotCases } from "./snapshot-cases.js";

/** Long enough for the cases that stream 64 MiB through a commit, a read, an export and a restore on a slow machine. */
const LARGE_CASE_TIME_LIMIT = 120_000;

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
    remove: (target) => rm(target, { force: true }),
    memoryUsed: heldOnNode,
  };
  for (const c of [...snapshotCases, ...exportCases]) {
    test(
      c.name,
      async () => {
        const note = await c.run(harness);
        if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
      },
      c.large ? LARGE_CASE_TIME_LIMIT : undefined
    );
  }
});
