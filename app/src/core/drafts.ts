import { reactive } from "vue";

import type { ChannelId, ChannelRecord, DidId, Snapshot } from "./types.js";

/**
 * What is being written, held by the channel it is to go out in and
 * never by the conversation on screen. How channels are grouped under
 * contacts is display, and can change with an import; who reads a
 * message is decided by the pair it is sealed for. On its own a draft
 * therefore moves only along verified continuity, to the head its
 * channel leads to; to any other channel only when the person hands it
 * there. It is kept even when no conversation shows its channel any
 * more, so that what was written can still be read and dealt with.
 */
export interface Draft {
  channelId: ChannelId;
  /** the DID of ours the draft is written as, which says whose vault it is of */
  localDid: string;
  text: string;
}

/** A channel as a draft is held by it: the channel's ID, and our end of it. */
export type DraftChannel = Pick<ChannelRecord, "channelId" | "localDid">;

// at most one draft to a channel
const drafts = reactive<Draft[]>([]);

const held = (channelId: ChannelId) => drafts.find((draft) => draft.channelId === channelId) ?? null;

export function draftIn(channelId: ChannelId): Draft | null {
  const draft = held(channelId);
  return draft === null || draft.text === "" ? null : draft;
}

export function writtenDrafts(): Draft[] {
  return drafts.filter((draft) => draft.text !== "");
}

export function writeDraft({ channelId, localDid }: DraftChannel, text: string): void {
  const draft = held(channelId);
  if (draft === null) drafts.push({ channelId, localDid, text });
  else draft.text = text;
}

// only ever into a channel with nothing written in it: what is left there is an emptied draft
function rehome(draft: Draft, { channelId, localDid }: DraftChannel): void {
  const emptied = held(channelId);
  if (emptied !== null) drafts.splice(drafts.indexOf(emptied), 1);
  draft.channelId = channelId;
  draft.localDid = localDid;
}

export function dropDrafts(): void {
  drafts.splice(0);
  created.clear();
}

/** Hand what is written in one channel to another the person picked instead, unless something is written there. */
export function moveDraft(from: ChannelId, to: DraftChannel): void {
  const draft = draftIn(from);
  if (draft !== null && from !== to.channelId && draftIn(to.channelId) === null) rehome(draft, to);
}

// each DID a snapshot has named, under every entity of the vault it was named for
const created = new Map<string, Set<DidId>>();

/**
 * Bring the drafts to a snapshot, before anything shows it.
 *
 * A draft is of the vault that holds the DID it is written as. Which
 * vault a snapshot is of cannot be told from what led up to it: a page
 * cut off from its daemon comes back to whatever vault is there by then,
 * with no word of one forgotten and another made in between. So each
 * snapshot is asked, and a draft written as a DID of no entity of the
 * vault is dropped.
 *
 * It is the entity that is asked for, not the DID. An import can bring a
 * second, different creation of an entity; the vault then names no DID
 * for it and closes its sends, but it is the same vault, and what was
 * being written stays to be read. So a DID is remembered under its
 * entity from when the vault still named it. An import can as well bring
 * another entity that claims the same DID, which the vault faults and
 * goes on naming. Which of the two a draft was written as is not the
 * page's to judge, and a later claim takes nothing from an earlier one:
 * the DID is remembered under each, and its drafts stay while any of
 * them is in the vault. None of them is in another identity's vault. A
 * lock, a reconnection and a withdrawn selection leave the entities, and
 * the drafts; so does a restore of the same identity from a backup that
 * holds the entity.
 *
 * Then each draft follows its channel to the head it now leads to. One
 * whose channel has no single successor stays where it is, and so does
 * one whose head already has something written in it: two drafts are
 * never made one, and neither is dropped for the other. A draft is the
 * same object wherever it is, so a send begun before a move still clears
 * what it sent and nothing else.
 */
export function carryDrafts({ dids, channels }: Pick<Snapshot, "dids" | "channels">): void {
  const entities = new Set(dids.map(({ didId }) => didId));
  for (const [did, named] of created) {
    for (const didId of named) if (!entities.has(didId)) named.delete(didId);
    if (named.size === 0) created.delete(did);
  }
  for (const { did, didId } of dids) {
    if (did !== null) created.set(did, (created.get(did) ?? new Set()).add(didId));
  }
  for (const draft of [...drafts]) if (!created.has(draft.localDid)) drafts.splice(drafts.indexOf(draft), 1);
  const records = new Map(channels.map((record) => [record.channelId, record]));
  for (const draft of writtenDrafts()) {
    const head = records.get(draft.channelId)?.headChannelId ?? null;
    const target = head === null ? undefined : records.get(head);
    if (target !== undefined && head !== draft.channelId && draftIn(target.channelId) === null) rehome(draft, target);
  }
}
