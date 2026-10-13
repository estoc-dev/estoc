/**
 * What the wasm pool itself must do, beyond the driver cases its
 * connections pass. Run in the Worker by `sqlite-worker.ts`; the cases
 * take the pool opener so this module loads without the wasm runtime,
 * for the test that lists their names.
 */

import type { SqlitePool, SqlitePoolOptions } from "../../src/browser.js";
import { SqliteObjectStore, createRuntime } from "../../src/index.js";
import { META, WRAPPED } from "../fixtures.js";
import { type Case, assertEqual, assertRejects, assertThrows, assertBytes, pattern } from "../sqlite/driver-cases.js";

export type OpenPool = (options: SqlitePoolOptions) => Promise<SqlitePool>;

export interface PoolCase extends Case {
  run(open: OpenPool): Promise<string | void>;
}

/** A database `name` created in `pool` with one marker row holding `v`, closed. */
async function marked(pool: SqlitePool, name: string, v: number): Promise<void> {
  const db = await pool.open(name, "create");
  try {
    db.exec(`CREATE TABLE marker (v INTEGER NOT NULL) STRICT; INSERT INTO marker VALUES (${v})`);
  } finally {
    db.close();
  }
}

export const poolCases: PoolCase[] = [
  {
    name: "names are the databases: one that spells another's journal is its own, and the journal SQLite keeps beside a database is not listed",
    run: async (open) => {
      const pool = await open({ directory: "/names" });
      const side = await pool.open("vault-journal", "create");
      side.exec("CREATE TABLE valuable (v TEXT NOT NULL) STRICT; INSERT INTO valuable VALUES ('keep me')");
      side.close();
      const main = await pool.open("vault", "create");
      main.exec("CREATE TABLE marker (v INTEGER NOT NULL) STRICT");
      main.transaction("immediate", () => {
        main.prepare("INSERT INTO marker VALUES (?)").run(1);
        assertEqual(pool.names(), ["vault", "vault-journal"], "inside a transaction, with the journal on disk");
      });
      main.close();
      assertEqual(pool.names(), ["vault", "vault-journal"], "after it");
      const again = await pool.open("vault-journal", "readonly");
      assertEqual(again.prepare("SELECT v FROM valuable").all(), [{ v: "keep me" }], "the database with the journal-like name is intact");
      again.close();
      const vault = await pool.open("vault", "readonly");
      assertEqual(vault.prepare("SELECT v FROM marker").all(), [{ v: 1 }], "and so is the other");
      vault.close();
      await pool.close();
    },
  },
  {
    name: "two directories are two pools however alike their names; one directory is one pool however it is spelled",
    run: async (open) => {
      const first = await open({ directory: "/collision-a" });
      const db = await first.open("vault", "create");
      db.exec("CREATE TABLE marker (v TEXT NOT NULL) STRICT; INSERT INTO marker VALUES ('first')");
      db.close();
      const second = await open({ directory: "/collision/a" });
      assertEqual(second.names(), [], "nothing of the first directory");
      await assertRejects(() => second.open("vault", "readwrite"), "DatabaseMissing", "the first directory's database is not here");
      await second.close();
      await assertRejects(() => open({ directory: "collision-a//" }), "DatabaseBusy", "the held directory, spelled without the leading slash and with a doubled one");
      await assertRejects(() => open({ directory: "/collision-a/" }), "DatabaseBusy", "the held directory, with a trailing slash");
      await first.close();
      const third = await open({ directory: "collision-a" });
      assertEqual(third.names(), ["vault"], "the directory once released, under another spelling");
      await third.close();
      for (const bad of ["", "/", "//", "/a/../b", "/./a"]) await assertRejects(() => open({ directory: bad }), "Error", `${JSON.stringify(bad)} is not a directory the pool takes`);
    },
  },
  {
    name: "a closed pool refuses every call: the directory is the next owner's alone",
    run: async (open) => {
      const first = await open({ directory: "/lifecycle" });
      const db = await first.open("vault", "create");
      db.exec("CREATE TABLE marker (v INTEGER NOT NULL) STRICT; INSERT INTO marker VALUES (1)");
      db.close();
      await first.close();
      await first.close();
      await assertRejects(() => first.open("vault", "readwrite"), "Error", "open after close");
      assertThrows(() => first.names(), "Error", "names after close");
      assertThrows(() => first.remove("vault"), "Error", "remove after close");
      const next = await open({ directory: "/lifecycle" });
      const current = await next.open("vault", "readwrite");
      await assertRejects(() => first.open("vault", "readwrite"), "Error", "the old pool while the new owner works");
      assertThrows(() => first.remove("vault"), "Error", "the old pool cannot remove what the new owner holds");
      assertEqual(current.prepare("SELECT v FROM marker").all(), [{ v: 1 }], "the new owner's view, untouched");
      current.close();
      await next.close();
    },
  },
  {
    name: "the pool does not close under an open in progress",
    run: async (open) => {
      const pool = await open({ directory: "/lifecycle-pending" });
      const opening = pool.open("vault", "create");
      await assertRejects(() => pool.close(), "Error", "close while an open is in progress");
      const db = await opening;
      await assertRejects(() => pool.close(), "Error", "close while a connection is open");
      db.close();
      await pool.close();
    },
  },
  {
    name: "creating more databases than the pool has handles for grows it",
    run: async (open) => {
      const pool = await open({ directory: "/create-capacity" });
      const names = Array.from({ length: 8 }, (_, i) => `vault-${i}`);
      for (const name of names) await marked(pool, name, 7);
      assertEqual(pool.names(), names, "every database landed");
      const last = await pool.open("vault-7", "readonly");
      assertEqual(last.prepare("SELECT v FROM marker").all(), [{ v: 7 }], "and reads");
      last.close();
      await pool.close();
    },
  },
  {
    name: "creates started together all land, past the handles the pool had",
    run: async (open) => {
      const pool = await open({ directory: "/create-together" });
      const names = Array.from({ length: 8 }, (_, i) => `vault-${i}`);
      await Promise.all(names.map((name) => marked(pool, name, 3)));
      assertEqual(pool.names(), names, "every database landed");
      for (const name of names) {
        const db = await pool.open(name, "readonly");
        assertEqual(db.prepare("SELECT v FROM marker").all(), [{ v: 3 }], `${name} reads`);
        db.close();
      }
      await pool.close();
    },
  },
  {
    name: "two creates of one name started together: the first lands, the second is refused as taken",
    run: async (open) => {
      const pool = await open({ directory: "/create-twice" });
      const outcomes = await Promise.allSettled([marked(pool, "target", 1), marked(pool, "target", 2)]);
      assertEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "rejected"], "the first lands");
      assertEqual(((outcomes[1] as PromiseRejectedResult).reason as Error).name, "DatabaseExists", "the second is refused as taken");
      const target = await pool.open("target", "readonly");
      assertEqual(target.prepare("SELECT v FROM marker").all(), [{ v: 1 }], "the first one's content");
      target.close();
      await pool.close();
    },
  },
  {
    name: "connections kept open keep the handles their staging and journals will take: each in turn stages and accepts an object past the temporary cache, another opens after them, and every one still writes",
    large: true,
    run: async (open) => {
      const pool = await open({ directory: "/capacity-held" });
      const vaults: ReturnType<typeof createRuntime>[] = [];
      for (let i = 0; i < 4; i++) vaults.push(createRuntime(await pool.open(`vault-${i}`, "create"), { metadata: META, wrapped: WRAPPED }));
      const big = 8 * 1024 * 1024;
      const putAndRead = async (i: number, size: number, seed: number): Promise<void> => {
        const vault = vaults[i];
        if (vault === undefined) throw new Error(`no vault ${i}`);
        const store = new SqliteObjectStore(vault);
        const bytes = pattern(size, seed);
        const info = await store.putRaw(bytes);
        assertEqual(info.size, size, `vault ${i}: the put`);
        const back = await store.read(info.cid, size);
        if (back === null) throw new Error(`vault ${i}: the object is not there`);
        assertBytes(back, bytes, `vault ${i}: the bytes back`);
      };
      for (let i = 0; i < 4; i++) await putAndRead(i, big, 100 + i);
      vaults.push(createRuntime(await pool.open("vault-4", "create"), { metadata: META, wrapped: WRAPPED }));
      await putAndRead(4, big, 104);
      for (let i = 0; i < 5; i++) await putAndRead(i, 1024 * 1024 + 1, 200 + i);
      for (const vault of vaults) vault.close();
      assertEqual(pool.names(), ["vault-0", "vault-1", "vault-2", "vault-3", "vault-4"], "the databases");
      await pool.close();
    },
  },
  {
    name: "a repair whose statement journal outgrows memory finds its handle: with the pool's spare handles taken by databases created beside the open connection, a damaged 32 MiB object is put again with its bytes, read back whole and no longer damaged",
    large: true,
    run: async (open) => {
      const pool = await open({ directory: "/capacity-repair" });
      const vault = createRuntime(await pool.open("vault", "create"), { metadata: META, wrapped: WRAPPED });
      for (let i = 0; i < 3; i++) await marked(pool, `copy-${i}`, i);
      const store = new SqliteObjectStore(vault);
      const size = 32 * 1024 * 1024;
      const object = pattern(size, 31);
      const info = await store.putRaw(object);
      const damage = vault.driver.prepare("UPDATE object_chunks SET bytes = X'00' WHERE cid = ? AND chunk_no = 0");
      try {
        damage.run(info.cid);
      } finally {
        damage.finalize();
      }
      await assertRejects(() => store.read(info.cid, size), "DamagedObject", "the read that finds the damage");
      await assertRejects(() => store.has(info.cid), "DamagedObject", "presence while damaged");
      assertEqual((await store.putObject(info.cid, object)).size, size, "the repair");
      const back = await store.read(info.cid, size);
      if (back === null) throw new Error("the repaired object is not there");
      assertBytes(back, object, "the bytes back");
      assertEqual(await store.has(info.cid), true, "sound again");
      vault.close();
      assertEqual(pool.names(), ["copy-0", "copy-1", "copy-2", "vault"], "the databases");
      await pool.close();
    },
  },
  {
    name: "text SQLite holds that is not text is refused at the read, not repaired",
    run: async (open) => {
      const pool = await open({ directory: "/text" });
      const db = await pool.open("vault", "create");
      db.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT; INSERT INTO t VALUES (1, CAST(X'610062' AS TEXT)), (2, CAST(X'EDA080' AS TEXT)), (3, CAST(X'C3A9' AS TEXT)), (4, '')");
      const select = db.prepare("SELECT s FROM t WHERE k = ?");
      assertThrows(() => select.get(1), "InvalidSqlValue", "a NUL inside");
      assertThrows(() => select.get(2), "InvalidSqlValue", "an encoded surrogate");
      assertEqual(select.get(3), { s: "é" }, "valid text reads");
      assertEqual(select.get(4), { s: "" }, "empty text reads");
      assertThrows(() => db.prepare("SELECT CAST(X'FF' AS TEXT) AS s").get(), "InvalidSqlValue", "from an expression too");
      assertEqual(db.prepare("SELECT typeof(s) AS t FROM t WHERE k = 1").get(), { t: "text" }, "the stored value is left as it is");
      db.close();
      await pool.close();
    },
  },
];
