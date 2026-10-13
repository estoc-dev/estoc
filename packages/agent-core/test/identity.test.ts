import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openNodeSqlite } from "@estoc/event-store/node";
import { AnchorMismatch, ReadOnlyVault, Snapshot, exportSnapshot, restoreSnapshot, type OpenMode } from "@estoc/event-store";
import { createSeedKeystore, type SeedKey } from "@estoc/keystore";
import { Keys, vaultDraft, vaultHeldRoots } from "@estoc/vault";

import { createVault, inspectRuntime, openRestoredVault, openVault } from "../src/index.js";
import { PASSPHRASE, freshVault, memoryDriver, opened, seedOf, ticking } from "./helpers.js";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-c01-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const open = (file: string, mode: OpenMode) => openNodeSqlite(file, { mode });

describe("the vault opened with the seed", () => {
  it("creates under the seed's anchor with its label, and reopens as the same identity with the seed or the passphrase", async () => {
    const file = fresh();
    const { doc, seedKey } = await createSeedKeystore(PASSPHRASE, { seed: seedOf(1) });
    const made = await createVault(open(file, "create"), { seedKey, wrapped: doc, label: "Alice", now: ticking() });
    expect(made.runtime.metadata.anchor).toBe(await Keys.anchorOf(seedKey));
    const fold = await made.fold();
    expect(fold.label).toBe("Alice");
    expect(fold.authors.map((author) => author.author)).toEqual([made.runtime.author]);
    await made.runtime.close();

    const bySeed = await openVault(open(file, "readwrite"), seedKey);
    expect(bySeed.runtime.metadata.anchor).toBe(made.runtime.metadata.anchor);
    expect(bySeed.runtime.author).toBe(made.runtime.author);
    expect((await bySeed.fold()).label).toBe("Alice");
    expect(opened(bySeed).keys.locked).toBe(false);
    await bySeed.runtime.close();

    const byPassphrase = await openVault(open(file, "readwrite"), { passphrase: PASSPHRASE });
    expect((await byPassphrase.fold()).label).toBe("Alice");
    await byPassphrase.runtime.close();
  });

  it("refuses another seed and a wrong passphrase, closing the driver either way", async () => {
    const file = fresh();
    const made = await freshVault(1, "Alice", open(file, "create"));
    await made.runtime.close();
    const other = await createSeedKeystore(PASSPHRASE, { seed: seedOf(2) });
    await expect(openVault(open(file, "readwrite"), other.seedKey)).rejects.toBeInstanceOf(AnchorMismatch);
    await expect(openVault(open(file, "readwrite"), { passphrase: "wrong" })).rejects.toThrow();
    // the file is not held by the refused opens: it opens again
    const again = await openVault(open(file, "readwrite"), made.seedKey);
    expect((await again.fold()).label).toBe("Alice");
    await again.runtime.close();
  });
});

describe("an open that fails once the database is in hand", () => {
  const lookupFailed = () => ({
    effectTypes: (function* () {
      yield "https://example.org/custom";
      throw new Error("effect-type lookup failed");
    })(),
  });
  const reopens = async (file: string, seedKey: SeedKey) => (await openVault(open(file, "readwrite"), seedKey)).runtime.close();

  it("closes the file when the effect types fail as they are read, on create, open and restore alike", async () => {
    const { doc, seedKey } = await createSeedKeystore(PASSPHRASE, { seed: seedOf(1) });
    const file = fresh();
    await expect(createVault(open(file, "create"), { seedKey, wrapped: doc, label: "Alice", ...lookupFailed() })).rejects.toThrow("effect-type lookup failed");
    await reopens(file, seedKey);
    await expect(openVault(open(file, "readwrite"), seedKey, lookupFailed())).rejects.toThrow("effect-type lookup failed");
    await reopens(file, seedKey);

    const source = await openVault(open(file, "readwrite"), seedKey);
    const bytes = await exportSnapshot(source.runtime, { parts: "both", heldRoots: source.heldRoots() });
    await source.runtime.close();
    const snapshot = await Snapshot.read(bytes, { heldRoots: vaultHeldRoots(null) });
    const restoredFile = fresh();
    const { runtime: restored } = await restoreSnapshot(snapshot, () => open(restoredFile, "create"), { anchor: await Keys.anchorOf(seedKey) });
    await expect(openRestoredVault(restored, seedKey, lookupFailed())).rejects.toThrow("effect-type lookup failed");
    await reopens(restoredFile, seedKey);
  });

  it("closes the file when the storage options are refused, on create, open and inspection alike", async () => {
    const { doc, seedKey } = await createSeedKeystore(PASSPHRASE, { seed: seedOf(1) });
    const file = fresh();
    await expect(createVault(open(file, "create"), { seedKey, wrapped: doc, label: "Alice", maxObjectBytes: -1 })).rejects.toBeInstanceOf(RangeError);
    await reopens(file, seedKey);
    await expect(openVault(open(file, "readwrite"), seedKey, { maxObjectBytes: -1 })).rejects.toBeInstanceOf(RangeError);
    await reopens(file, seedKey);
    await expect(inspectRuntime(open(file, "readwrite"), { maxObjectBytes: -1 })).rejects.toBeInstanceOf(RangeError);
    await reopens(file, seedKey);
  });
});

describe("the runtime inspected without the seed", () => {
  it("reads the wrapped seed and the fold, writes nothing, and lets the passphrase be checked before a writable open", async () => {
    const file = fresh();
    const made = await freshVault(1, "Alice", open(file, "create"));
    await made.runtime.close();

    const inspected = await inspectRuntime(open(file, "readwrite"));
    expect(inspected.fold.label).toBe("Alice");
    expect(inspected.fold.checks.didKeys.size).toBe(0);
    expect(inspected.wrapped).toEqual({ version: 3, seedJwe: made.keystore.seedJwe });
    expect(inspected.runtime.writable).toBe(false);
    await expect(inspected.runtime.vault.commit([], [vaultDraft("identity.label", { name: "Mallory" })])).rejects.toBeInstanceOf(ReadOnlyVault);
    const keys = await Keys.unlock(inspected.wrapped, PASSPHRASE, inspected.runtime.metadata.anchor);
    expect(keys.locked).toBe(false);
    await expect(Keys.unlock(inspected.wrapped, "wrong", inspected.runtime.metadata.anchor)).rejects.toThrow();
    await inspected.runtime.close();

    const reopened = await openVault(open(file, "readwrite"), made.seedKey);
    expect((await reopened.fold()).label).toBe("Alice");
    await reopened.runtime.close();
  });
});

describe("in memory", () => {
  it("makes and folds a vault on a private in-memory database", async () => {
    const made = await freshVault(3, "Carol", memoryDriver());
    expect((await made.session.fold()).label).toBe("Carol");
    await made.runtime.close();
  });
});
