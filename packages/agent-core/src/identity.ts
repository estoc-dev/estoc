/**
 * The vault as the agent opens it: the SQLite runtime under
 * `@estoc/event-store` with the seed's keys under `@estoc/vault`,
 * bound as one `VaultSession` with the options its folds are read
 * under. The host opens the driver — a file on Node, the access-handle
 * pool in a browser Worker — in the mode each entry asks for, and the
 * driver's ownership is the runtime's from then on: an open that
 * fails closes it. Every writable open verifies the seed against the
 * vault's anchor before anything is derived or written, and reads the
 * fold once, as the first step of recovery, so that a vault that does
 * not fold is refused here; every procedure re-reads it under the
 * lock.
 */

import { SqliteVault, VAULT_VERSION, createRuntime, openInspector, openRuntime, type RuntimeDatabase, type SqliteDriver, type SqliteVaultOptions, type WrappedSeed } from "@estoc/event-store";
import { unlockSeedKeystore, type SeedKey } from "@estoc/keystore";
import { Keys, scanVault, vaultDraft, type ScanOptions, type VaultFold } from "@estoc/vault";

import { Session, type VaultSession } from "./session.js";

export interface VaultOptions extends SqliteVaultOptions, ScanOptions {}

export interface OpenVaultOptions extends VaultOptions {
  /**
   * The runtime takes a fresh replica ID and store generation as it
   * opens, its history untouched: for a copy of a vault that went on
   * being written elsewhere under the same replica ID, which a merge
   * refuses as a forked author until one of the two is renewed.
   */
  resetIdentity?: boolean;
}

/** The seed in hand, or the passphrase that unlocks the wrapped seed the vault holds. */
export type Unlock = SeedKey | { passphrase: string };

/**
 * Opens the runtime in `driver`, opened `readwrite`, and verifies the
 * seed: given outright, its anchor is compared with the vault's; given
 * as a passphrase, the vault's wrapped seed is unlocked with it first,
 * so a wrong passphrase fails before any comparison. Either failure
 * closes the driver.
 */
export async function openVault(driver: SqliteDriver, unlock: Unlock, { resetIdentity, ...options }: OpenVaultOptions = {}): Promise<VaultSession> {
  let seedKey: SeedKey | undefined = "passphrase" in unlock ? undefined : unlock;
  const db = await openRuntime(driver, {
    anchor: async (wrapped) => {
      if (seedKey === undefined) seedKey = await unlockSeedKeystore({ version: 3, seedJwe: wrapped.seedJwe }, (unlock as { passphrase: string }).passphrase);
      return Keys.anchorOf(seedKey);
    },
    ...(resetIdentity === true ? { resetIdentity } : {}),
  });
  return owned(db, options, (runtime) => bound(runtime, seedKey as SeedKey, options));
}

export interface CreateVaultOptions extends VaultOptions {
  seedKey: SeedKey;
  /** the seed sealed under the passphrase, as `@estoc/keystore` version 3 seals it: what the vault keeps and every snapshot carries */
  wrapped: WrappedSeed;
  /** what the identity calls itself: the first `identity.label` */
  label: string;
}

/** Creates the vault in `driver`, opened to create, under the seed's anchor, and records its label. */
export async function createVault(driver: SqliteDriver, { seedKey, wrapped, label, ...options }: CreateVaultOptions): Promise<VaultSession> {
  const anchor = await Keys.anchorOf(seedKey);
  const db = createRuntime(driver, { metadata: { version: VAULT_VERSION, anchor }, wrapped });
  return owned(db, options, async (runtime) => {
    await runtime.vault.commit([], [vaultDraft("identity.label", { name: label })]);
    return bound(runtime, seedKey, options);
  });
}

/**
 * A runtime the event store restored from a snapshot, bound under the
 * seed the snapshot was unlocked with: the seed must derive the
 * runtime's anchor, else `IdentityMismatch` and the runtime closed.
 * The restore compared the anchor already; this is where the keys
 * are made, so the comparison stands wherever the seed came from.
 */
export async function openRestoredVault(restored: RuntimeDatabase, seedKey: SeedKey, options: VaultOptions = {}): Promise<VaultSession> {
  return owned(restored, options, (runtime) => bound(runtime, seedKey, options));
}

/**
 * What `make` makes of the runtime over `db`. The database is the
 * runtime's from here: whatever fails before the value is handed out,
 * the runtime's construction included, closes it.
 */
async function owned<T>(db: RuntimeDatabase, options: SqliteVaultOptions, make: (runtime: SqliteVault) => Promise<T>): Promise<T> {
  let runtime: SqliteVault | undefined;
  try {
    runtime = new SqliteVault(db, options);
    return await make(runtime);
  } catch (err) {
    if (runtime === undefined) db.close();
    else await runtime.close();
    throw err;
  }
}

async function bound(runtime: SqliteVault, seedKey: SeedKey, options: ScanOptions): Promise<VaultSession> {
  const session = new Session(runtime, await Keys.open(seedKey, runtime.metadata.anchor), options);
  await session.fold();
  return session;
}

/** A runtime looked at without its seed: nothing is written, nothing derived; the fold carries no key verdicts. */
export interface InspectedRuntime {
  runtime: SqliteVault;
  /** the wrapped seed as it is, for a passphrase to be tried against (`Keys.unlock`) before the vault is reopened to run */
  wrapped: WrappedSeed;
  fold: VaultFold;
}

/**
 * The runtime in `driver`, opened `readwrite` — the one mode that owns
 * the file — to look at: what a locked host holds before the passphrase
 * is given. Every write is refused. Running the vault is a second open,
 * on a fresh driver, once this one is closed.
 */
export async function inspectRuntime(driver: SqliteDriver, options: VaultOptions = {}): Promise<InspectedRuntime> {
  return owned(openInspector(driver), options, async (runtime) => ({ runtime, wrapped: await runtime.keystore.read(), fold: await scanVault(runtime.vault, null, options) }));
}

