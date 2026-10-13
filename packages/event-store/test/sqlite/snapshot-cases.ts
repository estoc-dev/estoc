/**
 * The CAR snapshot on whatever the platform's driver is, as cases free
 * of any test framework: run over `node:sqlite` by `snapshot.test.ts`
 * and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What the two platforms must agree on: the
 * range an export reads in the lock that fixes its cut; restores of
 * the seed alone and of both parts, and an import of the content,
 * holding the same events and objects; the restored runtime a replica
 * of its own and the import placing what it adds by the target's
 * acceptance; a block both an event and an object, restored and
 * imported as both; a part missing, refused before anything is
 * written; a restore failing at any statement; an export over damage;
 * the export's bound, met before an object is read; a SQLite file
 * refused; and the snapshot owning its bytes, taken from the caller
 * and handed out only as copies.
 */

import {
  Connection,
  MemoryVault,
  SqliteError,
  SqliteVault,
  Snapshot,
  canonicalEventBytes,
  chunksOf,
  compareEvents,
  createRuntime,
  exportSnapshot,
  importSnapshot,
  openInspector,
  openRuntime,
  restoreSnapshot,
  type Cid,
  type Event,
  type ExportSnapshotOptions,
  type Held,
  type HeldRoots,
  type RawConnection,
  type SqliteDriver,
  type VaultRuntime,
} from "../../src/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { authorN } from "../suite/helpers.js";
import { type Case, assert, assertBytes, assertEqual, assertRejects, rawOver } from "./driver-cases.js";
import { destination, type ExportHarness } from "./export-cases.js";
import { HELLO, HELLO_CID, MIB, WORLD, WORLD_CID, all, bytesOf, cidOf, clock, corruptChunk, damageEvent, draft, make, retainedOf, rootsOf, rows } from "./vault-cases.js";

export interface SnapshotCase extends Case {
  run(harness: ExportHarness): Promise<string | void>;
}

const ENROLLMENT = "test.enrollment";
const SEED_TYPES = new Set([ENROLLMENT]);
const ACROSS = bytesOf(MIB + 1, 3);
const ACROSS_CID = cidOf(ACROSS);

/**
 * A SQLite vault holding an enrollment event of its own over hello,
 * one of another author's, an event over hello and world and one over
 * an object across a chunk boundary.
 */
async function filled(h: ExportHarness, target = h.fresh()): Promise<{ vault: SqliteVault; driver: SqliteDriver; events: Event[] }> {
  const c = clock();
  const { vault, driver } = await make(h, target, c.now);
  const own = await vault.vault.commit(
    [
      { cid: HELLO_CID, source: HELLO },
      { cid: WORLD_CID, source: WORLD },
      { cid: ACROSS_CID, source: ACROSS },
    ],
    [
      { type: ENROLLMENT, roots: [HELLO_CID], data: { i: 0 } },
      { type: "test.event", roots: [HELLO_CID, WORLD_CID], data: { i: 1 } },
      { type: "test.event", roots: [ACROSS_CID], data: { i: 2 } },
    ]
  );
  c.advance(1000);
  const other = new MemoryVault({ metadata: META, wrapped: WRAPPED, author: authorN(7), now: c.now });
  const foreign = await other.vault.commit([], [{ type: ENROLLMENT, roots: [], data: { from: "elsewhere" } }]);
  await vault.ingest(foreign);
  return { vault, driver, events: [...own, ...foreign] };
}

const read = async (bytes: Uint8Array | Promise<Uint8Array>): Promise<Snapshot> => Snapshot.read(await bytes, { heldRoots: rootsOf });

const exported = (runtime: VaultRuntime, parts: "seed" | "content" | "both"): Promise<Uint8Array> =>
  exportSnapshot(runtime, parts === "seed" ? { parts, types: SEED_TYPES, heldRoots: rootsOf } : { parts, heldRoots: rootsOf });

