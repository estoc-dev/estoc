/**
 * The CAR snapshot over vaults in memory: what each kind of export
 * writes — its header, its roots, its blocks and their order — what a
 * read refuses, header and blocks, and what it hands back; and the
 * import of a content part into a vault in memory. What needs SQLite —
 * a restore, the export's bound and lock, the tally the store keeps —
 * and what the browser must agree on is in `sqlite/snapshot-cases.ts`.
 */

import { Float, carLength, decodeCar, drislCid, encodeCar, encodeDrisl, type Car, type CarMetadata, type Drisl } from "@estoc/dasl";
import { describe, expect, it, test } from "vitest";

import {
  IncompleteSnapshot,
  InvalidSnapshot,
  MemoryVault,
  MissingPart,
  NotAVault,
  SNAPSHOT_VERSION,
  Snapshot,
  UnsupportedOperation,
  VAULT_VERSION,
  canonicalEventBytes,
  compareCids,
  envelopeOf,
  exportSnapshot,
  importSnapshot,
  type Cid,
  type Event,
  type HeldRoots,
} from "../src/index.js";
import { ANCHOR, META, WRAPPED, all, authorN, clock } from "./suite/helpers.js";
import { HELLO, HELLO_CID, WORLD, WORLD_CID, bytesOf, cidOf, retainedOf, rootsOf } from "./sqlite/vault-cases.js";

const ENROLLMENT = "test.enrollment";
const SEED_TYPES = new Set([ENROLLMENT]);
const LONE = bytesOf(300, 9);
const LONE_CID = cidOf(LONE);

/**
 * A vault in memory with two enrollment events — one its own, holding
 * hello, and one of another author's — and two other events, one
 * holding hello and world and one the lone object world is not.
 */
async function sample(): Promise<{ vault: MemoryVault; events: Event[] }> {
  const c = clock("2026-10-13T10:00:00.000Z");
  const vault = new MemoryVault({ metadata: META, wrapped: WRAPPED, now: c.now });
  const own = await vault.vault.commit(
    [
      { cid: HELLO_CID, source: HELLO },
      { cid: WORLD_CID, source: WORLD },
      { cid: LONE_CID, source: LONE },
    ],
    [
      { type: ENROLLMENT, roots: [HELLO_CID], data: { i: 0 } },
      { type: "test.event", roots: [HELLO_CID, WORLD_CID], data: { i: 1 } },
      { type: "test.event", roots: [LONE_CID], data: { i: 2 } },
    ]
  );
  c.advance(1000);
  const other = new MemoryVault({ metadata: META, wrapped: WRAPPED, author: authorN(7), now: c.now });
  const foreign = await other.vault.commit([], [{ type: ENROLLMENT, roots: [], data: { from: "elsewhere" } }]);
  await vault.ingest(foreign);
  return { vault, events: [...own, ...foreign] };
}

const canonical = (events: Event[]): Event[] => [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.cid < b.cid ? -1 : 1));

/** The CAR decoded from a copy, so the bytes stay readable. */
const decoded = (car: Uint8Array): Promise<Car> => decodeCar(car.slice());

const estocOf = (car: Car): { [key: string]: Drisl } => car.metadata["estoc"] as { [key: string]: Drisl };

/** `car` written again with what `edit` makes of its roots, its metadata and its blocks. */
async function forged(car: Uint8Array, edit: (parts: { roots: string[]; metadata: { [key: string]: Drisl }; blocks: Map<string, Uint8Array> }) => void): Promise<Uint8Array> {
  const { roots, metadata, blocks } = await decoded(car);
  const parts = { roots: [...roots], metadata: structuredClone({ ...metadata }) as { [key: string]: Drisl }, blocks: new Map(blocks) };
  edit(parts);
  return encodeCar({ roots: parts.roots, metadata: parts.metadata as CarMetadata }, parts.blocks);
}

/** `car` with its `estoc` member edited. */
const withEstoc = (car: Uint8Array, edit: (estoc: { [key: string]: Drisl }) => void): Promise<Uint8Array> =>
  forged(car, ({ metadata }) => {
    const estoc = metadata["estoc"] as { [key: string]: Drisl };
    edit(estoc);
  });

