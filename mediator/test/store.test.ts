import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqlStore } from "../src/store/sql-store.js";
import type { SqlDriver, SqlResult, SqlStatement } from "../src/store/sql-store.js";
import { SqliteStore } from "../src/store/sqlite.js";

const REPLICA_TABLES_WITHOUT_PACKAGE_KINDS = `
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
`;

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
const key = (forwardId: string) => ({ next: ALICE, forwardId });

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

    expect((await store.storeMessage(ALICE, key("1"), "one")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, key("2"), "two")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, key("3"), "three")).outcome).toBe("full");
    expect((await store.storeMessage(ALICE, key("2"), "two")).outcome).toBe("repeated");
    expect(await store.messageCount("did:example:alice")).toBe(2);
    store.close();
  });

  it("keeps the first bytes a key was given, per recipient and per account", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation(ALICE);
    await store.grantMediation("did:example:bob");

    expect((await store.storeMessage(ALICE, key("1"), "first")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, key("1"), "second")).outcome).toBe("conflict");
    expect(
      (await store.storeMessage(ALICE, { next: "did:example:alias", forwardId: "1" }, "second")).outcome
    ).toBe("stored");
    expect((await store.storeMessage("did:example:bob", key("1"), "second")).outcome).toBe("stored");

    expect((await store.messagesFor(ALICE, 10)).map((m) => m.packed)).toEqual(["first", "second"]);
    store.close();
  });

  it("lets a key be taken again once the mail under it has expired", async () => {
    const store = new SqliteStore(":memory:", { messageTtlSeconds: -1 });
    await store.grantMediation(ALICE);

    expect((await store.storeMessage(ALICE, key("1"), "old")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, key("1"), "new")).outcome).toBe("stored");
    store.close();
  });

  it("keys a queue created before packages had keys, and keeps its mail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE accounts (did TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
        packed TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES ('${ALICE}', 1);
      INSERT INTO messages VALUES ('a', '${ALICE}', 'one', 1, ${Date.now() + 60_000});
      INSERT INTO messages VALUES ('b', '${ALICE}', 'two', 2, ${Date.now() + 60_000});
    `);
    old.close();

    const store = new SqliteStore(path);
    expect((await store.storeMessage(ALICE, key("1"), "three")).outcome).toBe("stored");
    expect((await store.storeMessage(ALICE, key("1"), "three")).outcome).toBe("repeated");
    expect((await store.messagesFor(ALICE, 10)).map((m) => m.packed)).toEqual(["one", "two", "three"]);
    store.close();

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
      ${REPLICA_TABLES_WITHOUT_PACKAGE_KINDS}
      INSERT INTO replica_accounts VALUES ('did:example:account', 'm', 'did:example:mediator', 'long', 1);
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

  it("keeps the replica mail queued before a package recorded what its recipient was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const later = Date.now() + 60_000;
    const old = new Database(path);
    old.exec(`
      ${REPLICA_TABLES_WITHOUT_PACKAGE_KINDS}
      INSERT INTO replica_accounts VALUES ('did:example:account', 'm', 'did:example:mediator', 'long', 1);
      INSERT INTO replicas VALUES ('did:example:replica', 'did:example:account', 'r', 1, 'long', 'grant', 1);
      INSERT INTO replica_recipients VALUES ('did:example:shared', 'did:example:account', 'long', 1);
      INSERT INTO replica_packages VALUES
        ('p1', 'did:example:account', 'did:example:shared', '1', 'shared mail', 11, 1, ${later}),
        ('p2', 'did:example:account', 'did:example:replica', '1', 'own mail', 8, 2, ${later});
      INSERT INTO replica_deliveries VALUES
        ('d1', 'p1', 'did:example:replica'),
        ('d2', 'p2', 'did:example:replica');
    `);
    old.close();
    const bounds = { deadline: null, maxRetainedBytes: 1000 };
    const toShared = { next: "did:example:shared", forwardId: "1" };
    const toReplica = { next: "did:example:replica", forwardId: "1" };

    const store = new SqliteStore(path);
    const waiting = await store.deliveriesFor("did:example:replica", 10);
    expect(waiting.map((message) => [message.id, message.packed])).toEqual([
      ["d1", "shared mail"],
      ["d2", "own mail"],
    ]);
    await store.acknowledgeDeliveries("did:example:replica", ["d1", "d2"]);
    expect((await store.fanOut(toShared, "shared mail", bounds)).outcome).toBe("repeated");
    expect((await store.fanOut(toReplica, "own mail", bounds)).outcome).toBe("stored");
    store.close();

    const reopened = new SqliteStore(path);
    expect(await reopened.deliveryCount("did:example:replica")).toBe(1);
    reopened.close();
    rmSync(dir, { recursive: true });
  });

  it("scopes deletion to the owner", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation("did:example:alice");
    await store.grantMediation("did:example:bob");
    const stored = await store.storeMessage(ALICE, key("1"), "hers");
    if (stored.outcome !== "stored") throw new Error(stored.outcome);

    expect(await store.deleteMessages("did:example:bob", [stored.message.id])).toEqual([]);
    expect(await store.messageCount("did:example:alice")).toBe(1);
    store.close();
  });

  it("expires messages by TTL", async () => {
    const store = new SqliteStore(":memory:", { messageTtlSeconds: -1 });
    await store.grantMediation("did:example:alice");
    await store.storeMessage(ALICE, key("1"), "already old");

    expect(await store.messageCount("did:example:alice")).toBe(0);
    expect(await store.purgeExpired()).toBe(1);
    store.close();
  });

  it("takes the keylist and inbox down with the account", async () => {
    const store = new SqliteStore(":memory:");
    await store.grantMediation("did:example:alice");
    await store.addRecipient("did:example:alice", "did:example:alias");
    await store.storeMessage(ALICE, key("1"), "waiting");

    await store.revokeMediation("did:example:alice");
    expect(await store.ownerOf("did:example:alias")).toBeNull();
    expect(await store.isMediated("did:example:alice")).toBe(false);
    store.close();
  });
});

describe("a store that read the old replica mail tables before another store rebuilt them", () => {
  it("leaves the rebuilt tables and the kinds recorded in them alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mediator-store-"));
    const path = join(dir, "mediator.db");
    const account = "did:example:account";
    const mediator = "did:example:mediator";
    const old = new Database(path);
    old.exec(`
      ${REPLICA_TABLES_WITHOUT_PACKAGE_KINDS}
      INSERT INTO replica_accounts VALUES ('${account}', 'm', '${mediator}', 'long', 1);
      INSERT INTO replicas VALUES ('did:example:replica', '${account}', 'r', 1, 'long', 'grant', 1);
      INSERT INTO replica_recipients VALUES ('did:example:shared', '${account}', 'long', 1);
      INSERT INTO replica_packages VALUES
        ('p1', '${account}', 'did:example:shared', '1', 'shared mail', 11, 1, ${Date.now() + 60_000});
      INSERT INTO replica_deliveries VALUES ('d1', 'p1', 'did:example:replica');
    `);
    old.close();

    const late = new HeldDriver(
      path,
      ([statement]) => statement.sql.includes("sqlite_master") && statement.sql.includes("'replica_packages'")
    );
    const lateStore = new SqlStore(late);
    const store = new SqlStore(new HeldDriver(path));
    const lateRead = lateStore.deliveryCount("did:example:replica");
    await late.whenHeld();

    expect(await store.removeSharedRecipient(account, mediator, "did:example:shared")).toBe("removed");
    const enrolled = await store.addReplica({
      accountDid: account,
      mediator,
      replicaDid: "did:example:shared",
      replicaLongForm: "long",
      grant: "grant",
      maxReplicas: 3,
    });
    expect(enrolled.outcome).toBe("added");

    late.release();
    expect(await lateRead).toBe(1);
    expect((await store.removeReplica(account, mediator, "did:example:shared")).outcome).toBe("removed");
    expect(await lateStore.deliveryCount("did:example:replica")).toBe(1);
    await lateStore.acknowledgeDeliveries("did:example:replica", []);
    lateStore.close();
    store.close();
    rmSync(dir, { recursive: true });
  });
});
