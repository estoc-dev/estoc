/**
 * The snapshot's export from a SQLite runtime, and its restore, on
 * whatever the platform's driver is, as cases free of any test
 * framework: run over `node:sqlite` by `snapshot.test.ts` and over the
 * wasm pool in a Chromium Worker by `browser-driver.test.ts`. What the
 * runtime keeps for itself left out of every part; the cut fixed
 * under the lock while writes wait; a seed part restored and exported
 * again unchanged; and an object of 64 MiB streamed
 * through a commit, a read, an export and a restore, with what the
 * platform holds measured on the way.
 */

import {
  SqliteVault,
  Snapshot,
  exportSnapshot,
  hashSource,
  restoreSnapshot,
  type Cid,
  type CreateDestination,
  type Held,
  type HeldRoots,
  type SqliteDriver,
  type VaultRuntime,
} from "../../src/index.js";
import { ANCHOR, REWRAPPED, WRAPPED } from "../fixtures.js";
import { type Case, assert, assertBytes, assertEqual, type MemoryHeld } from "./driver-cases.js";
import { HELLO, HELLO_CID, MIB, WORLD, WORLD_CID, all, bytesOf, cidOf, clock, draft, make, rootsOf, type VaultHarness } from "./vault-cases.js";

export interface ExportHarness extends VaultHarness {
  memoryUsed?: () => MemoryHeld | Promise<MemoryHeld>;
  /** Deletes the database at `target`, which no connection holds open: a case that made a large one gives the space back, where space is scarce. */
  remove?(target: string): void | Promise<void>;
}

export interface ExportCase extends Case {
  run(harness: ExportHarness): Promise<string | void>;
}

/** Every root but `except`: what a fold that had released that object would compute. */
export const rootsExcept =
  (except: Cid): HeldRoots =>
  async (vault) =>
    (await rootsOf(vault)).filter((cid) => cid !== except);

/** A creator of the destination at `target` over the harness, counting the destinations it created. */
export function destination(h: VaultHarness, target: string): CreateDestination & { created: number } {
  const create = (async () => {
    create.created += 1;
    return h.open(target, "create");
  }) as CreateDestination & { created: number };
  create.created = 0;
  return create;
}

/** Has `p` settled by the time the runnable work has run? */
export async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return done;
}

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `target`'s member, a method bound to it: what a proxy hands through for everything it does not replace. */
const bound = <T extends object>(target: T, property: string | symbol): unknown => {
  const value = Reflect.get(target, property, target) as unknown;
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
};

type Sample = [at: string, held: MemoryHeld];

function sampleAt(samples: Sample[], mark: string, of: keyof MemoryHeld): number {
  const found = samples.find(([at]) => at === mark);
  if (found === undefined) throw new Error(`no sample ${mark}`);
  const value = found[1][of];
  if (value === undefined) throw new Error(`no ${of} in the sample ${mark}`);
  return value;
}

/** The page cache the wasm build gives a connection by default, and fills as the connection reads or writes: what a connection costs SQLite's allocator while it is open. */
const CONNECTION_CACHE = 16 * MIB;

const OBJECT_MIB = 64;

interface Bound {
  of: keyof MemoryHeld;
  from: string;
  to: string;
  limit: number;
  or: string;
}

/**
 * What may grow from one sample to the next while a 64 MiB object
 * streams through, for what JavaScript holds and for what SQLite's
 * allocator holds where it is measured. The margins are 4 MiB: chunks
 * in flight and a little of the allocator's own. The snapshot is one
 * buffer the length of its CAR, held from the start of the export
 * until the restore is done with it.
 */
