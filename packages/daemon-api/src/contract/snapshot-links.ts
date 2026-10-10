/**
 * A vault's snapshot put sealed at its mediator, for a new device to
 * restore from. The daemon that put it keeps what it put, the key
 * among it, in its own local state and not in the vault; the
 * mediator keeps the blob until `retainUntil`, or until it is revoked.
 */

import type { DisplayTime } from "./ids.js";

/**
 * What a new device restores from: where the sealed snapshot is, the
 * name its bytes have, and the key that opens them. Whoever holds it
 * reads every event and object of the vault in the clear for as long
 * as the mediator keeps the blob; the seed stays sealed under the
 * passphrase, which a link does not carry.
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
 * A snapshot this daemon put. `pending` until its bytes are uploaded:
 * there is no link yet, and revoking it frees whatever the mediator
 * holds of it; its `retainUntil` is null while the mediator has not
 * answered the put. `published` once uploaded, with the link to hand
 * over.
 *
 * Only the replica that put a blob may delete it at the mediator. A
 * daemon that gives up its replica ID, as when a merge finds a copy of
 * it wrote under that ID too, can no longer revoke what it put before:
 * a published one stays listed with `revocable` false, and its link
 * reads until `retainUntil`. A pending one is dropped then, its key
 * having gone to no one.
 */
export type SnapshotLinkRecord =
  | { status: "pending"; hash: string; placedAt: DisplayTime; retainUntil: DisplayTime | null }
  | { status: "published"; hash: string; placedAt: DisplayTime; retainUntil: DisplayTime; revocable: boolean; link: SnapshotLink };

export type PublishedSnapshotLink = Extract<SnapshotLinkRecord, { status: "published" }>;
