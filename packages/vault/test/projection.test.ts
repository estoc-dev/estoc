import { canonicalize } from "@estoc/event-store";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  InvalidPlaintext,
  PLAINTEXT_TYP,
  RESERVED_HEADERS,
  SELF,
  checkHeaders,
  intentOf,
  intentOfInbound,
  intentOfOutbound,
  intentProjection,
  plaintextCidOf,
  rawCidOfBytes,
  readPlaintext,
  replyThread,
  requestsAck,
  storeMessage,
  wirePlaintext,
  type Cid,
  type ControlHeaders,
  type Did,
  type EnvelopeCid,
  type IntentCid,
  type MessageIn,
  type MessageOut,
  type PlaintextCid,
} from "../src/index.js";

const cidOf = (value: unknown) => rawCidOfBytes(canonicalize(value));
const without = <T extends object>(value: T, ...members: (keyof T)[]): Partial<T> => Object.fromEntries(Object.entries(value).filter(([k]) => !members.includes(k as keyof T))) as Partial<T>;
const PHOTO = Uint8Array.from([1, 2, 3, 4]);
const ALICE = "did:peer:4zQmAlice" as Did;
const BOB = "did:web:bob.example" as Did;
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6ZXhhbXBsZTphIn0.c2ln";

const PLAINTEXT = {
  typ: PLAINTEXT_TYP,
  id: "019b2a70-f225-721c-835f-67175be0667e",
  type: "https://didcomm.org/basicmessage/2.0/message",
  from: BOB,
  to: [ALICE],
  thid: "t1",
  created_time: 1788442800,
  expires_time: 1788446400,
  please_ack: ["", "older", ""],
  ack: ["x", "x", "y"],
  from_prior: JWT,
  lang: "en",
  body: { content: "hello" },
  attachments: [{ id: "a1", media_type: "image/png", data: { base64: base64urlnopad.encode(PHOTO) } }],
};

const CONTROL: ControlHeaders = {
  type: PLAINTEXT.type,
  thid: "t1",
  pthid: null,
  createdTime: 1788442800,
  expiresTime: 1788446400,
  pleaseAck: ["", "older", ""],
  ack: ["x", "x", "y"],
  headers: { lang: "en" },
};

