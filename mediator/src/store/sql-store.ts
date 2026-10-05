/**
 * One mediator store, many SQLite dialects.
 *
 * better-sqlite3 and Cloudflare D1 *are* SQLite — the schema and every query
 * are identical, so the store is written once against the narrowest contract
 * the backends share: a batch of statements that runs in order as one
 * transaction. That is D1's only transaction shape; better-sqlite3's
 * transactions are a superset, and every transactional path here fits it.
 * Drivers translate only the calling convention.
 *
 * The schema is ensured lazily on first use instead of by a migrations step,
 * so a fresh deploy needs nothing beyond an empty database; a failed ensure
 * (D1 hiccup, lost migration race) must not poison the process — the next
 * call retries from scratch.
 */

import { isLongForm, longToShort } from "@estoc/did-peer";

import type {
  AddRecipientResult,
  AddReplicaOutcome,
  BlobKeep,
  BlobRow,
  FanOutOutcome,
  KeepOutcome,
  MediationStore,
  PackageBounds,
  RecipientPage,
  RecipientPlace,
  RegisterAccountOutcome,
  RemoveOutcome,
  ReplicaAccount,
  ReplicaAddition,
  ReplicaDelivery,
  RosterPage,
  SharedRecipient,
  SharedRecipientPage,
  ShareOutcome,
  StoredMessage,
  StoreOutcome,
  UploadGrant,
} from "./types.js";

export type SqlValue = string | number | null | Uint8Array;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  /** Rows the statement modified; a driver that cannot know reports 0. */
  changes: number;
}

/** What a backend must do: run a list of statements as ONE transaction. */
export interface SqlDriver {
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
  close(): void;
}