const BOUNDS: Bound[] = [
  { of: "javascript", from: "32 MiB into the commit", to: "64 MiB into the commit", limit: 4 * MIB, or: "the second half of the commit's source held no more than the first" },
  { of: "javascript", from: "32 MiB into the read", to: "64 MiB into the read", limit: 4 * MIB, or: "the second half of the read held no more than the first" },
  { of: "javascript", from: "after the commit", to: "most during the export", limit: (OBJECT_MIB + 4) * MIB, or: "the export held its CAR and a chunk at most while it copied" },
  { of: "javascript", from: "after the commit", to: "most during the restore", limit: (OBJECT_MIB + 16) * MIB, or: "the restore held the snapshot and a batch of chunks at most while it copied" },
  { of: "javascript", from: "after the commit", to: "after the restore", limit: 4 * MIB, or: "the export and the restore held no more than the commit left" },
  { of: "javascript", from: "before", to: "after the restore", limit: 32 * MIB, or: "less than half the object held in all" },
  { of: "sqlite", from: "32 MiB into the commit", to: "64 MiB into the commit", limit: 4 * MIB, or: "SQLite spilled the second half of the staging to the temporary file as it did the first" },
  { of: "sqlite", from: "32 MiB into the read", to: "64 MiB into the read", limit: 4 * MIB, or: "SQLite held no more of the second half of the read than of the first" },
  { of: "sqlite", from: "after the commit", to: "most during the export", limit: 4 * MIB, or: "SQLite held no more while the export read the object than the read had" },
  { of: "sqlite", from: "after the commit", to: "most during the restore", limit: CONNECTION_CACHE + 4 * MIB, or: "SQLite held the destination connection's cache at most while the restore copied" },
  { of: "sqlite", from: "after the commit", to: "after the restore", limit: 4 * MIB, or: "SQLite freed what the restore had it hold" },
  { of: "sqlite", from: "before", to: "after the restore", limit: CONNECTION_CACHE + 8 * MIB, or: "SQLite held the vault's connection cache the commit filled, and its staging cache, and little else" },
];

/** The bounds `samples` measure — every JavaScript bound, the SQLite bounds when the platform reports SQLite — that they break. */
function brokenBounds(samples: Sample[]): Bound[] {
  const measured = (of: keyof MemoryHeld): boolean => samples.every(([, held]) => held[of] !== undefined);
  return BOUNDS.filter(({ of, from, to, limit }) => measured(of) && sampleAt(samples, to, of) - sampleAt(samples, from, of) >= limit);
}

const described = (samples: Sample[], bounds: Bound[]): string =>
  bounds.map(({ of, from, to, limit, or }) => `${or}: ${((sampleAt(samples, to, of) - sampleAt(samples, from, of)) / MIB).toFixed(1)} MiB from ${from} to ${to}, the bound ${limit / MIB} MiB`).join("; ");

const shown = (held: MemoryHeld): string => `${(held.javascript / MIB).toFixed(1)}${held.sqlite === undefined ? "" : ` / SQLite ${(held.sqlite / MIB).toFixed(1)}`}`;

/** `stream` handing its chunks on, `seen` told of each and `mark` awaited every `every` bytes: a copy's source, watched while the copy still holds what it read. */
function watched(stream: ReadableStream<Uint8Array>, every: number, seen: ((chunk: Uint8Array) => void) | undefined, mark: () => Promise<void>): ReadableStream<Uint8Array> {
  let read = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        seen?.(chunk);
        controller.enqueue(chunk);
        const before = read;
        read += chunk.length;
        if (Math.floor(read / every) > Math.floor(before / every)) await mark();
      },
    })
  );
}

