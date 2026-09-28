import { describe, expect, it } from "vitest";

import { channelOf as pairOf, type Did } from "@estoc/vault";

import { InvalidChannelId, channelIdOf, channelOf } from "../src/channels.js";

const A = "did:example:alice" as Did;
const B = "did:example:bob" as Did;

describe("a channel ID", () => {
  it("is the canonical text of the pair, and names that pair back", () => {
    const id = channelIdOf(pairOf(A, B));
    expect(id).toBe('["did:example:alice","did:example:bob"]');
    expect(channelOf(id)).toEqual({ localDid: A, peerDid: B });
    expect(channelIdOf(channelOf(id))).toBe(id);
  });

  it("names back whatever pair the daemon published, checked by no more than its text: the vault checks a DID where the pair is used", () => {
    const held = pairOf("did:peer:4zQmAnna" as Did, "did:peer:4zQmBob" as Did);
    expect(channelOf(channelIdOf(held))).toEqual(held);
  });

  it("orders the ends, so the reverse pair is another ID", () => {
    expect(channelOf(channelIdOf(pairOf(B, A)))).toEqual({ localDid: B, peerDid: A });
    expect(channelIdOf(pairOf(B, A))).not.toBe(channelIdOf(pairOf(A, B)));
  });

  it.each([
    ["not JSON", "did:example:alice"],
    ["an object", '{"localDid":"did:example:alice","peerDid":"did:example:bob"}'],
    ["one DID", '["did:example:alice"]'],
    ["three", '["did:example:alice","did:example:bob","did:example:carol"]'],
    ["a number", '["did:example:alice",7]'],
    ["an empty DID", '["","did:example:bob"]'],
    ["the same DID twice", '["did:example:alice","did:example:alice"]'],
    ["another spelling of the same pair", '["did:example:alice", "did:example:bob"]'],
  ])("refuses %s as no channel ID", (_, text) => {
    expect(() => channelOf(text)).toThrow(InvalidChannelId);
    try {
      channelOf(text);
    } catch (err) {
      expect((err as InvalidChannelId).channelId).toBe(text);
    }
  });
});