export interface SqlStoreOptions {
  /** Messages older than this are purged. */
  messageTtlSeconds?: number;
  /** Past this many waiting messages an account stops receiving new ones. */
  maxMessagesPerAccount?: number;
  /**
   * The live mediator ensures its schema on first use (the default); an
   * admin tool visiting a database the mediator owns can skip the round trip.
   */
  ensureSchema?: boolean;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_MESSAGES = 1000;

const REPLICA_MAIL = [
  `CREATE TABLE IF NOT EXISTS replica_packages (
     id          TEXT PRIMARY KEY,
     account_did TEXT NOT NULL REFERENCES replica_accounts(did),
     next_did    TEXT NOT NULL,
     packed      TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS replica_packages_account ON replica_packages(account_did, expires_at)",
  "CREATE INDEX IF NOT EXISTS replica_packages_expiry ON replica_packages(expires_at)",
  `CREATE TABLE IF NOT EXISTS replica_deliveries (
     id          TEXT PRIMARY KEY,
     package_id  TEXT NOT NULL REFERENCES replica_packages(id),
     replica_did TEXT NOT NULL REFERENCES replicas(replica_did),
     UNIQUE (package_id, replica_did)
   )`,
  "CREATE INDEX IF NOT EXISTS replica_deliveries_replica ON replica_deliveries(replica_did)",
];

const REPLICAS = `CREATE TABLE IF NOT EXISTS replicas (
     replica_did   TEXT PRIMARY KEY,
     account_did   TEXT NOT NULL REFERENCES replica_accounts(did),
     ordinal       INTEGER NOT NULL,
     long_form     TEXT NOT NULL,
     grant_jws     TEXT NOT NULL,
     registered_at INTEGER NOT NULL,
     removed_at    INTEGER,
     UNIQUE (account_did, ordinal)
   )`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     did        TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS keylist (
     recipient_did TEXT PRIMARY KEY,
     owner_did     TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
     created_at    INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS keylist_owner ON keylist(owner_did)",
  `CREATE TABLE IF NOT EXISTS messages (
     id         TEXT PRIMARY KEY,
     owner_did  TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
     packed     TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS messages_owner ON messages(owner_did, created_at)",
  "CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at)",
  // owner_did deliberately has no foreign key: a blob must outlive its
  // account's row long enough for purge to learn its id and delete the bytes.
  `CREATE TABLE IF NOT EXISTS blobs (
     id           TEXT PRIMARY KEY,
     owner_did    TEXT NOT NULL,
     hash         TEXT NOT NULL,
     size         INTEGER NOT NULL,
     created_at   INTEGER NOT NULL,
     uploaded_at  INTEGER,
     retain_until INTEGER NOT NULL,
     UNIQUE (owner_did, hash)
   )`,
  "CREATE INDEX IF NOT EXISTS blobs_expiry ON blobs(retain_until)",
  `CREATE TABLE IF NOT EXISTS blob_uploads (
     token      TEXT PRIMARY KEY,
     blob_id    TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS replica_accounts (
     did          TEXT PRIMARY KEY,
     mediator     TEXT NOT NULL,
     long_form    TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     registration TEXT NOT NULL
   )`,
  REPLICAS,
  `CREATE TABLE IF NOT EXISTS replica_recipients (
     recipient_did TEXT PRIMARY KEY,
     account_did   TEXT NOT NULL REFERENCES replica_accounts(did),
     long_form     TEXT NOT NULL,
     created_at    INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS replica_recipients_account ON replica_recipients(account_did)",
  ...REPLICA_MAIL,
  `CREATE TABLE IF NOT EXISTS identity (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     secrets    TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

/*
 * Columns a table created before them gains in place. A replica enrolled
 * before removal existed is active, which NULL says. An account registered
 * before registrations were told apart is given its own as the column arrives.
 */
const LATER_COLUMNS = [
  { table: "replicas", column: "removed_at", type: "INTEGER" },
  { table: "replica_accounts", column: "registration", type: "TEXT" },
];
const NEW_REGISTRATION = "lower(hex(randomblob(16)))";
/*
 * Columns an older database still has and nothing uses any more. An indexed
 * column cannot be dropped, so the index over the two message columns goes
 * first.
 */
const FORMER_COLUMNS = [
  { table: "replica_accounts", column: "mediation_id" },
  { table: "messages", column: "next_did" },
  { table: "messages", column: "forward_id" },
];
const FORMER_INDEXES = ["messages_package"];

/**
 * The spellings one DID may be bound under. Ordinary mediation keeps a DID
 * as its holder wrote it, so a did:peer:4 can sit there in its long form
 * while replica mediation keeps the short one.
 */
function spellings(did: string, longForm?: string): [string, string] {
  return [did, longForm ?? (isLongForm(did) ? longToShort(did) : did)];
}

const ACTIVE = "removed_at IS NULL";
const NOT_ORDINARY =
  "NOT EXISTS (SELECT 1 FROM accounts WHERE did IN (?, ?)) " +
  "AND NOT EXISTS (SELECT 1 FROM keylist WHERE recipient_did IN (?, ?))";
const NOT_SHARED_RECIPIENT =
  "NOT EXISTS (SELECT 1 FROM replica_recipients WHERE recipient_did IN (?, ?))";
const NOT_REPLICA_MEDIATION =
  "NOT EXISTS (SELECT 1 FROM replica_accounts WHERE did IN (?, ?)) " +
  `AND NOT EXISTS (SELECT 1 FROM replicas WHERE replica_did IN (?, ?)) AND ${NOT_SHARED_RECIPIENT}`;

export class SqlStore implements MediationStore {
  private ttlMs: number;
  private maxMessages: number;
  private ensure: boolean;
  private ready: Promise<void> | null = null;

  constructor(
    private driver: SqlDriver,
    options: SqlStoreOptions = {}
  ) {
    this.ttlMs = (options.messageTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.maxMessages = options.maxMessagesPerAccount ?? DEFAULT_MAX_MESSAGES;
    this.ensure = options.ensureSchema ?? true;
  }

  private init(): Promise<void> {
    if (this.ready === null) {
      this.ready = this.ensure
        ? this.dropOldBlobTables()
            .then(() => this.driver.batch(SCHEMA.map((sql) => ({ sql }))))
            .then(() => this.alignColumns())
            .then(() => this.rebuildReplicas())
            .then(() => this.rebuildReplicaMail())
        : Promise.resolve();
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  /**
   * The first blob-store schema (2026-08-26/27) keyed blobs by hash with a
   * `blob_holds` table shared between mediations. Blobs are temporary by
   * design, so a database still carrying that shape is simply reset: the
   * three tables go and are recreated. Their bytes in storage are not
   * reachable from here and are the operator's to sweep.
   */
  private async dropOldBlobTables(): Promise<void> {
    const [found] = await this.driver.batch([
      {
        sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blobs'",
      },
    ]);
    const row = (found.rows as { sql: string }[])[0];
    if (row !== undefined && !row.sql.includes("owner_did")) {
      await this.driver.batch(
        ["blob_uploads", "blob_holds", "blobs"].map((table) => ({
          sql: `DROP TABLE IF EXISTS ${table}`,
        }))
      );
    }
  }

  /*
   * Another store may align the same tables between the read and the batch,
   * which then fails on a column that is already there, or already gone, and
   * changes nothing. A failure after the tables changed is taken for that and
   * what is left is worked out again; one with the tables as they were read
   * is the database's own and is thrown.
   */
  private async alignColumns(): Promise<void> {
    let created = await this.alignedTables();
    for (;;) {
      try {
        await this.align(created);
        return;
      } catch (error) {
        const now = await this.alignedTables();
        if ([...now].every(([table, sql]) => created.get(table) === sql)) {
          throw error;
        }
        created = now;
      }
    }
  }

  private async alignedTables(): Promise<Map<string, string>> {
    const [found] = await this.driver.batch([
      {
        sql:
          "SELECT name, sql FROM sqlite_master " +
          "WHERE type = 'table' AND name IN ('messages', 'replicas', 'replica_accounts')",
      },
    ]);
    return new Map(
      (found.rows as { name: string; sql: string }[]).map((row) => [row.name, row.sql])
    );
  }

  private async align(created: Map<string, string>): Promise<void> {
    await this.driver.batch([
      ...LATER_COLUMNS.filter(({ table, column }) => !created.get(table)?.includes(column)).map(
        ({ table, column, type }) => ({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${type}` })
      ),
      ...FORMER_INDEXES.map((index) => ({ sql: `DROP INDEX IF EXISTS ${index}` })),
      ...FORMER_COLUMNS.filter(({ table, column }) => created.get(table)?.includes(column)).map(
        ({ table, column }) => ({ sql: `ALTER TABLE ${table} DROP COLUMN ${column}` })
      ),
      {
        sql: `UPDATE replica_accounts SET registration = ${NEW_REGISTRATION} WHERE registration IS NULL`,
      },
    ]);
  }

  /*
   * A replica table that also names each replica by an ID holds that ID
   * under a unique constraint, which only a new table can take away. The
   * deliveries that refer to its rows are checked when the batch commits,
   * by when the rows are back. Another store may rebuild between the read
   * below and the batch, so the batch opens by reading the column, which a
   * rebuilt table refuses, taking the whole batch with it.
   */
  private async rebuildReplicas(): Promise<void> {
    if (!(await this.replicasKeepIds())) {
      return;
    }
    try {
      await this.driver.batch(
        [
          "SELECT replica_id FROM replicas LIMIT 0",
          "PRAGMA defer_foreign_keys = ON",
          "CREATE TABLE replicas_before AS SELECT * FROM replicas",
          "DROP TABLE replicas",
          REPLICAS,
          "INSERT INTO replicas " +
            "(replica_did, account_did, ordinal, long_form, grant_jws, registered_at, removed_at) " +
            "SELECT replica_did, account_did, ordinal, long_form, grant_jws, registered_at, removed_at " +
            "FROM replicas_before",
          "DROP TABLE replicas_before",
        ].map((sql) => ({ sql }))
      );
    } catch (error) {
      if (await this.replicasKeepIds()) {
        throw error;
      }
    }
  }

  private async replicasKeepIds(): Promise<boolean> {
    const [found] = await this.driver.batch([
      { sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'replicas'" },
    ]);
    return (found.rows as { sql: string }[])[0].sql.includes("replica_id");
  }

  /*
   * A package table that names each package by its forward id holds that id
   * under a unique constraint, which only a new table can take away. Every
   * package is carried over, those every target has acknowledged among them:
   * the old table cannot tell them from those accepted with no target, so
   * both wait out their retention. Another store may rebuild between the read
   * below and the batch, so the batch opens by reading the column, which a
   * rebuilt table refuses, taking the whole batch with it.
   */
  private async rebuildReplicaMail(): Promise<void> {
    if (!(await this.packagesKeepForwardIds())) {
      return;
    }
    try {
      await this.driver.batch(
        [
          "SELECT forward_id FROM replica_packages LIMIT 0",
          "CREATE TABLE replica_packages_before AS SELECT * FROM replica_packages",
          "CREATE TABLE replica_deliveries_before AS SELECT * FROM replica_deliveries",
          "DROP TABLE replica_deliveries",
          "DROP TABLE replica_packages",
          ...REPLICA_MAIL,
          "INSERT INTO replica_packages " +
            "(id, account_did, next_did, packed, bytes, created_at, expires_at) " +
            "SELECT id, account_did, next_did, packed, bytes, created_at, expires_at " +
            "FROM replica_packages_before",
          "INSERT INTO replica_deliveries SELECT id, package_id, replica_did FROM replica_deliveries_before",
          "DROP TABLE replica_deliveries_before",
          "DROP TABLE replica_packages_before",
        ].map((sql) => ({ sql }))
      );
    } catch (error) {
      if (await this.packagesKeepForwardIds()) {
        throw error;
      }
    }
  }

  private async packagesKeepForwardIds(): Promise<boolean> {
    const [found] = await this.driver.batch([
      {
        sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'replica_packages'",
      },
    ]);
    return (found.rows as { sql: string }[])[0].sql.includes("forward_id");
  }

  private async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    await this.init();
    if (statements.length === 0) {
      return [];
    }
    return this.driver.batch(statements);
  }

  private async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const [result] = await this.batch([{ sql, params }]);
    return result.rows as T[];
  }

  private async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  private async run(sql: string, params: SqlValue[] = []): Promise<number> {
    const [result] = await this.batch([{ sql, params }]);
    return result.changes;
  }

  async loadIdentity(): Promise<string | null> {
    const row = await this.first<{ secrets: string }>(
      "SELECT secrets FROM identity WHERE id = 1"
    );
    return row?.secrets ?? null;
  }

  async initIdentity(secretsJson: string): Promise<string> {
    await this.run(
      "INSERT OR IGNORE INTO identity (id, secrets, created_at) VALUES (1, ?, ?)",
      [secretsJson, Date.now()]
    );
    const winner = await this.loadIdentity();
    if (winner === null) {
      throw new Error("The identity row vanished between insert and read");
    }
    return winner;
  }

  async grantMediation(did: string): Promise<boolean> {
    const names = spellings(did);
    const [, held] = await this.batch([
      {
        sql:
          "INSERT OR IGNORE INTO accounts (did, created_at) " +
          `SELECT ?, ? WHERE ${NOT_REPLICA_MEDIATION}`,
        params: [did, Date.now(), ...names, ...names, ...names],
      },
      { sql: "SELECT 1 AS one FROM accounts WHERE did = ?", params: [did] },
    ]);
    return held.rows.length > 0;
  }

  async revokeMediation(did: string): Promise<void> {
    // Cascades: the keylist entries and waiting messages go with the account.
    await this.run("DELETE FROM accounts WHERE did = ?", [did]);
  }

  async isMediated(did: string): Promise<boolean> {
    const row = await this.first("SELECT 1 AS one FROM accounts WHERE did = ?", [
      did,
    ]);
    return row !== null;
  }

  async addRecipient(
    ownerDid: string,
    recipientDid: string
  ): Promise<AddRecipientResult> {
    const names = spellings(recipientDid);
    const owner = {
      sql: "SELECT owner_did FROM keylist WHERE recipient_did = ?",
      params: [recipientDid],
    };
    const [before, , after] = await this.batch([
      owner,
      {
        sql:
          "INSERT INTO keylist (recipient_did, owner_did, created_at) " +
          `SELECT ?, ?, ? WHERE ${NOT_REPLICA_MEDIATION} ` +
          "ON CONFLICT (recipient_did) DO NOTHING",
        params: [recipientDid, ownerDid, Date.now(), ...names, ...names, ...names],
      },
      owner,
    ]);

    const ownerIn = (result: SqlResult) =>
      (result.rows as { owner_did: string }[])[0]?.owner_did ?? null;
    if (ownerIn(after) !== ownerDid) {
      return "taken";
    }
    return ownerIn(before) === ownerDid ? "already-yours" : "added";
  }

  async removeRecipient(
    ownerDid: string,
    recipientDid: string
  ): Promise<boolean> {
    const changes = await this.run(
      "DELETE FROM keylist WHERE recipient_did = ? AND owner_did = ?",
      [recipientDid, ownerDid]
    );
    return changes > 0;
  }

  async listRecipients(
    ownerDid: string,
    offset: number,
    limit: number
  ): Promise<RecipientPage> {
    const [page, count] = await this.batch([
      {
        sql:
          "SELECT recipient_did FROM keylist WHERE owner_did = ? " +
          "ORDER BY created_at, recipient_did LIMIT ? OFFSET ?",
        params: [ownerDid, limit, offset],
      },
      {
        sql: "SELECT COUNT(*) AS n FROM keylist WHERE owner_did = ?",
        params: [ownerDid],
      },
    ]);

    const recipients = (page.rows as { recipient_did: string }[]).map(
      (row) => row.recipient_did
    );
    const total = (count.rows as { n: number }[])[0].n;

    return {
      recipients,
      remaining: Math.max(0, total - offset - recipients.length),
    };
  }

  async ownerOf(recipientDid: string): Promise<string | null> {
    const row = await this.first<{ owner_did: string }>(
      "SELECT owner_did FROM keylist WHERE recipient_did = ?",
      [recipientDid]
    );
    return row?.owner_did ?? null;
  }

  async registerReplicaAccount({
    accountDid,
    accountLongForm,
    mediator,
    create,
  }: ReplicaAccount): Promise<RegisterAccountOutcome> {
    const account = spellings(accountDid, accountLongForm);
    const [, accounts] = await this.batch([
      {
        sql:
          "INSERT INTO replica_accounts (did, mediator, long_form, created_at, registration) " +
          `SELECT ?, ?, ?, ?, ${NEW_REGISTRATION} WHERE ? = 1 AND ${NOT_ORDINARY} ` +
          "AND NOT EXISTS (SELECT 1 FROM replicas WHERE replica_did IN (?, ?)) " +
          `AND ${NOT_SHARED_RECIPIENT} ` +
          "ON CONFLICT (did) DO NOTHING",
        params: [
          accountDid,
          mediator,
          accountLongForm,
          Date.now(),
          create ? 1 : 0,
          ...account,
          ...account,
          ...account,
          ...account,
        ],
      },
      {
        sql: "SELECT mediator, created_at FROM replica_accounts WHERE did = ?",
        params: [accountDid],
      },
    ]);

    const held = (accounts.rows as { mediator: string; created_at: number }[])[0];
    if (held === undefined) {
      return { outcome: create ? "conflict" : "refused" };
    }
    return held.mediator === mediator
      ? { outcome: "registered", registeredTime: Math.floor(held.created_at / 1000) }
      : { outcome: "conflict" };
  }

  /*
   * One transaction, so a fan-out or an enrollment lands wholly before the
   * deletion, and goes with the account, or finds no account at all.
   */
  async deleteReplicaAccount(accountDid: string, mediator: string): Promise<boolean> {
    const key = [accountDid, mediator];
    const held =
      "account_did = (SELECT did FROM replica_accounts WHERE did = ? AND mediator = ?)";

    const [bound] = await this.batch([
      {
        sql: "SELECT 1 AS one FROM replica_accounts WHERE did = ? AND mediator = ?",
        params: key,
      },
      {
        sql:
          "DELETE FROM replica_deliveries WHERE package_id IN " +
          `(SELECT id FROM replica_packages WHERE ${held}) ` +
          `OR replica_did IN (SELECT replica_did FROM replicas WHERE ${held})`,
        params: [...key, ...key],
      },
      { sql: `DELETE FROM replica_packages WHERE ${held}`, params: key },
      { sql: `DELETE FROM replica_recipients WHERE ${held}`, params: key },
      { sql: `DELETE FROM replicas WHERE ${held}`, params: key },
      {
        sql: "DELETE FROM replica_accounts WHERE did = ? AND mediator = ?",
        params: key,
      },
    ]);
    return bound.rows.length > 0;
  }

  /* One transaction; the rows read back afterwards say which of the outcomes it was. */
  async addReplica({
    accountDid,
    mediator,
    replicaDid,
    replicaLongForm,
    grant,
    maxReplicas,
  }: ReplicaAddition): Promise<AddReplicaOutcome> {
    const replica = spellings(replicaDid, replicaLongForm);
    const enrolled = "(SELECT COUNT(*) FROM replicas WHERE account_did = ?)";
    const active = `(SELECT COUNT(*) FROM replicas WHERE account_did = ? AND ${ACTIVE})`;

    const [, accounts, bound, members] = await this.batch([
      {
        sql:
          "INSERT INTO replicas " +
          "(replica_did, account_did, ordinal, long_form, grant_jws, registered_at) " +
          `SELECT ?, ?, ${enrolled} + 1, ?, ?, ? ` +
          "WHERE EXISTS (SELECT 1 FROM replica_accounts WHERE did = ? AND mediator = ?) " +
          `AND ${NOT_ORDINARY} ` +
          "AND NOT EXISTS (SELECT 1 FROM replica_accounts WHERE did = ?) " +
          `AND ${NOT_SHARED_RECIPIENT} ` +
          `AND ${active} < ? ` +
          "ON CONFLICT DO NOTHING",
        params: [
          replicaDid,
          accountDid,
          accountDid,
          replicaLongForm,
          grant,
          Math.floor(Date.now() / 1000),
          accountDid,
          mediator,
          ...replica,
          ...replica,
          replicaDid,
          replicaDid,
          replicaDid,
          accountDid,
          maxReplicas,
        ],
      },
      {
        sql: "SELECT mediator FROM replica_accounts WHERE did = ?",
        params: [accountDid],
      },
      {
        sql:
          "SELECT account_did, registered_at, removed_at FROM replicas " +
          "WHERE replica_did = ?",
        params: [replicaDid],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM replicas WHERE account_did = ? AND ${ACTIVE}`,
        params: [accountDid],
      },
    ]);

    const held = (accounts.rows as { mediator: string }[])[0];
    if (held === undefined) {
      return { outcome: "unknown" };
    }
    if (held.mediator !== mediator) {
      return { outcome: "conflict" };
    }

    const binding = (
      bound.rows as {
        account_did: string;
        registered_at: number;
        removed_at: number | null;
      }[]
    )[0];
    if (binding !== undefined) {
      return binding.account_did === accountDid && binding.removed_at === null
        ? { outcome: "added", addedTime: binding.registered_at }
        : { outcome: "conflict" };
    }

    const enrollments = (members.rows as { n: number }[])[0].n;
    return { outcome: enrollments >= maxReplicas ? "full" : "conflict" };
  }

  /*
   * One transaction, so a fan-out sees the replica either as a target, whose
   * delivery is then dropped here, or not at all.
   */
  async removeReplica(
    accountDid: string,
    mediator: string,
    replicaDid: string
  ): Promise<RemoveOutcome> {
    const account = {
      sql: "SELECT 1 AS one FROM replica_accounts WHERE did = ? AND mediator = ?",
      params: [accountDid, mediator],
    };
    const enrolled =
      "replica_did = ? AND account_did = (SELECT did FROM replica_accounts WHERE did = ? AND mediator = ?)";
    const member = [replicaDid, accountDid, mediator];
    const replica = `SELECT replica_did FROM replicas WHERE ${enrolled}`;

    const [bound, , , , , removed] = await this.batch([
      account,
      ...SqlStore.endDeliveries(`replica_did IN (${replica})`, member),
      {
        sql: `UPDATE replicas SET removed_at = ? WHERE ${enrolled} AND ${ACTIVE}`,
        params: [Math.floor(Date.now() / 1000), ...member],
      },
      { sql: `SELECT removed_at FROM replicas WHERE ${enrolled}`, params: member },
    ]);

    if (bound.rows.length === 0) {
      return { outcome: "unknown" };
    }
    const row = (removed.rows as { removed_at: number }[])[0];
    return row === undefined
      ? { outcome: "not-enrolled" }
      : { outcome: "removed", removedTime: row.removed_at };
  }

  async isReplicaAccount(did: string): Promise<boolean> {
    const row = await this.first("SELECT 1 AS one FROM replica_accounts WHERE did = ?", [did]);
    return row !== null;
  }

  async replicaState(did: string): Promise<"active" | "removed" | null> {
    const row = await this.first<{ removed_at: number | null }>(
      "SELECT removed_at FROM replicas WHERE replica_did = ?",
      [did]
    );
    if (row === null) {
      return null;
    }
    return row.removed_at === null ? "active" : "removed";
  }

  async replicaRoster(
    accountDid: string,
    mediator: string,
    after: number,
    through: number | null,
    limit: number
  ): Promise<RosterPage | null> {
    const ofAccount =
      "account_did = (SELECT did FROM replica_accounts WHERE did = ? AND mediator = ?)";
    const [bound, count, page] = await this.batch([
      {
        sql: "SELECT registration FROM replica_accounts WHERE did = ? AND mediator = ?",
        params: [accountDid, mediator],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM replicas WHERE ${ofAccount}`,
        params: [accountDid, mediator],
      },
      {
        sql:
          "SELECT ordinal, grant_jws, registered_at, removed_at FROM replicas " +
          `WHERE ${ofAccount} AND ordinal > ? AND (? IS NULL OR ordinal <= ?) ` +
          "ORDER BY ordinal LIMIT ?",
        params: [accountDid, mediator, after, through, through, limit],
      },
    ]);

    const held = (bound.rows as { registration: string }[])[0];
    if (held === undefined) {
      return null;
    }
    const size = (count.rows as { n: number }[])[0].n;
    return {
      registration: held.registration,
      size,
      entries: (
        page.rows as {
          ordinal: number;
          grant_jws: string;
          registered_at: number;
          removed_at: number | null;
        }[]
      ).map((row) => ({
        ordinal: row.ordinal,
        grant: row.grant_jws,
        addedTime: row.registered_at,
        removedTime: row.removed_at,
      })),
    };
  }

  async resolutionMaterial(did: string): Promise<string | null> {
    const row = await this.first<{ long_form: string }>(
      "SELECT long_form FROM replica_accounts WHERE did = ? " +
        "UNION ALL SELECT long_form FROM replicas WHERE replica_did = ?",
      [did, did]
    );
    return row?.long_form ?? null;
  }

  /*
   * One transaction, so two accounts racing for a DID cannot both bind it and
   * a refused add leaves nothing behind.
   */
  async addSharedRecipient({
    accountDid,
    mediator,
    recipientDid,
    recipientLongForm,
    maxRecipients,
  }: SharedRecipient): Promise<ShareOutcome> {
    const names = spellings(recipientDid, recipientLongForm);
    const elsewhere = [...names, ...names, ...names, ...names];
    const unbound =
      `${NOT_ORDINARY} AND NOT EXISTS (SELECT 1 FROM replica_accounts WHERE did IN (?, ?)) ` +
      "AND NOT EXISTS (SELECT 1 FROM replicas WHERE replica_did IN (?, ?))";
    const [account, , held, free] = await this.batch([
      {
        sql: "SELECT 1 AS one FROM replica_accounts WHERE did = ? AND mediator = ?",
        params: [accountDid, mediator],
      },
      {
        sql:
          "INSERT INTO replica_recipients (recipient_did, account_did, long_form, created_at) " +
          "SELECT ?, ?, ?, ? " +
          "WHERE EXISTS (SELECT 1 FROM replica_accounts WHERE did = ? AND mediator = ?) " +
          `AND ${unbound} ` +
          "AND (SELECT COUNT(*) FROM replica_recipients WHERE account_did = ?) < ? " +
          "ON CONFLICT (recipient_did) DO NOTHING",
        params: [
          recipientDid,
          accountDid,
          recipientLongForm,
          Date.now(),
          accountDid,
          mediator,
          ...elsewhere,
          accountDid,
          maxRecipients,
        ],
      },
      {
        sql: "SELECT account_did, created_at FROM replica_recipients WHERE recipient_did = ?",
        params: [recipientDid],
      },
      { sql: `SELECT (${unbound}) AS free`, params: elsewhere },
    ]);

    if (account.rows.length === 0) {
      return { outcome: "unknown" };
    }
    const binding = (held.rows as { account_did: string; created_at: number }[])[0];
    if (binding !== undefined) {
      return binding.account_did === accountDid
        ? { outcome: "added", addedTime: Math.floor(binding.created_at / 1000) }
        : { outcome: "conflict" };
    }
    return { outcome: (free.rows as { free: number }[])[0].free === 1 ? "full" : "conflict" };
  }

  async removeSharedRecipient(
    accountDid: string,
    mediator: string,
    recipientDid: string
  ): Promise<"removed" | "no_change" | "unknown"> {
    const [account, removed] = await this.batch([
      {
        sql: "SELECT 1 AS one FROM replica_accounts WHERE did = ? AND mediator = ?",
        params: [accountDid, mediator],
      },
      {
        sql:
          "DELETE FROM replica_recipients WHERE recipient_did = ? AND account_did = " +
          "(SELECT did FROM replica_accounts WHERE did = ? AND mediator = ?)",
        params: [recipientDid, accountDid, mediator],
      },
    ]);
    if (account.rows.length === 0) {
      return "unknown";
    }
    return removed.changes > 0 ? "removed" : "no_change";
  }

  async listSharedRecipients(
    accountDid: string,
    mediator: string,
    after: RecipientPlace | null,
    limit: number
  ): Promise<SharedRecipientPage | null> {
    const [account, page] = await this.batch([
      {
        sql: "SELECT registration FROM replica_accounts WHERE did = ? AND mediator = ?",
        params: [accountDid, mediator],
      },
      {
        sql:
          "SELECT recipient_did AS did, created_at AS addedAt FROM replica_recipients " +
          "WHERE account_did = ? AND (created_at, recipient_did) > (?, ?) " +
          "ORDER BY created_at, recipient_did LIMIT ?",
        params: [accountDid, after?.addedAt ?? -1, after?.did ?? "", limit + 1],
      },
    ]);
    const held = (account.rows as { registration: string }[])[0];
    if (held === undefined) {
      return null;
    }

    const rows = page.rows as { did: string; addedAt: number }[];
    return {
      registration: held.registration,
      recipients: rows.slice(0, limit),
      more: rows.length > limit,
    };
  }

  async sharedRecipientMaterial(did: string): Promise<string | null> {
    const row = await this.first<{ long_form: string }>(
      "SELECT long_form FROM replica_recipients WHERE recipient_did = ?",
      [did]
    );
    return row?.long_form ?? null;
  }

  /*
   * One transaction, so a replica enrolls either before it, and is a target,
   * or after it, and is not.
   */
  async fanOut(
    next: string,
    packed: string,
    { deadline, maxRetainedBytes }: PackageBounds
  ): Promise<FanOutOutcome> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = Math.min(now + this.ttlMs, deadline ?? Infinity);
    if (expiresAt <= now) {
      return { outcome: "lapsed" };
    }
    const bytes = new TextEncoder().encode(packed).byteLength;
    const sharedBy = "SELECT account_did FROM replica_recipients WHERE recipient_did = ?";
    const accounts =
      `${sharedBy} UNION ALL ` +
      `SELECT account_did FROM replicas WHERE replica_did = ? AND ${ACTIVE}`;
    const retained = (what: string) =>
      `(SELECT ${what} FROM replica_packages WHERE account_did = a.account_did AND expires_at > ?)`;

    const [, , found, account, queued] = await this.batch([
      {
        sql:
          "INSERT INTO replica_packages " +
          "(id, account_did, next_did, packed, bytes, created_at, expires_at) " +
          `SELECT ?, a.account_did, ?, ?, ?, ?, ? FROM (${accounts}) AS a ` +
          `WHERE ${retained("COUNT(*)")} < ? ` +
          `AND ${retained("COALESCE(SUM(bytes), 0)")} + ? <= ?`,
        params: [
          id,
          next,
          packed,
          bytes,
          now,
          expiresAt,
          next,
          next,
          now,
          this.maxMessages,
          now,
          bytes,
          maxRetainedBytes,
        ],
      },
      {
        sql:
          "INSERT INTO replica_deliveries (id, package_id, replica_did) " +
          "SELECT lower(hex(randomblob(16))), ?, replica_did FROM replicas " +
          `WHERE (replica_did = ? OR account_did = (${sharedBy})) AND ${ACTIVE} ` +
          "AND EXISTS (SELECT 1 FROM replica_packages WHERE id = ?)",
        params: [id, next, next, id],
      },
      { sql: "SELECT 1 AS one FROM replica_packages WHERE id = ?", params: [id] },
      { sql: accounts, params: [next, next] },
      { sql: "SELECT id, replica_did FROM replica_deliveries WHERE package_id = ?", params: [id] },
    ]);

    if (found.rows.length === 0) {
      return { outcome: account.rows.length === 0 ? "unknown" : "full" };
    }
    const deliveries: ReplicaDelivery[] = (queued.rows as { id: string; replica_did: string }[]).map(
      (delivery) => ({
        replicaDid: delivery.replica_did,
        message: { id: delivery.id, packed, createdAt: now },
      })
    );
    return { outcome: "stored", deliveries };
  }

  private static readonly WAITING =
    "FROM replica_deliveries d JOIN replica_packages p ON p.id = d.package_id " +
    "WHERE d.replica_did = ? AND p.expires_at > ? AND (? IS NULL OR p.next_did = ?)";

  async deliveriesFor(
    replicaDid: string,
    limit: number,
    next: string | null = null
  ): Promise<StoredMessage[]> {
    const rows = await this.all<{ id: string; packed: string; created_at: number }>(
      `SELECT d.id, p.packed, p.created_at ${SqlStore.WAITING} ORDER BY p.created_at, p.rowid LIMIT ?`,
      [replicaDid, Date.now(), next, next, limit]
    );
    return rows.map((row) => ({ id: row.id, packed: row.packed, createdAt: row.created_at }));
  }

  async deliveryCount(replicaDid: string, next: string | null = null): Promise<number> {
    const row = await this.first<{ n: number }>(`SELECT COUNT(*) AS n ${SqlStore.WAITING}`, [
      replicaDid,
      Date.now(),
      next,
      next,
    ]);
    return row?.n ?? 0;
  }

  async acknowledgeDeliveries(replicaDid: string, ids: string[]): Promise<void> {
    await this.batch(
      SqlStore.endDeliveries("replica_did = ? AND id IN (SELECT value FROM json_each(?))", [
        replicaDid,
        JSON.stringify(ids),
      ])
    );
  }

  /*
   * Ends the deliveries `which` selects and the packages left with no other.
   * The packages are found while those deliveries still exist: looking
   * afterwards for packages without a delivery would also take the ones
   * accepted with no target, which wait out their retention. So they are
   * deleted first, with foreign keys checked at commit, by when their
   * deliveries are gone too.
   */
  private static endDeliveries(which: string, params: SqlValue[]): SqlStatement[] {
    const ending = `SELECT id FROM replica_deliveries WHERE ${which}`;
    return [
      { sql: "PRAGMA defer_foreign_keys = ON" },
      {
        sql:
          "DELETE FROM replica_packages WHERE id IN " +
          `(SELECT package_id FROM replica_deliveries WHERE ${which}) ` +
          "AND NOT EXISTS (SELECT 1 FROM replica_deliveries " +
          `WHERE package_id = replica_packages.id AND id NOT IN (${ending}))`,
        params: [...params, ...params],
      },
      { sql: `DELETE FROM replica_deliveries WHERE ${which}`, params },
    ];
  }

  async storeMessage(ownerDid: string, packed: string): Promise<StoreOutcome> {
    const id = crypto.randomUUID();
    const now = Date.now();

    const [, found] = await this.batch([
      {
        sql:
          "INSERT INTO messages (id, owner_did, packed, created_at, expires_at) " +
          "SELECT ?, ?, ?, ?, ? " +
          "WHERE (SELECT COUNT(*) FROM messages WHERE owner_did = ? AND expires_at > ?) < ?",
        params: [id, ownerDid, packed, now, now + this.ttlMs, ownerDid, now, this.maxMessages],
      },
      { sql: "SELECT 1 AS one FROM messages WHERE id = ?", params: [id] },
    ]);

    return found.rows.length === 0
      ? { outcome: "full" }
      : { outcome: "stored", message: { id, packed, createdAt: now } };
  }

  async messageCount(ownerDid: string): Promise<number> {
    const row = await this.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE owner_did = ? AND expires_at > ?",
      [ownerDid, Date.now()]
    );
    return row?.n ?? 0;
  }

  async messagesFor(ownerDid: string, limit: number): Promise<StoredMessage[]> {
    const rows = await this.all<{
      id: string;
      packed: string;
      created_at: number;
    }>(
      "SELECT id, packed, created_at FROM messages " +
        "WHERE owner_did = ? AND expires_at > ? ORDER BY created_at LIMIT ?",
      [ownerDid, Date.now(), limit]
    );

    return rows.map((row) => ({
      id: row.id,
      packed: row.packed,
      createdAt: row.created_at,
    }));
  }

  async deleteMessages(ownerDid: string, ids: string[]): Promise<string[]> {
    const results = await this.batch(
      ids.map((id) => ({
        sql: "DELETE FROM messages WHERE id = ? AND owner_did = ?",
        params: [id, ownerDid],
      }))
    );
    return ids.filter((_, i) => results[i].changes > 0);
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    const [messages, , packages] = await this.batch([
      { sql: "DELETE FROM messages WHERE expires_at <= ?", params: [now] },
      {
        sql:
          "DELETE FROM replica_deliveries WHERE package_id IN " +
          "(SELECT id FROM replica_packages WHERE expires_at <= ?)",
        params: [now],
      },
      { sql: "DELETE FROM replica_packages WHERE expires_at <= ?", params: [now] },
    ]);
    return messages.changes + packages.changes;
  }

  private static readonly BLOB_COLUMNS =
    "id, owner_did, hash, size, uploaded_at, retain_until";

  private static blobRow(row: Record<string, unknown>): BlobRow {
    return {
      id: row.id as string,
      ownerDid: row.owner_did as string,
      hash: row.hash as string,
      size: row.size as number,
      uploadedAt: row.uploaded_at as number | null,
      retainUntil: row.retain_until as number,
    };
  }

  async blobOf(ownerDid: string, hash: string): Promise<BlobRow | null> {
    const row = await this.first<Record<string, unknown>>(
      `SELECT ${SqlStore.BLOB_COLUMNS} FROM blobs WHERE owner_did = ? AND hash = ?`,
      [ownerDid, hash]
    );
    return row === null ? null : SqlStore.blobRow(row);
  }

  async blobById(id: string): Promise<BlobRow | null> {
    const row = await this.first<Record<string, unknown>>(
      `SELECT ${SqlStore.BLOB_COLUMNS} FROM blobs WHERE id = ?`,
      [id]
    );
    return row === null ? null : SqlStore.blobRow(row);
  }

  async blobUsage(ownerDid: string): Promise<number> {
    const row = await this.first<{ n: number | null }>(
      "SELECT SUM(size) AS n FROM blobs WHERE owner_did = ? AND retain_until > ?",
      [ownerDid, Date.now()]
    );
    return row?.n ?? 0;
  }

  async keepBlob(
    { id, ownerDid, hash, size, retainUntil }: BlobKeep,
    quotaBytes: number
  ): Promise<KeepOutcome> {
    const now = Date.now();
    const room =
      "(SELECT COALESCE(SUM(size), 0) FROM blobs WHERE owner_did = ? AND retain_until > ?) + ? <= ?";
    const [created, renewed, kept] = await this.batch([
      {
        sql:
          "INSERT INTO blobs (id, owner_did, hash, size, created_at, retain_until) " +
          "SELECT ?, ?, ?, ?, ?, ? " +
          "WHERE NOT EXISTS (SELECT 1 FROM blobs WHERE owner_did = ? AND hash = ?) " +
          `AND ${room}`,
        params: [id, ownerDid, hash, size, now, retainUntil, ownerDid, hash, ownerDid, now, size, quotaBytes],
      },
      {
        sql:
          "UPDATE blobs SET retain_until = MAX(retain_until, ?) " +
          "WHERE owner_did = ? AND hash = ? AND size = ? " +
          `AND (retain_until > ? OR ${room})`,
        params: [retainUntil, ownerDid, hash, size, now, ownerDid, now, size, quotaBytes],
      },
      {
        sql: `SELECT ${SqlStore.BLOB_COLUMNS} FROM blobs WHERE owner_did = ? AND hash = ?`,
        params: [ownerDid, hash],
      },
    ]);
    const row = kept.rows[0] as Record<string, unknown> | undefined;
    if (row !== undefined && row.size !== size) {
      return { outcome: "mismatch" };
    }
    if (row === undefined || created.changes + renewed.changes === 0) {
      return { outcome: "full" };
    }
    return { outcome: "kept", blob: SqlStore.blobRow(row) };
  }

  async dropBlob(ownerDid: string, hash: string): Promise<string | null> {
    const [found] = await this.batch([
      { sql: "SELECT id FROM blobs WHERE owner_did = ? AND hash = ?", params: [ownerDid, hash] },
      { sql: "DELETE FROM blobs WHERE owner_did = ? AND hash = ?", params: [ownerDid, hash] },
    ]);
    const row = (found.rows as { id: string }[])[0];
    return row === undefined ? null : row.id;
  }

  async grantUpload(id: string, expiresAt: number): Promise<string> {
    const token = crypto.randomUUID();
    await this.run(
      "INSERT INTO blob_uploads (token, blob_id, expires_at) VALUES (?, ?, ?)",
      [token, id, expiresAt]
    );
    return token;
  }

  async claimUpload(token: string): Promise<UploadGrant | null> {
    const [found] = await this.batch([
      {
        sql:
          "SELECT b.id, b.hash, b.size FROM blob_uploads u JOIN blobs b ON b.id = u.blob_id " +
          "WHERE u.token = ? AND u.expires_at > ?",
        params: [token, Date.now()],
      },
      { sql: "DELETE FROM blob_uploads WHERE token = ?", params: [token] },
    ]);
    const row = (found.rows as { id: string; hash: string; size: number }[])[0];
    return row === undefined ? null : { id: row.id, hash: row.hash, size: row.size };
  }

  async markUploaded(id: string): Promise<void> {
    await this.run("UPDATE blobs SET uploaded_at = ? WHERE id = ? AND uploaded_at IS NULL", [
      Date.now(),
      id,
    ]);
  }

  async purgeBlobs(): Promise<string[]> {
    const now = Date.now();
    const dead =
      "retain_until <= ? OR owner_did NOT IN (SELECT did FROM accounts)";
    const [found] = await this.batch([
      { sql: `SELECT id FROM blobs WHERE ${dead}`, params: [now] },
      { sql: `DELETE FROM blobs WHERE ${dead}`, params: [now] },
      { sql: "DELETE FROM blob_uploads WHERE expires_at <= ?", params: [now] },
    ]);
    return (found.rows as { id: string }[]).map((row) => row.id);
  }

  close(): void {
    this.driver.close();
  }
}