async function refusal(bytes: Uint8Array, heldRoots: HeldRoots = rootsOf): Promise<unknown> {
  return Snapshot.read(bytes, { heldRoots }).then(
    () => undefined,
    (err: unknown) => err
  );
}

describe("exportSnapshot", () => {
  it("writes the seed alone as the wrapper, the events of the types selected and the objects they hold on their own, with no range", async () => {
    const { vault, events } = await sample();
    const car = await decoded(await exportSnapshot(vault, { parts: "seed", types: SEED_TYPES, heldRoots: rootsOf }));
    const selected = canonical(events.filter((event) => event.type === ENROLLMENT));
    expect(estocOf(car)).toEqual({ snapshot: SNAPSHOT_VERSION, vault_version: VAULT_VERSION, anchor: ANCHOR, seed: WRAPPED.seedJwe });
    expect(car.roots).toEqual(selected.map((event) => event.cid));
    expect([...car.blocks.keys()]).toEqual([...selected.map((event) => event.cid), HELLO_CID]);
    expect(car.bad).toEqual([]);
  });

  it("writes the content alone as every event, every author's, and the objects they hold, with the range of the exporting replica up to the position accepted last, and no wrapper", async () => {
    const { vault, events } = await sample();
    const car = await decoded(await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf }));
    const { lastSeq } = await vault.locked((held) => held.tally());
    expect(lastSeq).toBe(events.length);
    expect(estocOf(car)).toEqual({
      snapshot: SNAPSHOT_VERSION,
      vault_version: VAULT_VERSION,
      anchor: ANCHOR,
      content: { replica: vault.author, generation: vault.generation, after: 0, through: lastSeq },
    });
    expect(car.roots).toEqual(canonical(events).map((event) => event.cid));
    expect(new Set(car.blocks.keys())).toEqual(new Set([...events.map((event) => event.cid), HELLO_CID, WORLD_CID, LONE_CID]));
  });

  it("writes both as the wrapper and the range over every event", async () => {
    const { vault, events } = await sample();
    const car = await decoded(await exportSnapshot(vault, { parts: "both", heldRoots: rootsOf }));
    expect(estocOf(car)).toEqual({
      snapshot: SNAPSHOT_VERSION,
      vault_version: VAULT_VERSION,
      anchor: ANCHOR,
      seed: WRAPPED.seedJwe,
      content: { replica: vault.author, generation: vault.generation, after: 0, through: events.length },
    });
    expect(car.roots).toEqual(canonical(events).map((event) => event.cid));
  });

  it("writes the events in canonical order and then the objects in binary CID order, each CID once, an event the events hold as an object too written as the event", async () => {
    const vault = new MemoryVault({ metadata: META, wrapped: WRAPPED });
    const [first] = (await vault.vault.commit([], [{ type: "test.event", roots: [], data: { i: 0 } }])) as [Event];
    const asObject = first.cid as string as Cid;
    const later = await vault.vault.commit(
      [
        { cid: asObject, source: canonicalEventBytes(first) },
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: WORLD },
      ],
      [{ type: "test.event", roots: [asObject, WORLD_CID, HELLO_CID], data: { i: 1 } }]
    );
    const bytes = await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf });
    const car = await decoded(bytes);
    const events = canonical([first, ...later]);
    const objects = [HELLO_CID, WORLD_CID].sort(compareCids);
    expect([...car.blocks.keys()]).toEqual([...events.map((event) => event.cid), ...objects]);
    const sizes = [...events.map((event) => canonicalEventBytes(event).length), HELLO.length, WORLD.length];
    expect(bytes.length, "no block written twice").toBe(carLength({ roots: car.roots, metadata: car.metadata }, sizes));
  });

  it("refuses a cut with a held root the vault does not have, naming it, before a byte is written", async () => {
    const { vault } = await sample();
    const absent = cidOf(bytesOf(10, 4));
    const err = await exportSnapshot(vault, { parts: "content", heldRoots: async (v) => [...(await rootsOf(v)), absent] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteSnapshot);
    expect((err as IncompleteSnapshot).problems).toEqual([{ where: `objects/${absent}`, error: "held by the events but not present" }]);
  });
});

