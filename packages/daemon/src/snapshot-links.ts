/**
 * The snapshots this runtime put at its mediator, each kept under a
 * local option of its own until it is revoked or the mediator lets it
 * go: what its link needs, the key among it. They stay on this device,
 * which holds the vault in the clear already, and out of the vault, so
 * that no snapshot, backup or other replica carries a key.
 */

import { base64urlnopad } from "@scure/base";
import type { BlobKey } from "@estoc/agent-core";
import { isAuthorId, type AuthorId, type JsonValue, type LocalOptions } from "@estoc/event-store";
import type { MediationId } from "@estoc/vault";

const PREFIX = "daemon.snapshotLink.";

/** What restores a snapshot: where its sealed bytes are read, their name and their key. */
export interface SnapshotLink extends BlobKey {
  url: string;
}

/** A snapshot put, as a view is told of it. Times are milliseconds since the epoch. */
export type PutSnapshot =
  | { status: "pending"; hash: string; placedAt: number; retainUntil: number | null }
  | { status: "published"; hash: string; placedAt: number; retainUntil: number; revocable: boolean; link: SnapshotLink };

/** Whose blob a put is at the mediator: the replica this runtime was under `author`, in the arrangement `mediationId`. Only that replica may delete it there. */
interface Owner {
  author: AuthorId;
  mediationId: MediationId;
}

interface Asked extends BlobKey {
  owner: Owner;
  placedAt: number;
}

interface Placed extends Asked {
  url: string;
  retainUntil: number;
}

type Uploaded = Placed & { stage: "uploaded" };

/** One snapshot put, as far as it got: asked of the mediator, placed where its answer said, or uploaded there and linked. */
export type Put = (Asked & { stage: "asked" }) | (Placed & { stage: "placed" }) | Uploaded;

export type PublishedSnapshot = Extract<PutSnapshot, { status: "published" }>;

export const keyText = (key: Uint8Array): string => base64urlnopad.encode(key);

export const keyBytes = (text: string): Uint8Array => base64urlnopad.decode(text);

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A value under the prefix in another shape is none this daemon wrote: no snapshot it can say anything of. */
function putOf(hash: string, value: JsonValue | undefined): Put | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { key, placedAt, author, mediationId, stage, url, retainUntil } = value;
  if (typeof key !== "string" || !isTime(placedAt) || !isAuthorId(author) || typeof mediationId !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = keyBytes(key);
  } catch {
    return null;
  }
  const asked: Asked = { hash, key: bytes, owner: { author, mediationId: mediationId as MediationId }, placedAt };
  if (stage === "asked") return { ...asked, stage };
  if ((stage === "placed" || stage === "uploaded") && typeof url === "string" && isTime(retainUntil)) return { ...asked, stage, url, retainUntil };
  return null;
}

export class SnapshotLinks {
  constructor(
    private readonly options: LocalOptions,
    private readonly currentAuthor: AuthorId
  ) {}

  keep(put: Put): Promise<void> {
    const { hash, key, owner, placedAt, stage } = put;
    const asked = { key: keyText(key), placedAt, author: owner.author, mediationId: owner.mediationId, stage };
    return this.options.set(PREFIX + hash, stage === "asked" ? asked : { ...asked, url: put.url, retainUntil: put.retainUntil });
  }

  async get(hash: string): Promise<Put | null> {
    return putOf(hash, await this.options.get(PREFIX + hash));
  }

  forget(hash: string): Promise<void> {
    return this.options.delete(PREFIX + hash);
  }

  /** Whether this runtime is the replica that put it. */
  owns(put: Put): boolean {
    return put.owner.author === this.currentAuthor;
  }

  published(put: Uploaded): PublishedSnapshot {
    const { hash, key, placedAt, url, retainUntil } = put;
    return { status: "published", hash, placedAt, retainUntil, revocable: this.owns(put), link: { url, hash, key } };
  }

  private shown(put: Put): PutSnapshot {
    if (put.stage === "uploaded") return this.published(put);
    return { status: "pending", hash: put.hash, placedAt: put.placedAt, retainUntil: put.stage === "asked" ? null : put.retainUntil };
  }

  /** Every snapshot put that the mediator keeps or may keep at `now`, and that still matters to someone here, by when it was put. */
  async list(now: number): Promise<PutSnapshot[]> {
    const puts: Put[] = [];
    for (const name of await this.options.keys()) {
      if (!name.startsWith(PREFIX)) continue;
      const put = await this.get(name.slice(PREFIX.length));
      if (put !== null && !this.gone(put, now)) puts.push(put);
    }
    return puts.sort((a, b) => a.placedAt - b.placedAt || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)).map((put) => this.shown(put));
  }

  /** Those gone by `now` forgotten, with whatever under the prefix is no snapshot put. */
  async prune(now: number): Promise<void> {
    for (const name of await this.options.keys()) {
      if (!name.startsWith(PREFIX)) continue;
      const put = await this.get(name.slice(PREFIX.length));
      if (put === null || this.gone(put, now)) await this.options.delete(name);
    }
  }

  /**
   * A put the mediator answered is kept there until the time it said;
   * one it never answered may be held, for all this runtime knows,
   * until it is revoked. One put under a replica ID this runtime has
   * given up since, and never uploaded, matters to no one: nothing here
   * can revoke it, and its key went to no one.
   */
  private gone(put: Put, now: number): boolean {
    if (put.stage !== "uploaded" && !this.owns(put)) return true;
    return put.stage !== "asked" && put.retainUntil <= now;
  }
}
