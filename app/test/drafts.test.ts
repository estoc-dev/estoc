import { beforeEach, describe, expect, it } from "vitest";

import { carryDrafts, draftIn, dropDrafts, moveDraft, writeDraft, writtenDrafts } from "../src/core/drafts.js";
import type { ChannelId, ChannelRecord, DidId, Snapshot } from "../src/core/types.js";

type LocalDid = Snapshot["dids"][number];

const id = <Id extends string>(text: string) => text as Id;
const channel = (channelId: string, localDid: string, headChannelId: string | null = null): ChannelRecord => ({ channelId: id(channelId), localDid, headChannelId: headChannelId === null ? null : id(headChannelId) }) as ChannelRecord;
const entity = (didId: string, did: string | null): LocalDid => ({ didId: id<DidId>(didId), did }) as LocalDid;

const OLD = channel("old", "did:peer:4zLocal", "head");
const HEAD = channel("head", "did:peer:4zLocalNext");
const OTHER = channel("other", "did:peer:4zLocal");
const ours = entity("e-1", "did:peer:4zLocal");
const oursNext = entity("e-2", "did:peer:4zLocalNext");

beforeEach(() => dropDrafts());

describe("a draft", () => {
  it("is held by its channel, and is nothing once emptied", () => {
    writeDraft(OLD, "hello");
    expect(draftIn(id<ChannelId>("old"))?.text).toBe("hello");
    writeDraft(OLD, "");
    expect(draftIn(id<ChannelId>("old"))).toBeNull();
    expect(writtenDrafts()).toEqual([]);
  });

  it("follows its channel to the head, written as the head's own DID", () => {
    writeDraft(OLD, "hello");
    carryDrafts({ dids: [ours, oursNext], channels: [OLD, HEAD] });
    expect(draftIn(id<ChannelId>("old"))).toBeNull();
    expect(draftIn(id<ChannelId>("head"))).toMatchObject({ channelId: "head", localDid: "did:peer:4zLocalNext", text: "hello" });
  });

  it("stays where it is when something is already written at the head", () => {
    writeDraft(OLD, "first");
    writeDraft(HEAD, "second");
    carryDrafts({ dids: [ours, oursNext], channels: [OLD, HEAD] });
    expect(draftIn(id<ChannelId>("old"))?.text).toBe("first");
    expect(draftIn(id<ChannelId>("head"))?.text).toBe("second");
  });

  it("is dropped when its DID is of no entity of the vault", () => {
    writeDraft(OLD, "hello");
    carryDrafts({ dids: [ours], channels: [OLD] });
    expect(draftIn(id<ChannelId>("old"))?.text).toBe("hello");
    carryDrafts({ dids: [entity("e-9", "did:peer:4zStranger")], channels: [] });
    expect(writtenDrafts()).toEqual([]);
  });

  it("stays while the entity that once named its DID is in the vault, even after the vault names no DID for it", () => {
    writeDraft(OLD, "hello");
    carryDrafts({ dids: [ours], channels: [OLD] });
    carryDrafts({ dids: [entity("e-1", null)], channels: [OLD] });
    expect(draftIn(id<ChannelId>("old"))?.text).toBe("hello");
  });

  it("is handed to the channel the person picked, unless something is written there", () => {
    writeDraft(OLD, "hello");
    moveDraft(id<ChannelId>("old"), OTHER);
    expect(draftIn(id<ChannelId>("old"))).toBeNull();
    expect(draftIn(id<ChannelId>("other"))?.text).toBe("hello");
    writeDraft(HEAD, "kept");
    moveDraft(id<ChannelId>("other"), HEAD);
    expect(draftIn(id<ChannelId>("other"))?.text).toBe("hello");
    expect(draftIn(id<ChannelId>("head"))?.text).toBe("kept");
  });
});
