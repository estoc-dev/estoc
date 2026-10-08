import { canonicalize } from "@estoc/event-store";
import { describe, expect, it, test } from "vitest";
import { v5 as uuidv5 } from "uuid";

import {
  ANCHOR_KEY_NAME,
  InvalidIdentifier,
  NAMESPACE_PURPOSES,
  anonymousMessageId,
  automaticMessageId,
  canonicalDid,
  canonicalWireId,
  channelKey,
  channelOf,
  compareChannels,
  compareUtf8,
  didKeyName,
  effectKey,
  estocNamespace,
  executionId,
  inboundMessageId,
  mediationIdOf,
  mediationKeyName,
  replicaKeyName,
  sameDid,
  sameWireId,
  startDidId,
  successorDidId,
  sameChannel,
  type Did,
  type DidId,
  type EffectKey,
  type ExecutionId,
  type KeyName,
  type MediationId,
  type ReplicaId,
  type WireMessageId,
} from "../src/index.js";

const did = (s: string) => s as Did;
const wire = (s: string) => s as WireMessageId;

/** The published delivery fixture: our DID receiving, the peer's sending. */
const LOCAL = did("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd");
const PEER = did("did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP");
const FIRST_WIRE = wire("019b2a70-f225-721c-835f-67175be0667e");
const ACK_WIRE = wire("019b1b61-3444-7190-9db5-1cc9c215eb23");
const ACK_EXECUTION = "ccee59f0-8c79-5011-8822-dbb14de9cf7d" as ExecutionId;
const PURE_ACK = "https://estoc.dev/distributed-delivery/1.0#pure-ack";
const PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";

describe("estocNamespace", () => {
  it("derives each of the five namespaces from the URL namespace to the published value", () => {
    expect(NAMESPACE_PURPOSES).toHaveLength(5);
    expect(Object.fromEntries(NAMESPACE_PURPOSES.map((p) => [p, estocNamespace(p)]))).toEqual({
      "inbound-message": "4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6",
      "message-execution": "6511fc66-4d39-589e-b2c7-7185a807b6c6",
      "automatic-mid": "8847bd57-5907-5bcd-9a71-d1e97cee3199",
      mediation: "ef3354b7-959d-5de2-a68d-f475ff7a7ab4",
      "did-entity": "47c0b363-2cc9-5e29-8898-0cb3cffa2ac2",
    });
    expect(estocNamespace("inbound-message")).toBe(uuidv5("https://estoc.dev/uuid/v1/inbound-message", "6ba7b811-9dad-11d1-80b4-00c04fd430c8"));
  });
});

describe("channels", () => {
  it("is an ordered pair of distinct DIDs: the reverse pair is another channel", () => {
    const channel = channelOf(LOCAL, PEER);
    expect(channel).toEqual({ localDid: LOCAL, peerDid: PEER });
    expect(sameChannel(channel, channelOf(LOCAL, PEER))).toBe(true);
    expect(sameChannel(channel, channelOf(PEER, LOCAL))).toBe(false);
    expect(() => channelOf(LOCAL, LOCAL)).toThrow(InvalidIdentifier);
    expect(() => channelOf(did(""), PEER)).toThrow(InvalidIdentifier);
    expect(() => channelOf(LOCAL, did(""))).toThrow(InvalidIdentifier);
  });

  it("keys a channel by the canonical text of its pair and orders a set by the UTF-8 bytes of the keys, not the two ends within a pair", () => {
    expect(channelKey(channelOf(LOCAL, PEER))).toBe(`["${LOCAL}","${PEER}"]`);
    const bmp = did("did:peer:4z");
    const astral = did("did:peer:4z\u{10000}");
    expect(astral < bmp).toBe(true);
    expect(compareUtf8(bmp, astral)).toBeLessThan(0);
    expect(compareChannels(channelOf(bmp, LOCAL), channelOf(astral, LOCAL))).toBeLessThan(0);
    expect(compareChannels(channelOf(LOCAL, bmp), channelOf(LOCAL, astral))).toBeLessThan(0);
    expect(compareChannels(channelOf(LOCAL, PEER), channelOf(LOCAL, PEER))).toBe(0);
    expect(compareChannels(channelOf(PEER, LOCAL), channelOf(LOCAL, PEER))).toBeLessThan(0);
    const sorted = [channelOf(LOCAL, bmp), channelOf(LOCAL, PEER), channelOf(PEER, LOCAL)].sort(compareChannels);
    expect(sorted.map(channelKey)).toEqual([channelKey(channelOf(PEER, LOCAL)), channelKey(channelOf(LOCAL, PEER)), channelKey(channelOf(LOCAL, bmp))]);
  });
});

