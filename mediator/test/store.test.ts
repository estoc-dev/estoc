import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqlStore } from "../src/store/sql-store.js";
import type { SqlDriver, SqlResult, SqlStatement } from "../src/store/sql-store.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type {
  ExecutionId,
  ExecutionPolicy,
  ExecutionRegistrationSnapshot,
  RegisterExecutionOutcome,
} from "../src/store/types.js";

const REPLICA_TABLES_WITH_REPLICA_IDS = `
  CREATE TABLE replica_accounts (
    did TEXT PRIMARY KEY,
    mediation_id TEXT NOT NULL,
    mediator TEXT NOT NULL,
    long_form TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE replicas (
    replica_did TEXT PRIMARY KEY,
    account_did TEXT NOT NULL REFERENCES replica_accounts(did),
    replica_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    long_form TEXT NOT NULL,
    grant_jws TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    UNIQUE (account_did, replica_id),
    UNIQUE (account_did, ordinal)
  );
  CREATE TABLE replica_recipients (
    recipient_did TEXT PRIMARY KEY,
    account_did TEXT NOT NULL REFERENCES replica_accounts(did),
    long_form TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE replica_packages (
    id TEXT PRIMARY KEY,
    account_did TEXT NOT NULL REFERENCES replica_accounts(did),
    next_did TEXT NOT NULL,
    forward_id TEXT NOT NULL,
    packed TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (next_did, forward_id)
  );
  CREATE TABLE replica_deliveries (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES replica_packages(id),
    replica_did TEXT NOT NULL REFERENCES replicas(replica_did),
    UNIQUE (package_id, replica_did)
  );
  INSERT INTO replica_accounts VALUES ('did:example:account', 'm', 'did:example:mediator', 'long', 1);
`;

const REPLICA_TABLES_WITH_PACKAGE_KINDS = `
  CREATE TABLE replica_accounts (
    did TEXT PRIMARY KEY,
    mediator TEXT NOT NULL,
    long_form TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    registration TEXT NOT NULL
  );
  CREATE TABLE replicas (
    replica_did TEXT PRIMARY KEY,
    account_did TEXT NOT NULL REFERENCES replica_accounts(did),
    ordinal INTEGER NOT NULL,
    long_form TEXT NOT NULL,
    grant_jws TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    removed_at INTEGER,
    UNIQUE (account_did, ordinal)
  );
  CREATE TABLE replica_recipients (
    recipient_did TEXT PRIMARY KEY,
    account_did TEXT NOT NULL REFERENCES replica_accounts(did),
    long_form TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE replica_packages (
    id TEXT PRIMARY KEY,
    account_did TEXT NOT NULL REFERENCES replica_accounts(did),
    next_did TEXT NOT NULL,
    forward_id TEXT NOT NULL,
    shared INTEGER NOT NULL,
    packed TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (account_did, next_did, forward_id)
  );
  CREATE TABLE replica_deliveries (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES replica_packages(id),
    replica_did TEXT NOT NULL REFERENCES replicas(replica_did),
    UNIQUE (package_id, replica_did)
  );
  INSERT INTO replica_accounts VALUES ('did:example:account', 'did:example:mediator', 'long', 1, 'r');
`;

/*
 * Replica mail as older tables held it, when a package outlived its
 * deliveries: `p0` is one every target acknowledged, `p1` waits for the
 * replica as shared mail and `p2` as the replica's own.
 */
