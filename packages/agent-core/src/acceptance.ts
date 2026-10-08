/**
 * An acceptance the wire gave, on its way into the vault. The call
 * happened whatever becomes of the commit meant to record it, so the
 * acceptance is kept as owed in the runtime's local records before
 * that commit and dropped once the commit is durable. While it is owed
 * it is recorded before anything else is done with its message — no
 * other call, no cancellation, no expired failure in its place — and an
 * open records every one it finds, calling nothing. An acceptance that
 * could be neither kept nor recorded leaves the outcome unknown: the
 * message shows as prepared, and only a manual retry may carry the same
 * envelope again.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { VaultEventSet, readVaultEvent, scanVault, vaultDraft, type EventReference, type Keys, type MessageId, type VaultEvent } from "@estoc/vault";

import type { LocalRecords } from "./local-records.js";
import { note, type AgentTrace } from "./trace.js";

/** `delivery.submitted` for the preparation whose envelope the wire accepted, owed until it is committed; one already recording it is returned instead of being repeated. */
export async function recordAcceptance(runtime: VaultRuntime, local: LocalRecords, messageId: MessageId, preparationEventCid: EventReference<"message.prepared">, trace: AgentTrace | null = null): Promise<VaultEvent<"delivery.submitted">> {
  try {
    await local.oweAcceptance(messageId, preparationEventCid);
  } catch (err) {
    await note(trace, { stream: "diag", what: "delivery", data: { messageId, preparationEventCid, reason: `the acceptance could not be kept as owed: ${err instanceof Error ? err.message : String(err)}` } });
  }
  return committed(runtime, local, messageId, preparationEventCid);
}

/** The acceptance of a preparation of `messageId` this runtime owes, recorded now; null when it owes none. */
export async function recordOwedAcceptance(runtime: VaultRuntime, local: LocalRecords, messageId: MessageId): Promise<VaultEvent<"delivery.submitted"> | null> {
  const preparationEventCid = await local.owedAcceptance(messageId);
  return preparationEventCid === null ? null : committed(runtime, local, messageId, preparationEventCid);
}

/** Every acceptance owed for a message prepared here and not submitted, recorded, as an open does; nothing is called. */
export async function recordAcceptancesOwed(runtime: VaultRuntime, keys: Keys, local: LocalRecords): Promise<VaultEvent<"delivery.submitted">[]> {
  const fold = await scanVault(runtime.vault, keys);
  const recorded: VaultEvent<"delivery.submitted">[] = [];
  for (const outbound of fold.outbound.outbounds.values()) {
    if (outbound.submitted || outbound.preparations.length === 0) continue;
    const event = await recordOwedAcceptance(runtime, local, outbound.messageId);
    if (event !== null) recorded.push(event);
  }
  return recorded;
}

/** A record left owed after its commit is found recorded by the next look, and dropped then. */
async function committed(runtime: VaultRuntime, local: LocalRecords, messageId: MessageId, preparationEventCid: EventReference<"message.prepared">): Promise<VaultEvent<"delivery.submitted">> {
  const recorded = await runtime.locked(async (held) => {
    const set = await VaultEventSet.from(held.events.scan());
    const existing = set.of("delivery.submitted").find((event) => event.data.messageId === messageId && event.data.preparationEventCid === preparationEventCid);
    if (existing !== undefined) return existing;
    const [event] = (await held.commit([], [vaultDraft("delivery.submitted", { messageId, preparationEventCid })])).map(readVaultEvent);
    return event as VaultEvent<"delivery.submitted">;
  });
  await local.acceptanceRecorded(messageId).catch(() => undefined);
  return recorded;
}
