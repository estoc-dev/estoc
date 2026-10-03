/**
 * How a decision over the whole fold commits: under the writer lock,
 * one scan, the decision over it, and what it drafted in one batch,
 * so that nothing commits against a fold another writer has moved on
 * from. A decision that may release a root collects under the same
 * lock, before anything else can hold the root again.
 */

import type { Collected, Event, VaultRuntime } from "@estoc/event-store";

import { scanVault, type ScanOptions, type VaultFold } from "./fold/vault.js";
import type { Keys } from "./identity.js";
import { vaultHeldRoots } from "./retention.js";
import type { VaultDraft } from "./schema.js";

export interface Committed {
  readonly events: Event[];
  readonly collected: Collected;
}

/** Scan under the lock, commit what the decision drafts in one batch; nothing drafted commits nothing. */
export function commitDecided(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions, drafts: (fold: VaultFold) => VaultDraft[]): Promise<Event[]> {
  return runtime.locked(async (held) => {
    const batch = drafts(await scanVault(held, keys, options));
    return batch.length === 0 ? [] : held.commit([], batch);
  });
}

/** As `commitDecided`, then one collection pass under the same lock: for a batch that may release a root. */
export function commitAndCollect(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions, drafts: (fold: VaultFold) => VaultDraft[]): Promise<Committed> {
  return runtime.locked(async (held) => {
    const batch = drafts(await scanVault(held, keys, options));
    const events = batch.length === 0 ? [] : await held.commit([], batch);
    return { events, collected: await held.collect(vaultHeldRoots(keys, options)) };
  });
}
