/**
 * The erasure of a message: every root its events and its preparations
 * still retain, released in one erase and collected in the same lock;
 * and the closure that keeps an erasure complete when a later event
 * names roots the erase did not — a later observation's, a preparation
 * made after.
 */

import type { VaultRuntime } from "@estoc/event-store";

import { commitAndCollect, type Committed } from "./commit.js";
import { erased } from "./fold/held.js";
import type { ScanOptions, VaultFold } from "./fold/vault.js";
import type { Keys } from "./identity.js";
import { vaultDraft, type VaultDraft } from "./schema.js";
import type { Cid, MessageId } from "./types.js";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every root the events of each message name, by message ID: what its erasure must release. */
function rootsByMessage(fold: VaultFold): Map<MessageId, Set<Cid>> {
  const roots = new Map<MessageId, Set<Cid>>();
  for (const type of ["message.out", "message.in", "message.prepared"] as const) {
    for (const event of fold.set.of(type)) {
      const named = roots.get(event.data.messageId);
      if (named === undefined) roots.set(event.data.messageId, new Set(event.roots));
      else for (const root of event.roots) named.add(root);
    }
  }
  return roots;
}

function unreleased(fold: VaultFold, roots: Map<MessageId, Set<Cid>>, messageId: MessageId): Cid[] {
  return [...(roots.get(messageId) ?? [])].filter((root) => !erased(fold.erasures, messageId, root)).sort();
}

/** One erase per message that still names a root no erasure of it released, in message order. */
export function eraseDrafts(fold: VaultFold, messageIds: Iterable<MessageId>, because: string): VaultDraft<"message.erased">[] {
  const roots = rootsByMessage(fold);
  const drafts: VaultDraft<"message.erased">[] = [];
  for (const messageId of [...new Set(messageIds)].sort()) {
    const dropCids = unreleased(fold, roots, messageId);
    if (dropCids.length > 0) drafts.push(vaultDraft("message.erased", { messageId, dropCids, because }));
  }
  return drafts;
}

/**
 * The equivalent erase each erased message is owed for roots learned
 * since its erasure, under the reason of the first erasure in
 * canonical order, one erase per message ID.
 */
export function erasureClosure(fold: VaultFold): VaultDraft<"message.erased">[] {
  const because = new Map<MessageId, string>();
  for (const event of fold.set.of("message.erased")) if (!because.has(event.data.messageId)) because.set(event.data.messageId, event.data.because);
  const roots = rootsByMessage(fold);
  const drafts: VaultDraft<"message.erased">[] = [];
  for (const [messageId, reason] of [...because].sort(([a], [b]) => cmp(a, b))) {
    const dropCids = unreleased(fold, roots, messageId);
    if (dropCids.length > 0) drafts.push(vaultDraft("message.erased", { messageId, dropCids, because: reason }));
  }
  return drafts;
}

/** Erase a message: every root its events and its preparations still retain, in one commit, then collect. Nothing left to release commits nothing. */
export function eraseMessage(runtime: VaultRuntime, keys: Keys | null, messageId: MessageId, because = "user", options: ScanOptions = {}): Promise<Committed> {
  return commitAndCollect(runtime, keys, options, (fold) => eraseDrafts(fold, [messageId], because));
}

/** Append the equivalent erases later events made erased messages owed, then collect. */
export function closeErasures(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Committed> {
  return commitAndCollect(runtime, keys, options, erasureClosure);
}
