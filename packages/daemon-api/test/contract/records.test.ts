import { describe, expect, it } from "vitest";

import { schemas, type JsonObject } from "../../src/contract/index.js";
import { HEAD_CHANNEL, LOCAL, PEER_HEAD, conversation, headChannel, inbound, linesState, outbound, snapshot, withPath } from "./fixtures.js";

const { snapshot: snapshotSchema, messageRecord, channelRecord, channelId, linesState: linesStateSchema, jsonValue, deliveryOutcome, conversationRecord } = schemas;

describe("the snapshot schema", () => {
  it("accepts a complete snapshot and returns it unchanged", () => {
    expect(snapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("ignores a member it does not know on a record", () => {
    const parsed = snapshotSchema.parse(withPath(snapshot, ["messages", 0, "laterAddition"], "ignored"));
    expect(parsed.messages[0]).toEqual(inbound);
  });

  it("keeps every key of a message body, including ones an unknown member would drop", () => {
    const parsed = messageRecord.parse(inbound);
    expect(parsed.body).toEqual(inbound.body);
  });

  it("keeps a __proto__ key of a message body at every level as data", () => {
    const body = JSON.parse('{"__proto__":{"kept":"outer"},"nested":{"__proto__":{"kept":"inner"}},"constructor":"ordinary"}') as JsonObject;
    const parsed = messageRecord.parse(withPath(inbound, ["body", "body"], body));
    const kept = parsed.body.state === "available" ? parsed.body.body : {};
    expect(kept).toEqual(body);
    expect(Object.hasOwn(kept, "__proto__")).toBe(true);
    expect(Object.hasOwn(kept.nested as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });

  it("rejects a snapshot missing a required list", () => {
    expect(snapshotSchema.safeParse(withPath(snapshot, ["conversations"], undefined)).success).toBe(false);
  });

  it("rejects a non-finite number inside a body", () => {
    expect(messageRecord.safeParse(withPath(inbound, ["body", "body", "n"], NaN)).success).toBe(false);
    expect(messageRecord.safeParse(withPath(inbound, ["body", "body", "n"], Infinity)).success).toBe(false);
  });

  it("reads negative zero as zero", () => {
    expect(Object.is(jsonValue.parse(-0), 0)).toBe(true);
    const parsed = messageRecord.parse(withPath(inbound, ["headers", "createdTime"], -0));
    expect(Object.is(parsed.headers?.createdTime, 0)).toBe(true);
  });

  it("rejects an undefined element in an ID list", () => {
    expect(channelRecord.safeParse(withPath(headChannel, ["messageIds"], ["m-in", undefined])).success).toBe(false);
  });

  it("rejects an empty ID", () => {
    expect(messageRecord.safeParse(withPath(inbound, ["messageId"], "")).success).toBe(false);
  });

  it("rejects a delivery outcome outside the closed union", () => {
    expect(deliveryOutcome.safeParse({ status: "lost" }).success).toBe(false);
    expect(deliveryOutcome.safeParse({ status: "terminal", code: "dropped" }).success).toBe(false);
    expect(deliveryOutcome.safeParse({ status: "conflict" }).success).toBe(false);
  });

  it("requires an input's standing and an output's delivery to be nullable in the other direction", () => {
    expect(messageRecord.safeParse(withPath(outbound, ["delivery"], undefined)).success).toBe(false);
    expect(messageRecord.parse(withPath(outbound, ["input"], null)).input).toBeNull();
  });
});

describe("a channel ID", () => {
  it("is validated as a non-empty string and never taken apart", () => {
    expect(channelId.parse(HEAD_CHANNEL)).toBe(HEAD_CHANNEL);
    expect(channelId.parse("not json at all")).toBe("not json at all");
    expect(channelId.safeParse("").success).toBe(false);
  });

  it("does not accept a pair object in its place", () => {
    expect(channelId.safeParse({ localDid: LOCAL, peerDid: PEER_HEAD }).success).toBe(false);
    expect(channelId.safeParse([LOCAL, PEER_HEAD]).success).toBe(false);
    expect(conversationRecord.safeParse(withPath(conversation, ["writeTo", 0], [LOCAL, PEER_HEAD])).success).toBe(false);
  });
});

describe("the lines schema", () => {
  it("accepts a complete lines state", () => {
    expect(linesStateSchema.parse(linesState)).toEqual(linesState);
  });

  it("rejects a delivery source of an unknown kind", () => {
    expect(linesStateSchema.safeParse(withPath(linesState, ["value", "waiting", 0, "source"], { kind: "relay" })).success).toBe(false);
  });

  it("rejects a negative acknowledgement count", () => {
    expect(linesStateSchema.safeParse(withPath(linesState, ["value", "connections", 0, "drained", "acked"], -1)).success).toBe(false);
  });
});
