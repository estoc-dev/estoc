/**
 * The vault's retention as the event store asks for it: folded from
 * the vault it is handed, with the seed's checks when the keys are
 * here, and handed over the same way for collection, export,
 * validation and import; and the events a new replica enrolls from,
 * for an export of them alone.
 */

import { heldRootsOf, type Collected, type HeldRoots, type RetainedRoots, type VaultRuntime } from "@estoc/event-store";

import { scanVault, type ScanOptions } from "./fold/vault.js";
import type { Keys } from "./identity.js";
import type { VaultEventType } from "./types.js";

/**
 * The event types a new replica enrolls from: the vault's name, every
 * arrangement as it was created, granted, selected and retired, and
 * every replica enrolled at one. A valid event of these types holds no
 * root, so a snapshot of them alone carries no object; one whose
 * payload is malformed keeps its roots, under the ordinary retention.
 * Restored, it is an ordinary replica that enrolls at the preferred
 * arrangement and receives; the history comes by an import. No `did.*`
 * event is among them: mail to the vault's DIDs that reaches the
 * replica before the import is what the other replicas received and
 * recorded as well, and the import brings it.
 */
export const ENROLLMENT_EVENT_TYPES: ReadonlySet<VaultEventType> = new Set<VaultEventType>(["identity.label", "mediation.created", "mediation.granted", "mediation.selected", "mediation.retired", "replica.created"]);

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