const OLD_REPLICA_MAIL = [
  {
    tables: "tables that named a replica by an ID",
    sql: (expiresAt: number) => `
      ${REPLICA_TABLES_WITH_REPLICA_IDS}
      INSERT INTO replicas VALUES ('did:example:replica', 'did:example:account', 'r', 1, 'long', 'grant', 1);
      INSERT INTO replica_recipients VALUES ('did:example:shared', 'did:example:account', 'long', 1);
      INSERT INTO replica_packages VALUES
        ('p0', 'did:example:account', 'did:example:shared', '0', 'acknowledged mail', 17, 1, ${expiresAt}),
        ('p1', 'did:example:account', 'did:example:shared', '1', 'shared mail', 11, 2, ${expiresAt}),
        ('p2', 'did:example:account', 'did:example:replica', '1', 'own mail', 8, 3, ${expiresAt});
      INSERT INTO replica_deliveries VALUES ('d1', 'p1', 'did:example:replica'), ('d2', 'p2', 'did:example:replica');
    `,
  },
  {
    tables: "tables that recorded what a package's recipient was",
    sql: (expiresAt: number) => `
      ${REPLICA_TABLES_WITH_PACKAGE_KINDS}
      INSERT INTO replicas VALUES ('did:example:replica', 'did:example:account', 1, 'long', 'grant', 1, NULL);
      INSERT INTO replica_recipients VALUES ('did:example:shared', 'did:example:account', 'long', 1);
      INSERT INTO replica_packages VALUES
        ('p0', 'did:example:account', 'did:example:shared', '0', 1, 'acknowledged mail', 17, 1, ${expiresAt}),
        ('p1', 'did:example:account', 'did:example:shared', '1', 1, 'shared mail', 11, 2, ${expiresAt}),
        ('p2', 'did:example:account', 'did:example:replica', '1', 0, 'own mail', 8, 3, ${expiresAt});
      INSERT INTO replica_deliveries VALUES ('d1', 'p1', 'did:example:replica'), ('d2', 'p2', 'did:example:replica');
    `,
  },
];

function tableSql(path: string, name: string): string {
  const opened = new Database(path);
  const row = opened.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as
    | { sql: string }
    | undefined;
  opened.close();
  return row?.sql ?? "";
}

function packageIds(path: string): string[] {
  const opened = new Database(path);
  const rows = opened.prepare("SELECT id FROM replica_packages ORDER BY created_at").all() as { id: string }[];
  opened.close();
  return rows.map((row) => row.id);
}

/** Lets a test hold a store between two of its transactions. */
class HeldDriver implements SqlDriver {
  private db: Database.Database;
  private held = Promise.withResolvers<void>();
  private gate = Promise.withResolvers<void>();

  constructor(
    path: string,
    private holdAfter: (statements: SqlStatement[]) => boolean = () => false
  ) {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    const results = this.db.transaction(() =>
      statements.map(({ sql, params = [] }) => {
        const statement = this.db.prepare(sql);
        return statement.reader
          ? { rows: statement.all(...params) as Record<string, unknown>[], changes: 0 }
          : { rows: [], changes: statement.run(...params).changes };
      })
    )();
    if (this.holdAfter(statements)) {
      this.holdAfter = () => false;
      this.held.resolve();
      await this.gate.promise;
    }
    return results;
  }

  whenHeld(): Promise<void> {
    return this.held.promise;
  }

  release(): void {
    this.gate.resolve();
  }

  close(): void {
    this.db.close();
  }
}

const ALICE = "did:example:alice";

