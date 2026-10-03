/**
 * What the product does to a contact and its channels on the user's
 * word: the denial of channels, for good, with or without their
 * successors, and the deletion of a contact, whose tombstone takes
 * alongside it the denials and erasures the product chose. Each
 * decision is a pure function of the fold and commits in one batch.
 */

import type { Event, VaultRuntime } from "@estoc/event-store";

import { commitAndCollect, commitDecided, type Committed } from "./commit.js";
import { eraseDrafts } from "./erasure.js";
import type { ScanOptions, VaultFold } from "./fold/vault.js";
import { messageIdsOf } from "./fold/views.js";
import type { Keys } from "./identity.js";
import { channelKey, channelOf, compareChannels, sameChannel } from "./ids.js";
import { vaultDraft, type VaultDraft } from "./schema.js";
import type { Channel, ContactId } from "./types.js";

/** One denial per pair not already denied to at least that extent, in canonical order. */
export function blockDrafts(fold: VaultFold, channels: Iterable<Channel>, includeSuccessors: boolean): VaultDraft<"channel.blocked">[] {
  const distinct = new Map<string, Channel>();
  for (const channel of channels) distinct.set(channelKey(channel), channel);
  const drafts: VaultDraft<"channel.blocked">[] = [];
  for (const channel of [...distinct.values()].sort(compareChannels)) {
    const exact = fold.continuity.blocked(channel).filter((denial) => sameChannel(channelOf(denial.data.localDid, denial.data.peerDid), channel));
    if (exact.some((denial) => denial.data.includeSuccessors || !includeSuccessors)) continue;
    drafts.push(vaultDraft("channel.blocked", { localDid: channel.localDid, peerDid: channel.peerDid, includeSuccessors }));
  }
  return drafts;
}

/** Deny channels for good, with or without their successors. */
export function blockChannels(runtime: VaultRuntime, keys: Keys | null, channels: readonly Channel[], includeSuccessors: boolean, options: ScanOptions = {}): Promise<Event[]> {
  return commitDecided(runtime, keys, options, (fold) => blockDrafts(fold, channels, includeSuccessors));
}

export type DeleteContactOptions = {
  /** deny the contact's selected channels as well, with or without their successors */
  block?: { includeSuccessors: boolean };
  /** erase every message in the selected channels as well, under this reason */
  erase?: string;
};

/**
 * The tombstone, unless one is already there, and what the product
 * chose to do with the concrete selected channels alongside: deny
 * them, erase their messages. Neither reaches the derived history,
 * and a later selection changes neither.
 */
export function deleteContactDrafts(fold: VaultFold, contactId: ContactId, options: DeleteContactOptions = {}): VaultDraft[] {
  const contact = fold.contacts.contacts.get(contactId);
  const drafts: VaultDraft[] = [];
  if (contact === undefined) return drafts;
  if (!contact.deleted) drafts.push(vaultDraft("contact.deleted", { contactId }));
  if (options.block !== undefined) drafts.push(...blockDrafts(fold, contact.channels, options.block.includeSuccessors));
  if (options.erase !== undefined) drafts.push(...eraseDrafts(fold, contact.channels.flatMap((channel) => messageIdsOf(fold.views.channel(channel))), options.erase));
  return drafts;
}

/** Delete a contact, and deny or erase what the product chose, in one commit; then collect, since an erase may release a root. */
export function deleteContact(runtime: VaultRuntime, keys: Keys | null, contactId: ContactId, options: DeleteContactOptions = {}, scan: ScanOptions = {}): Promise<Committed> {
  return commitAndCollect(runtime, keys, scan, (fold) => deleteContactDrafts(fold, contactId, options));
}