describe("readPlaintext", () => {
  it("takes a plaintext apart into its headers as spelled, its intent, stored content and addressing", () => {
    const read = readPlaintext(PLAINTEXT);
    const stored = storeMessage(PLAINTEXT.body, PLAINTEXT.attachments);
    expect(read.id).toBe(PLAINTEXT.id);
    expect(read.control).toEqual(CONTROL);
    expect(read.intent.value).toEqual({ ...without(CONTROL, "type"), type: PLAINTEXT.type, document: stored.bodyCid });
    expect(read.stored.bodyCid).toBe(stored.bodyCid);
    expect(read.stored.attachmentCids).toEqual([rawCidOfBytes(PHOTO)]);
    expect(read.typ).toBe(PLAINTEXT_TYP);
    expect(read.from).toBe(BOB);
    expect(read.to).toEqual([ALICE]);
    expect(read.fromPrior).toBe(JWT);
    expect(read.plaintext).toBe(PLAINTEXT);
  });

  it("identifies the exact plaintext and the versioned intent projection by the raw CID of their canonical JSON", () => {
    const read = readPlaintext(PLAINTEXT);
    expect(read.plaintextCid).toBe(cidOf(PLAINTEXT));
    expect(plaintextCidOf(PLAINTEXT)).toBe(read.plaintextCid);
    const projection = {
      type: PLAINTEXT.type,
      thid: "t1",
      pthid: null,
      created_time: 1788442800,
      expires_time: 1788446400,
      please_ack: ["", "older", ""],
      ack: ["x", "x", "y"],
      document: read.stored.bodyCid,
      headers: { lang: "en" },
    };
    expect(intentProjection(read.intent.value)).toEqual(projection);
    expect(read.intent.cid).toBe(cidOf(["estoc.message.intent", 1, projection]));
    expect(intentOf(PLAINTEXT.id, read.control, read.stored.bodyCid)).toEqual(read.intent);
  });

  it("reads absent and null optional headers alike, as null, [] or {}", () => {
    const bare = readPlaintext({ id: "m", type: "t", body: {} });
    expect(bare.control).toEqual({ type: "t", thid: null, pthid: null, createdTime: null, expiresTime: null, pleaseAck: null, ack: [], headers: {} });
    expect(bare.intent.value).toEqual({ type: "t", thid: SELF, pthid: null, createdTime: null, expiresTime: null, pleaseAck: null, ack: [], document: bare.stored.bodyCid, headers: {} });
    expect([bare.typ, bare.from, bare.to, bare.fromPrior]).toEqual([null, null, null, null]);
    const nulls = readPlaintext({ id: "m", type: "t", body: {}, thid: null, pthid: null, created_time: null, expires_time: null, please_ack: null, ack: null, from: null, to: null, from_prior: null, typ: null });
    expect(nulls.control).toEqual(bare.control);
    expect(nulls.intent).toEqual(bare.intent);
    expect(nulls.plaintextCid).not.toBe(bare.plaintextCid);
  });

  it("folds a thread or an ACK request naming the message itself to the self reference, under either case, and keeps the spelling in the headers", () => {
    const own = readPlaintext(PLAINTEXT);
    const upper = PLAINTEXT.id.toUpperCase();
    for (const [variant, control] of [
      [without(PLAINTEXT, "thid"), { thid: null }],
      [{ ...PLAINTEXT, thid: PLAINTEXT.id }, { thid: PLAINTEXT.id }],
      [{ ...PLAINTEXT, thid: upper }, { thid: upper }],
      [{ ...PLAINTEXT, id: upper, thid: PLAINTEXT.id }, { thid: PLAINTEXT.id }],
    ] as const) {
      const read = readPlaintext(variant);
      expect(read.control).toEqual({ ...CONTROL, ...control });
      expect(read.intent.value.thid).toBe(SELF);
      expect(read.intent.cid).toBe(readPlaintext(without(PLAINTEXT, "thid")).intent.cid);
      expect(read.intent.cid).not.toBe(own.intent.cid);
    }
    const asked = readPlaintext({ ...PLAINTEXT, please_ack: [PLAINTEXT.id, "older", upper] });
    expect(asked.control.pleaseAck).toEqual([PLAINTEXT.id, "older", upper]);
    expect(asked.intent.value.pleaseAck).toEqual(["", "older", ""]);
    expect(asked.intent.cid).toBe(own.intent.cid);
    expect(asked.plaintextCid).not.toBe(own.plaintextCid);
  });

  it("leaves the own ID where content carries it: a body string equal to the wire ID is content", () => {
    const carrying = readPlaintext({ ...PLAINTEXT, body: { content: PLAINTEXT.id } });
    expect(carrying.stored.document.body).toEqual({ content: PLAINTEXT.id });
    expect(readPlaintext({ ...PLAINTEXT, id: "other", body: { content: PLAINTEXT.id } }).intent.cid).toBe(carrying.intent.cid);
    expect(readPlaintext({ ...PLAINTEXT, id: "other", body: { content: "other" } }).intent.cid).not.toBe(carrying.intent.cid);
  });

  it("refuses return_route and a present member of the wrong shape", () => {
    const base = { id: "m", type: "t", body: {} };
    expect(() => readPlaintext({ ...base, return_route: "all" })).toThrow(/return_route/);
    expect(() => readPlaintext({ ...base, return_route: null })).toThrow(/return_route/);
    expect(() => readPlaintext({ ...base, id: "" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, type: 3 })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, typ: "application/json" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, from: "bob" })).toThrow(/from must be a DID/);
    expect(() => readPlaintext({ ...base, to: BOB })).toThrow(/to must be an array/);
    expect(() => readPlaintext({ ...base, to: ["nope"] })).toThrow(/to\[0\] must be a DID/);
    expect(() => readPlaintext({ ...base, thid: "" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, created_time: "1788442800" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, created_time: 10, expires_time: 10 })).toThrow(/expires_time must be later/);
    expect(() => readPlaintext({ ...base, please_ack: "" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, ack: [1] })).toThrow(InvalidPlaintext);
    expect(readPlaintext({ ...base, from_prior: "not.a-jwt" }).fromPrior).toBe("not.a-jwt");
    expect(() => readPlaintext({ ...base, from_prior: 7 })).toThrow(/from_prior must be a string/);
    expect(() => readPlaintext({ ...base, body: [] })).toThrow(/body must be a JSON object/);
    expect(() => readPlaintext("{}")).toThrow(InvalidPlaintext);
  });
});