/** What a runtime holds, read through its vault: every event by CID and author, every object by CID and size, each object read through, which rehashes it. */
async function held(runtime: VaultRuntime): Promise<{ events: string[][]; objects: (string | number)[][] }> {
  const events = (await all(runtime.vault.events.scan())).map((event) => [event.cid, event.author]);
  const objects: (string | number)[][] = [];
  for (const cid of await all(runtime.vault.objects.list())) {
    const bytes = await runtime.vault.objects.read(cid, 2 * MIB);
    assert(bytes !== null, `${cid} reads`);
    objects.push([cid, bytes.length]);
  }
  return { events, objects };
}

const problemsOf = (err: Error): { where: string; error: string }[] => (err as unknown as { problems: { where: string; error: string }[] }).problems;

const lastSeqOf = (driver: SqliteDriver): unknown => rows(driver, "SELECT last_seq FROM store_state")[0]?.["last_seq"];

/** `inner`, opened to create, as a connection whose `n`-th statement run fails as a bad disk would; `n` past the last run fails nothing. */
function failingCreate(inner: SqliteDriver, n: number): SqliteDriver {
  const raw = rawOver(inner);
  let count = 0;
  const failing: RawConnection = {
    ...raw,
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        ...statement,
        run: (params) => {
          if (++count === n) throw new SqliteError(10, "disk I/O error");
          return statement.run(params);
        },
      };
    },
  };
  return new Connection(failing, "create");
}

/** `runtime` with every locked operation's object reads counted, and the folds an export runs. */
function counted(runtime: VaultRuntime): { runtime: VaultRuntime; opened: () => number } {
  let opens = 0;
  const watched = new Proxy(runtime, {
    get: (target, property) => {
      if (property !== "locked") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return <T>(op: (held: Held) => Promise<T>): Promise<T> =>
        target.locked((held) =>
          op(
            new Proxy(held, {
              get: (inner, member) => {
                if (member !== "objects") {
                  const value = Reflect.get(inner, member, inner) as unknown;
                  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(inner) : value;
                }
                return {
                  ...inner.objects,
                  open: (cid: Cid) => {
                    opens += 1;
                    return inner.objects.open(cid);
                  },
                };
              },
            })
          )
        );
    },
  });
  return { runtime: watched, opened: () => opens };
}

