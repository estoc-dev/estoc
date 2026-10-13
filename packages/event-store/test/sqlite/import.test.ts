/**
 * Restore and import over `node:sqlite`: the cross-platform cases on
 * files, and what only a path shows — a restore into a destination
 * kept in either journal, reopening the same.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";

import { openNodeSqlite } from "../../src/node.js";
import { SqliteVault, Snapshot, createRuntime, exportSnapshot, openRuntime, restoreSnapshot, type OpenMode, type SqliteDriver } from "../../src/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { all } from "../suite/helpers.js";
import { importCases } from "./import-cases.js";
import { HELLO, HELLO_CID, draft, rootsOf, type VaultHarness } from "./vault-cases.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-import-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (target: string, mode: OpenMode): SqliteDriver => openNodeSqlite(target, { mode });

describe("the import cases on node:sqlite files", () => {
  const harness: VaultHarness = {
    fresh,
    open: async (target, mode) => open(target, mode),
  };
  for (const c of importCases) {
    test(c.name, async () => {
      const note = await c.run(harness);
      if (note !== undefined) console.info(`on node:sqlite: ${c.name}: ${note}`);
    });
  }
});

describe("restoreSnapshot on a path", () => {
  it("lays the runtime in whatever journal the destination was created with, and the same open reopens it", async () => {
    const vault = new SqliteVault(createRuntime(open(fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const snapshot = await Snapshot.read(await exportSnapshot(vault, { parts: "both", heldRoots: rootsOf }), { heldRoots: rootsOf });
    await vault.close();
    for (const journal of ["wal", "delete"] as const) {
      const target = fresh();
      const restored = await restoreSnapshot(snapshot, () => openNodeSqlite(target, { mode: "create", journal }), { anchor: ANCHOR });
      expect(restored).toMatchObject({ events: 1, objects: 1, objectBytes: 5 });
      const first = new SqliteVault(restored.runtime);
      expect((await all(first.vault.events.scan())).map((e) => e.roots)).toEqual([[HELLO_CID]]);
      await first.close();
      const again = new SqliteVault(await openRuntime(open(target, "readwrite"), { anchor: ANCHOR }));
      try {
        expect([again.author, again.generation]).toEqual([restored.runtime.author, restored.runtime.generation]);
        expect((await all(again.vault.events.scan())).length).toBe(1);
      } finally {
        await again.close();
      }
    }
  });
});
