/**
 * The snapshots this runtime put at its mediator, each kept under a
 * local option of its own until it is revoked or the mediator lets it
 * go: what its link needs, the key among it. They stay on this device,
 * which holds the vault in the clear already, and out of the vault, so
 * that no snapshot, backup or other replica carries a key.
 */

import { base64urlnopad } from "@scure/base";
import type { BlobKey } from "@estoc/agent-core";
import type { JsonValue, LocalOptions } from "@estoc/event-store";

const PREFIX = "daemon.snapshotLink.";

/** What restores a snapshot: where its sealed bytes are read, their name and their key. */
export interface SnapshotLink extends BlobKey {
  url: string;
}

/** A snapshot put, as a view is told of it. Times are milliseconds since the epoch. */
export type PutSnapshot =
  | { status: "pending"; hash: string; placedAt: number; retainUntil: number | null }
  | { status: "published"; hash: string; placedAt: number; retainUntil: number; link: SnapshotLink };

/** One snapshot put, as it stands: answered by the mediator once `placement` is set, linked once its bytes are `uploaded`. */
export interface Put extends BlobKey {
  placedAt: number;
  placement: { url: string; retainUntil: number } | null;
  uploaded: boolean;
}

export const keyText = (key: Uint8Array): string => base64urlnopad.encode(key);

export const keyBytes = (text: string): Uint8Array => base64urlnopad.decode(text);

export function shown({ hash, key, placedAt, placement, uploaded }: Put): PutSnapshot {
  if (placement === null) return { status: "pending", hash, placedAt, retainUntil: null };
  if (!uploaded) return { status: "pending", hash, placedAt, retainUntil: placement.retainUntil };
  return { status: "published", hash, placedAt, retainUntil: placement.retainUntil, link: { url: placement.url, hash, key } };
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A value under the prefix in another shape is none this daemon wrote: no snapshot it can say anything of. */
function putOf(hash: string, value: JsonValue | undefined): Put | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { key, placedAt, url, retainUntil, uploaded } = value;
  if (typeof key !== "string" || !isTime(placedAt) || typeof uploaded !== "boolean") return null;
  let placement: Put["placement"] = null;
  if (url !== null || retainUntil !== null) {
    if (typeof url !== "string" || !isTime(retainUntil)) return null;
    placement = { url, retainUntil };
  }
  try {
    return { hash, key: keyBytes(key), placedAt, placement, uploaded };
  } catch {
    return null;
  }
}

export class SnapshotLinks {
  constructor(private readonly options: LocalOptions) {}

  keep({ hash, key, placedAt, placement, uploaded }: Put): Promise<void> {
    return this.options.set(PREFIX + hash, { key: keyText(key), placedAt, url: placement?.url ?? null, retainUntil: placement?.retainUntil ?? null, uploaded });
  }

  async get(hash: string): Promise<Put | null> {
    return putOf(hash, await this.options.get(PREFIX + hash));
  }

  forget(hash: string): Promise<void> {
    return this.options.delete(PREFIX + hash);
  }

  /** Every snapshot put that the mediator keeps or may keep at `now`, by when it was put. */
  async list(now: number): Promise<Put[]> {
    const puts: Put[] = [];
    for (const name of await this.options.keys()) {
      if (!name.startsWith(PREFIX)) continue;
      const put = await this.get(name.slice(PREFIX.length));
      if (put !== null && !gone(put, now)) puts.push(put);
    }
    return puts.sort((a, b) => a.placedAt - b.placedAt || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  }

  /** Those the mediator has let go of by `now` forgotten, with whatever under the prefix is no snapshot put. */
  async prune(now: number): Promise<void> {
    for (const name of await this.options.keys()) {
      if (!name.startsWith(PREFIX)) continue;
      const put = await this.get(name.slice(PREFIX.length));
      if (put === null || gone(put, now)) await this.options.delete(name);
    }
  }
}

/** A put the mediator answered is kept until the time it said; one it never answered may be held there, for all this runtime knows, until it is revoked. */
const gone = ({ placement }: Put, now: number): boolean => placement !== null && placement.retainUntil <= now;
