/**
 * The SQLite object store on whatever the platform's driver is, as
 * cases free of any test framework: run over `node:sqlite` by
 * `objects.test.ts` and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What the conformance suite cannot see —
 * the rows a put leaves, a runtime reopened, a preparation staged
 * beside a read, damage under the store, a repair rolled back, a
 * reused object checked as it publishes — where the two platforms'
 * SQLite must agree.
 */

import { sha256 } from "@noble/hashes/sha2";

import {
  SqliteObjectStore,
  chunksOf,
  createRuntime,
  openInspector,
  openRuntime,
  rawCidFromDigest,
  hashSource,
  sortCids,
  type Cid,
  type OpenMode,
  type SqliteDriver,
  type SqlitePreparation,
} from "../../src/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { type Case, assert, assertBytes, assertEqual, assertRejects, assertThrows, type MemoryHeld } from "./driver-cases.js";

export interface ObjectHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
  memoryUsed?: () => MemoryHeld | Promise<MemoryHeld>;
  /** Deletes the database at `target`, which no connection holds open: a case that made a large one gives the space back, where space is scarce. */
  remove?(target: string): void | Promise<void>;
}

export interface ObjectCase extends Case {
  run(harness: ObjectHarness): Promise<string | void>;
}

const MIB = 1024 * 1024;

/** `n` deterministic bytes from `seed`. */
function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

function cidOf(bytes: Uint8Array): Cid {
  return rawCidFromDigest(sha256(bytes)).text as Cid;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunksOf(stream)) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function listed(store: SqliteObjectStore): Promise<Cid[]> {
  const out: Cid[] = [];
  for await (const cid of store.list()) out.push(cid);
  return out;
}

