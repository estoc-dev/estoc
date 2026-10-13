/**
 * Creating and opening a vault on whatever the platform's driver is,
 * as cases free of any test framework: run over `node:sqlite` by
 * `open.test.ts` and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What only a file on disk can show — a
 * second process, a crash mid-rewrap — is in the Node test, with the
 * counterexamples run there alone.
 */

import { VAULT_VERSION, createRuntime, openInspector, openRuntime, type OpenMode, type SqliteDriver } from "../../src/index.js";
import { ANCHOR, META, WRAPPED } from "../fixtures.js";
import { type Case, assert, assertEqual, assertRejects, assertThrows } from "./driver-cases.js";

export interface OpenHarness {
  /** A target no database exists at yet. */
  fresh(): string;
  open(target: string, mode: OpenMode): Promise<SqliteDriver>;
}

export interface OpenCase extends Case {
  /** Returns a note for the report, or nothing. */
  run(harness: OpenHarness): Promise<string | void>;
}

/** The metadata, wrapper and control rows of the database at `target`, read as they are stored. */
async function control(h: OpenHarness, target: string): Promise<unknown[]> {
  const db = await h.open(target, "readwrite");
  try {
    return ["vault_meta", "keystore", "store_state"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  } finally {
    db.close();
  }
}

/** A runtime created at a fresh target, `sql` run on it, closed. */
async function altered(h: OpenHarness, sql: string): Promise<string> {
  const target = h.fresh();
  const made = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
  try {
    made.driver.exec(sql);
  } finally {
    made.close();
  }
  return target;
}

export const openCases: OpenCase[] = [
  {
    name: "a runtime created here reopens with its identity and local IDs, and is inspected without a write",
    run: async (h) => {
      const target = h.fresh();
      const made = createRuntime(await h.open(target, "create"), { metadata: META, wrapped: WRAPPED });
      const { author, generation } = made;
      made.close();
      const runtime = await openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR });
      try {
        assertEqual(runtime.metadata, META, "metadata");
        assertEqual({ author: runtime.author, generation: runtime.generation }, { author, generation }, "local IDs");
        assertEqual(await runtime.keystore((op) => op()).read(), WRAPPED, "the wrapper");
      } finally {
        runtime.close();
      }
      const inspector = openInspector(await h.open(target, "readwrite"));
      try {
        assertEqual(inspector.writable, false, "an inspector is not writable");
        assertEqual(inspector.author, author, "the inspector sees the same replica");
        assertThrows(() => inspector.driver.exec("UPDATE store_state SET last_seq = 1"), "SqliteError", "a write through the inspector");
      } finally {
        inspector.close();
      }
    },
  },
  {
    name: "a runtime of the earlier vault version is refused before the seed is asked for, and is left as it was",
    run: async (h) => {
      const target = await altered(h, "PRAGMA ignore_check_constraints = ON; UPDATE vault_meta SET vault_version = 4");
      const before = await control(h, target);
      const refused = await assertRejects(
        async () =>
          openRuntime(await h.open(target, "readwrite"), {
            anchor: () => {
              throw new Error("the seed was asked for");
            },
          }),
        "NotAVault",
        "runtime"
      );
      assert(refused.message.includes(`vault version 4 is not ${VAULT_VERSION}`), `refused with ${refused.message}`);
      assertEqual(await control(h, target), before, "the metadata and control after the refusal");
    },
  },
  {
    name: "a table named like an object's inherited property is an extra table like any other",
    run: async (h) => {
      for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const target = await altered(h, `CREATE TABLE "${name}" (secret BLOB) STRICT`);
        const driver = await h.open(target, "readwrite");
        const refused = assertThrows(() => openInspector(driver), "NotAVault", name);
        assert(refused.message === `table ${name} is not in the runtime schema`, `${name}: ${refused.message}`);
      }
    },
  },
  {
    name: "a table made WITHOUT ROWID is not the schema's: refused before any write, the target released",
    run: async (h) => {
      const expected = "table events is WITHOUT ROWID: a vault's tables keep their rowid";
      const target = await altered(h, "DROP TABLE events; CREATE TABLE events (cid TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, author TEXT NOT NULL, type TEXT NOT NULL, canonical BLOB NOT NULL) STRICT, WITHOUT ROWID");
      const runtime = await assertRejects(async () => openRuntime(await h.open(target, "readwrite"), { anchor: ANCHOR }), "NotAVault", "runtime");
      assert(runtime.message === expected, runtime.message);
      const inspectorDriver = await h.open(target, "readwrite");
      const inspector = assertThrows(() => openInspector(inspectorDriver), "NotAVault", "inspector");
      assert(inspector.message === expected, inspector.message);
      const released = await h.open(target, "readwrite");
      released.close();
    },
  },
  {
    name: "a column that compares other than byte for byte is not the schema's",
    run: async (h) => {
      const target = await altered(h, "DROP TABLE events; CREATE TABLE events (cid TEXT PRIMARY KEY NOT NULL, at TEXT NOT NULL, author TEXT NOT NULL, type TEXT COLLATE NOCASE NOT NULL, canonical BLOB NOT NULL) STRICT");
      const driver = await h.open(target, "readwrite");
      const refused = assertThrows(() => openInspector(driver), "NotAVault", "NOCASE");
      assert(refused.message === "table events: column type does not compare as BINARY", refused.message);
    },
  },
];
