import { canonicalText } from "@estoc/event-store";
import { describe, expect, test } from "vitest";

import { PLAINTEXT_TYP, executionId, inboundMessageId, intentOf, intentProjection, plaintextCidOf, readPlaintext, storeMessage, wirePlaintext, type Cid, type ControlHeaders, type Did, type WireMessageId } from "../src/index.js";

const OURS = "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd" as Did;
const PEER = "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP" as Did;
const ID = "019b2a70-e2c8-7fb4-b63f-1aca32152062";
const OTHER = "019b2a70-f225-721c-835f-67175be0667e";
const BASIC_MESSAGE = "https://didcomm.org/basicmessage/2.0/message";
const EMPTY = "https://didcomm.org/empty/1.0/empty";
const BODY = { content: "hello" };
const CREATED = 1788442800;

const HELLO = storeMessage(BODY, undefined);
const WITH_ATTACHMENT = storeMessage(BODY, [{ id: "a1", media_type: "application/json", data: { json: { k: 1 } } }]);
const CONTROL: ControlHeaders = { type: BASIC_MESSAGE, thid: null, pthid: null, createdTime: CREATED, expiresTime: null, pleaseAck: [""], ack: [], headers: {} };
const INTENT_CID = "bafkreiem7tcs2b3noyacl5iegvaqpjgy77pptqpgpxhpdfzfvawhb6j7nu";
const PLAINTEXT_CID = "bafkreihpzyq47ncv37altvbrhq2jb6m4dr2l2nqrsgxoqdne5va37rotlq";

const decoder = new TextDecoder();
const noPayload = () => {
  throw new Error("no inline payload");
};

