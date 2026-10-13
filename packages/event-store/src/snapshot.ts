/**
 * The snapshot as a DASL CAR, in two parts a snapshot carries one or
 * both of. The seed part is the wrapper; travelling alone it brings
 * only the events of the types the exporter selects, with the objects
 * they hold on their own. The content part is every event and every
 * object the events hold, labelled with the range of positions the
 * exporting replica accepted them at. The header is
 * `{ version: 1, roots, estoc }`: `roots` the events, each the CID of
 * a block of its envelope's canonical bytes; every other block an
 * object the events hold; `estoc` the format, the vault's version and
 * anchor, and the parts. Any runtime exports this way, the vault in memory too,
 * since the export reads through the interfaces every runtime presents.
 * A read validates the whole CAR before anything of it is handed out,
 * and keeps the bytes it validated to itself.
 */

import { CarWriter, Float, Link, carLength, compareBytes, decodeCar, type Car, type CarHeader, type CarMetadata, type Drisl } from "@estoc/dasl";

import { DamagedObject, IncompleteSnapshot, InvalidSnapshot, NotAVault, ObjectTooLarge, SnapshotTooLarge, UnsupportedOperation } from "./errors.js";
import { canonicalEnvelope, canonicalEventBytes, checkFilter, compareEvents, isAuthorId, isEventCid, isRawCid, isUuidv7, matches, type AuthorId, type Cid, type Event, type EventCid } from "./event.js";
import { parseStrict } from "./jcs.js";
import { deepFreeze } from "./json.js";
import { VAULT_VERSION, checkMetadata, checkWrappedSeed, type VaultMetadata, type WrappedSeed } from "./keystore.js";
import { checkedCids, chunksOf, rawCidOf, sortCids } from "./objects.js";
import { MemoryVault, type Held, type HeldRoots, type Vault, type VaultEvents, type VaultObjects, type VaultRuntime } from "./vault.js";

/** The snapshot format every export writes and the one a read accepts. */
export const SNAPSHOT_VERSION = 1;

/**
 * The events of a content part, as the replica that exported them
 * placed them: every event `replica` accepted under `generation` at a
 * position after `after` and up to `through`, of any author — what
 * `changes` from a token at `after` gives. A whole export starts at 0
 * and ends at the position accepted last when its cut was made. A
 * label of the exporting replica's own: no importer takes it for a
 * position or a token of its own.
 */
export type SnapshotRange = Readonly<{ replica: AuthorId; generation: string; after: number; through: number }>;

/**
 * The parts an export writes: the seed alone, with the events of
 * `types` and the objects those events hold on their own; the content
 * alone; or both, the content's events standing for the seed's.
 */
export type SnapshotParts = { parts: "seed"; types: ReadonlySet<string> } | { parts: "content" | "both"; types?: undefined };

export type ExportSnapshotOptions = SnapshotParts & {
  /** The roots the exported events hold, folded by the caller under the lock: through the held view, or, for the seed alone, through a vault of the selected events alone that reads its objects through the held view. */
  heldRoots: HeldRoots;
  /**
   * The most bytes the CAR may be. Checked before an event is read
   * against the events' tally, for an export with content; once the
   * events are read against their bytes, before the fold runs; and
   * against the CAR's whole length, before an object is read.
   * `SnapshotTooLarge` past it, nothing written. Unbounded when left out.
   */
  maxBytes?: number;
};

export interface ReadSnapshotOptions {
  /** The roots the snapshot's events hold, folded by the caller from the snapshot's own events: the objects must be exactly these. */
  heldRoots: HeldRoots;
}

type Problem = { where: string; error: string };

/** An event or an object as the CAR names it: the CID, and the bytes or the size of its block. */
type EventBlock = { cid: EventCid; bytes: Uint8Array };
type ObjectBlock = { cid: Cid; size: number };

/** One cut of a vault, read whole under the lock before a block is written. */
interface Cut {
  header: CarHeader;
  length: number;
  events: EventBlock[];
  /** the held objects, but those that are events as well: their block is the event's */
  objects: ObjectBlock[];
}

/**
 * Exports the parts `options` names from `runtime` as a CAR, all under
 * the writer lock: the cut is selected — `SnapshotTooLarge` past
 * `maxBytes`, `IncompleteSnapshot` when the history has damage or a
 * held root is absent or known damaged, nothing read further in either
 * case — and its length computed; then the CAR is written into one
 * buffer of that length, the events in canonical order, then each held
 * object in CID order, streamed through the vault's own read, which
 * rehashes it, and is not checked again. A content part's range is
 * read in the same lock as its events. A source that fails while its
 * bytes are written is `IncompleteSnapshot`.
 */