describe("inboundMessageId and executionId", () => {
  it("give the published observation and execution IDs of the delivery fixture", () => {
    expect(inboundMessageId(PEER, LOCAL, FIRST_WIRE)).toBe("d2192dcf-cc5c-5f7d-b4f1-46972b7b04de");
    expect(executionId(PEER, LOCAL, FIRST_WIRE)).toBe("a03249b8-5e3e-5d10-a2e7-46844b38f5ae");
    expect(inboundMessageId(PEER, LOCAL, ACK_WIRE)).toBe("9cfaed56-2cb3-5a84-bc56-f8e882784ac8");
    expect(executionId(PEER, LOCAL, ACK_WIRE)).toBe(ACK_EXECUTION);
  });

  it("scope both IDs to the channel: the reverse direction under the same wire ID and another peer are other values", () => {
    const other = did("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Be");
    expect(inboundMessageId(LOCAL, PEER, FIRST_WIRE)).not.toBe(inboundMessageId(PEER, LOCAL, FIRST_WIRE));
    expect(inboundMessageId(other, LOCAL, FIRST_WIRE)).not.toBe(inboundMessageId(PEER, LOCAL, FIRST_WIRE));
    expect(executionId(LOCAL, PEER, FIRST_WIRE)).not.toBe(executionId(PEER, LOCAL, FIRST_WIRE));
    expect(executionId(PEER, other, FIRST_WIRE)).not.toBe(executionId(PEER, LOCAL, FIRST_WIRE));
  });

  it("hash the literal `sender` and `recipient` tags in the execution transcript, whatever the payload calls them", () => {
    expect(executionId(PEER, LOCAL, ACK_WIRE)).toBe(uuidv5(canonicalize(["v4", { recipient: LOCAL, sender: PEER }, ACK_WIRE]), estocNamespace("message-execution")));
    expect(executionId(PEER, LOCAL, ACK_WIRE)).not.toBe(uuidv5(canonicalize(["v4", { did: PEER, localDid: LOCAL }, ACK_WIRE]), estocNamespace("message-execution")));
  });

  test("an anonymous observation is scoped by the local key, and never equals an authenticated one", () => {
    const k1 = "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement" as KeyName;
    const k2 = "did/019b6a10-12c0-7410-89ab-38e54b097c21/key-agreement" as KeyName;
    expect(anonymousMessageId(k1, ACK_WIRE)).toBe(uuidv5(canonicalize(["v1", "anonymous", k1, ACK_WIRE]), estocNamespace("inbound-message")));
    expect(anonymousMessageId(k1, ACK_WIRE)).not.toBe(anonymousMessageId(k2, ACK_WIRE));
    expect(anonymousMessageId(k1, ACK_WIRE)).not.toBe(inboundMessageId(PEER, LOCAL, ACK_WIRE));
  });

  it("take the wire ID in its canonical form: one spelling of the ID in any case is one observation and one execution, and one anonymous observation", () => {
    const upper = wire(ACK_WIRE.toUpperCase());
    expect(upper).not.toBe(ACK_WIRE);
    expect(inboundMessageId(PEER, LOCAL, upper)).toBe(inboundMessageId(PEER, LOCAL, ACK_WIRE));
    expect(executionId(PEER, LOCAL, upper)).toBe(ACK_EXECUTION);
    expect(executionId(PEER, LOCAL, upper)).toBe(uuidv5(canonicalize(["v4", { recipient: LOCAL, sender: PEER }, ACK_WIRE]), estocNamespace("message-execution")));
    const key = "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement" as KeyName;
    expect(anonymousMessageId(key, upper)).toBe(anonymousMessageId(key, ACK_WIRE));
    expect(inboundMessageId(PEER, LOCAL, wire("Not-The-Same-1"))).not.toBe(inboundMessageId(PEER, LOCAL, wire("not-the-same-2")));
  });

  it("refuse an empty wire ID, DID or key name", () => {
    expect(() => inboundMessageId(PEER, LOCAL, wire(""))).toThrow(InvalidIdentifier);
    expect(() => inboundMessageId(did(""), LOCAL, ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => inboundMessageId(PEER, did(""), ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => anonymousMessageId("" as KeyName, ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => anonymousMessageId("did/x/key-agreement" as KeyName, wire(""))).toThrow(InvalidIdentifier);
    expect(() => executionId(did(""), LOCAL, ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => executionId(PEER, LOCAL, wire(""))).toThrow(InvalidIdentifier);
  });
});

describe("effectKey and automaticMessageId", () => {
  it("give the delivery fixture's pure ACK its published key and message ID", () => {
    const key = effectKey(ACK_EXECUTION, PURE_ACK);
    expect(key).toBe("Vyjgpd9idT4bb9ejAEdwT5J8dX-kL6FfSniCkFZDB20");
    expect(automaticMessageId(key)).toBe("3543ac01-4ac6-5c14-b160-4f8f4e2e6811");
  });

  test("both members of the tuple change the key, and the key alone determines the message ID", () => {
    const keys = [effectKey(ACK_EXECUTION, PURE_ACK), effectKey("a03249b8-5e3e-5d10-a2e7-46844b38f5ae" as ExecutionId, PURE_ACK), effectKey(ACK_EXECUTION, PING_RESPONSE)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(automaticMessageId(keys[0] as EffectKey)).toBe(automaticMessageId(effectKey(ACK_EXECUTION, PURE_ACK)));
  });

  it("takes the effect type as spelled, never normalized: another spelling of the same URI is another key", () => {
    expect(effectKey(ACK_EXECUTION, PURE_ACK)).not.toBe(effectKey(ACK_EXECUTION, "HTTPS://estoc.dev/distributed-delivery/1.0#pure-ack"));
    expect(effectKey(ACK_EXECUTION, PURE_ACK)).not.toBe(effectKey(ACK_EXECUTION, `${PURE_ACK}/`));
  });

  it("refuses an empty execution, an effect type without a scheme, with U+0000, an unpaired surrogate or a noncharacter", () => {
    expect(() => effectKey("" as ExecutionId, PURE_ACK)).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "pure-ack")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:a\0b")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:effect-\ud800")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:effect-\udfff")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:effect-￿")).toThrow(InvalidIdentifier);
    expect(effectKey(ACK_EXECUTION, "urn:effect-�")).not.toBe(effectKey(ACK_EXECUTION, "urn:effect-\u{10000}"));
    expect(() => automaticMessageId("" as EffectKey)).toThrow(InvalidIdentifier);
  });
});

describe("canonicalWireId and sameWireId", () => {
  it("fold the ASCII letters of a wire ID to lower case and nothing else, and compare two IDs by that spelling", () => {
    expect(canonicalWireId("019B2A70-E2C8-7fb4-b63f-1ACA32152062")).toBe("019b2a70-e2c8-7fb4-b63f-1aca32152062");
    expect(canonicalWireId("Ünïcode~Id_1.2-3")).toBe("Ünïcode~id_1.2-3");
    expect(sameWireId("a1", "A1")).toBe(true);
    expect(sameWireId("a1", "a1")).toBe(true);
    expect(sameWireId("a1", "a2")).toBe(false);
    expect(sameWireId("", "")).toBe(true);
  });
});

describe("canonicalDid", () => {
  it("spells a did:peer:4 by its short form whichever form it is given, and any other DID as it is, so that two spellings of one DID are the same DID", () => {
    const long = did(`${LOCAL}:z2LongForm`);
    expect(canonicalDid(long)).toBe(LOCAL);
    expect(canonicalDid(LOCAL)).toBe(LOCAL);
    expect(canonicalDid("did:web:mediator.example")).toBe("did:web:mediator.example");
    expect(sameDid(long, LOCAL)).toBe(true);
    expect(sameDid(LOCAL, long)).toBe(true);
    expect(sameDid(LOCAL, PEER)).toBe(false);
    expect(sameDid("did:web:mediator.example", "did:web:mediator.example")).toBe(true);
  });
});

describe("mediationIdOf", () => {
  const MEDIATOR = did("did:web:mediator.example");

  it("names the arrangement with a mediator by its canonical DID alone, to the published value", () => {
    expect(mediationIdOf(MEDIATOR)).toBe("1922ce3b-533a-5c75-8cb1-10cdd1f80204");
    expect(mediationIdOf(MEDIATOR)).toBe(uuidv5(canonicalize(["v1", MEDIATOR]), estocNamespace("mediation")));
    expect(mediationIdOf(did("did:web:other.example"))).toBe("a9934024-3ed4-5e9d-b04d-33ce664c4300");
    expect(mediationIdOf(LOCAL)).not.toBe(mediationIdOf(PEER));
  });

  it("derives from the short form whichever spelling of a did:peer:4 arrives, and refuses an empty or malformed DID", () => {
    expect(mediationIdOf(did(`${LOCAL}:z2LongForm`))).toBe(mediationIdOf(LOCAL));
    expect(() => mediationIdOf(did(""))).toThrow(InvalidIdentifier);
    expect(() => mediationIdOf(did("mediator.example"))).toThrow(InvalidIdentifier);
    expect(() => mediationIdOf(did("did:peer:4abc"))).toThrow(InvalidIdentifier);
  });
});

describe("successorDidId and startDidId", () => {
  it("name the successor of a DID by that DID alone, and the first address toward a peer by the public DID and the peer, to the published values", () => {
    expect(successorDidId(LOCAL)).toBe("24ae4bcc-e4ee-5111-b600-1674a2300462");
    expect(successorDidId(LOCAL)).toBe(uuidv5(canonicalize(["v1", "next", LOCAL]), estocNamespace("did-entity")));
    expect(startDidId(LOCAL, PEER)).toBe("4cb0f38a-668b-5472-b82c-509b397c8058");
    expect(startDidId(LOCAL, PEER)).toBe(uuidv5(canonicalize(["v1", "start", LOCAL, PEER]), estocNamespace("did-entity")));
  });

  it("give one value for one input, and other values for the other DID, the swapped pair and the other rule", () => {
    expect(successorDidId(LOCAL)).toBe(successorDidId(LOCAL));
    expect(successorDidId(LOCAL)).not.toBe(successorDidId(PEER));
    expect(startDidId(LOCAL, PEER)).not.toBe(startDidId(PEER, LOCAL));
    expect(startDidId(LOCAL, PEER)).not.toBe(successorDidId(LOCAL));
    expect(didKeyName(successorDidId(LOCAL), "authentication")).toBe(`did/${successorDidId(LOCAL)}/authentication`);
  });

  it("take either spelling of a did:peer:4, and refuse an empty or malformed DID and a relationship of one DID with itself", () => {
    expect(successorDidId(did(`${LOCAL}:z2LongForm`))).toBe(successorDidId(LOCAL));
    expect(startDidId(LOCAL, did(`${PEER}:z2LongForm`))).toBe(startDidId(LOCAL, PEER));
    expect(() => successorDidId(did(""))).toThrow(InvalidIdentifier);
    expect(() => successorDidId(did("not a did"))).toThrow(InvalidIdentifier);
    expect(() => startDidId(did(""), PEER)).toThrow(InvalidIdentifier);
    expect(() => startDidId(LOCAL, LOCAL)).toThrow(InvalidIdentifier);
    expect(() => startDidId(LOCAL, did(`${LOCAL}:z2LongForm`))).toThrow(InvalidIdentifier);
  });
});

describe("key names", () => {
  it("names the anchor, a DID entity's two keys whether its ID is minted or derived, and a mediation's identity key", () => {
    expect(ANCHOR_KEY_NAME).toBe("anchor");
    const d = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
    expect(didKeyName(d, "authentication")).toBe("did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/authentication");
    expect(didKeyName(d, "key-agreement")).toBe("did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement");
    expect(didKeyName("019b0000-0000-5000-8000-00000000000c" as DidId, "authentication")).toBe("did/019b0000-0000-5000-8000-00000000000c/authentication");
    expect(mediationKeyName("1922ce3b-533a-5c75-8cb1-10cdd1f80204" as MediationId)).toBe("mediation/1922ce3b-533a-5c75-8cb1-10cdd1f80204/me");
    expect(() => didKeyName("" as DidId, "authentication")).toThrow(InvalidIdentifier);
    expect(() => didKeyName("019b0000-0000-4000-8000-00000000000c" as DidId, "authentication")).toThrow(InvalidIdentifier);
    expect(() => mediationKeyName("" as MediationId)).toThrow(InvalidIdentifier);
    expect(() => mediationKeyName("019b2a60-c68e-75bf-b6fb-ae1a41f8d716" as MediationId)).toThrow(InvalidIdentifier);
    expect(replicaKeyName("019b2a43-4a56-7c0f-862f-194c0c4124a0" as ReplicaId)).toBe("replica/019b2a43-4a56-7c0f-862f-194c0c4124a0/me");
    expect(() => replicaKeyName("019b0000-0000-5000-8000-00000000000c" as ReplicaId)).toThrow(InvalidIdentifier);
  });
});