describe("the intent CID", () => {
  const read = readPlaintext(PLAINTEXT);

  it("does not change with the own ID, addressing, proof or typ, which the plaintext CID covers", () => {
    for (const variant of [
      { ...PLAINTEXT, id: "019b2a70-e2c8-7fb4-b63f-1aca32152062" },
      { ...PLAINTEXT, from: ALICE },
      { ...PLAINTEXT, to: [BOB, ALICE] },
      { ...PLAINTEXT, from_prior: JWT + "x" },
      without(PLAINTEXT, "typ"),
    ]) {
      const other = readPlaintext(variant);
      expect(other.intent.cid).toBe(read.intent.cid);
      expect(other.plaintextCid).not.toBe(read.plaintextCid);
    }
  });

  it("changes with body, type, thread, attachments, timing, ACK policy and every additional header", () => {
    for (const variant of [
      { ...PLAINTEXT, body: { content: "hello!" } },
      { ...PLAINTEXT, type: "https://didcomm.org/basicmessage/2.0/other" },
      { ...PLAINTEXT, thid: "t2" },
      { ...PLAINTEXT, pthid: "p" },
      { ...PLAINTEXT, attachments: [{ ...PLAINTEXT.attachments[0], media_type: "image/jpeg" }] },
      { ...PLAINTEXT, attachments: [] },
      { ...PLAINTEXT, created_time: 1788442801 },
      without(PLAINTEXT, "expires_time"),
      { ...PLAINTEXT, please_ack: [""] },
      without(PLAINTEXT, "please_ack"),
      { ...PLAINTEXT, ack: ["x", "y"] },
      { ...PLAINTEXT, lang: "fr" },
      { ...PLAINTEXT, custom: 1 },
    ]) {
      expect(readPlaintext(variant).intent.cid).not.toBe(read.intent.cid);
    }
  });

  it("is the same for every wire spelling of one closed stored attachment", () => {
    const a = PLAINTEXT.attachments[0] as (typeof PLAINTEXT.attachments)[number];
    for (const variant of [
      [{ ...a, data: { base64: base64urlnopad.encode(PHOTO) + "=".repeat((4 - (base64urlnopad.encode(PHOTO).length % 4)) % 4) } }],
      [{ ...a, description: null, filename: null, format: null, lastmod_time: null, byte_count: null }],
      [{ ...a, byte_count: PHOTO.length }],
      [{ ...a, data: { ...a.data, hash: null, jws: null } }],
      [{ ...a, presentation: { width: 10 }, data: { ...a.data, diagnostic: "x" } }],
    ]) {
      expect(readPlaintext({ ...PLAINTEXT, attachments: variant }).intent.cid).toBe(read.intent.cid);
    }
    const json = { id: "j", data: { json: { b: 1, a: 2 } } };
    expect(readPlaintext({ ...PLAINTEXT, attachments: [json] }).intent.cid).toBe(readPlaintext({ ...PLAINTEXT, attachments: [{ id: "j", data: { json: { a: 2, b: 1 } } }] }).intent.cid);
  });

  it("distinguishes null please_ack from [] and [] from a request for the current message", () => {
    const cids = [without(PLAINTEXT, "please_ack"), ...[[], [""], ["older"], ["older", ""]].map((please_ack) => ({ ...PLAINTEXT, please_ack }))].map((p) => readPlaintext(p).intent.cid);
    expect(new Set(cids).size).toBe(cids.length);
  });

  it("keeps the order of please_ack, of ack and of the attachments, and a reference please_ack repeats", () => {
    const [photo] = PLAINTEXT.attachments;
    const json = { id: "j", data: { json: { a: 1 } } };
    const cids = [
      { please_ack: ["older", ""] },
      { please_ack: ["", "older"] },
      { please_ack: ["older"] },
      { please_ack: ["older", "older"] },
      { ack: ["x", "y"] },
      { ack: ["y", "x"] },
      { attachments: [photo, json] },
      { attachments: [json, photo] },
    ].map((change) => readPlaintext({ ...PLAINTEXT, ...change }).intent.cid);
    expect(new Set(cids).size).toBe(cids.length);
  });
});

