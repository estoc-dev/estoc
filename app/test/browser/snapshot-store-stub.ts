import { reactive } from "vue";

import type { OpenedSnapshotLink } from "../../src/core/store.js";
import type { MergeResult, Phase, ReplicaId, Snapshot, SnapshotLink, SnapshotLinkRecord, SnapshotSelection } from "../../src/core/types.js";

/**
 * Stands in for the app's store where a vault is restored from a link,
 * where links are made and where they are imported, and where history
 * goes to the vault's other devices: a daemon of the test's, which holds
 * the links it is given and writes down what it is asked. A publish here
 * leaves its pending link behind and fails, as an upload cut short does;
 * an import answers `merged`, or fails with `unmerged` while that is set,
 * once `held` lets it; history sent goes to the devices `told` names.
 */
export const daemon = {
  calls: [] as { name: string; args: unknown[] }[],
  links: [] as SnapshotLinkRecord[],
  /** why the list cannot be read, while it cannot */
  unlistable: null as string | null,
  merged: { added: 3, duplicates: 7, objects: 0, repaired: 0, renewed: false } as MergeResult,
  /** why an import fails, while it does */
  unmerged: null as string | null,
  /** what an import waits on before it answers, while set */
  held: null as Promise<void> | null,
  /** the devices history sent goes to: those asked for, or none */
  told: null as ReplicaId[] | null,
};

/** What the devices section reads of the vault. */
export type ShownVault = Pick<Snapshot, "mediations" | "historyReceived" | "conversations">;

export const state = reactive({ pendingSnapshotLink: null as OpenedSnapshotLink | null, away: null as string | null, vault: { phase: "onboarding" as Phase }, snapshot: null as ShownVault | null });

export const openIndex = (): { snapshot: ShownVault } | null => (state.snapshot === null ? null : { snapshot: state.snapshot });

export function dismissPendingSnapshotLink(opened: OpenedSnapshotLink): void {
  if (state.pendingSnapshotLink === opened) state.pendingSnapshotLink = null;
}

export const heldNow = () => () => true;

const recorded =
  (name: string) =>
  async (...args: unknown[]): Promise<void> => {
    daemon.calls.push({ name, args });
  };

export const createIdentity = recorded("createIdentity");
export const restoreIdentity = recorded("restoreIdentity");
export const restoreFromLink = recorded("restoreFromLink");

export async function snapshotLinks(): Promise<SnapshotLinkRecord[]> {
  daemon.calls.push({ name: "snapshotLinks", args: [] });
  if (daemon.unlistable !== null) throw new Error(daemon.unlistable);
  return [...daemon.links];
}

export async function publishSnapshotLink(selection: SnapshotSelection): Promise<never> {
  daemon.calls.push({ name: "publishSnapshotLink", args: [selection] });
  daemon.links.unshift({ status: "pending", hash: `bciqcutshort${daemon.links.length}`, selection, placedAt: "2026-10-10T12:00:00.000Z", retainUntil: "2026-11-09T12:00:00.000Z" } as SnapshotLinkRecord);
  throw new Error("the upload was cut short");
}

export async function importFromLink(input: string): Promise<MergeResult> {
  daemon.calls.push({ name: "importFromLink", args: [input] });
  await daemon.held;
  if (daemon.unmerged !== null) throw new Error(daemon.unmerged);
  return daemon.merged;
}

export async function refreshReplicas(): Promise<void> {
  daemon.calls.push({ name: "refreshReplicas", args: [] });
}

export async function sendHistory(replicaId?: ReplicaId): Promise<ReplicaId[]> {
  daemon.calls.push({ name: "sendHistory", args: [replicaId ?? null] });
  return daemon.told ?? (replicaId === undefined ? [] : [replicaId]);
}

export async function revokeSnapshotLink(hash: string): Promise<void> {
  daemon.calls.push({ name: "revokeSnapshotLink", args: [hash] });
  daemon.links = daemon.links.filter((link) => link.hash !== hash);
}

export const snapshotLinkOf = (link: SnapshotLink): string => `http://app.test/#snapshot=${link.hash}`;