export async function exportSnapshot(runtime: VaultRuntime, options: ExportSnapshotOptions): Promise<Uint8Array> {
  return runtime.locked(async (held) => {
    const cut = await cutOf(runtime, held, options);
    const writer = new CarWriter(cut.header, cut.length);
    for (const { cid, bytes } of cut.events) {
      writer.block(cid, bytes.length);
      writer.write(bytes);
    }
    for (const object of cut.objects) {
      writer.block(object.cid, object.size);
      await written(writer, held, object);
    }
    return writer.close();
  });
}

async function cutOf(runtime: VaultRuntime, held: Held, options: ExportSnapshotOptions): Promise<Cut> {
  const { maxBytes } = options;
  let range: SnapshotRange | undefined;
  if (options.parts !== "seed") {
    const tally = await held.tally();
    if (maxBytes !== undefined && tally.bytes > maxBytes) throw new SnapshotTooLarge(maxBytes, tally.bytes);
    range = { replica: runtime.author, generation: runtime.generation, after: 0, through: tally.lastSeq };
  }
  const damage = await held.events.damaged();
  if (damage.length > 0) throw new IncompleteSnapshot(damage.map(({ where, error }) => ({ where, error })));
  const wrapped = options.parts === "content" ? undefined : await runtime.keystore.read();
  const events = options.parts === "seed" ? await selected(held, options.types) : await scanned(held);
  const blocks = events.map((event) => ({ cid: event.cid, bytes: canonicalEventBytes(event) }));
  const eventBytes = blocks.reduce((n, block) => n + block.bytes.length, 0);
  if (maxBytes !== undefined && eventBytes > maxBytes) throw new SnapshotTooLarge(maxBytes, eventBytes);
  const folded = options.parts === "seed" ? await selection(runtime.metadata, held, events) : held;
  const eventCids = new Set<Cid>(events.map((event) => event.cid as string as Cid));
  const problems: Problem[] = [];
  const objects: ObjectBlock[] = [];
  for (const cid of sortCids(checkedCids(await options.heldRoots(folded)))) {
    let info;
    try {
      info = await held.objects.stat(cid);
    } catch (err) {
      if (!(err instanceof DamagedObject)) throw err;
      problems.push({ where: `objects/${cid}`, error: err.message });
      continue;
    }
    if (info === null) problems.push({ where: `objects/${cid}`, error: "held by the events but not present" });
    else if (!eventCids.has(cid)) objects.push({ cid, size: info.size });
  }
  if (problems.length > 0) throw new IncompleteSnapshot(problems);
  const header: CarHeader = { roots: blocks.map((block) => block.cid), metadata: { estoc: estocOf(runtime.metadata, wrapped, range) } };
  const length = carLength(header, [...blocks.map((block) => block.bytes.length), ...objects.map((object) => object.size)]);
  if (maxBytes !== undefined && length > maxBytes) throw new SnapshotTooLarge(maxBytes, length);
  return { header, length, events: blocks, objects };
}

async function scanned(held: Held): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of held.events.scan()) events.push(event);
  return events;
}

async function selected(held: Held, types: ReadonlySet<string>): Promise<Event[]> {
  const events: Event[] = [];
  for (const type of types) for await (const event of held.events.scan({ type })) events.push(event);
  return events.sort(compareEvents);
}

/** The selected events as a vault of their own, reading objects through the held view: what a selection's held roots are folded from, as a read folds them from the snapshot's own events. Read only, as a snapshot is: a commit is refused. */
export async function selection(metadata: VaultMetadata, held: Held, events: Event[]): Promise<Vault> {
  const selected = new MemoryVault({ metadata });
  await selected.ingest(events);
  return {
    metadata,
    events: selected.vault.events,
    objects: held.objects,
    commit: () => Promise.reject(new UnsupportedOperation("a commit to the selection an export folds")),
  };
}

