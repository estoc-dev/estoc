import { describe, expect, it } from "vitest";

import type { ConversationRecord, Snapshot } from "../../src/contract/index.js";
import { successorOf, trailOf } from "../../src/views/index.js";
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

describe("the trail of a conversation", () => {
  const before = withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL)]);

  it("is the vault, the ID and the channels shown, and nothing of the records", () => {
    expect(trailOf(before, as(`channel:${OLD_CHANNEL}`))).toEqual({ anchor: snapshot.anchor, id: `channel:${OLD_CHANNEL}`, channels: [OLD_CHANNEL] });
  });

  it("is null for an ID the snapshot shows no conversation by", () => {
    expect(trailOf(before, as("channel:never"))).toBeNull();
  });
});

describe("the successor of a conversation", () => {
  const before = withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL)]);
  const trail = trailOf(before, as(`channel:${OLD_CHANNEL}`))!;

  it("is the conversation itself while the next snapshot still has its ID", () => {
    const after = withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL), nameless(`channel:${HEAD_CHANNEL}`, HEAD_CHANNEL, OLD_CHANNEL)]);
    expect(successorOf(trail, after)?.id).toBe(`channel:${OLD_CHANNEL}`);
  });

  it("is the one conversation now showing a channel it showed: the group moved under its head, or the contact it was named as", () => {
    const moved = withConversations([nameless(`channel:${HEAD_CHANNEL}`, HEAD_CHANNEL, OLD_CHANNEL)]);
    expect(successorOf(trail, moved)?.id).toBe(`channel:${HEAD_CHANNEL}`);
    const named = withConversations([conversation]);
    expect(successorOf(trail, named)?.id).toBe("contact:c-1");
  });

  it("is null when none shows one, when several do, and when the snapshot is another vault's", () => {
    expect(successorOf(trail, withConversations([nameless(`channel:${NEWER}`, NEWER)]))).toBeNull();
    const split = withConversations([conversation, nameless(`channel:${NEWER}`, NEWER, OLD_CHANNEL)]);
    expect(successorOf(trail, split)).toBeNull();
    expect(successorOf(trail, withConversations([nameless(`channel:${OLD_CHANNEL}`, OLD_CHANNEL)], "did:key:z6MkOther"))).toBeNull();
  });
});
