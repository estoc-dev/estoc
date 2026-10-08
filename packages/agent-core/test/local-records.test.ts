import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { SqliteVault, canonicalText, exportVault, openPortable, restoreVault, type AuthorId, type JsonValue } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { Keys, rawCidOfBytes, vaultHeldRoots, type Did, type DidId, type EventReference, type ExecutionId, type MediationId, type MessageId } from "@estoc/vault";

import { LocalRecords, openVault, type LeftTo, type LocalStore } from "../src/index.js";
import { directParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const REPLICA = "019b0000-0000-7000-8000-0000000000f1" as AuthorId;
const ANOTHER = "019b0000-0000-7000-8000-0000000000f2" as AuthorId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const EXECUTION = "019b0000-0000-5000-8000-000000000201" as ExecutionId;
const PREPARED = rawCidOfBytes(new TextEncoder().encode("one preparation")) as string as EventReference<"message.prepared">;
const ACCEPTED = rawCidOfBytes(new TextEncoder().encode("another preparation")) as string as EventReference<"message.prepared">;
const LEFT: LeftTo = { mediationId: "019b0000-0000-7000-8000-000000000301" as MediationId, registrationId: "registration-1", responderDid: "did:peer:4zQmResponder" as Did };

/** Local options over a map the test reads, whose reads and writes fail while told to. */
function store(): LocalStore & { kept: Map<string, JsonValue>; failing: { get: boolean; set: boolean } } {
  const kept = new Map<string, JsonValue>();
  const failing = { get: false, set: false };
  return {
    kept,
    failing,
    get: async (key) => {
      if (failing.get) throw new Error("the disk does not read for now");
      return kept.get(key);
    },
    set: async (key, value) => {
      if (failing.set) throw new Error("the disk is full for now");
      kept.set(key, value);
    },
    delete: async (key) => void kept.delete(key),
  };
}

async function written(records: LocalRecords): Promise<void> {
  await records.leave(EXECUTION, LEFT);
  await records.select(MESSAGE, PREPARED);
  await records.oweAcceptance(MESSAGE, ACCEPTED);
}

const read = async (records: LocalRecords) => [await records.leftTo(EXECUTION), await records.selected(MESSAGE), await records.owedAcceptance(MESSAGE)];

describe("the local records", () => {
  test("are kept under a key naming the adapter, its version, the replica, the kind and the subject, each value a closed object of its kind, and are read by that replica alone", async () => {
    const options = store();
    const records = new LocalRecords(options, REPLICA);
    await written(records);
    expect([...options.kept]).toEqual([
      [canonicalText(["agent-core", 1, REPLICA, "execution-left", EXECUTION]), LEFT],
      [canonicalText(["agent-core", 1, REPLICA, "preparation-selected", MESSAGE]), { preparationEventCid: PREPARED }],
      [canonicalText(["agent-core", 1, REPLICA, "acceptance-owed", MESSAGE]), { preparationEventCid: ACCEPTED }],
    ]);
    expect(await read(records)).toEqual([LEFT, PREPARED, ACCEPTED]);
    expect(await read(new LocalRecords(options, ANOTHER))).toEqual([null, null, null]);

    await records.select(MESSAGE, ACCEPTED);
    await records.acceptanceRecorded(MESSAGE);
    expect(await read(records)).toEqual([LEFT, ACCEPTED, null]);
    expect(options.kept.size).toBe(2);
  });

  test("refuse a value of the wrong shape and report a write that could not be made; a read that fails, or finds a value of the wrong shape, finds no record", async () => {
    const options = store();
    const records = new LocalRecords(options, REPLICA);
    await expect(records.select(MESSAGE, "not a CID" as EventReference<"message.prepared">)).rejects.toBeInstanceOf(TypeError);
    await expect(records.leave(EXECUTION, { ...LEFT, registrationId: "" })).rejects.toBeInstanceOf(TypeError);
    await expect(records.leave(EXECUTION, { ...LEFT, more: true } as LeftTo)).rejects.toBeInstanceOf(TypeError);
    expect(options.kept.size).toBe(0);
    options.failing.set = true;
    await expect(records.oweAcceptance(MESSAGE, ACCEPTED)).rejects.toThrow("the disk is full for now");
    options.failing.set = false;

    await written(records);
    options.failing.get = true;
    expect(await read(records)).toEqual([null, null, null]);
    options.failing.get = false;
    await options.set(canonicalText(["agent-core", 1, REPLICA, "preparation-selected", MESSAGE]), { preparationEventCid: PREPARED, envelopeCid: PREPARED });
    await options.set(canonicalText(["agent-core", 1, REPLICA, "execution-left", EXECUTION]), { ...LEFT, responderDid: 4 });
    expect(await read(records)).toEqual([null, null, ACCEPTED]);
  });

  test("live in the runtime's local options: a clearing of the caches and the trace keeps every kind and a reopen reads them, while a restore from an export, and an identity reset, start with none", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "estoc-local-records-"));
    const file = path.join(dir, "vault.sqlite");
    try {
      const alice = await directParty(1, "https://alice.example/didcomm", ALICE, openNodeSqlite(file, { mode: "create", journal: "delete" }));
      const records = new LocalRecords(alice.runtime.local.options, alice.runtime.author);
      await written(records);
      await alice.runtime.local.clearCaches();
      expect(await read(records)).toEqual([LEFT, PREPARED, ACCEPTED]);
      await alice.runtime.close();

      const reopened = await openVault(openNodeSqlite(file, { mode: "readwrite" }), alice.seedKey);
      expect(reopened.runtime.author).toBe(alice.runtime.author);
      expect(await read(new LocalRecords(reopened.runtime.local.options, reopened.runtime.author))).toEqual([LEFT, PREPARED, ACCEPTED]);

      const snapshot = path.join(dir, "snapshot.sqlite");
      await exportVault(reopened.runtime, (mode) => openNodeSqlite(snapshot, { mode }), { heldRoots: vaultHeldRoots(reopened.keys) });
      const source = openPortable(openNodeSqlite(snapshot, { mode: "readonly" }));
      const restoredFile = path.join(dir, "restored.sqlite");
      const restored = new SqliteVault((await restoreVault(source, (mode) => openNodeSqlite(restoredFile, { mode }), { heldRoots: vaultHeldRoots(null), anchor: await Keys.anchorOf(alice.seedKey) })).runtime);
      source.close();
      expect(await restored.local.options.keys()).toEqual([]);
      await restored.close();
      await reopened.runtime.close();

      const reset = await openVault(openNodeSqlite(file, { mode: "readwrite" }), alice.seedKey, { resetIdentity: true });
      expect(reset.runtime.author).not.toBe(alice.runtime.author);
      expect(await read(new LocalRecords(reset.runtime.local.options, reset.runtime.author))).toEqual([null, null, null]);
      await reset.runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