describe("Snapshot.read", () => {
  it("reads back each kind as the parts it carries, its events and its objects, in a vault that refuses commit and changes", async () => {
    const { vault, events } = await sample();
    for (const parts of ["seed", "content", "both"] as const) {
      const bytes = await exportSnapshot(vault, parts === "seed" ? { parts, types: SEED_TYPES, heldRoots: rootsOf } : { parts, heldRoots: rootsOf });
      const length = bytes.length;
      const snapshot = await Snapshot.read(bytes, { heldRoots: rootsOf });
      const expected = parts === "seed" ? events.filter((event) => event.type === ENROLLMENT) : events;
      const objects = parts === "seed" ? [HELLO_CID] : [HELLO_CID, WORLD_CID, LONE_CID];
      expect(snapshot.metadata, parts).toEqual(META);
      expect(snapshot.seed, parts).toEqual(parts === "content" ? undefined : WRAPPED);
      expect(snapshot.content, parts).toEqual(parts === "seed" ? undefined : { replica: vault.author, generation: vault.generation, after: 0, through: events.length });
      expect(await all(snapshot.vault.events.scan()), parts).toEqual(canonical(expected));
      expect(await all(snapshot.vault.events.scan({ type: ENROLLMENT })), parts).toEqual(canonical(events.filter((event) => event.type === ENROLLMENT)));
      expect(new Set(await all(snapshot.vault.objects.list())), parts).toEqual(new Set(objects));
      expect(await snapshot.vault.objects.read(HELLO_CID, 5), parts).toEqual(HELLO);
      expect(await snapshot.vault.objects.stat(HELLO_CID), parts).toEqual({ cid: HELLO_CID, codec: "raw", size: 5 });
      expect(await snapshot.vault.events.damaged(), parts).toEqual([]);
      expect({ events: snapshot.events, objects: snapshot.objects }, parts).toEqual({ events: expected.length, objects: objects.length });
      expect(snapshot.eventBytes, parts).toBe(expected.reduce((n, event) => n + canonicalEventBytes(event).length, 0));
      expect(length, parts).toBeGreaterThan(snapshot.eventBytes + snapshot.objectBytes);
      await expect(snapshot.vault.commit([], [{ type: "t", data: {} }]), parts).rejects.toBeInstanceOf(UnsupportedOperation);
      await expect(snapshot.vault.events.changes(), parts).rejects.toBeInstanceOf(UnsupportedOperation);
    }
  });

  test("a block both an event and an object the events hold is read as both", async () => {
    const vault = new MemoryVault({ metadata: META, wrapped: WRAPPED });
    const [first] = (await vault.vault.commit([], [{ type: "test.event", roots: [], data: { i: 0 } }])) as [Event];
    const asObject = first.cid as string as Cid;
    await vault.vault.commit([{ cid: asObject, source: canonicalEventBytes(first) }], [{ type: "test.event", roots: [asObject], data: { i: 1 } }]);
    const snapshot = await Snapshot.read(await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf }), { heldRoots: rootsOf });
    expect((await all(snapshot.vault.events.scan())).map((event) => event.cid)).toContain(first.cid);
    expect(await all(snapshot.vault.objects.list())).toEqual([asObject]);
    expect(await snapshot.vault.objects.read(asObject, 1000)).toEqual(canonicalEventBytes(first));
  });

  describe("refuses a header that is not this format's", () => {
    const cases: [string, (estoc: { [key: string]: Drisl }) => void][] = [
      ["a member estoc does not have", (estoc) => void (estoc["extra"] = 1)],
      ["no snapshot", (estoc) => void delete estoc["snapshot"]],
      ["no vault_version", (estoc) => void delete estoc["vault_version"]],
      ["no anchor", (estoc) => void delete estoc["anchor"]],
      ["another snapshot format", (estoc) => void (estoc["snapshot"] = SNAPSHOT_VERSION + 1)],
      ["the snapshot format as a float", (estoc) => void (estoc["snapshot"] = new Float(SNAPSHOT_VERSION))],
      ["another vault version", (estoc) => void (estoc["vault_version"] = VAULT_VERSION - 1)],
      ["an anchor that is no DID", (estoc) => void (estoc["anchor"] = "z6Mk")],
      ["a seed that is no string", (estoc) => void (estoc["seed"] = new Uint8Array(4))],
      ["a seed that is no JWE of the keystore's profile", (estoc) => void (estoc["seed"] = "a.b.c")],
      ["neither part", (estoc) => void (delete estoc["seed"], delete estoc["content"])],
      ["a range that is no map", (estoc) => void (estoc["content"] = [0, 3])],
      ["a range without through", (estoc) => void delete (estoc["content"] as { [key: string]: Drisl })["through"]],
      ["a range with a member it does not have", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["author"] = "x")],
      ["a range whose replica is no UUIDv7", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["replica"] = "replica")],
      ["a range whose generation is no UUIDv7", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["generation"] = 7)],
      ["a range that starts past 0", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["after"] = 1)],
      ["a range that runs backwards", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["after"] = 9)],
      ["a range ending at a fraction", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["through"] = 2.5)],
      ["a range ending past the safe integers", (estoc) => void ((estoc["content"] as { [key: string]: Drisl })["through"] = 2n ** 60n)],
    ];
    for (const [what, edit] of cases) {
      it(`with ${what}, as NotAVault`, async () => {
        const { vault } = await sample();
        const bytes = await withEstoc(await exportSnapshot(vault, { parts: "both", heldRoots: rootsOf }), edit);
        expect(await refusal(bytes)).toBeInstanceOf(NotAVault);
      });
    }

    it("with no estoc member, or another beside it, as NotAVault", async () => {
      const { vault } = await sample();
      const exported = await exportSnapshot(vault, { parts: "both", heldRoots: rootsOf });
      expect(await refusal(await forged(exported, ({ metadata }) => void delete metadata["estoc"]))).toBeInstanceOf(NotAVault);
      expect(await refusal(await forged(exported, ({ metadata }) => void (metadata["other"] = 1)))).toBeInstanceOf(NotAVault);
    });

    it("that does not decode as a CAR, as InvalidSnapshot", async () => {
      const { vault } = await sample();
      const exported = await exportSnapshot(vault, { parts: "both", heldRoots: rootsOf });
      const err = await refusal(exported.slice(0, exported.length - 1));
      expect(err).toBeInstanceOf(InvalidSnapshot);
      expect((err as InvalidSnapshot).problems).toEqual([{ where: "car", error: "truncated CAR" }]);
    });
  });

  describe("refuses blocks that are not exactly the events and the objects they hold, naming every problem, as InvalidSnapshot", () => {
    const problemsOf = async (bytes: Uint8Array, heldRoots: HeldRoots = rootsOf): Promise<{ where: string; error: string }[]> => {
      const err = await refusal(bytes, heldRoots);
      expect(err).toBeInstanceOf(InvalidSnapshot);
      return (err as InvalidSnapshot).problems;
    };

    it("a root named twice, one with no block, and one that is not a raw CID", async () => {
      const { vault } = await sample();
      const exported = await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf });
      const absent = cidOf(bytesOf(10, 4));
      const drisl = encodeDrisl({ a: 1 });
      const linked = await drislCid(drisl);
      const bytes = await forged(exported, ({ roots, blocks }) => {
        roots.push(roots[0] as string, absent, linked);
        blocks.set(linked, drisl);
      });
      const { roots } = await decoded(exported);
      expect(await problemsOf(bytes)).toEqual([
        { where: `roots/${roots[0]}`, error: "named twice" },
        { where: `roots/${absent}`, error: "no block" },
        { where: `roots/${linked}`, error: "not a raw CID, as an event's is" },
        { where: `blocks/${linked}`, error: "not a raw CID: neither an event nor an object" },
      ]);
    });

    it("a root whose block is no envelope, and one whose block is an envelope in other bytes than its canonical ones", async () => {
      const { vault, events } = await sample();
      const exported = await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf });
      const notAnEnvelope = new TextEncoder().encode('{"a":1}');
      const spaced = new TextEncoder().encode(JSON.stringify(envelopeOf(events[0] as Event), null, 1));
      const bytes = await forged(exported, ({ roots, blocks }) => {
        for (const block of [notAnEnvelope, spaced]) {
          roots.push(cidOf(block));
          blocks.set(cidOf(block), block);
        }
      });
      const problems = await problemsOf(bytes);
      expect(problems.map((problem) => problem.where)).toEqual([`events/${cidOf(notAnEnvelope)}`, `events/${cidOf(spaced)}`]);
      expect(problems[1]?.error).toBe("the block is a valid envelope, but not in its canonical bytes");
    });

    it("a block whose bytes are not its CID's", async () => {
      const { vault } = await sample();
      const exported = await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf });
      const swapped = await forged(exported, ({ blocks }) => void blocks.set(HELLO_CID, WORLD));
      expect(await problemsOf(swapped)).toEqual([
        { where: `blocks/${HELLO_CID}`, error: "the bytes do not hash to the CID they are named by" },
      ]);
    });

    it("a held object with no block, and a block neither an event nor held", async () => {
      const { vault } = await sample();
      const exported = await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf });
      const extra = bytesOf(64, 12);
      const bytes = await forged(exported, ({ blocks }) => {
        blocks.delete(WORLD_CID);
        blocks.set(cidOf(extra), extra);
      });
      expect(await problemsOf(bytes)).toEqual([
        { where: `objects/${WORLD_CID}`, error: "held by the events but not in the snapshot" },
        { where: `blocks/${cidOf(extra)}`, error: "neither an event nor held by one" },
      ]);
      expect(await problemsOf(exported, async (v) => (await rootsOf(v)).filter((cid) => cid !== LONE_CID)), "a fold that holds less than the blocks").toEqual([
        { where: `blocks/${LONE_CID}`, error: "neither an event nor held by one" },
      ]);
    });
  });

  it("folds the held roots over every block the snapshot has, readable as an object, and hands the fold a vault that refuses a commit", async () => {
    const { vault } = await sample();
    const exported = await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf });
    let read: Uint8Array | null = null;
    let committed: unknown;
    await Snapshot.read(exported, {
      heldRoots: async (v) => {
        read = await v.objects.read(LONE_CID, LONE.length);
        committed = await v.commit([], [{ type: "t", data: {} }]).catch((err: unknown) => err);
        return rootsOf(v);
      },
    });
    expect(read).toEqual(LONE);
    expect(committed).toBeInstanceOf(UnsupportedOperation);
  });
});