/** The block of `object` filled from the vault's read of it: a read that fails, or ends short of the size stated, is `IncompleteSnapshot`; one past it the writer refuses. */
async function written(writer: CarWriter, held: Held, { cid, size }: ObjectBlock): Promise<void> {
  const incomplete = (error: string): IncompleteSnapshot => new IncompleteSnapshot([{ where: `objects/${cid}`, error }]);
  let got = 0;
  try {
    const stream = await held.objects.open(cid);
    if (stream === null) throw new Error("held by the events but not present");
    for await (const chunk of chunksOf(stream)) {
      writer.write(chunk);
      got += chunk.length;
    }
  } catch (err) {
    throw incomplete(err instanceof Error ? err.message : String(err));
  }
  if (got !== size) throw incomplete(`${got} bytes read of its ${size}`);
}

function estocOf(metadata: VaultMetadata, wrapped: WrappedSeed | undefined, range: SnapshotRange | undefined): Drisl {
  const estoc: { [key: string]: Drisl } = { snapshot: SNAPSHOT_VERSION, vault_version: metadata.version, anchor: metadata.anchor };
  if (wrapped !== undefined) estoc["seed"] = wrapped.seedJwe;
  if (range !== undefined) estoc["content"] = { replica: range.replica, generation: range.generation, after: range.after, through: range.through };
  return estoc;
}

/**
 * A snapshot read and validated whole: what a restore and an import
 * take, made only by `Snapshot.read`, which owns the bytes it read.
 * `seed` is the wrapper of the seed part and `content` the range of the
 * content part, each `undefined` when the snapshot carries no such
 * part; `vault` is the events and the objects they hold as a read-only
 * `Vault`, beside the counts of each and of their bytes. The snapshot
 * reads the same however often it is read, by as many operations as
 * take it.
 */
export class Snapshot {
  readonly metadata: VaultMetadata;
  readonly seed: WrappedSeed | undefined;
  readonly content: SnapshotRange | undefined;
  readonly vault: Vault;
  readonly events: number;
  readonly eventBytes: number;
  readonly objects: number;
  readonly objectBytes: number;

  private constructor(header: Header, events: Event[], eventBytes: number, objects: Map<Cid, Uint8Array>) {
    this.metadata = header.metadata;
    this.seed = header.seed;
    this.content = header.content;
    this.vault = new SnapshotVault(header.metadata, events, objects);
    this.events = events.length;
    this.eventBytes = eventBytes;
    this.objects = objects.size;
    this.objectBytes = [...objects.values()].reduce((n, bytes) => n + bytes.length, 0);
  }

