/**
 * The vault's retention as the event store asks for it: folded from
 * the vault it is handed, with the seed's checks when the keys are
 * here, and handed over the same way for collection, export,
 * validation and import.
 */

import { heldRootsOf, type Collected, type HeldRoots, type RetainedRoots, type VaultRuntime } from "@estoc/event-store";

import { scanVault, type ScanOptions } from "./fold/vault.js";
import type { Keys } from "./identity.js";

export function vaultRetention(keys: Keys | null, options: ScanOptions = {}): RetainedRoots {
  return async (vault) => (await scanVault(vault, keys, options)).retained;
}

/** The roots the vault holds, as a keep set for collection, an export or a validation. */
export function vaultHeldRoots(keys: Keys | null, options: ScanOptions = {}): HeldRoots {
  return heldRootsOf(vaultRetention(keys, options));
}

/** One collection pass: the keep set folded under the lock. */
export function collectGarbage(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Collected> {
  return runtime.collect(vaultHeldRoots(keys, options));
}
