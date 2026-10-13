import type { DisplayTime } from "@estoc/daemon-api/contract";
import { reactive } from "vue";

import type { OpenedSnapshotLink } from "../../src/core/store.js";
import type { MergeResult, Phase, PublishedSnapshotLink, ReplicaId, ReplicaRecord, Snapshot, SnapshotLink, SnapshotLinkRecord, SnapshotPart } from "../../src/core/types.js";

/**
 * Stands in for the app's store where a vault is restored from a link,
 * where links are made and where they are imported, and where history
 * goes to the vault's other devices: a daemon of the test's, which holds
 * the links it is given and writes down what it is asked. A publish here
 * puts its link at the head of the list, or, while `unpublished` is set,
 * leaves it pending there and fails, as an upload cut short does; a
 * restore from a link fails with `unrestored` while that is set; an import
 * answers `merged`, or fails with `unmerged` while that is set, once
 * `held` lets it; history sent goes to the devices `told` names, and the
 * mediator, asked which devices there are, answers `relisted` or fails
 * with `unasked`.
 */
export const daemon = {
  calls: [] as { name: string; args: unknown[] }[],
  links: [] as SnapshotLinkRecord[],
  /** why the list cannot be read, while it cannot */
  unlistable: null as string | null,
  unpublished: null as string | null,
  unrestored: null as string | null,
  merged: { added: 3, duplicates: 7, objects: 0, repaired: 0, renewed: false } as MergeResult,
  /** why an import fails, while it does */
  unmerged: null as string | null,
  /** what an import waits on before it answers, while set */
  held: null as Promise<void> | null,
  /** the devices history sent goes to: those asked for, or none */
  told: null as ReplicaId[] | null,
  /** the devices the mediator lists when asked next, while set; the listing shown stays as it is while not */
  relisted: null as ReplicaRecord[] | null,
  /** why the mediator cannot be asked, while it cannot */
  unasked: null as string | null,
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
export const downloadBackup = recorded("downloadBackup");

export async function restoreFromLink(input: string, passphrase: string): Promise<void> {
  daemon.calls.push({ name: "restoreFromLink", args: [input, passphrase] });
  if (daemon.unrestored !== null) throw new Error(daemon.unrestored);
}

export async function snapshotLinks(): Promise<SnapshotLinkRecord[]> {
  daemon.calls.push({ name: "snapshotLinks", args: [] });
  if (daemon.unlistable !== null) throw new Error(daemon.unlistable);
  return [...daemon.links];
}

export async function publishSnapshotLink(part: SnapshotPart): Promise<PublishedSnapshotLink> {
  daemon.calls.push({ name: "publishSnapshotLink", args: [part] });
  const hash = `bciqput${daemon.links.length}`;
  const placed = { hash, part, placedAt: "2026-10-10T12:00:00.000Z" as DisplayTime, retainUntil: "2026-11-09T12:00:00.000Z" as DisplayTime };
  if (daemon.unpublished !== null) {
    daemon.links.unshift({ status: "pending", ...placed });
    throw new Error(daemon.unpublished);
  }
  const published: PublishedSnapshotLink = { status: "published", ...placed, revocable: true, link: { url: `https://mediator.test/b/${hash}`, hash, key: "k".repeat(43) } };
  daemon.links.unshift(published);
  return published;
}

export async function importFromLink(input: string): Promise<MergeResult> {
  daemon.calls.push({ name: "importFromLink", args: [input] });
  await daemon.held;
  if (daemon.unmerged !== null) throw new Error(daemon.unmerged);
  return daemon.merged;
}

export async function refreshReplicas(): Promise<void> {
  daemon.calls.push({ name: "refreshReplicas", args: [] });
  if (daemon.unasked !== null) throw new Error(daemon.unasked);
  const selected = state.snapshot?.mediations.find((mediation) => mediation.selected);
  if (daemon.relisted !== null && selected !== undefined) selected.replicas = { listedAt: new Date().toISOString() as never, replicas: daemon.relisted };
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