describe("intentOf", () => {
  const stored = storeMessage({ content: "hi" }, undefined);

  it("hands out a frozen copy, under the CID of that copy, that nothing done to the input afterwards reaches", () => {
    const control: ControlHeaders = { ...CONTROL, pleaseAck: ["", "older"], ack: ["x"], headers: { lang: "en", tags: ["a"] } };
    const intent = intentOf("m", control, stored.bodyCid);
    const projected = intentProjection(intent.value);
    (control.pleaseAck as string[]).push("later");
    control.ack.push("y");
    (control.headers.tags as string[]).push("b");
    control.headers.lang = "fr";
    control.createdTime = 1788442801;
    expect(intentProjection(intent.value)).toEqual(projected);
    expect(intent.cid).toBe(cidOf(["estoc.message.intent", 1, projected]));
    expect(intentOf("m", control, stored.bodyCid).cid).not.toBe(intent.cid);
    for (const frozen of [intent.value, intent.value.pleaseAck, intent.value.ack, intent.value.headers, intent.value.headers.tags]) expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (intent.value as { type: string }).type = "other";
    }).toThrow(TypeError);
  });

  it("checks each field: the own ID, times, their order, the thread, the references, the document and the headers", () => {
    const ok = () => intentOf("m", CONTROL, stored.bodyCid);
    expect(ok().value.document).toBe(stored.bodyCid);
    expect(() => intentOf("", CONTROL, stored.bodyCid)).toThrow(/the own ID must be a non-empty string/);
    expect(() => intentOf("m", { ...CONTROL, type: "" }, stored.bodyCid)).toThrow(/type must be a non-empty string/);
    expect(() => intentOf("m", { ...CONTROL, thid: "" }, stored.bodyCid)).toThrow(/thid must be a non-empty string/);
    expect(() => intentOf("m", { ...CONTROL, pthid: "" }, stored.bodyCid)).toThrow(/pthid/);
    expect(() => intentOf("m", { ...CONTROL, createdTime: 1.5 }, stored.bodyCid)).toThrow(/createdTime must be an integer/);
    expect(() => intentOf("m", { ...CONTROL, expiresTime: CONTROL.createdTime }, stored.bodyCid)).toThrow(/expires_time must be later/);
    expect(() => intentOf("m", { ...CONTROL, pleaseAck: [1] as unknown as string[] }, stored.bodyCid)).toThrow(/pleaseAck must be an array of strings/);
    expect(() => intentOf("m", { ...CONTROL, ack: "x" as unknown as string[] }, stored.bodyCid)).toThrow(/ack must be an array of strings/);
    expect(() => intentOf("m", CONTROL, "bafyreib6zp5tlx5ya5mffwt5aeokbuqmwhxs4kkqe4ynoddufb6sewh3cu" as Cid)).toThrow(/document must be a raw DASL CID/);
    expect(() => intentOf("m", { ...CONTROL, headers: { return_route: "all" } }, stored.bodyCid)).toThrow(/reserved header/);
    expect(() => intentOf("m", { ...CONTROL, headers: { n: Number.NaN } }, stored.bodyCid)).toThrow(/headers is not I-JSON/);
    expect(() => intentOf("m", { ...CONTROL, headers: [] as unknown as ControlHeaders["headers"] }, stored.bodyCid)).toThrow(/headers must be a JSON object/);
  });

  it("reads a recorded intent from an outbound by its message ID and from an inbound by its wire ID", () => {
    const recorded = { msgType: CONTROL.type, thid: "A1", pthid: null, createdTime: 1788442800, expiresTime: null, pleaseAck: ["a1", "other"], ack: [], headers: {}, bodyCid: stored.bodyCid };
    const out = intentOfOutbound({ ...recorded, messageId: "a1" } as unknown as MessageOut);
    const inbound = intentOfInbound({ ...recorded, wireMessageId: "A1" } as unknown as MessageIn);
    expect(out.value).toMatchObject({ thid: SELF, pleaseAck: ["", "other"], document: stored.bodyCid });
    expect(inbound).toEqual(out);
    expect(intentOfOutbound({ ...recorded, messageId: "b1" } as unknown as MessageOut).value).toMatchObject({ thid: "A1", pleaseAck: ["a1", "other"] });
  });

  it("gives each layer its own CID type, so one role is not handed in for another", () => {
    const intent: IntentCid = intentOf("m", CONTROL, stored.bodyCid).cid;
    const plaintext: PlaintextCid = plaintextCidOf(PLAINTEXT);
    const cids: Cid[] = [intent, plaintext];
    expect(cids).toHaveLength(2);
    // @ts-expect-error a plaintext CID is not an intent CID
    const notIntent: IntentCid = plaintext;
    // @ts-expect-error an intent CID is not an envelope CID
    const notEnvelope: EnvelopeCid = intent;
    // @ts-expect-error a bare CID is not an intent CID
    const notEither: IntentCid = stored.bodyCid;
    expect([notIntent, notEnvelope, notEither]).toHaveLength(3);
  });
});

