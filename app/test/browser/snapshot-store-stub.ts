import { reactive } from "vue";

import type { OpenedSnapshotLink } from "../../src/core/store.js";
import type { SnapshotLink, SnapshotLinkRecord } from "../../src/core/types.js";

/**
 * Stands in for the app's store where a vault is restored from a link and
 * where links are made: a daemon of the test's, which holds the links it
 * is given and writes down what it is asked. A publish here leaves its
 * pending link behind and fails, as an upload cut short does.
 */
export const daemon = {
  calls: [] as { name: string; args: unknown[] }[],
  links: [] as SnapshotLinkRecord[],
  /** why the list cannot be read, while it cannot */
  unlistable: null as string | null,
};

export const state = reactive({ pendingSnapshotLink: null as OpenedSnapshotLink | null, away: null as string | null });

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

export async function publishSnapshotLink(): Promise<never> {
  daemon.calls.push({ name: "publishSnapshotLink", args: [] });
  daemon.links.unshift({ status: "pending", hash: "bciqcutshort", placedAt: "2026-10-10T12:00:00.000Z", retainUntil: "2026-11-09T12:00:00.000Z" } as SnapshotLinkRecord);
  throw new Error("the upload was cut short");
}

export async function revokeSnapshotLink(hash: string): Promise<void> {
  daemon.calls.push({ name: "revokeSnapshotLink", args: [hash] });
  daemon.links = daemon.links.filter((link) => link.hash !== hash);
}

export const snapshotLinkOf = (link: SnapshotLink): string => `http://app.test/#snapshot=${link.hash}`;
