import { describe, expect, it } from "vitest";

import type { ChannelId, ConversationId, Snapshot } from "../../src/contract/index.js";
import { conversationOf, indexSnapshot } from "../../src/views/index.js";
import { as, conversation, headChannel, inbound, oldChannel, outbound, snapshot, unadmitted } from "../contract/fixtures.js";

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("snapshot lookups", () => {
  it("indexes each table by its primary ID, keeping the original records", () => {
    const index = indexSnapshot(freeze(snapshot));
    expect(index.snapshot).toBe(snapshot);
    for (const record of snapshot.mediations) expect(index.mediations.get(record.mediationId)).toBe(record);
    for (const record of snapshot.dids) expect(index.dids.get(record.didId)).toBe(record);
    for (const record of snapshot.contacts) expect(index.contacts.get(record.contactId)).toBe(record);
    for (const record of snapshot.channels) expect(index.channels.get(record.channelId)).toBe(record);
    for (const record of snapshot.messages) expect(index.messages.get(record.messageId)).toBe(record);
    for (const record of snapshot.observations) expect(index.observations.get(record.sourceEventCid)).toBe(record);
    for (const record of snapshot.conversations) expect(index.conversations.get(record.id)).toBe(record);
    for (const record of snapshot.invitations) expect(index.invitations.get(record.disclosureEventCid)).toBe(record);
    expect(index.messages.get(unadmitted.messageId)).toBeUndefined();
    expect(index.messages.size).toBe(snapshot.messages.length);
    expect(conversationOf(index, as("absent"))).toBeNull();
  });

  it("compares opaque IDs without parsing them or using object properties as records", () => {
    const channel = { ...headChannel, channelId: as<ChannelId>("__proto__") };
    const shown = { ...conversation, id: as<ConversationId>("constructor"), channels: [{ channelId: channel.channelId, selected: true }], writeTo: [channel.channelId], defaultWriteTo: channel.channelId };
    const index = indexSnapshot({ ...snapshot, channels: [channel], conversations: [shown] });
    expect(index.channels.get(channel.channelId)).toBe(channel);
    expect(index.channels.get(as("toString"))).toBeUndefined();
    expect(conversationOf(index, shown.id)?.channels[0]?.channel).toBe(channel);
  });

  it("does not retain content or deleted records from a previous snapshot", () => {
    const before = indexSnapshot(snapshot);
    const erased = { ...inbound, body: { state: "erased" } as const, summary: null };
    const after = indexSnapshot({ ...snapshot, messages: [erased], contacts: [], conversations: [] });
    expect(after.messages.get(inbound.messageId)).toBe(erased);
    expect(after.messages.get(outbound.messageId)).toBeUndefined();
    expect(after.contacts.size).toBe(0);
    expect(conversationOf(after, conversation.id)).toBeNull();
    expect(before.messages.get(inbound.messageId)).toBe(inbound);
  });
});

describe("a conversation's records", () => {
  it("joins the contact and selected and derived channels in published order", () => {
    const view = conversationOf(indexSnapshot(freeze(snapshot)), conversation.id)!;
    expect(view.conversation).toBe(conversation);
    expect(view.contact).toBe(snapshot.contacts[0]);
    expect(view.channels.map(({ channel, selected }) => [channel.channelId, selected])).toEqual(conversation.channels.map(({ channelId, selected }) => [channelId, selected]));
    expect(view.channels[0]?.channel).toBe(headChannel);
    expect(view.channels[1]?.channel).toBe(oldChannel);
    expect(view.writeTo).toEqual([headChannel]);
    expect(view.defaultWriteTo).toBe(headChannel);
    expect(view.conversation.claimedName).toBe(conversation.claimedName);
  });

  it("uses message and observation reference lists, preserving bodies, summaries and source attribution", () => {
    const view = conversationOf(indexSnapshot(snapshot), conversation.id)!;
    expect(view.messages).toEqual([inbound, outbound]);
    expect(view.messages[0]).toBe(inbound);
    expect(view.messages[1]?.body).toBe(outbound.body);
    expect(view.unadmitted).toEqual([unadmitted]);
    expect(view.unadmitted[0]).toBe(unadmitted);
    expect(view.messages.some(({ messageId }) => messageId === unadmitted.messageId)).toBe(false);
    expect(view.messages.some(({ channelId }) => channelId === null)).toBe(false);
  });

  it("shares history between conversations without rebuilding membership or filling send choices", () => {
    const nameless = { ...conversation, id: as<ConversationId>("channel:head"), contactId: null, petname: null, claimedName: null, channels: [{ channelId: headChannel.channelId, selected: false }], writeTo: [], defaultWriteTo: null };
    const index = indexSnapshot(freeze({ ...snapshot, conversations: [conversation, nameless] }));
    const named = conversationOf(index, conversation.id)!;
    const other = conversationOf(index, nameless.id)!;
    expect(other.contact).toBeNull();
    expect(other.messages[0]).toBe(named.messages[0]);
    expect(other.channels[0]?.channel).toBe(named.channels[0]?.channel);
    expect(other.conversation.claimedName).toBeNull();
    expect(other.writeTo).toEqual([]);
    expect(other.defaultWriteTo).toBeNull();
  });

  it.each([
    ["contact", { contacts: [] }],
    ["channel", { channels: [] }],
    ["message", { messages: [] }],
    ["observation", { observations: [] }],
    ["channel", { conversations: [{ ...conversation, writeTo: [as<ChannelId>("missing")] }] }],
    ["channel", { conversations: [{ ...conversation, defaultWriteTo: as<ChannelId>("missing") }] }],
  ] satisfies [string, Partial<Snapshot>][])("refuses a dangling %s relationship instead of omitting it", (kind, change) => {
    expect(() => conversationOf(indexSnapshot({ ...snapshot, ...change }), conversation.id)).toThrow(`missing ${kind} record:`);
  });
});
