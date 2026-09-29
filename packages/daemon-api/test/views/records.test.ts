import { describe, expect, it } from "vitest";

import type { ConversationRecord } from "../../src/contract/index.js";
import { indexSnapshot } from "../../src/views/index.js";
import { HEAD_CHANNEL, OLD_CHANNEL, as, conversation, inbound, outbound, snapshot, unadmitted, withPath } from "../contract/fixtures.js";

describe("a snapshot indexed", () => {
  const index = indexSnapshot(snapshot);

  it("answers each table by its ID, and null for an ID it has no record of", () => {
    expect(index.channel(HEAD_CHANNEL)?.peerDid).toBe("did:peer:4zQmPeerHead");
    expect(index.message(as("m-out"))).toBe(outbound);
    expect(index.observation(as("bafyobs2"))).toBe(unadmitted);
    expect(index.contact(as("c-1"))?.origin).toBe("user");
    expect(index.channel(as("[\"nobody\",\"nowhere\"]"))).toBeNull();
    expect(index.message(as("m-none"))).toBeNull();
    expect(index.observation(as("bafynone"))).toBeNull();
    expect(index.contact(as("c-none"))).toBeNull();
  });

  it("assembles a conversation from the records its projection names, in the projection's order, with the record's own fields kept", () => {
    const [shown] = index.conversations;
    expect(shown).toBe(index.conversation(as("contact:c-1")));
    expect(shown).toBe(index.contactConversation(as("c-1")));
    expect(shown).toMatchObject({ id: "contact:c-1", contactId: "c-1", petname: "Ada", claimedName: { name: "Ada", messageId: "m-in" }, writeTo: [HEAD_CHANNEL], defaultWriteTo: HEAD_CHANNEL, diagnostics: [] });
    expect(shown!.channels.map(({ channelId, selected, superseded }) => [channelId, selected, superseded])).toEqual([
      [HEAD_CHANNEL, true, false],
      [OLD_CHANNEL, false, true],
    ]);
    expect(shown!.messages).toEqual([inbound, outbound]);
    expect(shown!.unadmitted).toEqual([unadmitted]);
    expect(shown).not.toHaveProperty("messageIds");
    expect(shown).not.toHaveProperty("unadmittedObservationIds");
    expect(index.conversation(as("channel:none"))).toBeNull();
    expect(index.contactConversation(as("c-none"))).toBeNull();
  });

  it("refuses a snapshot whose conversation names a record it does not hold", () => {
    expect(() => indexSnapshot(withPath(snapshot, ["conversations", 0, "messageIds", 1], "m-gone"))).toThrow("names message m-gone");
    expect(() => indexSnapshot(withPath(snapshot, ["conversations", 0, "channels", 0, "channelId"], "[\"a\",\"b\"]"))).toThrow('names channel ["a","b"]');
    expect(() => indexSnapshot(withPath(snapshot, ["conversations", 0, "unadmittedObservationIds", 0], "bafygone"))).toThrow("names observation bafygone");
  });

  it("reads a conversation record with no channel, message or observation as an empty view", () => {
    const bare: ConversationRecord = { ...conversation, id: as("channel:bare"), contactId: null, petname: null, claimedName: null, channels: [], writeTo: [], defaultWriteTo: null, messageIds: [], unadmittedObservationIds: [] };
    const [, shown] = indexSnapshot({ ...snapshot, conversations: [conversation, bare] }).conversations;
    expect(shown).toEqual({ id: "channel:bare", contactId: null, petname: null, claimedName: null, channels: [], writeTo: [], defaultWriteTo: null, messages: [], unadmitted: [], diagnostics: [] });
  });
});
