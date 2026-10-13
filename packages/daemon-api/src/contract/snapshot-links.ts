/**
 * A part of a vault's snapshot put sealed at its mediator, for a new
 * device to restore from or a replica to import. The daemon that put
 * it keeps what it put, the key among it, in its own local state and
 * not in the vault; the mediator keeps the blob until `retainUntil`,
 * or until it is revoked.
 */

import type { DisplayTime } from "./ids.js";

export const SNAPSHOT_PARTS = ["seed", "content"] as const;

/**
 * The part of a snapshot a link carries. `seed` is the seed sealed
 * under the passphrase, with the events a new replica enrolls from:
 * the vault's name, its arrangements and its replicas, which name no
 * object when well formed. A device restores from it, registers at the
 * mediator and receives from then on. `content` is every event and
 * every object the events hold, with no seed: a vault that is open
 * imports it, and no device is made from it. A backup carries both.
 */
export type SnapshotPart = (typeof SNAPSHOT_PARTS)[number];

/**
 * What a new device restores from, or an open vault imports: where the
 * sealed snapshot is, the name its bytes have, and the key that opens
 * them. Whoever holds it reads every event and object the snapshot
 * carries in the clear for as long as the mediator keeps the blob; a
 * seed stays sealed under the passphrase, which a link does not carry.
 */
export interface SnapshotLink {
  /** where the sealed snapshot is read, by anyone, with no identity */
  url: string;
  /** the sealed bytes' sha2-256 multihash in base32: what they are checked against before they are opened */
  hash: string;
  /** the AES-256-GCM key: 32 bytes, base64url without padding */
  key: string;
}

/**
 * A snapshot this daemon put, and the part it carries. `pending` until its
 * bytes are uploaded: there is no link yet, and revoking it frees
 * whatever the mediator holds of it; its `retainUntil` is null while
 * the mediator has not answered the put. `published` once uploaded,
 * with the link to hand over.
 *
 * Only the replica that put a blob may delete it at the mediator. A
 * daemon that gives up its replica ID, as when a merge finds a copy of
 * it wrote under that ID too, can no longer revoke what it put before:
 * a published one stays listed with `revocable` false, and its link
 * reads until `retainUntil`. A pending one is dropped then, its key
 * having gone to no one.
 */
export type SnapshotLinkRecord =
  | { status: "pending"; hash: string; part: SnapshotPart; placedAt: DisplayTime; retainUntil: DisplayTime | null }
  | { status: "published"; hash: string; part: SnapshotPart; placedAt: DisplayTime; retainUntil: DisplayTime; revocable: boolean; link: SnapshotLink };

export type PublishedSnapshotLink = Extract<SnapshotLinkRecord, { status: "published" }>;
