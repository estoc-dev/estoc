/**
 * What this runtime keeps of the vault's other replicas: the mediator's
 * last listing of an arrangement's replicas, the last history sent to
 * each, and the last history received. Each is this runtime's own to
 * know, so it is kept in its local options and never in the vault,
 * which every replica shares. Times are kept in milliseconds since the
 * epoch; one a view cannot be shown, a year of more than four digits as
 * JavaScript dates allow, reads as none.
 */

import type { ListedReplica } from "@estoc/agent-core";
import { schemas, type DisplayTime, type HistoryReceived, type HistorySent, type Hold, type ReplicaListing, type ReplicaRecord } from "@estoc/daemon-api/contract";
import { isAuthorId, type JsonObject, type JsonValue, type LocalOptions } from "@estoc/event-store";
import type { MediationId, ReplicaId } from "@estoc/vault";

import type { Merged } from "./api.js";

const LISTING = "daemon.replicas.";
const SENT = "daemon.historySent.";
const RECEIVED = "daemon.historyReceived";

const CUT_SHORT = "the daemon stopped before the import was over";

export type Sent = { at: number; outcome: "sent" } | { at: number; outcome: "failed"; because: string };

export type Ended = { status: "imported"; merged: Merged } | { status: "failed"; because: string };

type Imported = { status: "importing" } | Ended;

function displayTimeOf(ms: number): DisplayTime | null {
  if (!Number.isSafeInteger(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const text = date.toISOString();
  return schemas.isDisplayTime(text) ? text : null;
}

const timeIn = (value: JsonValue | undefined): DisplayTime | null => (typeof value === "number" ? displayTimeOf(value) : null);

/** A time the mediator gave in seconds, in milliseconds. */
function instantOf(seconds: number | null): number | null {
  if (seconds === null) return null;
  const ms = seconds * 1000;
  return displayTimeOf(ms) === null ? null : ms;
}

const isObject = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const apiReplicaId = (replicaId: ReplicaId): ReplicaRecord["replicaId"] => replicaId as string as ReplicaRecord["replicaId"];

// Each of these reads a value in the shape this daemon writes it, and null in any other: nothing it can say anything of.

function listedOf(value: JsonValue, author: ReplicaId): Omit<ReplicaRecord, "sent"> | null {
  if (!isObject(value)) return null;
  const { replicaId, did, state } = value;
  if (!isAuthorId(replicaId) || typeof did !== "string" || (state !== "active" && state !== "removed")) return null;
  return { replicaId: apiReplicaId(replicaId), did, self: replicaId === author, state, addedAt: timeIn(value.addedAt), removedAt: timeIn(value.removedAt) };
}

function sentOf(value: JsonValue | undefined): HistorySent | null {
  const at = isObject(value) ? timeIn(value.at) : null;
  if (!isObject(value) || at === null) return null;
  if (value.outcome === "sent") return { at, outcome: "sent" };
  return value.outcome === "failed" && typeof value.because === "string" ? { at, outcome: "failed", because: value.because } : null;
}

function mergedOf(value: JsonValue | undefined): Merged | null {
  if (!isObject(value)) return null;
  const { added, duplicates, objects, repaired, renewed } = value;
  return isCount(added) && isCount(duplicates) && isCount(objects) && isCount(repaired) && typeof renewed === "boolean" ? { added, duplicates, objects, repaired, renewed } : null;
}

function receivedOf(value: JsonValue | undefined): HistoryReceived | null {
  const at = isObject(value) ? timeIn(value.at) : null;
  if (!isObject(value) || at === null || !isAuthorId(value.from)) return null;
  const { status } = value;
  const from = apiReplicaId(value.from);
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

  keepReceived(from: ReplicaId, at: number, imported: Imported): Promise<void> {
    return this.options.set(RECEIVED, { from, at, ...(imported.status === "imported" ? { status: imported.status, merged: { ...imported.merged } } : imported) });
  }

  /** A receipt kept as importing turned into a failure: nothing here imports it any more. */
  async cutShort(): Promise<void> {
    const kept = await this.options.get(RECEIVED);
    if (isObject(kept) && kept.status === "importing") await this.options.set(RECEIVED, { ...kept, status: "failed", because: CUT_SHORT });
  }

  /** The last listing of the arrangement's replicas, `self` on the one `author` names. */
  async listing(mediationId: MediationId, author: ReplicaId): Promise<ReplicaListing | null> {
    const kept = await this.options.get(LISTING + mediationId);
    const listedAt = isObject(kept) ? timeIn(kept.listedAt) : null;
    if (!isObject(kept) || listedAt === null || !Array.isArray(kept.replicas)) return null;
    const replicas: ReplicaRecord[] = [];
    for (const replica of kept.replicas) {
      const listed = listedOf(replica, author);
      if (listed !== null) replicas.push({ ...listed, sent: sentOf(await this.options.get(SENT + listed.replicaId)) });
    }
    return { listedAt, replicas };
  }

  async received(): Promise<HistoryReceived | null> {
    return receivedOf(await this.options.get(RECEIVED));
  }
}

/** History another replica sent, its import under way until it ends. */
export interface Receipt {
  /** How the import ended; false where a receipt begun later is shown in this one's place, and this end is written nowhere. */
  end(ended: Ended): boolean;
}

interface Begun {
  hold: Hold;
  from: ReplicaId;
  at: number;
  imported: Imported;
  kept: Imported | null;
}

/**
 * The history received into a vault file, one receipt after another.
 * The record shows the receipt begun last: one begun earlier still
 * merges what it brings when it ends after it, as merges are unions,
 * and is not shown over it. A receipt's import is written while the
 * vault is open, or once it opens again where it ended while the vault
 * was locked; a record showing an import under way that no receipt
 * here stands behind, as a daemon that stopped in the middle leaves it,
 * is written as failed. A write may hit a runtime being closed, so
 * whoever keeps the receipts makes each write in turn with whatever
 * opens or closes the vault.
 */
export class Receipts {
  #shown: Begun | null = null;

  /** History from `from` received into the vault file `hold` names, shown from now on. */
  begin(hold: Hold, from: ReplicaId): Receipt {
    const begun: Begun = { hold, from, at: Date.now(), imported: { status: "importing" }, kept: null };
    this.#shown = begun;
    return {
      end: (ended) => {
        begun.imported = ended;
        return this.#shown === begun;
      },
    };
  }

  /** What the receipt shown came to, written into `options`, those of the vault file `hold` names, where it is not written yet. */
  async keep(hold: Hold, options: LocalOptions): Promise<void> {
    const records = new ReplicaRecords(options);
    const shown = this.#shown;
    if (shown === null || shown.hold !== hold) return records.cutShort();
    const { from, at, imported } = shown;
    if (shown.kept === imported) return;
    await records.keepReceived(from, at, imported);
    shown.kept = imported;
  }
}
