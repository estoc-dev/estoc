/**
 * The vault's SQLite schema, and the check that a database
 * holds exactly it. The check is structural — what the tables are, not
 * the SQL they were spelled with — through SQLite's own pragmas, plus a
 * probe for what the pragmas do not tell: a column's collation. Every
 * name read out of the schema is read as its stored bytes and decoded:
 * the file is checked before anything in it is trusted.
 */

import { NotAVault, SqliteError } from "../errors.js";
import { VAULT_VERSION } from "../keystore.js";
import { decodeText, type SqliteDriver, type SqlRow, type SqlValue } from "./driver.js";

/** `PRAGMA application_id`: the bytes `ESTC`. */
export const APPLICATION_ID = 0x45535443;
/** `PRAGMA user_version`: the SQLite schema this module makes and accepts. */
export const SCHEMA_VERSION = 2;

const DDL = [
  `CREATE TABLE vault_meta (
    singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
    format        TEXT NOT NULL CHECK (format = 'estoc-sqlite'),
    vault_version INTEGER NOT NULL CHECK (vault_version = ${VAULT_VERSION}),
    kind          TEXT NOT NULL CHECK (kind = 'runtime'),
    ready         INTEGER NOT NULL CHECK (ready IN (0, 1)),
    anchor        TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE keystore (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version   INTEGER NOT NULL CHECK (version = 3),
    seed_jwe  BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE events (
    cid       TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
    at        TEXT COLLATE BINARY NOT NULL,
    author    TEXT COLLATE BINARY NOT NULL,
    type      TEXT COLLATE BINARY NOT NULL,
    canonical BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE objects (
    cid  TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0)
  ) STRICT`,
  `CREATE TABLE object_chunks (
    cid      TEXT COLLATE BINARY NOT NULL REFERENCES objects(cid) ON DELETE CASCADE,
    chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0),
    bytes    BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
    PRIMARY KEY (cid, chunk_no)
  ) STRICT`,
  `CREATE TABLE store_state (
    singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
    replica_id       TEXT NOT NULL,
    store_generation TEXT NOT NULL,
    last_seq         INTEGER NOT NULL CHECK (last_seq >= 0)
  ) STRICT`,
  `CREATE TABLE event_positions (
    accepted_seq INTEGER PRIMARY KEY CHECK (accepted_seq > 0),
    cid          TEXT COLLATE BINARY NOT NULL UNIQUE REFERENCES events(cid)
  ) STRICT`,
];

/** Creates the runtime's tables in an empty database. */
export function createTables(driver: SqliteDriver): void {
  for (const sql of DDL) driver.exec(sql);
}