export const snapshotCases: SnapshotCase[] = [
  {
    name: "an export's range names the exporting runtime's replica and generation and runs from 0 to the last_seq of its control row, read in the lock that fixes the cut: a commit issued while the cut is folded lands after the export and outside the range; an inspector's export names the runtime it inspects",
    run: async (h) => {
      const target = h.fresh();
      const { vault, driver, events } = await filled(h, target);
      assertEqual(lastSeqOf(driver), events.length, "a position for every event");
      let pending: Promise<unknown> | undefined;
      const bytes = await exportSnapshot(vault, {
        parts: "content",
        heldRoots: async (v) => {
          pending ??= vault.vault.commit([], [draft([], { during: true })]);
          return rootsOf(v);
        },
      });
      assert(pending !== undefined, "the fold ran");
      const snapshot = await read(bytes);
      assertEqual(snapshot.content, { replica: vault.author, generation: vault.generation, after: 0, through: events.length }, "the range of the cut");
      assertEqual(snapshot.events, events.length, "the cut's events, every author's");
      await pending;
      assertEqual(lastSeqOf(driver), events.length + 1, "the commit landed after the export");
      assertEqual((await read(exported(vault, "both"))).content?.through, events.length + 1, "the next export's range takes it in");
      assertEqual((await read(exported(vault, "seed"))).content, undefined, "the seed alone has no range");
      const { author, generation } = vault;
      await vault.close();
      const inspector = new SqliteVault(openInspector(await h.open(target, "readwrite")));
      try {
        assertEqual((await read(exported(inspector, "content"))).content, { replica: author, generation, after: 0, through: events.length + 1 }, "an inspector's export names the runtime it inspects");
      } finally {
        await inspector.close();
      }
    },
  },
  {
    name: "the seed and the content restored together, and the seed restored with the content imported into it, both hold the events and objects of the vault exported; the content imported again adds nothing",
    run: async (h) => {
      const { vault, events } = await filled(h);
      const expected = await held(vault);
      const both = await read(exported(vault, "both"));
      const seed = await read(exported(vault, "seed"));
      const content = await read(exported(vault, "content"));
      await vault.close();
      const together = new SqliteVault((await restoreSnapshot(both, destination(h, h.fresh()), { anchor: ANCHOR })).runtime);
      const seeded = new SqliteVault((await restoreSnapshot(seed, destination(h, h.fresh()), { anchor: ANCHOR })).runtime);
      try {
        const enrolled = events.filter((event) => event.type === ENROLLMENT).length;
        assertEqual((await held(seeded)).events.length, enrolled, "the seed alone restores the enrollment events");
        assertEqual(
          await importSnapshot(seeded, content, { retainedRoots: retainedOf }),
          { added: events.length - enrolled, duplicates: enrolled, objects: 2, repaired: 0, range: content.content },
          "the content imported into the seed"
        );
        assertEqual(await held(together), expected, "the seed and the content restored together");
        assertEqual(await held(seeded), expected, "the seed restored, the content imported");
        assertEqual(await importSnapshot(together, content, { retainedRoots: retainedOf }), { added: 0, duplicates: events.length, objects: 0, repaired: 0, range: content.content }, "the content again");
      } finally {
        for (const restored of [together, seeded]) await restored.close();
      }
    },
  },
  {
    name: "a restored runtime is a replica of its own — a new replica ID and generation, positions from 1 in canonical order — and an import takes neither the source's positions nor its token: what it adds is placed after the target's own in the order it accepts them, last_seq moves with them, and a token from before the import reads exactly them",
    run: async (h) => {
      const { vault, events } = await filled(h);
      const both = await read(exported(vault, "both"));
      const content = await read(exported(vault, "content"));
      const source = { author: vault.author, generation: vault.generation };
      await vault.close();
      const canonical = [...events].sort(compareEvents);
      const { runtime } = await restoreSnapshot(both, destination(h, h.fresh()), { anchor: ANCHOR });
      const restored = new SqliteVault(runtime);
      try {
        assert(restored.author !== source.author && restored.generation !== source.generation, "a fresh replica ID and generation");
        assertEqual(rows(runtime.driver, "SELECT replica_id, store_generation, last_seq FROM store_state"), [{ replica_id: restored.author, store_generation: restored.generation, last_seq: events.length }], "the control row is its own");
        assertEqual(rows(runtime.driver, "SELECT accepted_seq, cid FROM event_positions ORDER BY accepted_seq"), canonical.map((event, i) => ({ accepted_seq: i + 1, cid: event.cid })), "positions from 1, in canonical order");
        assertEqual((await read(exported(restored, "content"))).content, { replica: restored.author, generation: restored.generation, after: 0, through: events.length }, "its own range");
      } finally {
        await restored.close();
      }
      const c = clock();
      c.advance(3_600_000);
      const { vault: target, driver } = await make(h, h.fresh(), c.now);
      try {
        const mine = await target.vault.commit([], [draft([], { mine: 0 }), draft([], { mine: 1 })]);
        const { token } = await target.vault.events.changes();
        const outcome = await importSnapshot(target, content, { retainedRoots: retainedOf });
        assertEqual(outcome.range, { replica: source.author, generation: source.generation, after: 0, through: events.length }, "the range handed back is the source's");
        assertEqual(rows(driver, "SELECT replica_id, store_generation, last_seq FROM store_state"), [{ replica_id: target.author, store_generation: target.generation, last_seq: mine.length + events.length }], "the target's control, last_seq moved by what was added");
        assertEqual(
          rows(driver, "SELECT cid FROM event_positions WHERE accepted_seq > ? ORDER BY accepted_seq", mine.length).map((row) => row["cid"]),
          canonical.map((event) => event.cid),
          "the added events placed after the target's own, in the order accepted"
        );
        assertEqual((await all((await target.vault.events.changes(undefined, token)).events)).map((event) => event.cid).sort(), events.map((event) => event.cid).sort(), "a token from before reads exactly what was added");
      } finally {
        await target.close();
      }
    },
  },
  {
    name: "a block both an event and an object the events hold is restored and imported as both",
    run: async (h) => {
      const { vault } = await make(h, h.fresh(), clock().now);
      const [first] = (await vault.vault.commit([], [draft([], { i: 0 })])) as [Event];
      const asObject = first.cid as string as Cid;
      await vault.vault.commit([{ cid: asObject, source: canonicalEventBytes(first) }], [draft([asObject], { i: 1 })]);
      const both = await read(exported(vault, "both"));
      const content = await read(exported(vault, "content"));
      await vault.close();
      const restored = new SqliteVault((await restoreSnapshot(both, destination(h, h.fresh()), { anchor: ANCHOR })).runtime);
      const target = new SqliteVault(createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
      try {
        assertEqual(await importSnapshot(target, content, { retainedRoots: retainedOf }), { added: 2, duplicates: 0, objects: 1, repaired: 0, range: content.content }, "the import");
        for (const [what, runtime] of [
          ["the restore", restored],
          ["the import", target],
        ] as const) {
          assert((await all(runtime.vault.events.scan({ cid: first.cid }))).length === 1, `${what}: the event`);
          assertBytes((await runtime.vault.objects.read(asObject, 1000)) as Uint8Array, canonicalEventBytes(first), `${what}: the object`);
        }
      } finally {
        await restored.close();
        await target.close();
      }
    },
  },
  {
    name: "a snapshot without the part an operation needs is refused as MissingPart before anything is written: a restore of the content alone makes no destination and asks for no credential, and an import of the seed alone leaves the target as it was",
    run: async (h) => {
      const { vault, driver } = await filled(h);
      const seed = await read(exported(vault, "seed"));
      const content = await read(exported(vault, "content"));
      try {
        const open = destination(h, h.fresh());
        let asked = false;
        const restoring = await assertRejects(
          () =>
            restoreSnapshot(content, open, {
              anchor: () => {
                asked = true;
                return ANCHOR;
              },
            }),
          "MissingPart",
          "a restore of the content alone"
        );
        assertEqual([(restoring as unknown as { part: string }).part, open.created, asked], ["seed", 0, false], "the seed part named, no destination made, no credential asked");
        const before = rows(driver, "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM objects) AS objects, (SELECT last_seq FROM store_state) AS last_seq");
        const target = h.fresh();
        const { vault: fresh, driver: freshDriver } = await make(h, target, clock().now);
        try {
          const importing = await assertRejects(() => importSnapshot(fresh, seed, { retainedRoots: retainedOf }), "MissingPart", "an import of the seed alone");
          assertEqual((importing as unknown as { part: string }).part, "content", "the content part named");
          assertEqual(rows(freshDriver, "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM objects) AS objects, (SELECT last_seq FROM store_state) AS last_seq"), [{ events: 0, objects: 0, last_seq: 0 }], "the target as it was");
        } finally {
          await fresh.close();
        }
        assertEqual(rows(driver, "SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM objects) AS objects, (SELECT last_seq FROM store_state) AS last_seq"), before, "the source as it was");
      } finally {
        await vault.close();
      }
    },
  },
  {
    name: "a restore that fails at any statement once its destination is made leaves the destination closed and unready, opening as nothing; past the last statement it completes",
    run: async (h) => {
      const { vault } = await filled(h);
      const both = await read(exported(vault, "both"));
      const expected = await held(vault);
      await vault.close();
      let failures = 0;
      for (let n = 1; ; n++) {
        assert(n < 1000, "the restore completes within a thousand statements");
        const target = h.fresh();
        let given: SqliteDriver | undefined;
        let restored;
        try {
          restored = await restoreSnapshot(both, async () => (given = failingCreate(await h.open(target, "create"), n)), { anchor: ANCHOR });
        } catch (err) {
          assert(err instanceof Error && err.name === "SqliteError", `statement ${n}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
          await assertRejects(async () => given?.exec("SELECT 1"), "DatabaseClosed", `statement ${n}: the destination is closed`);
          await assertRejects(async () => openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR }), "NotAVault", `statement ${n}: the destination opens as nothing`);
          failures += 1;
          continue;
        }
        const copy = new SqliteVault(restored.runtime);
        try {
          assertEqual(await held(copy), expected, "the restore past the last statement");
        } finally {
          await copy.close();
        }
        break;
      }
      assert(failures > 5, `a failure at each statement: ${failures}`);
      return `${failures} statements failed in turn`;
    },
  },
  {
    name: "an export over damage is refused as IncompleteSnapshot naming it: an object whose bytes fail as they are written, and once that damage is known before a byte is; an event row that no longer decodes, whatever the parts",
    run: async (h) => {
      const { vault, driver, events } = await filled(h);
      try {
        corruptChunk(driver, ACROSS_CID, 1);
        const writing = await assertRejects(() => exported(vault, "content"), "IncompleteSnapshot", "an object failing as it is written");
        assertEqual(problemsOf(writing).map((problem) => problem.where), [`objects/${ACROSS_CID}`], "the object named");
        const known = await assertRejects(() => exported(vault, "both"), "IncompleteSnapshot", "an object known damaged");
        assertEqual(problemsOf(known), [{ where: `objects/${ACROSS_CID}`, error: `the bytes held for ${ACROSS_CID} no longer hash to it` }], "named before a byte is written");
        assertEqual((await read(exported(vault, "seed"))).objects, 1, "the seed alone, whose events do not hold it, exports");
        damageEvent(driver, events[1] as Event);
        for (const parts of ["seed", "content", "both"] as const) {
          const history = await assertRejects(() => exported(vault, parts), "IncompleteSnapshot", `${parts}: a damaged history`);
          assertEqual(problemsOf(history).length, 1, `${parts}: the damaged row named`);
        }
      } finally {
        await vault.close();
      }
    },
  },
  {
    name: "an export past its bound is refused as SnapshotTooLarge before an object is read: past the events' tally before an event is read, past the selected events before the fold runs, and past the CAR's length before its first object; at the CAR's length it is written whole",
    run: async (h) => {
      const { vault, events } = await filled(h);
      try {
        const { runtime, opened: opens } = counted(vault);
        let folds = 0;
        const options = (parts: "seed" | "content" | "both", maxBytes: number): ExportSnapshotOptions => {
          const heldRoots: HeldRoots = (v) => {
            folds += 1;
            return rootsOf(v);
          };
          return parts === "seed" ? { parts, types: SEED_TYPES, heldRoots, maxBytes } : { parts, heldRoots, maxBytes };
        };
        const tooLarge = async (what: string, parts: "seed" | "content" | "both", maxBytes: number): Promise<number> => {
          const err = await assertRejects(() => exportSnapshot(runtime, options(parts, maxBytes)), "SnapshotTooLarge", what);
          return (err as unknown as { bytes: number }).bytes;
        };
        const { bytes: tallied } = await vault.locked((held) => held.tally());
        assertEqual(await tooLarge("past the tally", "content", tallied - 1), tallied, "the tally named");
        assertEqual([folds, opens()], [0, 0], "past the tally: no fold, no object read");
        const selected = events.filter((event) => event.type === ENROLLMENT).reduce((n, event) => n + canonicalEventBytes(event).length, 0);
        assertEqual(await tooLarge("past the selected events", "seed", selected - 1), selected, "the selected events' bytes named");
        assertEqual([folds, opens()], [0, 0], "past the selected events: no fold, no object read");
        const whole = await exportSnapshot(vault, { parts: "both", heldRoots: rootsOf });
        assertEqual(await tooLarge("past the CAR's length", "both", whole.length - 1), whole.length, "the CAR's length named");
        assertEqual([folds, opens()], [1, 0], "past the CAR's length: the fold ran, no object read");
        assertEqual((await exportSnapshot(runtime, options("both", whole.length))).length, whole.length, "at the CAR's length");
        assertEqual(opens(), 3, "every object read once");
      } finally {
        await vault.close();
      }
    },
  },
  {
    name: "a SQLite file, as a backup of the earlier format is, is no CAR: refused as InvalidSnapshot",
    run: async () => {
      const file = new Uint8Array(4096);
      file.set(new TextEncoder().encode("SQLite format 3\0"));
      const err = await assertRejects(() => read(file), "InvalidSnapshot", "the SQLite file");
      assertEqual((err as unknown as { problems: { where: string }[] }).problems.map((problem) => problem.where), ["car"], "refused as a container");
    },
  },
  {
    name: "a read takes its input over: a view of a whole buffer is detached from the caller, a view of part of a larger one or of a shared buffer is copied, and what the caller does with its bytes afterwards changes nothing the snapshot reads, restores or imports",
    run: async (h) => {
      const { vault } = await filled(h);
      const bytes = await exported(vault, "both");
      const expected = await held(vault);
      await vault.close();
      const whole = bytes.slice();
      const { buffer } = whole;
      await read(whole);
      assertEqual([whole.byteLength, buffer.byteLength], [0, 0], "the caller's view and buffer detached");
      const larger = new Uint8Array(bytes.length + 16);
      larger.set(bytes, 8);
      const part = larger.subarray(8, 8 + bytes.length);
      const fromPart = await read(part);
      assertEqual(part.byteLength, bytes.length, "a part of a larger buffer is left to the caller");
      assertBytes(part, bytes, "and left as it was");
      larger.fill(0);
      let note: string | undefined;
      const sources: [string, Snapshot][] = [["a part of a larger buffer", fromPart]];
      if (typeof SharedArrayBuffer === "function") {
        const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
        shared.set(bytes);
        const fromShared = await read(shared);
        shared.fill(0);
        sources.push(["a shared buffer", fromShared]);
      } else note = "no SharedArrayBuffer here: the shared input is not tried";
      for (const [what, snapshot] of sources) {
        assertBytes((await snapshot.vault.objects.read(ACROSS_CID, ACROSS.length)) as Uint8Array, ACROSS, `${what}: the object reads as it was`);
        const restored = new SqliteVault((await restoreSnapshot(snapshot, destination(h, h.fresh()), { anchor: ANCHOR })).runtime);
        try {
          assertEqual(await held(restored), expected, `${what}: the restore`);
        } finally {
          await restored.close();
        }
      }
      return note;
    },
  },
  {
    name: "what a snapshot hands out is a copy: a read's result and a stream's chunks changed by the caller change neither a later read nor what a restore or an import lays",
    run: async (h) => {
      const { vault } = await filled(h);
      const snapshot = await read(exported(vault, "both"));
      const expected = await held(vault);
      await vault.close();
      const first = await snapshot.vault.objects.read(ACROSS_CID, ACROSS.length);
      assert(first !== null, "the object reads");
      first.fill(0);
      const stream = await snapshot.vault.objects.open(ACROSS_CID);
      assert(stream !== null, "the object opens");
      let pieces = 0;
      for await (const chunk of chunksOf(stream)) {
        chunk.fill(0);
        pieces += 1;
      }
      assert(pieces > 1, "the stream hands the object out a piece at a time");
      assertBytes((await snapshot.vault.objects.read(ACROSS_CID, ACROSS.length)) as Uint8Array, ACROSS, "a later read");
      const restored = new SqliteVault((await restoreSnapshot(snapshot, destination(h, h.fresh()), { anchor: ANCHOR })).runtime);
      const target = new SqliteVault(createRuntime(await h.open(h.fresh(), "create"), { metadata: META, wrapped: WRAPPED }));
      try {
        await importSnapshot(target, snapshot, { retainedRoots: retainedOf });
        assertEqual(await held(restored), expected, "the restore");
        assertEqual(await held(target), expected, "the import");
      } finally {
        await restored.close();
        await target.close();
      }
    },
  },
];
