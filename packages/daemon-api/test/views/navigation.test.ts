import { describe, expect, it } from "vitest";

import type { ChannelId, ConversationId, ConversationRecord } from "../../src/contract/index.js";
import { successorOf } from "../../src/views/index.js";
import { as, conversation, HEAD_CHANNEL, OLD_CHANNEL, snapshot } from "../contract/fixtures.js";

const renamed: ConversationRecord = { ...conversation, id: as("contact:named"), channels: [{ channelId: OLD_CHANNEL, selected: false }] };
const next = (...conversations: ConversationRecord[]) => ({ ...snapshot, conversations });

describe("following a conversation", () => {
  it("follows a sole overlap through derived history, returning the new record", () => {
    expect(successorOf(snapshot, next(renamed), conversation.id)).toBe(renamed);
  });

  it("counts a conversation once even when it shares several channels", () => {
    const moved = { ...conversation, id: as<ConversationId>("channel:new-head") };
    expect(successorOf(snapshot, next(moved), conversation.id)).toBe(moved);
  });

  it("follows either old conversation when both merge into one", () => {
    const other = { ...renamed, id: as<ConversationId>("contact:other") };
    const before = next(conversation, other);
    expect(successorOf(before, next(renamed), conversation.id)).toBe(renamed);
    expect(successorOf(before, next(renamed), other.id)).toBe(renamed);
  });

  it("returns null when history splits across conversations or is shared by several", () => {
    const headOnly = { ...conversation, id: as<ConversationId>("contact:head"), channels: [{ channelId: HEAD_CHANNEL, selected: true }] };
    expect(successorOf(snapshot, next(renamed, headOnly), conversation.id)).toBeNull();
    expect(successorOf(snapshot, next(headOnly, renamed), conversation.id)).toBeNull();
    expect(successorOf(snapshot, next(renamed, { ...renamed, id: as("contact:also") }), conversation.id)).toBeNull();
  });

  it("does not use a surviving ID to choose between overlaps; the caller retains that ID first", () => {
    expect(successorOf(snapshot, snapshot, conversation.id)).toBe(conversation);
    expect(successorOf(snapshot, next(conversation, renamed), conversation.id)).toBeNull();
  });

  it("never follows across vault anchors, even with identical IDs and channels", () => {
    expect(successorOf(snapshot, { ...snapshot, anchor: "did:key:another-vault" }, conversation.id)).toBeNull();
  });

  it("returns null for a missing old conversation, empty channel set, or no overlap", () => {
    expect(successorOf(snapshot, snapshot, as("unknown"))).toBeNull();
    expect(successorOf(next({ ...conversation, channels: [] }), snapshot, conversation.id)).toBeNull();
    expect(successorOf(snapshot, next(), conversation.id)).toBeNull();
    expect(successorOf(snapshot, next({ ...renamed, channels: [{ channelId: as("unrelated"), selected: true }] }), conversation.id)).toBeNull();
  });

  it("does not infer overlap from endpoints, heads, contacts or send choices", () => {
    const unrelated = { ...conversation, channels: [{ channelId: as<ChannelId>("different-opaque-id"), selected: true }] };
    expect(successorOf(snapshot, next(unrelated), conversation.id)).toBeNull();
  });
});