  /**
   * Reads `bytes` as a snapshot, taking them over first: when they are
   * all of their buffer, the buffer is transferred to the snapshot and
   * the caller's view of it detached; otherwise they are copied, once.
   * Every block is a view into what was taken, and nothing outside can
   * reach it: what the snapshot hands out is a copy.
   *
   * Refused, in order: a CAR that does not decode, `InvalidSnapshot`; a
   * header that is not this format's — members beside `estoc`, a
   * member of `estoc` missing or unknown, another format or vault
   * version, an anchor that is no DID, a seed not of the keystore's
   * profile, a range that is no range or does not start at 0, neither
   * part — `NotAVault`; then, all reported at once as
   * `InvalidSnapshot`, a block whose bytes do not hash to its CID, a
   * root named twice, one that is not a raw CID or has no block, one
   * whose block is not an envelope's canonical bytes, and a block not
   * raw. Then `heldRoots` is folded from the events, every block
   * readable as an object meanwhile, and the objects must be exactly
   * what it returns: a held root with no block, and a block that is
   * neither an event nor held, are `InvalidSnapshot`. A block can be an
   * event and an object at once. Nothing is written anywhere.
   */
  static async read(bytes: Uint8Array, options: ReadSnapshotOptions): Promise<Snapshot> {
    const own = taken(bytes);
    let car: Car;
    try {
      car = await decodeCar(own);
    } catch (err) {
      throw new InvalidSnapshot([{ where: "car", error: err instanceof Error ? err.message : String(err) }]);
    }
    const header = headerOf(car.metadata);
    const problems: Problem[] = car.bad.map((name) => ({ where: `blocks/${name}`, error: "the bytes do not hash to the CID they are named by" }));
    const roots = new Set<string>();
    const events: Event[] = [];
    let eventBytes = 0;
    for (const root of car.roots) {
      if (roots.has(root)) {
        problems.push({ where: `roots/${root}`, error: "named twice" });
        continue;
      }
      roots.add(root);
      const block = car.blocks.get(root);
      if (!isEventCid(root)) problems.push({ where: `roots/${root}`, error: "not a raw CID, as an event's is" });
      else if (block === undefined) problems.push({ where: `roots/${root}`, error: "no block" });
      else {
        try {
          events.push(eventOf(block));
          eventBytes += block.length;
        } catch (err) {
          problems.push({ where: `events/${root}`, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    const blocks = new Map<Cid, Uint8Array>();
    for (const [cid, block] of car.blocks) {
      if (isRawCid(cid)) blocks.set(cid, block);
      else problems.push({ where: `blocks/${cid}`, error: "not a raw CID: neither an event nor an object" });
    }
    if (problems.length > 0) throw new InvalidSnapshot(problems);
    events.sort(compareEvents);
    deepFreeze(events);
    const held = new Set(checkedCids(await options.heldRoots(new SnapshotVault(header.metadata, events, blocks))));
    for (const cid of sortCids(held)) {
      if (!blocks.has(cid)) problems.push({ where: `objects/${cid}`, error: "held by the events but not in the snapshot" });
    }
    for (const cid of blocks.keys()) {
      if (!roots.has(cid) && !held.has(cid)) problems.push({ where: `blocks/${cid}`, error: "neither an event nor held by one" });
    }
    if (problems.length > 0) throw new InvalidSnapshot(problems);
    const objects = new Map<Cid, Uint8Array>();
    for (const cid of sortCids(held)) objects.set(cid, blocks.get(cid) as Uint8Array);
    return new Snapshot(header, events, eventBytes, objects);
  }
}

/**
 * `bytes` as the snapshot's own. A view that spans its whole buffer has
 * the buffer transferred, at a fixed length, rather than copied: the
 * caller's view is detached and the snapshot holds the only reference
 * to what it validates. A part of a larger buffer, a shared buffer and
 * one that cannot be detached — a WebAssembly memory — are copied.
 */
function taken(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("a snapshot is read from a Uint8Array");
  const { buffer } = bytes;
  if (buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    try {
      return new Uint8Array(buffer.transferToFixedLength());
    } catch {
      // not detachable: copied below like any other
    }
  }
  return new Uint8Array(bytes);
}

interface Header {
  metadata: VaultMetadata;
  seed: WrappedSeed | undefined;
  content: SnapshotRange | undefined;
}

const RANGE_MEMBERS = ["replica", "generation", "after", "through"];

function headerOf(metadata: CarMetadata): Header {
  const names = Object.keys(metadata);
  if (names.length !== 1 || names[0] !== "estoc") throw new NotAVault(`a snapshot's CAR header has one member beside version and roots, estoc, where this one has ${names.map((name) => JSON.stringify(name)).join(", ") || "none"}`);
  const estoc = mapOf(metadata["estoc"], "the header's estoc member");
  checkMembers(estoc, ["snapshot", "vault_version", "anchor"], ["seed", "content"], "the header's estoc member");
  if (estoc["snapshot"] !== SNAPSHOT_VERSION) throw new NotAVault(`snapshot format ${describeDrislValue(estoc["snapshot"])} is not ${SNAPSHOT_VERSION}`);
  if (estoc["vault_version"] !== VAULT_VERSION) throw new NotAVault(`vault version ${describeDrislValue(estoc["vault_version"])} is not ${VAULT_VERSION}`);
  const vault = checkMetadata({ version: VAULT_VERSION, anchor: estoc["anchor"] });
  const seed = Object.hasOwn(estoc, "seed") ? seedOf(estoc["seed"] as Drisl) : undefined;
  const content = Object.hasOwn(estoc, "content") ? rangeOf(estoc["content"] as Drisl) : undefined;
  if (seed === undefined && content === undefined) throw new NotAVault("a snapshot carries a seed part, a content part or both: this one carries neither");
  return { metadata: vault, seed, content };
}

function seedOf(value: Drisl): WrappedSeed {
  if (typeof value !== "string") throw new NotAVault(`the seed part is a compact JWE, not ${describeDrislValue(value)}`);
  return checkWrappedSeed({ version: 3, seedJwe: value });
}

function rangeOf(value: Drisl): SnapshotRange {
  const range = mapOf(value, "the content part's range");
  checkMembers(range, RANGE_MEMBERS, [], "the content part's range");
  const { replica, generation, after, through } = range;
  if (!isAuthorId(replica)) throw new NotAVault(`the range's replica ${describeDrislValue(replica)} is not a canonical UUIDv7`);
  if (!isUuidv7(generation)) throw new NotAVault(`the range's generation ${describeDrislValue(generation)} is not a canonical UUIDv7`);
  for (const [name, position] of [["after", after], ["through", through]] as const) {
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) throw new NotAVault(`the range's ${name} ${describeDrislValue(position)} is not a position`);
  }
  if ((after as number) > (through as number)) throw new NotAVault(`the range runs from ${after as number} to ${through as number}, backwards`);
  if (after !== 0) throw new NotAVault(`the content part starts after position ${after as number}: an increment, which this reader does not take; a content part starts at 0`);
  return Object.freeze({ replica, generation, after: 0, through: through as number });
}

function mapOf(value: Drisl | undefined, what: string): { readonly [key: string]: Drisl } {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array || value instanceof Link || value instanceof Float) throw new NotAVault(`${what} is a map, not ${describeDrislValue(value)}`);
  return value;
}

function checkMembers(map: { readonly [key: string]: Drisl }, required: readonly string[], optional: readonly string[], what: string): void {
  const unknown = Object.keys(map).filter((key) => !required.includes(key) && !optional.includes(key));
  if (unknown.length > 0) throw new NotAVault(`${what} has ${unknown.map((key) => JSON.stringify(key)).join(", ")}, which this format does not`);
  const missing = required.filter((key) => !Object.hasOwn(map, key));
  if (missing.length > 0) throw new NotAVault(`${what} has no ${missing.join(", ")}`);
}

function describeDrislValue(value: Drisl | undefined): string {
  if (value === undefined) return "nothing";
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `the integer ${value}`;
  if (value instanceof Float) return `the float ${value.toString()}`;
  if (value instanceof Link) return `a link to ${value.cid.text}`;
  if (value instanceof Uint8Array) return `${value.length} bytes`;
  return Array.isArray(value) ? "an array" : "a map";
}

/** The event a root's block holds, which must be the canonical bytes of a valid envelope. */
function eventOf(block: Uint8Array): Event {
  const { event, bytes } = canonicalEnvelope(parseStrict(block));
  if (compareBytes(bytes, block) !== 0) throw new Error("the block is a valid envelope, but not in its canonical bytes");
  return event;
}

const OBJECT_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * A snapshot's events and objects as a read-only `Vault`: scans in
 * canonical order, objects under the ordinary read rules, every one
 * sound — each block was checked against its CID as it was read — so
 * nothing is damaged. What is handed out is the snapshot's events,
 * frozen, and copies of its objects' bytes. It has no author, no
 * positions and no change frontier: `changes` is refused, and
 * `commit` with it.
 */
class SnapshotVault implements Vault {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;

  constructor(
    readonly metadata: VaultMetadata,
    events: readonly Event[],
    blocks: ReadonlyMap<Cid, Uint8Array>
  ) {
    const block = (cid: Cid): Uint8Array | undefined => blocks.get(rawCidOf(cid).text as Cid);
    this.events = {
      scan: async function* (filter) {
        checkFilter(filter);
        for (const event of events) if (matches(event, filter)) yield event;
      },
      changes: () => Promise.reject(new UnsupportedOperation("changes over a snapshot, which has no change frontier")),
      damaged: async () => [],
    };
    this.objects = {
      open: async (cid) => {
        const bytes = block(cid);
        return bytes === undefined ? null : chunks(bytes);
      },
      read: async (cid, maxBytes) => {
        const bytes = block(cid);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes is a non-negative integer");
        if (bytes === undefined) return null;
        if (bytes.length > maxBytes) throw new ObjectTooLarge(`${cid} is ${bytes.length} bytes, more than the ${maxBytes}-byte bound`);
        return bytes.slice();
      },
      stat: async (cid) => {
        const bytes = block(cid);
        return bytes === undefined ? null : { cid, codec: "raw", size: bytes.length };
      },
      has: async (cid) => block(cid) !== undefined,
      list: async function* () {
        yield* sortCids(blocks.keys());
      },
    };
  }

  commit(): Promise<never> {
    return Promise.reject(new UnsupportedOperation("commit over a snapshot"));
  }
}

/** `bytes` as a stream of copies, a chunk at a time as the reader pulls. */
function chunks(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at === bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(bytes.length, at + OBJECT_READ_CHUNK_BYTES);
        controller.enqueue(bytes.slice(at, end));
        at = end;
      },
    },
    { highWaterMark: 0 }
  );
}
