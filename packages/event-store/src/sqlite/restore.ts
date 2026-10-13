/**
 * A snapshot restored into a new runtime: a fresh database laid with
 * the runtime's own schema and filled with what the snapshot validated
 * as it was read, under a fresh replica identity, and opened.
 */

import { v7 } from "uuid";

import { AnchorMismatch, MissingPart } from "../errors.js";
import { canonicalEventBytes, type AuthorId, type Cid, type Event } from "../event.js";
import { VAULT_VERSION, type WrappedSeed } from "../keystore.js";
import { Packer, chunksOf } from "../objects.js";
import { Snapshot } from "../snapshot.js";
import type { Vault } from "../vault.js";
import type { SqliteDriver } from "./driver.js";
import { CHUNK_BYTES } from "./objects.js";
import { publishedRuntime, type RuntimeDatabase } from "./open.js";
import { APPLICATION_ID, SCHEMA_VERSION, createTables, query, run } from "./schema.js";

/**
 * Creates the database a restore lays the runtime in, a target nothing
 * is at yet: the platform's to provide — a path for `node:sqlite`, a
 * name in the pool for wasm. A destination a restore failed on is left
 * closed and unready, for the caller to remove.
 */
export type CreateDestination = () => Promise<SqliteDriver> | SqliteDriver;

export interface RestoreOptions {
  /**
   * The anchor DID the recovery credential derives: given outright when
   * the seed is in hand, or as the function that unlocks the snapshot's
   * wrapper and derives it — a wrong passphrase fails there. Compared
   * with the snapshot's own anchor before the destination is made:
   * `AnchorMismatch` otherwise.
   */
  anchor: string | ((wrapped: WrappedSeed) => string | Promise<string>);
}

/** What a restore made: the runtime, open on the destination, and what the snapshot held — its events and their canonical bytes, its objects and their bytes. */
export interface Restored {
  runtime: RuntimeDatabase;
  events: number;
  eventBytes: number;
  objects: number;
  objectBytes: number;
}

const FORMAT = "estoc-sqlite";

/** How many bytes of chunks are gathered from an object before a transaction writes them: the memory a restore holds beyond the chunk in hand. */
const BATCH_BYTES = 8 * CHUNK_BYTES;

type CopiedObject = { cid: Cid; size: number };

/**
 * Restores `snapshot`, which must carry the seed part — `MissingPart`
 * otherwise, before the credential is asked — into the runtime
 * `create` makes. The credential's anchor is compared with the
 * snapshot's first, nothing made when it differs; then the destination
 * is laid in one transaction as a runtime with `ready = 0`: the schema,
 * the metadata, the snapshot's wrapper adopted, a fresh replica ID and
 * store generation, and every event the snapshot carries — the
 * selection a seed alone brings, or with content every event — with a
 * fresh position in canonical order. Every held object is then written
 * in transactions of its own; the destination is checked against what
 * the snapshot counted and set ready in one transaction; and the
 * runtime is returned open, on the same connection, for the host to
 * reconstruct what the events say is unfinished before it runs. A
 * failure after the destination was made closes it and leaves it
 * unready, for the caller to remove: it opens as nothing, and no seed
 * was minted for it. A snapshot with both parts restores what
 * restoring the seed alone and importing the content would.
 */
export async function restoreSnapshot(snapshot: Snapshot, create: CreateDestination, options: RestoreOptions): Promise<Restored> {
  if (!(snapshot instanceof Snapshot)) throw new TypeError("a restore takes a Snapshot that Snapshot.read made");
  const { metadata, seed, vault } = snapshot;
  if (seed === undefined) throw new MissingPart("seed");
  const derived = typeof options.anchor === "string" ? options.anchor : await options.anchor(seed);
  if (derived !== metadata.anchor) throw new AnchorMismatch(metadata.anchor, derived);
  const events: Event[] = [];
  for await (const event of vault.events.scan()) events.push(event);
  const objects: CopiedObject[] = [];
  for await (const cid of vault.objects.list()) {
    const info = await vault.objects.stat(cid);
    if (info === null) throw new Error(`${cid} is listed by the snapshot but has no bytes`);
    objects.push({ cid, size: info.size });
  }
  const writer = await create();
  try {
    if (writer.mode !== "create") throw new TypeError(`the destination was opened ${writer.mode}, not to create`);
    if (Number(query(writer, "SELECT count(*) AS n FROM sqlite_master")[0]?.["n"]) > 0) throw new Error("a runtime is restored into an empty database: this one already has a schema");
    const control = { author: v7() as AuthorId, generation: v7() };
    lay(writer, metadata.anchor, seed, control, events);
    await copyObjects(writer, vault, objects);
    const counts = { events: snapshot.events, eventBytes: snapshot.eventBytes, objects: snapshot.objects, objectBytes: snapshot.objectBytes };
    publish(writer, counts, objects);
    return { runtime: publishedRuntime(writer, metadata, control), ...counts };
  } catch (err) {
    writer.close();
    throw err;
  }
}