type Watch = (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;

/** `holder` with the streams its `objects.open` hands out wrapped by `watch`; everything else is the holder's own. */
function openingWatched<T extends { objects: { open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> } }>(holder: T, watch: Watch): T {
  const objects = new Proxy(holder.objects, {
    get: (target, property) =>
      property !== "open"
        ? bound(target, property)
        : async (cid: Cid): Promise<ReadableStream<Uint8Array> | null> => {
            const stream = await target.open(cid);
            return stream === null ? null : watch(stream);
          },
  });
  return new Proxy(holder, { get: (target, property) => (property === "objects" ? objects : bound(target, property)) });
}

/** `runtime` whose locked operations read objects through `watch`: what an export copies, seen from the source's side. */
function readsWatched(runtime: VaultRuntime, watch: Watch): VaultRuntime {
  return new Proxy(runtime, {
    get: (target, property) =>
      property !== "locked" ? bound(target, property) : <T>(op: (held: Held) => Promise<T>): Promise<T> => target.locked((held) => op(openingWatched(held, watch))),
  });
}

/** `snapshot` whose vault reads objects through `watch`: what a restore copies, seen from the source's side. */
function snapshotWatched(snapshot: Snapshot, watch: Watch): Snapshot {
  const vault = openingWatched(snapshot.vault, watch);
  return new Proxy(snapshot, { get: (target, property) => (property === "vault" ? vault : bound(target, property)) });
}

interface Streamed {
  samples: Sample[];
  /** The bounds broken; none when what was held stayed bounded, or when the platform measures nothing. */
  broken: Bound[];
  note: string;
}

interface Watching {
  /** Given every chunk that passes through, in every phase: what a store or a copy that kept the object would look like to the measure. */
  retain?: (chunk: Uint8Array) => void;
  /** Given every connection the flow opens, the vault's own first: what a connection told to hold the object would look like. */
  connected?: (driver: SqliteDriver) => void;
}

/**
 * An object of 64 MiB committed from a source that reuses one buffer,
 * read back whole, exported with both parts and restored, with what
 * the platform holds sampled on the way — and, while the export and
 * the restore copy, every mebibyte read from their source, the most of
 * those kept as the sample of the copy. The snapshot is let go of
 * before the sample after the restore.
 */
async function streamedThrough(given: ExportHarness, { retain, connected }: Watching = {}): Promise<Streamed> {
  const measure = given.memoryUsed;
  const h: ExportHarness =
    connected === undefined
      ? given
      : {
          ...given,
          open: async (target, mode) => {
            const driver = await given.open(target, mode);
            connected(driver);
            return driver;
          },
        };
  const piece = new Uint8Array(MIB); // one buffer, refilled: nothing here holds the object
  async function* source(): AsyncIterable<Uint8Array> {
    for (let i = 0; i < OBJECT_MIB; i++) {
      piece.fill(i + 1);
      yield piece;
    }
  }
  const { cid } = await hashSource(source(), OBJECT_MIB * MIB, () => undefined);
  const id = cid.text as Cid;
  const samples: Sample[] = [];
  const sample = async (at: string): Promise<void> => {
    if (measure !== undefined) samples.push([at, await measure()]);
  };
  const more = (a: MemoryHeld, b: MemoryHeld): MemoryHeld => ({ javascript: Math.max(a.javascript, b.javascript), ...(a.sqlite === undefined && b.sqlite === undefined ? {} : { sqlite: Math.max(a.sqlite ?? 0, b.sqlite ?? 0) }) });
  /** A copy's source watched, the most held at any of its samples recorded once the copy is done. */
  const copying = (what: string): { watch: Watch; done(): void } => {
    let most: MemoryHeld = { javascript: 0 };
    return {
      watch: (stream) =>
        watched(stream, MIB, retain, async () => {
          if (measure !== undefined) most = more(most, await measure());
        }),
      done: () => {
        if (measure !== undefined) samples.push([`most during the ${what}`, most]);
      },
    };
  };
  const own = h.fresh();
  const { vault } = await make(h, own, clock().now);
  await sample("before");
  let fed = 0;
  async function* sampled(): AsyncIterable<Uint8Array> {
    for await (const chunk of source()) {
      retain?.(chunk);
      yield chunk;
      if (++fed % 32 === 0) await sample(`${fed} MiB into the commit`);
    }
  }
  await vault.vault.commit([{ cid: id, source: sampled() }], [draft([id])]);
  await sample("after the commit");
  const stream = await vault.vault.objects.open(id);
  assert(stream !== null, "readable");
  const reader = stream.getReader();
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    retain?.(value);
    for (let i = 0; i < value.length; ) {
      const mebibyte = Math.floor((offset + i) / MIB);
      const end = Math.min(value.length, (mebibyte + 1) * MIB - offset);
      for (; i < end; i++) if (value[i] !== mebibyte + 1) throw new Error(`byte ${offset + i} read back as ${value[i]}, not ${mebibyte + 1}`);
    }
    const before = offset;
    offset += value.length;
    if (Math.floor(offset / (32 * MIB)) > Math.floor(before / (32 * MIB))) await sample(`${Math.floor(offset / MIB)} MiB into the read`);
  }
  assertEqual(offset, OBJECT_MIB * MIB, "read whole");
  const restoredTo = h.fresh();
  // In a call of its own, so that nothing of the snapshot is reachable once it returns.
  const restored = await (async () => {
    const exporting = copying("export");
    const bytes = await exportSnapshot(readsWatched(vault, exporting.watch), { parts: "both", heldRoots: rootsOf });
    exporting.done();
    const snapshot = await Snapshot.read(bytes, { heldRoots: rootsOf });
    assertEqual(snapshot.objectBytes, OBJECT_MIB * MIB, "exported whole");
    const restoring = copying("restore");
    const { runtime, objects, objectBytes } = await restoreSnapshot(snapshotWatched(snapshot, restoring.watch), destination(h, restoredTo), { anchor: ANCHOR });
    restoring.done();
    runtime.close();
    return { objects, objectBytes };
  })();
  assertEqual([restored.objects, restored.objectBytes], [1, OBJECT_MIB * MIB], "restored whole");
  await sample("after the restore");
  await vault.close();
  await sample("after the close");
  for (const made of [own, restoredTo]) await h.remove?.(made);
  const note = samples.map(([at, held]) => `${at}: ${shown(held)} MiB`).join(", ");
  return { samples, broken: measure === undefined ? [] : brokenBounds(samples), note };
}