describe("please_ack processing", () => {
  it("requests the current message's receipt only through the sentinel or its own ID, in any case", () => {
    expect(requestsAck("cur", null)).toBe(false);
    expect(requestsAck("cur", [])).toBe(false);
    expect(requestsAck("cur", ["older"])).toBe(false);
    expect(requestsAck("cur", [""])).toBe(true);
    expect(requestsAck("cur", ["older", "cur"])).toBe(true);
    expect(requestsAck("cur", ["older", ""])).toBe(true);
    expect(requestsAck("cur", ["CUR"])).toBe(true);
    expect(requestsAck("Cur", ["cuR"])).toBe(true);
  });

  it("leaves the recorded array as it was", () => {
    const read = readPlaintext(PLAINTEXT);
    expect(requestsAck(PLAINTEXT.id, read.control.pleaseAck)).toBe(true);
    expect(read.control.pleaseAck).toEqual(["", "older", ""]);
  });
});

describe("replyThread", () => {
  it("is the carrier's canonical wire ID when the carrier is in its own thread, by no thid or its own ID in any case, and otherwise the thread as spelled", () => {
    expect(replyThread({ wireMessageId: "Ab-1", thid: null })).toBe("ab-1");
    expect(replyThread({ wireMessageId: "Ab-1", thid: "aB-1" })).toBe("ab-1");
    expect(replyThread({ wireMessageId: "ab-1", thid: "ab-1" })).toBe("ab-1");
    expect(replyThread({ wireMessageId: "Ab-1", thid: "Other" })).toBe("Other");
  });

  it("agrees with the intent: a self thread in the projection is the canonical wire ID, another thread is the projection's", () => {
    const stored = storeMessage(PLAINTEXT.body, PLAINTEXT.attachments);
    for (const control of [CONTROL, { ...CONTROL, thid: "M" }, { ...CONTROL, thid: null }]) {
      const intent = intentOf("m", control, stored.bodyCid).value;
      expect(replyThread({ wireMessageId: "m", thid: control.thid })).toBe(intent.thid === "" ? "m" : intent.thid);
    }
  });
});

