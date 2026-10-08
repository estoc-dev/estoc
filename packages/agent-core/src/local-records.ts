/**
 * What this runtime alone knows of delivery: the input its replica left
 * to another replica, the preparation it selected for a message, and a
 * transport acceptance it observed and has not yet recorded. They live
 * in the runtime's local options, which outlive a reopen and every
 * commit and go with no event, snapshot, export or trace, under this
 * replica's ID: a restore or an identity reset mints another and finds
 * none, since another runtime's choice is not known here, and records
 * of an earlier ID are never carried over. Every record goes through
 * this one adapter, which spells the key and checks the value's shape
 * both ways: a value of the wrong shape is refused, a write that could
 * not be made is reported to its caller, and a read that fails, or
 * finds a value of the wrong shape, finds no record. None of them
 * decides whether a call may be made: that is the live action's.
 */

import { canonicalText, isEventCid, isJsonObject, type JsonValue, type LocalOptions, type VaultRuntime } from "@estoc/event-store";
import type { Did, EventReference, ExecutionId, MediationId, MessageId, ReplicaId } from "@estoc/vault";

/** Where the records are kept: the runtime's local options, or anything that reads, writes and deletes JSON by key as they do. */
export type LocalStore = Pick<LocalOptions, "get" | "set" | "delete">;

/** The registration an execution was left to another replica under, that replica answering it. */
export interface LeftTo {
  mediationId: MediationId;
  registrationId: string;
  responderDid: Did;
}

type Preparation = { preparationEventCid: EventReference<"message.prepared"> };

interface Kinds {
  "execution-left": LeftTo;
  "preparation-selected": Preparation;
  "acceptance-owed": Preparation;
}

type Kind = keyof Kinds;

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value !== "";

const SHAPES: { [K in Kind]: Record<keyof Kinds[K], (value: unknown) => boolean> } = {
  "execution-left": { mediationId: nonEmpty, registrationId: nonEmpty, responderDid: nonEmpty },
  "preparation-selected": { preparationEventCid: isEventCid },
  "acceptance-owed": { preparationEventCid: isEventCid },
};

/** The version of the keys below, this adapter's own and independent of the vault's. */
const KEY_VERSION = 1;

function fits(kind: Kind, value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  const shape: Record<string, (value: unknown) => boolean> = SHAPES[kind];
  const members = Object.keys(value);
  return members.length === Object.keys(shape).length && members.every((member) => shape[member]?.(value[member]) === true);
}

export class LocalRecords {
  constructor(
    private readonly store: LocalStore,
    readonly replicaId: ReplicaId
  ) {}

  /** The replica this one left the execution to; null where it left it to none. */
  leftTo(executionId: ExecutionId): Promise<LeftTo | null> {
    return this.read("execution-left", executionId);
  }

  leave(executionId: ExecutionId, to: LeftTo): Promise<void> {
    return this.write("execution-left", executionId, to);
  }

  /** The preparation whose envelope this runtime's calls of the message carry; null while it has selected none. */
  async selected(messageId: MessageId): Promise<EventReference<"message.prepared"> | null> {
    return (await this.read("preparation-selected", messageId))?.preparationEventCid ?? null;
  }

  /** Selects the preparation in place of any selected before. */
  select(messageId: MessageId, preparationEventCid: EventReference<"message.prepared">): Promise<void> {
    return this.write("preparation-selected", messageId, { preparationEventCid });
  }

  /** The preparation whose acceptance this runtime observed and has not yet recorded; null while it owes none. */
  async owedAcceptance(messageId: MessageId): Promise<EventReference<"message.prepared"> | null> {
    return (await this.read("acceptance-owed", messageId))?.preparationEventCid ?? null;
  }

  oweAcceptance(messageId: MessageId, preparationEventCid: EventReference<"message.prepared">): Promise<void> {
    return this.write("acceptance-owed", messageId, { preparationEventCid });
  }

  /** The acceptance owed is recorded as `delivery.submitted`: it is owed no longer. */
  acceptanceRecorded(messageId: MessageId): Promise<void> {
    return this.store.delete(this.key("acceptance-owed", messageId));
  }

  private key(kind: Kind, subjectId: string): string {
    return canonicalText(["agent-core", KEY_VERSION, this.replicaId, kind, subjectId]);
  }

  private async read<K extends Kind>(kind: K, subjectId: string): Promise<Kinds[K] | null> {
    let value: JsonValue | undefined;
    try {
      value = await this.store.get(this.key(kind, subjectId));
    } catch {
      return null;
    }
    return fits(kind, value) ? (value as unknown as Kinds[K]) : null;
  }

  private async write<K extends Kind>(kind: K, subjectId: string, value: Kinds[K]): Promise<void> {
    if (!fits(kind, value)) throw new TypeError(`${JSON.stringify(value)} is no ${kind} record`);
    await this.store.set(this.key(kind, subjectId), { ...value } as unknown as JsonValue);
  }
}

/** Local options kept for as long as the returned object is: what a runtime without its own keeps. */
export function transientOptions(): LocalStore {
  const kept = new Map<string, JsonValue>();
  return {
    get: async (key) => kept.get(key),
    set: async (key, value) => void kept.set(key, value),
    delete: async (key) => void kept.delete(key),
  };
}

const transient = new WeakMap<VaultRuntime, LocalRecords>();

/** `given`, or, left out, records kept in memory for as long as this process holds the runtime. */
export function localRecordsOf(runtime: VaultRuntime, given: LocalRecords | undefined): LocalRecords {
  if (given !== undefined) return given;
  let records = transient.get(runtime);
  if (records === undefined) transient.set(runtime, (records = new LocalRecords(transientOptions(), runtime.author)));
  return records;
}