/** The rows of `sql` with `params` bound, from a statement prepared for this call and finalized after it. */
export function query(driver: SqliteDriver, sql: string, ...params: SqlValue[]): SqlRow[] {
  const statement = driver.prepare(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

/** The rows `sql` with `params` bound changed, from a statement prepared for this call and finalized after it. */
export function run(driver: SqliteDriver, sql: string, ...params: SqlValue[]): number {
  const statement = driver.prepare(sql);
  try {
    return statement.run(...params).changes;
  } finally {
    statement.finalize();
  }
}

/** Whether the schema has a table named `name`: for the tables a runtime makes on first use. The name is the runtime's own, never a file's. */
export function hasTable(driver: SqliteDriver, name: string): boolean {
  return query(driver, "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;
}

type ColumnType = "INTEGER" | "TEXT" | "BLOB";

interface Column {
  name: string;
  type: ColumnType;
  notNull: boolean;
  /** 0 when not part of the primary key, else its 1-based place in it. */
  pk: number;
}

/** A column of the index a constraint made, with how the index orders it. */
interface Keyed {
  name: string;
  collation: string;
  descending: boolean;
}

interface ForeignKey {
  from: string;
  table: string;
  to: string;
  onUpdate: string;
  onDelete: string;
  match: string;
}

/** A table as the pragmas describe it: what the DDL above makes, and what a database must match. */
interface TableShape {
  columns: Column[];
  /** The indexes the PRIMARY KEY and UNIQUE constraints made, in declaration order. */
  keys: Keyed[][];
  foreignKeys: ForeignKey[];
}

const column = (name: string, type: ColumnType, notNull = true, pk = 0): Column => ({ name, type, notNull, pk });
const key = (...names: string[]): Keyed[] => names.map((name) => ({ name, collation: "BINARY", descending: false }));
const reference = (from: string, table: string, to: string, onDelete = "NO ACTION"): ForeignKey => ({ from, table, to, onUpdate: "NO ACTION", onDelete, match: "NONE" });

const TABLES = new Map<string, TableShape>([
  [
    "vault_meta",
    {
      columns: [column("singleton", "INTEGER", false, 1), column("format", "TEXT"), column("vault_version", "INTEGER"), column("kind", "TEXT"), column("ready", "INTEGER"), column("anchor", "TEXT")],
      keys: [],
      foreignKeys: [],
    },
  ],
  ["keystore", { columns: [column("singleton", "INTEGER", false, 1), column("version", "INTEGER"), column("seed_jwe", "BLOB")], keys: [], foreignKeys: [] }],
  [
    "events",
    {
      columns: [column("cid", "TEXT", true, 1), column("at", "TEXT"), column("author", "TEXT"), column("type", "TEXT"), column("canonical", "BLOB")],
      keys: [key("cid")],
      foreignKeys: [],
    },
  ],
  ["objects", { columns: [column("cid", "TEXT", true, 1), column("size", "INTEGER")], keys: [key("cid")], foreignKeys: [] }],
  [
    "object_chunks",
    {
      columns: [column("cid", "TEXT", true, 1), column("chunk_no", "INTEGER", true, 2), column("bytes", "BLOB")],
      keys: [key("cid", "chunk_no")],
      foreignKeys: [reference("cid", "objects", "cid", "CASCADE")],
    },
  ],
  ["store_state", { columns: [column("singleton", "INTEGER", false, 1), column("replica_id", "TEXT"), column("store_generation", "TEXT"), column("last_seq", "INTEGER")], keys: [], foreignKeys: [] }],
  ["event_positions", { columns: [column("accepted_seq", "INTEGER", false, 1), column("cid", "TEXT")], keys: [key("cid")], foreignKeys: [reference("cid", "events", "cid")] }],
]);

/** A table a runtime may keep beside the schema's: its own local state, or the statistics `ANALYZE` leaves. */
const EXTRA_TABLE = /^(local_[a-z0-9_]+|sqlite_stat[1-4])$/;

/**
 * Checks that the database holds exactly the runtime's schema — every
 * table of it with the columns, types, collations, keys and references
 * of schema version 2, all `STRICT` — and nothing that is not allowed
 * beside it: further indexes, `local_*` tables and `ANALYZE`
 * statistics. A view or a trigger is refused. `NotAVault` names the
 * first thing that does not fit; no row of any table is read.
 */
export function checkSchema(driver: SqliteDriver): void {
  const objects = query(driver, "SELECT type, CAST(name AS BLOB) AS name FROM sqlite_master ORDER BY type, name").map((row) => ({ type: String(row["type"]), name: text(row["name"], "sqlite_master.name") }));
  for (const object of objects) {
    if (object.type !== "table" && object.type !== "index") throw new NotAVault(`the schema has a ${object.type}, ${object.name}: a vault has tables and their indexes only`);
  }
  const tables = new Set(objects.filter((object) => object.type === "table").map((object) => object.name));
  for (const name of TABLES.keys()) {
    if (!tables.has(name)) throw new NotAVault(`table ${name} is missing`);
  }
  for (const name of tables) {
    if (TABLES.has(name) || EXTRA_TABLE.test(name)) continue;
    throw new NotAVault(`table ${name} is not in the runtime schema`);
  }
  for (const [name, shape] of TABLES) checkTable(driver, name, shape);
}

function checkTable(driver: SqliteDriver, name: string, expected: TableShape): void {
  const [listed] = query(driver, "SELECT strict, wr FROM pragma_table_list(?) WHERE schema = 'main'", name);
  if (listed?.["strict"] !== 1) throw new NotAVault(`table ${name} is not STRICT`);
  if (listed["wr"] !== 0) throw new NotAVault(`table ${name} is WITHOUT ROWID: a vault's tables keep their rowid`);
  const columns = query(driver, 'SELECT CAST(name AS BLOB) AS name, CAST(type AS BLOB) AS type, "notnull" AS not_null, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid', name).map((row) => ({
    name: text(row["name"], `${name} column`),
    type: text(row["type"], `${name} column type`).toUpperCase() as ColumnType,
    notNull: row["not_null"] === 1,
    pk: Number(row["pk"]),
    hidden: row["hidden"] !== 0,
  }));
  const hidden = columns.find((c) => c.hidden);
  if (hidden !== undefined) throw new NotAVault(`table ${name}: column ${hidden.name} is generated or hidden`);
  const keys: Keyed[][] = [];
  for (const index of query(driver, "SELECT CAST(name AS BLOB) AS name, origin FROM pragma_index_list(?) ORDER BY seq", name)) {
    if (String(index["origin"]) === "c") continue;
    const indexName = text(index["name"], `${name} index`);
    keys.push(
      query(driver, 'SELECT CAST(name AS BLOB) AS name, coll, "desc" AS descending FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno', indexName).map((row) => ({
        name: text(row["name"], `${indexName} column`),
        collation: String(row["coll"]).toUpperCase(),
        descending: row["descending"] === 1,
      }))
    );
  }
  const foreignKeys = query(driver, 'SELECT CAST("table" AS BLOB) AS "table", CAST("from" AS BLOB) AS "from", CAST("to" AS BLOB) AS "to", on_update, on_delete, match FROM pragma_foreign_key_list(?) ORDER BY id, seq', name).map(
    (row): ForeignKey => ({
      from: text(row["from"], `${name} foreign key`),
      table: text(row["table"], `${name} foreign key`),
      to: text(row["to"], `${name} foreign key`),
      onUpdate: String(row["on_update"]),
      onDelete: String(row["on_delete"]),
      match: String(row["match"]),
    })
  );
  const actual: TableShape = { columns: columns.map(({ name: n, type, notNull, pk }) => ({ name: n, type, notNull, pk })), keys, foreignKeys };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new NotAVault(`table ${name} is not schema version ${SCHEMA_VERSION}'s: expected ${describe(expected)}; found ${describe(actual)}`);
  }
  for (const c of expected.columns) {
    if (c.type === "TEXT" && !comparesBinary(driver, name, c.name)) throw new NotAVault(`table ${name}: column ${c.name} does not compare as BINARY`);
  }
}

/**
 * Whether the text column `column` of `table` collates as BINARY. No
 * pragma reports a column's collation; the column's own comparison
 * does. A column of an empty selection carries its collation into a
 * compound with it, so comparing a value through such a compound
 * compares it as the column would: NOCASE finds `A` equal to `a`, RTRIM
 * finds `a ` equal, BINARY neither. Both names are the schema's, never
 * the file's. A collation the platform does not have fails to prepare.
 */
function comparesBinary(driver: SqliteDriver, table: string, column: string): boolean {
  try {
    const [row] = query(driver, `SELECT count(*) AS n FROM (SELECT "${column}" AS c FROM "${table}" WHERE 0 UNION ALL SELECT 'A' UNION ALL SELECT 'a ') WHERE c = 'a'`);
    return row?.["n"] === 0;
  } catch (err) {
    if (err instanceof SqliteError) throw new NotAVault(`table ${table}: column ${column} cannot be compared: ${err.message}`);
    throw err;
  }
}

function describe(shape: TableShape): string {
  const columns = shape.columns.map((c) => `${c.name} ${c.type}${c.notNull ? " NOT NULL" : ""}${c.pk > 0 ? ` PK${c.pk}` : ""}`);
  const keys = shape.keys.map((k) => `KEY(${k.map((c) => `${c.name}${c.collation === "BINARY" ? "" : ` COLLATE ${c.collation}`}${c.descending ? " DESC" : ""}`).join(", ")})`);
  const references = shape.foreignKeys.map((f) => `${f.from} REFERENCES ${f.table}(${f.to}) ON UPDATE ${f.onUpdate} ON DELETE ${f.onDelete}${f.match === "NONE" ? "" : ` MATCH ${f.match}`}`);
  return [...columns, ...keys, ...references].join(", ");
}

/** The stored bytes `value` as the text they spell, read the way a foreign file's text is; `NotAVault` when they spell none. */
export function text(value: SqlValue | undefined, what: string): string {
  if (!(value instanceof Uint8Array)) throw new NotAVault(`${what} is not text`);
  try {
    return decodeText(value, what);
  } catch (err) {
    throw new NotAVault(err instanceof Error ? err.message : String(err));
  }
}