describe("checkHeaders", () => {
  it("refuses every reserved name and anything but an object", () => {
    expect(checkHeaders({ lang: "en", "custom-x": [1] })).toEqual({ lang: "en", "custom-x": [1] });
    for (const name of RESERVED_HEADERS) {
      expect(() => checkHeaders({ [name]: 1 })).toThrow(new RegExp(`reserved header "${name}"`));
    }
    expect(() => checkHeaders([])).toThrow(InvalidPlaintext);
    expect(() => checkHeaders(null)).toThrow(InvalidPlaintext);
  });

  it("keeps a header named __proto__, which JSON may carry, as an own member of the intent and of the wire plaintext", () => {
    const bare = readPlaintext(JSON.parse('{"id":"m","type":"t","body":{}}'));
    expect(() => checkHeaders(JSON.parse('{"__proto__":1}'))).not.toThrow();
    for (const literal of ["1", '"x"', "null", '{"custom":1}']) {
      const read = readPlaintext(JSON.parse(`{"id":"m","type":"t","body":{},"__proto__":${literal}}`));
      expect(Object.hasOwn(read.intent.value.headers, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(read.intent.value.headers, "__proto__")?.value).toEqual(JSON.parse(literal));
      expect(Object.getPrototypeOf(read.intent.value.headers)).toBe(Object.prototype);
      expect(read.intent.cid).not.toBe(bare.intent.cid);
      expect(read.plaintextCid).not.toBe(bare.plaintextCid);
      const wire = wirePlaintext(read.intent.value, "m", read.stored.document, { from: BOB, to: [ALICE], fromPrior: null }, () => new Uint8Array());
      expect(Object.hasOwn(wire, "__proto__")).toBe(true);
      expect(readPlaintext(wire).intent.cid).toBe(read.intent.cid);
    }
  });
});

describe("wirePlaintext", () => {
  const stored = storeMessage({ content: "hi" }, [{ id: "a1", data: { base64: base64urlnopad.encode(PHOTO) } }]);
  const payloadOf = (cid: string) => {
    const payload = stored.payloads.find((p) => p.cid === cid);
    if (payload === undefined) throw new Error(`no payload ${cid}`);
    return payload.bytes;
  };
  const ID = "019b2a70-e2c8-7fb4-b63f-1aca32152062";
  const control: ControlHeaders = {
    type: "https://didcomm.org/basicmessage/2.0/message",
    thid: null,
    pthid: "p1",
    createdTime: 1788442800,
    expiresTime: null,
    pleaseAck: [],
    ack: [],
    headers: { lang: "en" },
  };
  const intent = intentOf(ID, control, stored.bodyCid);
  const addressing = { from: ALICE, to: [BOB], fromPrior: null };

  it("emits the fixed members always, optional ones only when set, and additional headers at the top level", () => {
    expect(wirePlaintext(intent.value, ID, stored.document, addressing, payloadOf)).toEqual({
      typ: PLAINTEXT_TYP,
      id: ID,
      type: control.type,
      from: ALICE,
      to: [BOB],
      created_time: 1788442800,
      pthid: "p1",
      please_ack: [],
      lang: "en",
      body: { content: "hi" },
      attachments: [{ id: "a1", byte_count: PHOTO.length, data: { base64: base64urlnopad.encode(PHOTO) } }],
    });
    const empty = storeMessage({}, undefined);
    const bare = wirePlaintext(intentOf(ID, { ...control, createdTime: null, pthid: null, pleaseAck: null, headers: {} }, empty.bodyCid).value, ID, empty.document, { ...addressing, fromPrior: JWT }, payloadOf);
    expect(Object.keys(bare).sort()).toEqual(["body", "from", "from_prior", "id", "to", "typ", "type"]);
    expect(wirePlaintext(intentOf(ID, { ...control, ack: ["x"], expiresTime: 1788446400 }, stored.bodyCid).value, ID, stored.document, addressing, payloadOf)).toMatchObject({ ack: ["x"], expires_time: 1788446400 });
  });

  it("writes the self thread by omitting thid and a self ACK request as the empty string, whichever spelling the intent was recorded from", () => {
    const self = intentOf(ID, { ...control, thid: ID.toUpperCase(), pleaseAck: [ID, "older"] }, stored.bodyCid);
    const wire = wirePlaintext(self.value, ID, stored.document, addressing, payloadOf);
    expect(wire).not.toHaveProperty("thid");
    expect(wire.please_ack).toEqual(["", "older"]);
    expect(wirePlaintext(self.value, "other", stored.document, addressing, payloadOf)).toMatchObject({ id: "other", please_ack: ["", "older"] });
    expect(wirePlaintext(intentOf(ID, { ...control, thid: "t1" }, stored.bodyCid).value, ID, stored.document, addressing, payloadOf).thid).toBe("t1");
  });

  it("refuses a document other than the one the intent names, and an empty ID", () => {
    const other = storeMessage({ content: "ho" }, undefined);
    expect(() => wirePlaintext(intent.value, ID, other.document, addressing, payloadOf)).toThrow(/not the intent's/);
    expect(() => wirePlaintext(intent.value, "", stored.document, addressing, payloadOf)).toThrow(/id must be a non-empty string/);
  });

  it("reads back to the same intent under the same CID, and two preparations agree", () => {
    const one = readPlaintext(wirePlaintext(intent.value, ID, stored.document, addressing, payloadOf));
    const two = readPlaintext(wirePlaintext(intent.value, ID, stored.document, { from: BOB, to: [ALICE], fromPrior: JWT }, payloadOf));
    expect(one.intent).toEqual(intent);
    expect(two.intent.cid).toBe(one.intent.cid);
    expect(two.plaintextCid).not.toBe(one.plaintextCid);
    expect(one.stored.bodyCid).toBe(stored.bodyCid);
  });

  it("projects a committed message.out the same as the plaintext it produces", () => {
    const out: MessageOut = {
      messageId: ID as MessageOut["messageId"],
      senderDidId: "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as MessageOut["senderDidId"],
      recipientDid: BOB,
      msgType: control.type,
      thid: null,
      pthid: "p1",
      createdTime: 1788442800,
      expiresTime: null,
      pleaseAck: [],
      ack: [],
      headers: { lang: "en" },
      bodyCid: stored.bodyCid,
      attachmentCids: stored.attachmentCids,
      intentCid: intent.cid,
      executionId: null,
      effectType: null,
      effectKey: null,
      sourceEventCid: null,
      rotationEventCid: null,
    };
    const fromEvent = intentOfOutbound(out);
    expect(fromEvent).toEqual(intent);
    expect(readPlaintext(wirePlaintext(fromEvent.value, out.messageId, stored.document, addressing, payloadOf)).intent.cid).toBe(out.intentCid);
  });
});
