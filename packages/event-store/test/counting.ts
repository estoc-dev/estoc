import type { SqlRow, SqlValue, SqliteDriver, SqliteStatement } from "../src/index.js";

/** What a vault read off its database, by the kind of statement that read it. */
export interface Reads {
  /** reads of every event in canonical order: what a scan with no filter costs */
  scans: number;
  /** reads in canonical order narrowed by a filter */
  filteredScans: number;
  /** reads of the events accepted after a change token */
  changes: number;
  /** reads of every event in the order of the table, as a survey of damage makes */
  surveys: number;
  /** the rows those four handed over: the events decoded and held to their schema */
  eventRows: number;
  /** objects whose first chunk was read */
  objects: number;
  objectChunks: number;
  objectBytes: number;
}

export const noReads = (): Reads => ({ scans: 0, filteredScans: 0, changes: 0, surveys: 0, eventRows: 0, objects: 0, objectChunks: 0, objectBytes: 0 });

type Kind = "scans" | "filteredScans" | "changes" | "surveys" | "chunk" | null;

function kindOf(sql: string): Kind {
  if (sql.startsWith("SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = ?")) return "chunk";
  if (!/ FROM (events e|event_positions p JOIN events e)\b/.test(sql)) return null;
  if (sql.includes(" FROM event_positions p JOIN events e ")) return "changes";
  if (sql.endsWith(" ORDER BY e.rowid")) return "surveys";
  if (!sql.endsWith(" ORDER BY e.at, e.cid")) return null;
  return sql.includes(" WHERE ") ? "filteredScans" : "scans";
}

/**
 * `driver` with every read of events and of object bytes counted into
 * `reads`, told apart by the statement's text. Nothing else about the
 * driver changes, so what runs over it needs no counter of its own.
 */
export function countingDriver(driver: SqliteDriver, reads: Reads): SqliteDriver {
  const counted = (statement: SqliteStatement, kind: Exclude<Kind, null>): SqliteStatement => {
    const began = (params: SqlValue[]): void => {
      if (kind !== "chunk") reads[kind] += 1;
      else if (params[1] === 0) reads.objects += 1;
    };
    const row = <Row extends SqlRow | undefined>(read: Row): Row => {
      if (read === undefined) return read;
      if (kind !== "chunk") reads.eventRows += 1;
      else {
        reads.objectChunks += 1;
        const bytes = read["bytes"];
        if (bytes instanceof Uint8Array) reads.objectBytes += bytes.length;
      }
      return read;
    };
    return {
      run: (...params) => statement.run(...params),
      get(...params) {
        began(params);
        return row(statement.get(...params));
      },
      all(...params) {
        began(params);
        return statement.all(...params).map(row);
      },
      *iterate(...params) {
        began(params);
        for (const read of statement.iterate(...params)) yield row(read);
      },
      finalize: () => statement.finalize(),
    };
  };
  return {
    get mode() {
      return driver.mode;
    },
    get version() {
      return driver.version;
    },
    get inTransaction() {
      return driver.inTransaction;
    },
    get uncertain() {
      return driver.uncertain;
    },
    exec: (sql) => driver.exec(sql),
    prepare(sql) {
      const kind = kindOf(sql);
      const statement = driver.prepare(sql);
      return kind === null ? statement : counted(statement, kind);
    },
    transaction: (mode, body) => driver.transaction(mode, body),
    close: () => driver.close(),
  };
}