describe("importSnapshot", () => {
  it("imports the content part into a vault in memory and hands back its range, the source's and not the target's", async () => {
    const { vault, events } = await sample();
    const snapshot = await Snapshot.read(await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf }), { heldRoots: rootsOf });
    const target = new MemoryVault({ metadata: META, wrapped: WRAPPED });
    expect(await importSnapshot(target, snapshot, { retainedRoots: retainedOf })).toEqual({ added: events.length, duplicates: 0, objects: 3, repaired: 0, range: snapshot.content });
    expect(snapshot.content?.replica).toBe(vault.author);
    expect((await all(target.vault.events.scan())).map((event) => event.cid)).toEqual(canonical(events).map((event) => event.cid));
    expect(await importSnapshot(target, snapshot, { retainedRoots: retainedOf })).toMatchObject({ added: 0, duplicates: events.length });
  });

  it("refuses the seed alone as MissingPart, writing nothing", async () => {
    const { vault } = await sample();
    const snapshot = await Snapshot.read(await exportSnapshot(vault, { parts: "seed", types: SEED_TYPES, heldRoots: rootsOf }), { heldRoots: rootsOf });
    const target = new MemoryVault({ metadata: META, wrapped: WRAPPED });
    const err = await importSnapshot(target, snapshot, { retainedRoots: retainedOf }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingPart);
    expect((err as MissingPart).part).toBe("content");
    expect(await all(target.vault.events.scan())).toEqual([]);
  });

  it("takes only a Snapshot that Snapshot.read made", async () => {
    const { vault } = await sample();
    const snapshot = await Snapshot.read(await exportSnapshot(vault, { parts: "content", heldRoots: rootsOf }), { heldRoots: rootsOf });
    const lookalike = { ...snapshot } as unknown as Snapshot;
    await expect(importSnapshot(new MemoryVault({ metadata: META, wrapped: WRAPPED }), lookalike, { retainedRoots: retainedOf })).rejects.toBeInstanceOf(TypeError);
  });
});
