import { describe, expect, it } from "vitest";

import { openNodeSqlite } from "../src/node.js";
import { SqliteVault, createRuntime } from "../src/index.js";
import { countingDriver, noReads } from "./counting.js";
import { META, WRAPPED } from "./fixtures.js";
import { all } from "./suite/helpers.js";
import { HELLO_CID } from "./suite/object-store-suite.js";

const HELLO = new TextEncoder().encode("hello");

describe("a counting driver", () => {
  it("counts each read of the events by its kind with the rows it handed over, and each object read with its bytes, and nothing else", async () => {
    const reads = noReads();
    const runtime = new SqliteVault(createRuntime(countingDriver(openNodeSqlite(":memory:", { mode: "create" }), reads), { metadata: META, wrapped: WRAPPED }));
    try {
      await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [{ type: "test.first", roots: [HELLO_CID], data: {} }]);
      await runtime.vault.commit([], [{ type: "test.second", roots: [], data: {} }, { type: "test.second", roots: [], data: { n: 1 } }]);
      // The store looks its table over for damage once, before its first commit, and finds it empty.
      const committed = { ...noReads(), surveys: 1 };
      expect(reads).toEqual(committed);

      expect(await all(runtime.vault.events.scan())).toHaveLength(3);
      expect(reads).toEqual({ ...committed, scans: 1, eventRows: 3 });

      expect(await all(runtime.vault.events.scan({ type: "test.second" }))).toHaveLength(2);
      expect(reads).toEqual({ ...committed, scans: 1, filteredScans: 1, eventRows: 5 });

      const { token, events } = await runtime.vault.events.changes();
      expect(await all(events)).toHaveLength(3);
      expect(await all((await runtime.vault.events.changes(undefined, token)).events)).toHaveLength(0);
      expect(reads).toEqual({ ...committed, scans: 1, filteredScans: 1, changes: 2, eventRows: 8 });

      expect(await runtime.vault.objects.read(HELLO_CID, 1024)).toEqual(HELLO);
      expect(reads).toEqual({ ...committed, scans: 1, filteredScans: 1, changes: 2, eventRows: 8, objects: 1, objectChunks: 1, objectBytes: HELLO.length });
    } finally {
      await runtime.close();
    }
  });
});