describe("the message layer vectors", () => {
  test("the stored document of the fixture body, alone and with one inline JSON attachment, has the fixed bytes and CIDs", () => {
    expect(decoder.decode(HELLO.bytes)).toBe('{"attachments":[],"body":{"content":"hello"}}');
    expect(HELLO.bodyCid).toBe("bafkreifjsojjektsxjm7ap5cq3oy4uf3vijc4l4yxikxrwclndlsany5me");
    expect(WITH_ATTACHMENT.payloads.map(({ cid, bytes }) => [cid, decoder.decode(bytes)])).toEqual([["bafkreifa3ip44v6q4t47blsojs7aidju3taemjk4nsgrr2l7kwvo2bsv6a", '{"k":1}']]);
    expect(decoder.decode(WITH_ATTACHMENT.bytes)).toBe(
      '{"attachments":[{"byte_count":7,"data":{"hash":null,"jws":null,"kind":"json","root":"bafkreifa3ip44v6q4t47blsojs7aidju3taemjk4nsgrr2l7kwvo2bsv6a"},"description":null,"filename":null,"format":null,"id":"a1","lastmod_time":null,"media_type":"application/json"}],"body":{"content":"hello"}}'
    );
    expect(WITH_ATTACHMENT.bodyCid).toBe("bafkreig7s23pgqrytmeiyzlqdwd2tr4ibtovvc4q6nq6yqccryr66imf3e");
  });

  test("the fixture intent projects to the fixed bytes and CID", () => {
    const intent = intentOf(ID, CONTROL, HELLO.bodyCid);
    expect(canonicalText(["estoc.message.intent", 1, intentProjection(intent.value)])).toBe(
      '["estoc.message.intent",1,{"ack":[],"created_time":1788442800,"document":"bafkreifjsojjektsxjm7ap5cq3oy4uf3vijc4l4yxikxrwclndlsany5me","expires_time":null,"headers":{},"please_ack":[""],"pthid":null,"thid":"","type":"https://didcomm.org/basicmessage/2.0/message"}]'
    );
    expect(intent.cid).toBe(INTENT_CID);
  });

  test("every spelling of the same message gives the fixture intent CID", () => {
    const wire = { typ: PLAINTEXT_TYP, id: ID, type: BASIC_MESSAGE, from: OURS, to: [PEER], created_time: CREATED, please_ack: [""], body: BODY };
    for (const spelling of [
      wire,
      { ...wire, thid: ID },
      { ...wire, please_ack: [ID] },
      { ...wire, id: OTHER },
      { ...wire, from: PEER, to: [OURS, PEER], from_prior: "a.b.c" },
      { ...wire, typ: undefined, from: undefined, to: undefined },
    ]) {
      expect(readPlaintext(JSON.parse(JSON.stringify(spelling))).intent.cid).toBe(INTENT_CID);
    }
  });

  test("each change to the intent gives its fixed CID", () => {
    const cases: [Partial<ControlHeaders>, string, Cid?][] = [
      [{ createdTime: 1788442801 }, "bafkreidid3d4wna6upeqmyom5jirxner5yj4urkhzlqbahzonc53hokj5i"],
      [{ expiresTime: 1788446400 }, "bafkreie3fcb2zjzueqyfsfkfwpmw7fo7w3zz2pmxu5ytot5jvydpp2vbq4"],
      [{ headers: { lang: "en" } }, "bafkreibrmi25i7yxfkqzejz3riiws5domv2qesryz2txf4vwma2gtbsawe"],
      [{ pleaseAck: null }, "bafkreidg52mgoncqnli72hue5rkzcg52s3u43i527mws7yndk6nppwzzga"],
      [{ pleaseAck: [] }, "bafkreidrzhnsotsbbvp2eo2uqgioai2s5u32x3eyy2qttpkcyyvurksjbi"],
      [{ thid: OTHER }, "bafkreibvclxcgo52vduzlysrkm47u3ikdaa5xp46rsb7xyr27cwxr4dtd4"],
      [{ pleaseAck: [OTHER, ""] }, "bafkreibs4gq4ibpjhmkg2ckanhu6zls4uopksclycsrldomv75rnejk3ci"],
      [{}, "bafkreiawuwzqtp7wdihjclk2iv5hmuw7eivxh4yvewvqmygloa26cde6a4", WITH_ATTACHMENT.bodyCid],
    ];
    for (const [change, cid, document = HELLO.bodyCid] of cases) {
      expect(intentOf(ID, { ...CONTROL, ...change }, document).cid).toBe(cid);
    }
  });

  test("the fixture intent assembles to the fixed plaintext, under the fixed plaintext CID, and reads back to its intent", () => {
    const intent = intentOf(ID, CONTROL, HELLO.bodyCid);
    const plaintext = wirePlaintext(intent.value, ID, HELLO.document, { from: OURS, to: [PEER], fromPrior: null }, noPayload);
    expect(canonicalText(plaintext)).toBe(
      '{"body":{"content":"hello"},"created_time":1788442800,"from":"did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd","id":"019b2a70-e2c8-7fb4-b63f-1aca32152062","please_ack":[""],"to":["did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP"],"typ":"application/didcomm-plain+json","type":"https://didcomm.org/basicmessage/2.0/message"}'
    );
    expect(plaintextCidOf(plaintext)).toBe(PLAINTEXT_CID);
    const read = readPlaintext(plaintext);
    expect(read.plaintextCid).toBe(PLAINTEXT_CID);
    expect(read.intent).toEqual(intent);
    expect(plaintextCidOf(JSON.parse('{ "type": "https://didcomm.org/basicmessage/2.0/message", "typ": "application/didcomm-plain+json", "to": ["did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP"], "please_ack": [""], "id": "019b2a70-e2c8-7fb4-b63f-1aca32152062", "from": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd", "created_time": 1788442800, "body": { "content": "hello" } }'))).toBe(PLAINTEXT_CID);
  });

  test("each other spelling of the plaintext is another plaintext CID under the same intent CID", () => {
    const intent = intentOf(ID, CONTROL, HELLO.bodyCid);
    const plaintext = wirePlaintext(intent.value, ID, HELLO.document, { from: OURS, to: [PEER], fromPrior: null }, noPayload);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...plaintext, thid: null }, "bafkreidqxt7irsq6dy7glysmvraujacrz3csavkdrkzwb2ib33zpywifoy"],
      [{ ...plaintext, thid: ID }, "bafkreifxwbzt7tydidretpqr4yr6vrsuopsnahu5zvjtiknlwlxmobpdbu"],
      [{ ...plaintext, please_ack: [ID] }, "bafkreieyvcxfsirniso2vth3o46o3unaemv6a2viehpgar5zg3nx7zpxi4"],
      [{ ...plaintext, id: OTHER }, "bafkreiavxf23wwuk46tyfzrhmapsltiejc6lyxaqkgmh4dkdn5ydblmfye"],
    ];
    for (const [spelling, cid] of cases) {
      const read = readPlaintext(spelling);
      expect(read.plaintextCid).toBe(cid);
      expect(read.intent.cid).toBe(INTENT_CID);
    }
  });

  test("the fixture plaintext received under its ID in two cases is one input and one execution under one intent CID, with two plaintext CIDs; under another ID it is another input", () => {
    const lower = { typ: PLAINTEXT_TYP, id: "a1", type: BASIC_MESSAGE, from: PEER, to: [OURS], created_time: CREATED, please_ack: [""], body: BODY };
    const upper = { ...lower, id: "A1" };
    const other = { ...lower, id: "a2" };
    const identities = (plaintext: typeof lower) => {
      const read = readPlaintext(plaintext);
      const wire = read.id as WireMessageId;
      return { messageId: inboundMessageId(PEER, OURS, wire), executionId: executionId(PEER, OURS, wire), intentCid: read.intent.cid, plaintextCid: read.plaintextCid };
    };
    const [a, b, c] = [identities(lower), identities(upper), identities(other)];
    expect([b.messageId, b.executionId, b.intentCid]).toEqual([a.messageId, a.executionId, a.intentCid]);
    expect(b.plaintextCid).not.toBe(a.plaintextCid);
    expect([c.messageId === a.messageId, c.executionId === a.executionId, c.intentCid]).toEqual([false, false, a.intentCid]);
  });

  test("the pure ACK of the fixture carrier is one intent under the carrier's canonical wire ID, and another under a thread spelled otherwise", () => {
    const EMPTY_DOCUMENT = storeMessage({}, undefined);
    expect(decoder.decode(EMPTY_DOCUMENT.bytes)).toBe('{"attachments":[],"body":{}}');
    expect(EMPTY_DOCUMENT.bodyCid).toBe("bafkreibjtfmb4ccyujuyheuyeejnjpxticpt347cqyzi2w7p5ocsa432ga");
    const ack = (thid: string) => intentOf("48a1f735-5b37-501a-8b69-b56637fb50b0", { type: EMPTY, thid, pthid: null, createdTime: CREATED, expiresTime: null, pleaseAck: null, ack: ["a1"], headers: {} }, EMPTY_DOCUMENT.bodyCid);
    expect(canonicalText(["estoc.message.intent", 1, intentProjection(ack("a1").value)])).toBe(
      '["estoc.message.intent",1,{"ack":["a1"],"created_time":1788442800,"document":"bafkreibjtfmb4ccyujuyheuyeejnjpxticpt347cqyzi2w7p5ocsa432ga","expires_time":null,"headers":{},"please_ack":null,"pthid":null,"thid":"a1","type":"https://didcomm.org/empty/1.0/empty"}]'
    );
    expect(ack("a1").cid).toBe("bafkreibqllghqjfnj6fbhuvvsgegqhcjitqtrvf66jrd2oy64duelhgq4q");
    expect(ack("A1").cid).toBe("bafkreif5ja4bl5zthmexiwlod6solcaqnzik6uuhrfynhm3x2kyhxvqghe");
  });
});
