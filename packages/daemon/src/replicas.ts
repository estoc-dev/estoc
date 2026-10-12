/**
 * What this runtime keeps of the vault's other replicas: the mediator's
 * last listing of an arrangement's replicas, the last history sent to
 * each, and the last history received. Each is this runtime's own to
 * know, so it is kept in its local options and never in the vault,
 * which every replica shares. Times are milliseconds since the epoch.
 */

import type { ListedReplica } from "@estoc/agent-core";
import type { DisplayTime, HistoryReceived, ReplicaListing } from "@estoc/daemon-api/contract";
import { isAuthorId, type JsonObject, type JsonValue, type LocalOptions } from "@estoc/event-store";
import type { MediationId, ReplicaId } from "@estoc/vault";

import type { Merged } from "./api.js";

const LISTING = "daemon.replicas.";
const SENT = "daemon.historySent.";
const RECEIVED = "daemon.historyReceived";

/** The last history sent a replica, and why it did not go when it did not. */
export type Sent = { at: number; outcome: "sent" } | { at: number; outcome: "failed"; because: string };

/** How the import of history another replica sent went, or that it is going. */
export type Imported = { status: "importing" } | { status: "imported"; merged: Merged } | { status: "failed"; because: string };

/** History another replica sent: which, when it came, and its import. */
export type Received = { from: ReplicaId; at: number } & Imported;

interface Listed {
  replicaId: ReplicaId;
  did: string;
  state: "active" | "removed";
  addedAt: number | null;
  removedAt: number | null;
}

/** A time the mediator gave in seconds, in milliseconds; null where it names no instant a date can hold. */
function instantOf(seconds: number | null): number | null {
  if (seconds === null) return null;
  const ms = seconds * 1000;
  return Number.isSafeInteger(ms) && !Number.isNaN(new Date(ms).getTime()) ? ms : null;
}

const timeOf = (ms: number): DisplayTime => new Date(ms).toISOString() as DisplayTime;

const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && !Number.isNaN(new Date(value).getTime());

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const timeOrNull = (value: unknown): number | null | undefined => (value === null ? null : isTime(value) ? value : undefined);

/** Each of these reads a value under its key in the shape this daemon writes it, and null in any other: nothing it can say anything of. */
function listedOf(value: JsonValue): Listed | null {
  if (!isObject(value)) return null;
  const { replicaId, did, state, addedAt, removedAt } = value;
  const added = timeOrNull(addedAt);
  const removed = timeOrNull(removedAt);
  if (!isAuthorId(replicaId) || typeof did !== "string" || (state !== "active" && state !== "removed") || added === undefined || removed === undefined) return null;
  return { replicaId, did, state, addedAt: added, removedAt: removed };
}

function sentOf(value: JsonValue | undefined): Sent | null {
  if (!isObject(value) || !isTime(value.at)) return null;
  if (value.outcome === "sent") return { at: value.at, outcome: "sent" };
  return value.outcome === "failed" && typeof value.because === "string" ? { at: value.at, outcome: "failed", because: value.because } : null;
}

function mergedOf(value: JsonValue | undefined): Merged | null {
  if (!isObject(value)) return null;
  const { added, duplicates, objects, repaired, renewed } = value;
  return isCount(added) && isCount(duplicates) && isCount(objects) && isCount(repaired) && typeof renewed === "boolean" ? { added, duplicates, objects, repaired, renewed } : null;
}

function receivedOf(value: JsonValue | undefined): Received | null {
  if (!isObject(value) || !isAuthorId(value.from) || !isTime(value.at)) return null;
  const { from, at, status } = value;
  if (status === "importing") return { from, at, status };
  if (status === "failed") return typeof value.because === "string" ? { from, at, status, because: value.because } : null;
  const merged = status === "imported" ? mergedOf(value.merged) : null;
  return merged === null ? null : { from, at, status: "imported", merged };
}

export class ReplicaRecords {
  constructor(private readonly options: LocalOptions) {}

  keepListing(mediationId: MediationId, listedAt: number, replicas: readonly ListedReplica[]): Promise<void> {
    const listed = replicas.map(({ replicaId, did, state, addedTime, removedTime }) => ({ replicaId, did, state, addedAt: instantOf(addedTime), removedAt: instantOf(removedTime) }));
    return this.options.set(LISTING + mediationId, { listedAt, replicas: listed });
  }

  keepSent(replicaId: ReplicaId, sent: Sent): Promise<void> {
    return this.options.set(SENT + replicaId, sent);
  }

  keepReceived({ from, at, ...imported }: Received): Promise<void> {
    return this.options.set(RECEIVED, { from, at, ...(imported.status === "imported" ? { status: imported.status, merged: { ...imported.merged } } : imported) });
  }

  /** The last listing of the arrangement's replicas, `self` on the one `author` names, as a view is shown it. */
  async listing(mediationId: MediationId, author: ReplicaId): Promise<ReplicaListing | null> {
    const kept = await this.options.get(LISTING + mediationId);
    if (!isObject(kept) || !isTime(kept.listedAt) || !Array.isArray(kept.replicas)) return null;
    const replicas = [];
    for (const replica of kept.replicas) {
      const listed = listedOf(replica);
      if (listed === null) continue;
      const sent = sentOf(await this.options.get(SENT + listed.replicaId));
      replicas.push({
        replicaId: listed.replicaId as string as ReplicaListing["replicas"][number]["replicaId"],
        did: listed.did,
        self: listed.replicaId === author,
        state: listed.state,
        addedAt: listed.addedAt === null ? null : timeOf(listed.addedAt),
        removedAt: listed.removedAt === null ? null : timeOf(listed.removedAt),
        sent: sent === null ? null : { ...sent, at: timeOf(sent.at) },
      });
    }
    return { listedAt: timeOf(kept.listedAt), replicas };
  }

  /** The last history received, as a view is shown it. */
  async received(): Promise<HistoryReceived | null> {
    const received = receivedOf(await this.options.get(RECEIVED));
    if (received === null) return null;
    return { ...received, from: received.from as string as HistoryReceived["from"], at: timeOf(received.at) };
  }
}