describe("SqliteStore", () => {
  it("binds a recipient to one owner only", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation("did:example:alice");
    await store.grantMediation("did:example:bob");

    expect(await store.addRecipient("did:example:alice", "did:example:alias")).toBe(
      "added"
    );
    expect(await store.addRecipient("did:example:alice", "did:example:alias")).toBe(
      "already-yours"
    );
    expect(await store.addRecipient("did:example:bob", "did:example:alias")).toBe(
      "taken"
    );
    expect(await store.ownerOf("did:example:alias")).toBe("did:example:alice");
    store.close();
  });

  it("stops storing past the per-account quota", async () => {
    const store = new SqliteStore(":memory:", { maxMessagesPerAccount: 2 });
    await store.grantMediation("did:example:alice");

    expect((await store.storeMessage(ALICE, "one")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, "two")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, "three")).outcome).toBe("full");
    expect(await store.messageCount("did:example:alice")).toBe(2);
    store.close();
  });

  it("queues the same bytes as often as they come", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation(ALICE);

    expect((await store.storeMessage(ALICE, "same")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, "same")).outcome).toBe("stored");
    expect((await store.messagesFor(ALICE, 10)).map((m) => m.packed)).toEqual(["same", "same"]);
    store.close();
  });

  it("drops the package keys of a queue that had them, and keeps its mail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const later = Date.now() + 60_000;
    const old = new Database(path);
    old.exec(`
      CREATE TABLE accounts (did TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
        packed TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        next_did TEXT,
        forward_id TEXT
      );
      CREATE UNIQUE INDEX messages_package ON messages(owner_did, next_did, forward_id);
      INSERT INTO accounts VALUES ('${ALICE}', 1);
      INSERT INTO messages VALUES ('a', '${ALICE}', 'one', 1, ${later}, '${ALICE}', '1');
      INSERT INTO messages VALUES ('b', '${ALICE}', 'two', 2, ${later}, NULL, NULL);
    `);
    old.close();

    const store = new SqliteStore(path);
    expect((await store.storeMessage(ALICE, "one")).outcome).toBe("stored");
    expect((await store.messagesFor(ALICE, 10)).map((m) => m.packed)).toEqual(["one", "two", "one"]);
    store.close();

    expect(tableSql(path, "messages")).not.toMatch(/next_did|forward_id/);
    expect(tableSql(path, "messages_package")).toBe("");
    const reopened = new SqliteStore(path);
    expect(await reopened.messageCount(ALICE)).toBe(3);
    reopened.close();
    rmSync(dir, { recursive: true });
  });

  it("keeps the replicas enrolled before one could be removed, as active ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE replica_accounts (
        did TEXT PRIMARY KEY,
        mediation_id TEXT NOT NULL,
        mediator TEXT NOT NULL,
        long_form TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE replicas (
        replica_did TEXT PRIMARY KEY,
        account_did TEXT NOT NULL REFERENCES replica_accounts(did),
        replica_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        long_form TEXT NOT NULL,
        grant_jws TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        UNIQUE (account_did, replica_id),
        UNIQUE (account_did, ordinal)
      );
      INSERT INTO replica_accounts VALUES ('did:example:account', 'm', 'did:example:mediator', 'long', 1);
      INSERT INTO replicas VALUES ('did:example:replica', 'did:example:account', 'r', 1, 'long', 'grant', 1);
    `);
    old.close();

    const store = new SqliteStore(path);
    expect(await store.replicaState("did:example:replica")).toBe("active");
    const removal = await store.removeReplica(
      "did:example:account",
      "did:example:mediator",
      "did:example:replica"
    );
    expect(removal.outcome).toBe("removed");
    store.close();

    const reopened = new SqliteStore(path);
    expect(await reopened.replicaState("did:example:replica")).toBe("removed");
    reopened.close();
    rmSync(dir, { recursive: true });
  });

  it("tells apart the registrations of accounts made before registrations were named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE replica_accounts (
        did TEXT PRIMARY KEY,
        mediator TEXT NOT NULL,
        long_form TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO replica_accounts VALUES
        ('did:example:first', 'did:example:mediator', 'long', 1000),
        ('did:example:second', 'did:example:mediator', 'long', 1000);
    `);
    old.close();
    const registrationOf = async (store: SqliteStore, did: string) =>
      (await store.replicaRoster(did, "did:example:mediator", 0, null, 1))?.registration;

    const store = new SqliteStore(path);
    const first = await registrationOf(store, "did:example:first");
    const second = await registrationOf(store, "did:example:second");
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    store.close();

    const reopened = new SqliteStore(path);
    expect(await registrationOf(reopened, "did:example:first")).toBe(first);
    reopened.close();
    rmSync(dir, { recursive: true });
  });

  it("keeps the accounts registered under a mediation ID, and registers more without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE replica_accounts (
        did TEXT PRIMARY KEY,
        mediation_id TEXT NOT NULL,
        mediator TEXT NOT NULL,
        long_form TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO replica_accounts VALUES ('did:example:account', 'm', 'did:example:mediator', 'long', 1000);
    `);
    old.close();
    const registration = {
      accountLongForm: "long",
      mediator: "did:example:mediator",
      create: true,
    };

    const store = new SqliteStore(path);
    expect(
      await store.registerReplicaAccount({ ...registration, accountDid: "did:example:account" })
    ).toEqual({ outcome: "registered", registeredTime: 1 });
    expect(
      (await store.registerReplicaAccount({ ...registration, accountDid: "did:example:other" }))
        .outcome
    ).toBe("registered");
    store.close();

    const reopened = new SqliteStore(path);
    expect(await reopened.isReplicaAccount("did:example:account")).toBe(true);
    expect(await reopened.isReplicaAccount("did:example:other")).toBe(true);
    reopened.close();
    rmSync(dir, { recursive: true });
  });

  it("keeps the replicas enrolled under an ID, in their order and with what waits for them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const later = Date.now() + 60_000;
    const old = new Database(path);
    old.exec(`
      ${REPLICA_TABLES_WITH_REPLICA_IDS}
      INSERT INTO replicas VALUES
        ('did:example:first', 'did:example:account', 'r1', 1, 'long', 'first grant', 1),
        ('did:example:second', 'did:example:account', 'r2', 2, 'long', 'second grant', 2);
      INSERT INTO replica_packages VALUES
        ('p1', 'did:example:account', 'did:example:second', '1', 'own mail', 8, 1, ${later});
      INSERT INTO replica_deliveries VALUES ('d1', 'p1', 'did:example:second');
    `);
    old.close();

    const store = new SqliteStore(path);
    const roster = await store.replicaRoster("did:example:account", "did:example:mediator", 0, null, 10);
    expect(roster?.entries.map((entry) => [entry.ordinal, entry.grant])).toEqual([
      [1, "first grant"],
      [2, "second grant"],
    ]);
    expect(await store.deliveryCount("did:example:second")).toBe(1);
    store.close();

    const opened = new Database(path);
    const { sql } = opened
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'replicas'")
      .get() as { sql: string };
    expect(sql).not.toContain("replica_id");
    expect(opened.pragma("foreign_key_check")).toEqual([]);
    opened.close();
    rmSync(dir, { recursive: true });
  });


  it("scopes deletion to the owner", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation("did:example:alice");
    await store.grantMediation("did:example:bob");
    const stored = await store.storeMessage(ALICE, "hers");
    if (stored.outcome !== "stored") throw new Error(stored.outcome);

    expect(await store.deleteMessages("did:example:bob", [stored.message.id])).toEqual([]);
    expect(await store.messageCount("did:example:alice")).toBe(1);
    store.close();
  });

  it("expires messages by TTL", async () => {
    const store = new SqliteStore(":memory:", { messageTtlSeconds: -1 });
    await store.grantMediation("did:example:alice");
    await store.storeMessage(ALICE, "already old");

    expect(await store.messageCount("did:example:alice")).toBe(0);
    expect(await store.purgeExpired()).toBe(1);
    store.close();
  });

  it("takes the keylist and inbox down with the account", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation("did:example:alice");
    await store.addRecipient("did:example:alice", "did:example:alias");
    await store.storeMessage(ALICE, "waiting");

    await store.revokeMediation("did:example:alice");
    expect(await store.ownerOf("did:example:alias")).toBeNull();
    expect(await store.isMediated("did:example:alice")).toBe(false);
    store.close();
  });
});

describe.each(OLD_REPLICA_MAIL)("replica mail in $tables", ({ sql }) => {
  it("survives whole, in a table without forward ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(sql(Date.now() + 60_000));
    old.close();

    const store = new SqliteStore(path);
    const waiting = await store.deliveriesFor("did:example:replica", 10);
    expect(waiting.map((message) => [message.id, message.packed])).toEqual([
      ["d1", "shared mail"],
      ["d2", "own mail"],
    ]);
    store.close();

    expect(tableSql(path, "replica_packages")).not.toMatch(/forward_id|shared|UNIQUE/);
    expect(packageIds(path)).toEqual(["p0", "p1", "p2"]);
    const opened = new Database(path);
    expect(opened.pragma("foreign_key_check")).toEqual([]);
    opened.close();
    rmSync(dir, { recursive: true });
  });

  it("goes with its last delivery, apart from what every target had acknowledged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(sql(Date.now() + 60_000));
    old.close();
    const bounds = { deadline: null, maxRetainedBytes: 1000 };

    const store = new SqliteStore(path);
    await store.acknowledgeDeliveries("did:example:replica", ["d1", "d2"]);
    expect((await store.fanOut("did:example:shared", "shared mail", bounds)).outcome).toBe("stored");
    expect(await store.deliveryCount("did:example:replica")).toBe(1);
    store.close();

    const [kept, again] = packageIds(path);
    expect(kept).toBe("p0");
    expect(again).toEqual(expect.not.stringMatching(/^p\d$/));
    rmSync(dir, { recursive: true });
  });
});

describe("a store that read the old replica mail tables before another store rebuilt them", () => {
  it("answers its first request and leaves the mail put in the rebuilt tables alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(OLD_REPLICA_MAIL[1].sql(Date.now() + 60_000));
    old.close();
    const bounds = { deadline: null, maxRetainedBytes: 1000 };

    const late = new HeldDriver(
      path,
      ([statement]) => statement.sql.includes("sqlite_master") && statement.sql.includes("'replica_packages'")
    );
    const lateStore = new SqlStore(late);
    const store = new SqlStore(new HeldDriver(path));
    const lateRead = lateStore.deliveryCount("did:example:replica");
    await late.whenHeld();

    await store.acknowledgeDeliveries("did:example:replica", ["d1", "d2"]);
    expect((await store.fanOut("did:example:shared", "more shared mail", bounds)).outcome).toBe("stored");

    late.release();
    expect(await lateRead).toBe(1);
    const [delivery] = await lateStore.deliveriesFor("did:example:replica", 10);
    expect(delivery.packed).toBe("more shared mail");
    await lateStore.acknowledgeDeliveries("did:example:replica", [delivery.id]);
    expect(await lateStore.deliveryCount("did:example:replica")).toBe(0);
    lateStore.close();
    store.close();

    expect(packageIds(path)).toEqual(["p0"]);
    rmSync(dir, { recursive: true });
  });
});

describe("two stores that both read tables from before registrations were named", () => {
  it("each answer their first request, with the one registration the account was given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const account = "did:example:account";
    const mediator = "did:example:mediator";
    const early = new SqliteStore(path);
    await early.registerReplicaAccount({
      accountDid: account,
      accountLongForm: "long",
      mediator,
      create: true,
    });
    early.close();
    const old = new Database(path);
    old.exec("ALTER TABLE replica_accounts DROP COLUMN registration");
    old.close();

    const late = new HeldDriver(
      path,
      ([statement]) => statement.sql.includes("sqlite_master") && statement.sql.includes("'messages'")
    );
    const lateStore = new SqlStore(late);
    const store = new SqlStore(new HeldDriver(path));
    const lateRead = lateStore.replicaRoster(account, mediator, 0, null, 1);
    await late.whenHeld();

    const given = (await store.replicaRoster(account, mediator, 0, null, 1))?.registration;
    expect(given).toEqual(expect.any(String));

    late.release();
    expect((await lateRead)?.registration).toBe(given);
    lateStore.close();
    store.close();
    rmSync(dir, { recursive: true });
  });
});

/** Runs each batch as one transaction, in which a statement `fails` picks throws. */
class FailingDriver implements SqlDriver {
  private db: Database.Database;

  constructor(
    path: string,
    private fails: (sql: string) => boolean
  ) {
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
  }

  async batch(statements: SqlStatement[]): Promise<SqlResult[]> {
    return this.db.transaction(() =>
      statements.map(({ sql, params = [] }) => {
        if (this.fails(sql)) {
          throw new Error("the statement fails");
        }
        const statement = this.db.prepare(sql);
        return statement.reader
          ? { rows: statement.all(...params) as Record<string, unknown>[], changes: 0 }
          : { rows: [], changes: statement.run(...params).changes };
      })
    )();
  }

  close(): void {
    this.db.close();
  }
}

function rowCount(path: string, table: string): number {
  const opened = new Database(path);
  const { n } = opened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  opened.close();
  return n;
}

const MEDIATOR = "did:example:mediator";
const ACCOUNT = "did:example:account";
const [A, B, C] = ["did:example:a", "did:example:b", "did:example:c"];
const T0 = 1_800_000_000;
const WEEK = 7 * 24 * 3600;
const EXECUTION_POLICY: ExecutionPolicy = { retainSeconds: WEEK, maxRetained: 2, maxReplicas: 2 };

async function accountWith(store: SqlStore, accountDid: string, replicas: string[]): Promise<void> {
  await store.registerReplicaAccount({
    accountDid,
    accountLongForm: "long",
    mediator: MEDIATOR,
    create: true,
  });
  for (const replicaDid of replicas) {
    await store.addReplica({
      accountDid,
      mediator: MEDIATOR,
      replicaDid,
      replicaLongForm: "long",
      grant: "grant",
      maxReplicas: 16,
    });
  }
}

function registerExecution(
  store: SqlStore,
  replicaDid: string,
  executionId: string,
  policy: Partial<ExecutionPolicy> = {},
  mediator = MEDIATOR
): Promise<RegisterExecutionOutcome> {
  return store.registerExecution({
    replicaDid,
    mediator,
    executionId: executionId as ExecutionId,
    policy: { ...EXECUTION_POLICY, ...policy },
  });
}

function registered(outcome: RegisterExecutionOutcome): ExecutionRegistrationSnapshot {
  if (outcome.outcome !== "registered") {
    throw new Error(`not registered: ${outcome.outcome}`);
  }
  return outcome.registration;
}

const at = (seconds: number) => vi.setSystemTime(seconds * 1000);

describe("execution registrations", () => {
  let dir: string;
  let path: string;
  let store: SqliteStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(T0);
    dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    path = join(dir, "mediator.db");
    store = new SqliteStore(path);
    await accountWith(store, ACCOUNT, [A, B, C]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true });
    vi.useRealTimers();
  });

  it("list the replicas in the order each first registered, under the first ID and times", async () => {
    const first = registered(await registerExecution(store, A, "execution"));
    at(T0 + 60);
    const second = registered(await registerExecution(store, B, "execution"));
    at(T0 + 120);
    const repeated = registered(await registerExecution(store, A, "execution"));

    expect(first).toEqual({
      executionId: "execution",
      registrationId: expect.any(String),
      createdTime: T0,
      retainUntil: T0 + WEEK,
      replicas: [A],
    });
    expect(second).toEqual({ ...first, replicas: [A, B] });
    expect(repeated).toEqual(second);
  });

  it("give replicas racing for one execution through two stores a single registration", async () => {
    const other = new SqliteStore(path);

    const [ofA, ofB] = (
      await Promise.all([
        registerExecution(store, A, "execution"),
        registerExecution(other, B, "execution"),
      ])
    ).map(registered);
    other.close();

    expect(ofB.registrationId).toBe(ofA.registrationId);
    expect([ofA.replicas, ofB.replicas]).toContainEqual([A, B]);
    expect(rowCount(path, "replica_executions")).toBe(1);
  });

  it("keep each account's executions apart under one ID", async () => {
    await accountWith(store, "did:example:other", ["did:example:other-replica"]);

    const ours = registered(await registerExecution(store, A, "execution"));
    const theirs = registered(await registerExecution(store, "did:example:other-replica", "execution"));

    expect(theirs.registrationId).not.toBe(ours.registrationId);
    expect([ours.replicas, theirs.replicas]).toEqual([[A], ["did:example:other-replica"]]);
  });

  it("tell executions apart by their IDs exactly as given", async () => {
    const ids = ["execution", "Execution", "execution ", " execution"];

    const registrations = [];
    for (const id of ids) {
      registrations.push(registered(await registerExecution(store, A, id, { maxRetained: 4 })));
    }

    expect(new Set(registrations.map((r) => r.registrationId)).size).toBe(ids.length);
    expect(registrations.map((r) => r.executionId)).toEqual(ids);
  });

  it("are made by no account DID, removed replica or replica addressing another mediator", async () => {
    await store.removeReplica(ACCOUNT, MEDIATOR, C);

    expect(await registerExecution(store, ACCOUNT, "execution")).toEqual({ outcome: "unknown" });
    expect(await registerExecution(store, C, "execution")).toEqual({ outcome: "unknown" });
    expect(
      await registerExecution(store, A, "execution", {}, "did:example:elsewhere")
    ).toEqual({ outcome: "unknown" });
    expect(await registerExecution(store, "did:example:stranger", "execution")).toEqual({
      outcome: "unknown",
    });
    expect(rowCount(path, "replica_executions")).toBe(0);
  });

  it("keep a replica removed afterwards in its place, and list no more of it", async () => {
    await registerExecution(store, A, "execution", { maxReplicas: 3 });
    await registerExecution(store, B, "execution", { maxReplicas: 3 });

    await store.removeReplica(ACCOUNT, MEDIATOR, A);

    expect(await registerExecution(store, A, "execution", { maxReplicas: 3 })).toEqual({
      outcome: "unknown",
    });
    expect(
      registered(await registerExecution(store, C, "execution", { maxReplicas: 3 })).replicas
    ).toEqual([A, B, C]);
  });

  it("survive a purge until their retention has passed, and no purge after", async () => {
    const { retainUntil } = registered(await registerExecution(store, A, "execution"));
    await registerExecution(store, B, "execution");

    at(retainUntil - 1);
    expect(await store.purgeExecutions()).toBe(0);
    expect(rowCount(path, "replica_executions")).toBe(1);

    at(retainUntil);
    expect(await store.purgeExecutions()).toBe(1);
    expect(rowCount(path, "replica_executions")).toBe(0);
    expect(rowCount(path, "replica_execution_registrations")).toBe(0);
  });

  it("stand as before past their retention until purged, and begin anew after", async () => {
    const first = registered(await registerExecution(store, A, "execution"));

    at(first.retainUntil + 3600);
    const grown = registered(await registerExecution(store, B, "execution"));
    expect(grown).toEqual({ ...first, replicas: [A, B] });

    await store.purgeExecutions();
    const anew = registered(await registerExecution(store, B, "execution"));
    expect(anew.registrationId).not.toBe(first.registrationId);
    expect(anew).toMatchObject({
      createdTime: first.retainUntil + 3600,
      retainUntil: first.retainUntil + 3600 + WEEK,
      replicas: [B],
    });
  });

  it("keep the retention they were created with, whatever a later request is configured with", async () => {
    registered(await registerExecution(store, A, "execution", { retainSeconds: 100 }));

    const repeated = registered(await registerExecution(store, B, "execution", { retainSeconds: 5 }));
    const another = registered(await registerExecution(store, A, "another", { retainSeconds: 5 }));

    expect(repeated.retainUntil).toBe(T0 + 100);
    expect(another.retainUntil).toBe(T0 + 5);
  });

  it("are refused anew at the account's limit, the ones past their retention counted until purged", async () => {
    registered(await registerExecution(store, A, "first"));
    registered(await registerExecution(store, A, "second"));

    expect(await registerExecution(store, A, "third")).toEqual({ outcome: "full" });
    expect(registered(await registerExecution(store, A, "first")).replicas).toEqual([A]);
    expect(registered(await registerExecution(store, B, "first")).replicas).toEqual([A, B]);

    at(T0 + WEEK);
    expect(await registerExecution(store, A, "third")).toEqual({ outcome: "full" });
    expect(await store.purgeExecutions()).toBe(2);
    expect(registered(await registerExecution(store, A, "third")).replicas).toEqual([A]);
  });

  it("take no replica past their limit, and still answer the ones they list under a lower one", async () => {
    await registerExecution(store, A, "execution");
    await registerExecution(store, B, "execution");

    expect(await registerExecution(store, C, "execution")).toEqual({ outcome: "full" });
    expect(registered(await registerExecution(store, A, "execution", { maxReplicas: 1 })).replicas).toEqual([
      A,
      B,
    ]);
    expect(await registerExecution(store, C, "execution", { maxReplicas: 1 })).toEqual({
      outcome: "full",
    });
  });

  it("are untouched by mail, its acknowledgment and its purge", async () => {
    const first = registered(await registerExecution(store, A, "execution"));

    const fanned = await store.fanOut(A, "mail", { deadline: null, maxRetainedBytes: 1000 });
    if (fanned.outcome !== "stored") throw new Error(fanned.outcome);
    await store.acknowledgeDeliveries(A, fanned.deliveries.map((delivery) => delivery.message.id));
    await store.fanOut(A, "lapsing", { deadline: (T0 + 1) * 1000, maxRetainedBytes: 1000 });
    at(T0 + 2);
    expect(await store.purgeExpired()).toBe(1);

    expect(registered(await registerExecution(store, A, "execution"))).toEqual(first);
  });

  it("go with their account, which registers anew under the same DID in the same second", async () => {
    const before = registered(await registerExecution(store, A, "execution"));

    expect(await store.deleteReplicaAccount(ACCOUNT, MEDIATOR)).toBe(true);
    expect(rowCount(path, "replica_executions")).toBe(0);
    expect(rowCount(path, "replica_execution_registrations")).toBe(0);

    await accountWith(store, ACCOUNT, [A]);
    const after = registered(await registerExecution(store, A, "execution"));
    expect(after.registrationId).not.toBe(before.registrationId);
    expect(after).toMatchObject({ createdTime: before.createdTime, replicas: [A] });
  });

  it("leave nothing behind when the transaction that would create one fails", async () => {
    const failing = new SqlStore(
      new FailingDriver(path, (sql) => sql.startsWith("INSERT INTO replica_execution_registrations"))
    );

    await expect(registerExecution(failing, A, "execution")).rejects.toThrow("the statement fails");
    failing.close();

    expect(rowCount(path, "replica_executions")).toBe(0);
    expect(registered(await registerExecution(store, B, "execution")).replicas).toEqual([B]);
  });

  it("keep their ID, order and times through a restart", async () => {
    await registerExecution(store, A, "execution");
    const before = registered(await registerExecution(store, B, "execution"));
    store.close();

    at(T0 + 60);
    store = new SqliteStore(path);
    expect(registered(await registerExecution(store, A, "execution"))).toEqual(before);
  });
});

describe("a database from before execution registrations", () => {
  it("gains them on first use, beside replicas enrolled under an ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(`
      ${REPLICA_TABLES_WITH_REPLICA_IDS}
      INSERT INTO replicas VALUES ('did:example:replica', 'did:example:account', 'r', 1, 'long', 'grant', 1);
    `);
    old.close();

    const store = new SqliteStore(path);
    expect(
      registered(await registerExecution(store, "did:example:replica", "execution")).replicas
    ).toEqual(["did:example:replica"]);
    store.close();

    const opened = new Database(path);
    expect(opened.pragma("foreign_key_check")).toEqual([]);
    opened.close();
    rmSync(dir, { recursive: true });
  });
});
