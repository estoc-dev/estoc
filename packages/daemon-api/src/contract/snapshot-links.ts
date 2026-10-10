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
 */
export type SnapshotLinkRecord =
  | { status: "pending"; hash: string; placedAt: DisplayTime; retainUntil: DisplayTime | null }
  | { status: "published"; hash: string; placedAt: DisplayTime; retainUntil: DisplayTime; link: SnapshotLink };

export type PublishedSnapshotLink = Extract<SnapshotLinkRecord, { status: "published" }>;
