import { describe, expect, it } from "vitest";

import type { ConversationRecord, Snapshot } from "../../src/contract/index.js";
import { successorOf } from "../../src/views/index.js";
import { HEAD_CHANNEL, LOCAL, OLD_CHANNEL, as, channelId, conversation, snapshot } from "../contract/fixtures.js";

const NEWER = channelId(LOCAL, "did:peer:4zQmPeerNewer");

const nameless = (id: string, ...channelIds: ConversationRecord["channels"][number]["channelId"][]): ConversationRecord => ({
  ...conversation,
  id: as(id),
  contactId: null,
  petname: null,
  channels: channelIds.map((channelId) => ({ channelId, selected: false })),
  writeTo: [],
  defaultWriteTo: null,
});

const withConversations = (conversations: ConversationRecord[], anchor = snapshot.anchor): Snapshot => ({ ...snapshot, anchor, conversations });

describe("the successor of a conversation", () => {
  const before = withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL)]);

  it("is the conversation itself while the next snapshot still has its ID", () => {
    const after = withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL), nameless(`channel:${HEAD_CHANNEL}`, HEAD_CHANNEL, OLD_CHANNEL)]);
    expect(successorOf(before, after, as(`channel:${OLD_CHANNEL}`))?.id).toBe(`channel:${OLD_CHANNEL}`);
  });

  it("is the one conversation now showing a channel it showed: the group moved under its head, or the contact it was named as", () => {
    const moved = withConversations([nameless(`channel:${HEAD_CHANNEL}`, HEAD_CHANNEL, OLD_CHANNEL)]);
    expect(successorOf(before, moved, as(`channel:${OLD_CHANNEL}`))?.id).toBe(`channel:${HEAD_CHANNEL}`);
    const named = withConversations([conversation]);
    expect(successorOf(before, named, as(`channel:${OLD_CHANNEL}`))?.id).toBe("contact:c-1");
  });

  it("is null when none shows one, when several do, when the old ID was never a conversation, and when the snapshots are of different vaults", () => {
    expect(successorOf(before, withConversations([nameless(`channel:${NEWER}`, NEWER)]), as(`channel:${OLD_CHANNEL}`))).toBeNull();
    const split = withConversations([conversation, nameless(`channel:${NEWER}`, NEWER, OLD_CHANNEL)]);
    expect(successorOf(before, split, as(`channel:${OLD_CHANNEL}`))).toBeNull();
    expect(successorOf(before, withConversations([conversation]), as("channel:never"))).toBeNull();
    expect(successorOf(before, withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL)], "did:key:z6MkOther"), as(`channel:${OLD_CHANNEL}`))).toBeNull();
  });
});