/** The destination as a runtime, not yet ready: the schema, the metadata, the wrapper, fresh control, and every event under a fresh position in canonical order, in one transaction. */
function lay(writer: SqliteDriver, anchor: string, wrapped: WrappedSeed, control: { author: AuthorId; generation: string }, events: Event[]): void {
  writer.transaction("immediate", () => {
    writer.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
    createTables(writer);
    run(writer, "INSERT INTO vault_meta (singleton, format, vault_version, kind, ready, anchor) VALUES (1, ?, ?, 'runtime', 0, ?)", FORMAT, VAULT_VERSION, anchor);
    run(writer, "INSERT INTO keystore (singleton, version, seed_jwe) VALUES (1, 3, ?)", new TextEncoder().encode(wrapped.seedJwe));
    run(writer, "INSERT INTO store_state (singleton, replica_id, store_generation, last_seq) VALUES (1, ?, ?, ?)", control.author, control.generation, events.length);
    const insertEvent = writer.prepare("INSERT INTO events (cid, at, author, type, canonical) VALUES (?, ?, ?, CAST(? AS TEXT), ?)");
    const insertPosition = writer.prepare("INSERT INTO event_positions (accepted_seq, cid) VALUES (?, ?)");
    try {
      events.forEach((event, i) => {
        insertEvent.run(event.cid, event.at, event.author, new TextEncoder().encode(event.type), canonicalEventBytes(event));
        insertPosition.run(i + 1, event.cid);
      });
    } finally {
      insertEvent.finalize();
      insertPosition.finalize();
    }
  });
}

/**
 * Every object of `objects` written from the snapshot's `vault` into
 * the destination, one at a time, cut into the format's chunks and
 * written a batch at a time in transactions of their own, the
 * `objects` row with the first. The snapshot checked every block
 * against its CID as it read it and hands out copies of what it
 * checked, so the bytes are not hashed again here.
 */
async function copyObjects(writer: SqliteDriver, vault: Vault, objects: CopiedObject[]): Promise<void> {
  const insertObject = writer.prepare("INSERT INTO objects (cid, size) VALUES (?, ?)");
  const insertChunk = writer.prepare("INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, ?, ?)");
  try {
    for (const { cid, size } of objects) {
      let batch: Uint8Array[] = [];
      let batched = 0;
      let chunkNo = 0;
      let rowMade = false;
      const flush = (): void => {
        writer.transaction("immediate", () => {
          if (!rowMade) {
            insertObject.run(cid, size);
            rowMade = true;
          }
          for (const chunk of batch) insertChunk.run(cid, chunkNo++, chunk);
        });
        batch = [];
        batched = 0;
      };
      const packer = new Packer(CHUNK_BYTES, (chunk) => {
        batch.push(chunk);
        batched += chunk.length;
        if (batched >= BATCH_BYTES) flush();
      });
      const stream = await vault.objects.open(cid);
      if (stream === null) throw new Error(`${cid} is listed by the snapshot but has no bytes`);
      let got = 0;
      for await (const chunk of chunksOf(stream)) {
        packer.push(chunk);
        got += chunk.length;
      }
      packer.finish();
      if (got !== size) throw new Error(`${cid} read as ${got} bytes, not its ${size}`);
      flush();
    }
  } finally {
    insertObject.finalize();
    insertChunk.finalize();
  }
}

/** The destination checked against what the snapshot counted — events and their bytes, positions, objects, bytes and chunks — and set ready, in one transaction. */
function publish(writer: SqliteDriver, counts: Omit<Restored, "runtime">, objects: CopiedObject[]): void {
  const expected = {
    events: counts.events,
    eventBytes: counts.eventBytes,
    positions: counts.events,
    lastSeq: counts.events,
    objects: counts.objects,
    bytes: counts.objectBytes,
    chunks: objects.reduce((n, object) => n + Math.ceil(object.size / CHUNK_BYTES), 0),
  };
  writer.transaction("immediate", () => {
    const [row] = query(
      writer,
      "SELECT (SELECT count(*) FROM events) AS events, (SELECT coalesce(sum(length(canonical)), 0) FROM events) AS event_bytes, (SELECT count(*) FROM event_positions) AS positions, (SELECT last_seq FROM store_state) AS last_seq, (SELECT count(*) FROM objects) AS objects, (SELECT coalesce(sum(size), 0) FROM objects) AS bytes, (SELECT count(*) FROM object_chunks) AS chunks"
    );
    const laid = {
      events: Number(row?.["events"]),
      eventBytes: Number(row?.["event_bytes"]),
      positions: Number(row?.["positions"]),
      lastSeq: Number(row?.["last_seq"]),
      objects: Number(row?.["objects"]),
      bytes: Number(row?.["bytes"]),
      chunks: Number(row?.["chunks"]),
    };
    if (JSON.stringify(laid) !== JSON.stringify(expected)) throw new Error(`the destination holds ${JSON.stringify(laid)} where the snapshot has ${JSON.stringify(expected)}`);
    if (run(writer, "UPDATE vault_meta SET ready = 1 WHERE singleton = 1") !== 1) throw new Error("the metadata row is gone");
  });
}