export const exportCases: ExportCase[] = [
  {
    name: "an export carries nothing the runtime keeps for itself: no option, cache entry, trace entry, local table or control table is in any part, nor an object the events no longer hold",
    run: async (h) => {
      const { vault } = await make(h, h.fresh(), clock().now);
      const unheld = bytesOf(4096, 21);
      const unheldCid = cidOf(unheld);
      await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: unheldCid, source: unheld },
        ],
        [draft([HELLO_CID], { i: 0 }), draft([unheldCid], { i: 1, released: true })]
      );
      await vault.local.options.set("theme", "OPTION-SENTINEL-7f3a");
      await vault.local.cache.put("thumbs", "x", bytesOf(512, 22));
      await vault.local.trace.append("delivery", { mark: "TRACE-SENTINEL-9c1d" });
      const heldRoots = rootsExcept(unheldCid);
      for (const parts of ["both", "content"] as const) {
        const bytes = await exportSnapshot(vault, { parts, heldRoots });
        for (const [what, needle] of [
          ["the unheld object", unheld.subarray(0, 64)],
          ["the option", utf8("OPTION-SENTINEL-7f3a")],
          ["the cache entry", bytesOf(512, 22).subarray(0, 64)],
          ["the trace entry", utf8("TRACE-SENTINEL-9c1d")],
          ["a local table", utf8("local_")],
          ["the control table", utf8("store_state")],
          ["the positions table", utf8("event_positions")],
        ] as const) {
          assert(!contains(bytes, needle), `${parts}: ${what} is in the CAR`);
        }
      }
      await vault.close();
    },
  },
  {
    name: "the cut cannot be mixed: a commit, a collection pass and a rewrap issued while the export folds wait for it, then land without changing what it wrote",
    run: async (h) => {
      const { vault } = await make(h, h.fresh(), clock().now);
      const events = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: WORLD_CID, source: WORLD },
        ],
        [draft([HELLO_CID, WORLD_CID])]
      );
      let admit!: () => void;
      const gate = new Promise<void>((resolve) => {
        admit = resolve;
      });
      let folding!: () => void;
      const folded = new Promise<void>((resolve) => {
        folding = resolve;
      });
      const exporting = exportSnapshot(vault, {
        parts: "both",
        heldRoots: async (v) => {
          folding();
          await gate;
          return rootsOf(v);
        },
      });
      await folded;
      const committing = vault.vault.commit([], [draft([HELLO_CID], { later: true })]);
      const collecting = vault.collect(rootsExcept(WORLD_CID));
      const rewrapping = vault.keystore.rewrap(REWRAPPED);
      assertEqual([await settled(committing), await settled(collecting), await settled(rewrapping)], [false, false, false], "all three wait");
      assertEqual(await settled(exporting), false, "the export waits on the gate");
      admit();
      const bytes = await exporting;
      assertEqual((await committing).length, 1, "the commit landed after");
      assertEqual(await collecting, { removed: [WORLD_CID] }, "the collection pass removed the world after");
      await rewrapping;
      assertEqual(await vault.keystore.read(), REWRAPPED, "the rewrap landed after");
      const snapshot = await Snapshot.read(bytes, { heldRoots: rootsOf });
      assertEqual(snapshot.seed, WRAPPED, "the wrapper of the cut");
      assertEqual(snapshot.content?.through, 1, "the range of the cut");
      assertEqual((await all(snapshot.vault.events.scan())).map((e) => e.cid), events.map((e) => e.cid), "the event of the cut");
      assertBytes((await snapshot.vault.objects.read(WORLD_CID, 5)) as Uint8Array, WORLD, "the world, collected from the runtime since");
      await vault.close();
    },
  },
  {
    name: "a seed part restored into SQLite exports again as the same CAR, byte for byte",
    run: async (h) => {
      const c = clock();
      const { vault } = await make(h, h.fresh(), c.now);
      await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: WORLD_CID, source: WORLD },
        ],
        [draft([HELLO_CID, WORLD_CID], { i: 0 }), draft([], { i: 1 })]
      );
      const seed = await exportSnapshot(vault, { parts: "seed", types: new Set(["test.event"]), heldRoots: rootsOf });
      const restoredTo = h.fresh();
      const { runtime } = await restoreSnapshot(await Snapshot.read(seed.slice(), { heldRoots: rootsOf }), destination(h, restoredTo), { anchor: ANCHOR });
      const restored = new SqliteVault(runtime);
      try {
        const again = await exportSnapshot(restored, { parts: "seed", types: new Set(["test.event"]), heldRoots: rootsOf });
        assertBytes(again, seed, "the seed part a restore exports again is the one it restored");
      } finally {
        await restored.close();
        await vault.close();
      }
    },
  },
  {
    name: "an object of 64 MiB streams through a commit, a read, an export and a restore, and what the platform holds stays bounded throughout",
    large: true,
    run: async (h) => {
      const { samples, broken, note } = await streamedThrough(h);
      assert(broken.length === 0, `${described(samples, broken)} — ${note}`);
      return h.memoryUsed === undefined ? undefined : note;
    },
  },
  {
    name: "the measure of JavaScript sees what it holds: with a copy of every chunk the 64 MiB object passes through kept, every JavaScript bound breaks and no SQLite bound, and once the copies are let go what is held falls back",
    large: true,
    run: async (h) => {
      if (h.memoryUsed === undefined) return;
      const kept: Uint8Array[] = [];
      const { samples, broken, note } = await streamedThrough(h, { retain: (chunk) => kept.push(new Uint8Array(chunk)) });
      const retained = kept.reduce((n, chunk) => n + chunk.length, 0);
      kept.length = 0;
      const released = (await h.memoryUsed()).javascript;
      const javascript = broken.filter(({ of }) => of === "javascript");
      assertEqual(javascript.length, BOUNDS.filter(({ of }) => of === "javascript").length, `every JavaScript bound broken with ${retained / MIB} MiB kept — broken: ${described(samples, broken)} — ${note}`);
      assertEqual(broken.length - javascript.length, 0, `no SQLite bound broken by what JavaScript kept — broken: ${described(samples, broken)} — ${note}`);
      const before = sampleAt(samples, "before", "javascript");
      assert(released - before < 32 * MIB, `what JavaScript held fell back once the copies were let go: ${((released - before) / MIB).toFixed(1)} MiB over before — ${note}`);
      return `${retained / MIB} MiB kept broke ${javascript.length} bounds; let go, ${((released - before) / MIB).toFixed(1)} MiB over before`;
    },
  },
  {
    name: "the measure of SQLite sees what it holds: with every connection's cache the size of the object, the vault's own connection and the restore's destination keep the object in SQLite's allocator and their bounds break, no JavaScript bound does, and closing frees it",
    large: true,
    run: async (h) => {
      if (h.memoryUsed === undefined || (await h.memoryUsed()).sqlite === undefined) return;
      const { samples, broken, note } = await streamedThrough(h, { connected: (driver) => driver.exec(`PRAGMA cache_size = -${128 * 1024}`) });
      // The staging's cache the store sets after the connection opens, so the commit stays bounded; the read finds the object cached already, and so does the export; the restore's destination and the vault's own cache fill.
      const filling = BOUNDS.filter(({ of, from, to }) => of === "sqlite" && (to === "most during the restore" || from === "before"));
      for (const bound of filling) assert(broken.includes(bound), `${bound.or}: expected to break with the caches enlarged, held — ${note}`);
      assertEqual(broken.filter(({ of }) => of === "javascript").length, 0, `no JavaScript bound broken by what SQLite cached — broken: ${described(samples, broken)} — ${note}`);
      const before = sampleAt(samples, "before", "sqlite");
      const closed = sampleAt(samples, "after the close", "sqlite");
      assert(closed - before < 4 * MIB, `what SQLite held fell back once the connections closed: ${((closed - before) / MIB).toFixed(1)} MiB over before — ${note}`);
      return `caches enlarged broke ${broken.length} SQLite bounds: ${described(samples, broken)}; closed, ${((closed - before) / MIB).toFixed(1)} MiB over before`;
    },
  },
];