function rows(driver: SqliteDriver, sql: string, ...params: (string | number | Uint8Array)[]): Record<string, unknown>[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

function exec(driver: SqliteDriver, sql: string, ...params: (string | number | Uint8Array)[]): void {
  const statement = driver.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

/** Flips one byte of the first chunk of `cid`, as a bad sector would. */
function corrupt(driver: SqliteDriver, cid: Cid): void {
  const [row] = rows(driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = 0", cid);
  const bytes = new Uint8Array(row?.["bytes"] as Uint8Array);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  exec(driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = 0", bytes, cid);
}

async function expectDamaged(store: SqliteObjectStore, cid: Cid, what: string): Promise<void> {
  await assertRejects(() => store.has(cid), "DamagedObject", `has ${what}`);
  await assertRejects(() => store.stat(cid), "DamagedObject", `stat ${what}`);
  await assertRejects(() => store.open(cid), "DamagedObject", `open ${what}`);
  await assertRejects(() => store.read(cid, MIB), "DamagedObject", `read ${what}`);
  await assertRejects(() => listed(store), "DamagedObject", `list ${what}`);
}

export const objectCases: ObjectCase[] = [
  {
    name: "an object put in arbitrary chunks is held as 1 MiB chunks numbered from zero, the last shorter, and is read back after a reopen; an empty object has no chunk",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const bytes = bytesOf(2 * MIB + 12_345, 1);
      const cid = cidOf(bytes);
      const info = await store.putRaw(chunked(bytes, 300_007));
      assertEqual(info, { cid, codec: "raw", size: bytes.length }, "the info");
      assertEqual(rows(db.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks WHERE cid = ? ORDER BY chunk_no", cid), [
        { chunk_no: 0, n: MIB },
        { chunk_no: 1, n: MIB },
        { chunk_no: 2, n: 12_345 },
      ], "the chunks");
      assertEqual(rows(db.driver, "SELECT size FROM objects WHERE cid = ?", cid), [{ size: bytes.length }], "the size");
      const empty = await store.putRaw(new Uint8Array(0));
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks WHERE cid = ?", empty.cid), [{ n: 0 }], "no chunk for the empty object");
      assertEqual(rows(db.driver, "SELECT name FROM sqlite_master WHERE name LIKE '%staging%'"), [], "nothing of the staging in the vault's own schema");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteObjectStore(again);
        assertEqual(await reopened.stat(cid), info, "stat after a reopen");
        assertBytes(await drain((await reopened.open(cid)) as ReadableStream<Uint8Array>), bytes, "the bytes after a reopen");
        assertBytes((await reopened.read(empty.cid, 0)) as Uint8Array, new Uint8Array(0), "the empty object after a reopen");
        assertEqual(await reopened.damaged(), [], "no damage");
      } finally {
        again.close();
      }
    },
  },
  {
    name: "a preparation is staged where no read sees it and lands with the transaction it publishes in, or not at all",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const bytes = bytesOf(2 * MIB + 10, 2);
      const cid = cidOf(bytes);
      let published = false;
      const failed = await assertRejects(
        () =>
          store.preparing(async (prepared) => {
            await prepared.putObject(cid, chunked(bytes, 700_001));
            assert(await prepared.has(cid), "prepared here counts as present to the preparation");
            assertEqual(await store.has(cid), false, "not to the store");
            assertEqual(await store.stat(cid), null, "nor its metadata");
            assertEqual(await listed(store), [], "nor in the list");
            assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 0 }], "no chunk in the vault");
            assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 3 }], "three staged in the temporary database");
            try {
              db.driver.transaction("immediate", () => {
                prepared.publish();
                published = rows(db.driver, "SELECT count(*) AS n FROM object_chunks")[0]?.["n"] === 3;
                throw new Error("the commit fails after publishing");
              });
            } catch (err) {
              assertEqual(await store.has(cid), false, "rolled back: absent");
              assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 3 }], "the staging is back too");
              throw err;
            }
          }),
        "Error",
        "the failed commit"
      );
      assertEqual(failed.message, "the commit fails after publishing", "the throw comes back");
      assert(published, "publish moved the chunks inside the transaction");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "dropped with the failed commit");
      await store.preparing(async (again) => {
        await again.putObject(cid, chunked(bytes, MIB));
        db.driver.transaction("immediate", () => again.publish());
      });
      assertEqual(await store.stat(cid), { cid, codec: "raw", size: bytes.length }, "published");
      assertBytes((await store.read(cid, bytes.length)) as Uint8Array, bytes, "and read back");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "nothing staged after");
      db.close();
    },
  },
  {
    name: "bytes that no longer hash to the CID are damage every read and presence check reports until a verified put replaces them; a repair rolled back keeps the old bytes and the damage",
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const bytes = bytesOf(10, 3);
      const cid = cidOf(bytes);
      await store.putRaw(bytes);
      const other = (await store.putRaw(bytesOf(10, 4))).cid;
      corrupt(db.driver, cid);
      assert(await store.has(cid), "nothing has looked yet");
      await assertRejects(() => store.read(cid, 10), "DamagedObject", "the read finds it");
      await expectDamaged(store, cid, "once known");
      assertEqual((await store.damaged()).map((d) => d.where), [`objects/${cid}`], "reported");
      assertBytes((await store.read(other, 10)) as Uint8Array, bytesOf(10, 4), "the other object reads");
      await assertRejects(() => store.putObject(cid, bytesOf(10, 5)), "DigestMismatch", "wrong bytes under the CID");
      await expectDamaged(store, cid, "after a refused repair");
      await assertRejects(
        () =>
          store.preparing(async (prepared) => {
            await prepared.putObject(cid, bytes);
            db.driver.transaction("immediate", () => {
              prepared.publish();
              throw new Error("rolled back");
            });
          }),
        "Error",
        "the repair is rolled back"
      );
      await expectDamaged(store, cid, "after a rolled-back repair");
      const [chunk] = rows(db.driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = 0", cid);
      assert(((chunk?.["bytes"] as Uint8Array)[0] as number) !== (bytes[0] as number), "the old, corrupt bytes are still there");
      assertEqual(await store.putObject(cid, chunked(bytes, 3)), { cid, codec: "raw", size: 10 }, "the repair");
      assertEqual(rows(db.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks WHERE cid = ?", cid), [{ chunk_no: 0, n: 10 }], "one chunk again");
      assertBytes((await store.read(cid, 10)) as Uint8Array, bytes, "sound again");
      assertEqual(await listed(store), sortCids([cid, other]), "listed again");
      assertEqual((await store.damaged()).length, 0, "no damage known");
      corrupt(db.driver, cid);
      await assertRejects(() => store.read(cid, 10), "DamagedObject", "damaged again");
      db.close();
      const again = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        const reopened = new SqliteObjectStore(again);
        assert(await reopened.has(cid), "damage is not persisted: a reopen finds the object until it reads it");
        await assertRejects(() => reopened.read(cid, 10), "DamagedObject", "and finds the damage again");
      } finally {
        again.close();
      }
    },
  },
  {
    name: "an object a preparation declares reused is checked again as it publishes: known damaged by then, the publication throws inside the transaction and nothing staged lands; prepared as well, the repair goes through",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const bytes = bytesOf(10, 6);
      const cid = cidOf(bytes);
      await store.putRaw(bytes);
      const fresh = bytesOf(10, 7);
      const freshCid = cidOf(fresh);
      await assertRejects(
        () =>
          store.preparing(async (prepared) => {
            await prepared.putObject(freshCid, fresh);
            assert(await prepared.has(cid), "sound when the root was checked");
            prepared.reuse(cid);
            corrupt(db.driver, cid);
            await assertRejects(() => store.read(cid, 10), "DamagedObject", "a read finds the damage before the transaction");
            try {
              db.driver.transaction("immediate", () => prepared.publish());
            } catch (err) {
              assertEqual(await store.has(freshCid), false, "the staged object did not land");
              assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 1 }], "still staged");
              throw err;
            }
          }),
        "DamagedObject",
        "the publication refuses"
      );
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "dropped with the refused commit");
      await store.preparing(async (repairing) => {
        await repairing.putObject(freshCid, fresh);
        await repairing.putObject(cid, bytes);
        repairing.reuse(cid);
        db.driver.transaction("immediate", () => repairing.publish());
      });
      assertBytes((await store.read(cid, 10)) as Uint8Array, bytes, "repaired by the same publication");
      assertEqual(await store.has(freshCid), true, "the new object landed with it");
      await store.preparing(async (prepared) => {
        assertThrows(() => prepared.reuse("nope" as Cid), "InvalidCid", "a reuse of no CID");
      });
      db.close();
    },
  },
  {
    name: "a commit that fails while a put through its preparation is still reading waits for that put, then drops what it staged, and the staging bound is free again",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const bytes = bytesOf(10, 43);
      const cid = cidOf(bytes);
      const store = new SqliteObjectStore(db, { maxStagedBytes: bytes.length });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* slow(): AsyncIterable<Uint8Array> {
        await gate;
        yield bytes;
      }
      const failing = store.preparing(async (prepared) => {
        await Promise.all([prepared.putObject(cid, slow()), prepared.putObject(cid, bytesOf(10, 44))]);
      });
      const early = await Promise.race([
        failing.then(
          () => "resolved",
          () => "rejected"
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      assertEqual(early, "waiting", "the failed commit waits for the put still reading");
      release();
      await assertRejects(() => failing, "DigestMismatch", "the commit");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "what the late put staged is dropped");
      assertEqual(await store.putRaw(bytes), { cid, codec: "raw", size: bytes.length }, "the bound is free for the next put");
      db.close();
    },
  },
  {
    name: "a preparation takes nothing more once it has published and nothing at all once its commit has ended; a refusal reads no source and stages nothing",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const bytes = bytesOf(10, 45);
      const cid = cidOf(bytes);
      const other = bytesOf(10, 46);
      const otherCid = cidOf(other);
      let pulled = false;
      async function* source(): AsyncIterable<Uint8Array> {
        pulled = true;
        yield other;
      }
      const published = await store.preparing(async (prepared) => {
        await prepared.putObject(cid, bytes);
        db.driver.transaction("immediate", () => prepared.publish());
        const late = await assertRejects(() => prepared.putObject(otherCid, source()), "Error", "a put once published");
        assert(late.message.includes("has published"), `the refusal says why: ${late.message}`);
        await assertRejects(() => prepared.putRaw(source()), "Error", "a raw put once published");
        assertThrows(() => prepared.reuse(cid), "Error", "a reuse once published");
        assertThrows(() => db.driver.transaction("immediate", () => prepared.publish()), "Error", "a second publication");
        assert(await prepared.has(cid), "a presence check still answers");
        return prepared;
      });
      const unpublished = await store.preparing(async (prepared) => {
        await prepared.putObject(otherCid, other);
        return prepared;
      });
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "the unpublished staging is dropped");
      const refusedAfter = async (ended: SqlitePreparation, what: string): Promise<void> => {
        const late = await assertRejects(() => ended.putObject(otherCid, source()), "Error", `a put after the ${what} commit`);
        assert(late.message.includes("ended with its commit"), `the refusal says why: ${late.message}`);
        await assertRejects(() => ended.has(otherCid), "Error", `a presence check after the ${what} commit`);
        assertThrows(() => ended.reuse(cid), "Error", `a reuse after the ${what} commit`);
        assertThrows(() => db.driver.transaction("immediate", () => ended.publish()), "Error", `a publication after the ${what} commit`);
      };
      await refusedAfter(published, "published");
      await refusedAfter(unpublished, "unpublished");
      assert(!pulled, "no refused put read its source");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "nothing staged");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM objects"), [{ n: 1 }], "only the published object accepted");
      assertEqual(await store.has(otherCid), false, "not the unpublished one");
      db.close();
    },
  },
  {
    name: "an object whose chunks are not the layout — one missing, one short, one surplus, a chunk under an empty object, a size that is no count — is damage, and a verified put replaces the whole set",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const hello = new TextEncoder().encode("hello");
      const long = bytesOf(2 * MIB + 10, 11);
      const layout = (cid: Cid): unknown[] => rows(db.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks WHERE cid = ? ORDER BY chunk_no", cid);
      const cases: { what: string; bytes: Uint8Array; damage: (cid: Cid) => void; error: RegExp }[] = [
        { what: "a chunk missing", bytes: long, damage: (cid) => exec(db.driver, "DELETE FROM object_chunks WHERE cid = ? AND chunk_no = 1", cid), error: /chunk 1 is missing/ },
        { what: "a surplus chunk after the last", bytes: long, damage: (cid) => exec(db.driver, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 3, x'00')", cid), error: /4 chunk\(s\) are stored where the object's 2097162 bytes take 3/ },
        { what: "a surplus chunk after a gap", bytes: hello, damage: (cid) => exec(db.driver, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 2, x'00')", cid), error: /2 chunk\(s\) are stored where the object's 5 bytes take 1/ },
        { what: "a chunk under an empty object", bytes: new Uint8Array(0), damage: (cid) => exec(db.driver, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 1, x'00')", cid), error: /1 chunk\(s\) are stored where the object's 0 bytes take 0/ },
        {
          what: "an interior chunk short of the chunk size",
          bytes: hello,
          damage: (cid) => {
            exec(db.driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = 0", hello.subarray(0, 2), cid);
            exec(db.driver, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 1, ?)", cid, hello.subarray(2));
          },
          error: /chunk 0 holds 2 bytes, not the 5 the layout gives it/,
        },
        { what: "a size the chunks run past", bytes: long, damage: (cid) => exec(db.driver, "UPDATE objects SET size = 9 WHERE cid = ?", cid), error: /chunk 0 holds 1048576 bytes, not the 9/ },
        { what: "a size past the safe integer range", bytes: hello, damage: (cid) => exec(db.driver, "UPDATE objects SET size = 9007199254740992 WHERE cid = ?", cid), error: /size 9007199254740992 is not a count/ },
      ];
      const sound = (await store.putRaw(bytesOf(10, 12))).cid;
      for (const c of cases) {
        const store = new SqliteObjectStore(db);
        const cid = (await store.putRaw(chunked(c.bytes, 999_999))).cid;
        const before = layout(cid);
        c.damage(cid);
        await assertRejects(() => store.read(cid, long.length), "DamagedObject", `${c.what}: read`);
        await expectDamaged(store, cid, c.what);
        const [damage] = await store.damaged();
        assertEqual(damage?.where, `objects/${cid}`, `${c.what}: reported`);
        assert(c.error.test(damage?.error ?? ""), `${c.what}: named: ${damage?.error ?? ""}`);
        assertEqual(await store.putObject(cid, chunked(c.bytes, 999_999)), { cid, codec: "raw", size: c.bytes.length }, `${c.what}: the repair`);
        assertEqual(layout(cid), before, `${c.what}: the layout is whole again`);
        assertEqual(rows(db.driver, "SELECT size FROM objects WHERE cid = ?", cid), [{ size: c.bytes.length }], `${c.what}: the size too`);
        assertBytes((await store.read(cid, c.bytes.length)) as Uint8Array, c.bytes, `${c.what}: and the bytes`);
        assertEqual(await store.damaged(), [], `${c.what}: no damage known`);
        exec(db.driver, "DELETE FROM object_chunks WHERE cid = ?", cid);
        exec(db.driver, "DELETE FROM objects WHERE cid = ?", cid);
      }
      assertBytes((await store.read(sound, 10)) as Uint8Array, bytesOf(10, 12), "the sound object read throughout");
      db.close();
    },
  },
  {
    name: "collection deletes the unkept, damaged among them, keeps a damaged held object with its damage, and a stream open on a removed object fails explicitly",
    run: async (h) => {
      const db = createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db);
      const keptDamaged = (await store.putRaw(bytesOf(10, 21))).cid;
      const goneDamaged = (await store.putRaw(bytesOf(10, 22))).cid;
      const kept = (await store.putRaw(bytesOf(10, 23))).cid;
      const gone = (await store.putRaw(bytesOf(MIB + 5, 24))).cid;
      corrupt(db.driver, keptDamaged);
      corrupt(db.driver, goneDamaged);
      await assertRejects(() => store.read(keptDamaged, 10), "DamagedObject", "found");
      await assertRejects(() => store.read(goneDamaged, 10), "DamagedObject", "found");
      const reader = ((await store.open(gone)) as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      assertEqual(first.done, false, "the first chunk is out");
      const { removed } = await store.collect([kept, keptDamaged]);
      assertEqual(removed, sortCids([gone, goneDamaged]), "removed: the unkept, the damaged one among them");
      await assertRejects(() => reader.read(), "InterruptedRead", "the stream open on a removed object");
      assertEqual(await store.has(gone), false, "absent");
      assertEqual(await store.has(goneDamaged), false, "absent, its damage no longer reported as damage");
      await expectDamaged(store, keptDamaged, "the kept damaged object");
      assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 2 }], "the chunks of the two kept objects");
      assertEqual((await store.damaged()).map((d) => d.where), [`objects/${keptDamaged}`], "only the kept damage remains");
      await store.putObject(keptDamaged, bytesOf(10, 21));
      assertEqual(await listed(store), sortCids([kept, keptDamaged]), "both list once repaired");
      db.close();
    },
  },
  {
    name: "an inspector's store reads and refuses every write before reading a source",
    run: async (h) => {
      const target = h.fresh();
      const made = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const bytes = bytesOf(10, 31);
      const cid = (await new SqliteObjectStore(made).putRaw(bytes)).cid;
      made.close();
      const db = openInspector(await h.open(target, "readwrite"));
      try {
        const store = new SqliteObjectStore(db);
        assertBytes((await store.read(cid, 10)) as Uint8Array, bytes, "reads");
        assertEqual(await listed(store), [cid], "lists");
        let pulled = false;
        async function* source(): AsyncIterable<Uint8Array> {
          pulled = true;
          yield bytes;
        }
        await assertRejects(() => store.putRaw(source()), "ReadOnlyVault", "putRaw");
        await assertRejects(() => store.putObject(cid, source()), "ReadOnlyVault", "putObject");
        await assertRejects(() => store.preparing((prepared) => prepared.putObject(cid, source())), "ReadOnlyVault", "a preparation's putObject");
        await assertRejects(() => store.collect([]), "ReadOnlyVault", "collect");
        assert(!pulled, "no source was read");
        assert(await store.has(cid), "still there");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "staging goes to the temporary database's file under a bounded cache, so neither what JavaScript nor what SQLite holds grows with the object — and told to cache the whole staging, SQLite does; a put past the staging bound is refused with nothing staged",
    large: true,
    run: async (h) => {
      const target = h.fresh();
      const db = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const store = new SqliteObjectStore(db, { maxStagedBytes: 40 * MIB });
      assertEqual(rows(db.driver, "PRAGMA temp_store"), [{ temp_store: 1 }], "the temporary database is on a file");
      const total = 24;
      async function* reusing(): AsyncIterable<Uint8Array> {
        const chunk = new Uint8Array(MIB); // one buffer, refilled: nothing here holds the object
        for (let i = 0; i < total; i++) {
          chunk.fill(i + 1);
          yield chunk;
        }
      }
      const { cid } = await hashSource(reusing(), total * MIB, () => undefined);
      const sampled = (samples: MemoryHeld[]): AsyncIterable<Uint8Array> =>
        (async function* () {
          let i = 0;
          for await (const chunk of reusing()) {
            yield chunk;
            i += 1;
            if (i % 8 === 0 && h.memoryUsed !== undefined) samples.push(await h.memoryUsed());
          }
        })();
      const grew = (samples: MemoryHeld[], of: keyof MemoryHeld): number | undefined => {
        const [at8, , at24] = samples;
        return at8?.[of] === undefined || at24?.[of] === undefined ? undefined : at24[of] - at8[of];
      };
      const shown = (samples: MemoryHeld[]): string => samples.map((held) => `${(held.javascript / MIB).toFixed(1)}${held.sqlite === undefined ? "" : ` / SQLite ${(held.sqlite / MIB).toFixed(1)}`}`).join(", ");
      const samples: MemoryHeld[] = [];
      let note: string | undefined;
      await store.preparing(async (prepared) => {
        await prepared.putObject(cid.text as Cid, sampled(samples));
        assertEqual(rows(db.driver, "SELECT count(*) AS n, sum(length(bytes)) AS bytes FROM temp.staging_chunks"), [{ n: total, bytes: total * MIB }], "staged whole");
        assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 0 }], "none accepted");
        if (samples.length === 3) {
          note = `held ${shown(samples)} MiB at 8, 16 and 24 MiB staged`;
          const javascript = grew(samples, "javascript");
          assert(javascript !== undefined && javascript < 4 * MIB, `what JavaScript holds does not grow with the staging: ${note}`);
          const sqlite = grew(samples, "sqlite");
          if (sqlite !== undefined) {
            assert(sqlite < 4 * MIB, `what SQLite holds does not grow with the staging: ${note}`);
            // The same staging under a temporary cache the size of the object: the bound above is the cache's doing, and the measure sees the cache fill.
            const cachingTarget = h.fresh();
            const caching = createRuntime(await h.open(cachingTarget, "create"), { metadata: META, wrapped: WRAPPED });
            try {
              const cachingStore = new SqliteObjectStore(caching, { maxStagedBytes: 40 * MIB });
              const small = bytesOf(16, 3);
              await cachingStore.preparing((staging) => staging.putObject(cidOf(small), small)); // the first staging sets the temporary database's bounded cache; enlarged from here
              caching.driver.exec(`PRAGMA temp.cache_size = -${32 * 1024}`);
              const cached: MemoryHeld[] = [];
              await cachingStore.preparing((staging) => staging.putObject(cid.text as Cid, sampled(cached)));
              const cachedSqlite = grew(cached, "sqlite");
              assert(cachedSqlite !== undefined && cachedSqlite >= 12 * MIB, `told to cache the staging, SQLite holds it: held ${shown(cached)} MiB at 8, 16 and 24 MiB staged`);
              note += `; told to cache, SQLite held ${shown(cached)} MiB`;
            } finally {
              caching.close();
              await h.remove?.(cachingTarget);
            }
          }
        }
        await store.preparing(async (other) => {
          await assertRejects(() => other.putObject(cid.text as Cid, reusing()), "StagingFull", "a second put past the bound");
          assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: total }], "nothing of it staged");
          db.driver.transaction("immediate", () => prepared.publish());
          assertEqual(rows(db.driver, "SELECT count(*) AS n FROM temp.staging_chunks"), [{ n: 0 }], "the staging is empty once published");
          assertEqual(rows(db.driver, "SELECT count(*) AS n FROM object_chunks WHERE cid = ?", cid.text), [{ n: total }], "accepted");
          assertEqual(await other.putObject(cid.text as Cid, reusing()), { cid: cid.text, codec: "raw", size: total * MIB }, "and the bound is free again");
        });
      });
      db.close();
      await h.remove?.(target);
      return note;
    },
  },
];
