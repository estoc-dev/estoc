import type { Cid, JsonObject } from "@estoc/event-store";
import { SignJWT, importJWK } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  EMPTY_CONTENT_CID,
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_TYPE,
  PROBLEM_REPORT_TYPE,
  anonymousMessageId,
  didKeyName,
  executionId,
  foldVault,
  foldVaultChecked,
  kindOf,
  type DidId,
  type Keys,
  type ReadObject,
  type Source,
  type VaultChecks,
  type VaultFold,
  type VaultData,
  type WireMessageId,
} from "../../src/index.js";
import { AUTHOR, AUTHOR2, OTHER_BODY_CID, cidOf, expectOrderFree, type Scene, fakeEventCid } from "./helpers.js";
import { IAT, blocked, noObjects, proof, receipt, resolved, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);


const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;

/** A proof under any header and claims, signed by the authentication key a seed derives for an entity. */
async function resign(keys: Keys, didId: DidId, header: Record<string, unknown>, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
}

type Observation = { local: Local; peer: Peer; wire: string; body?: Cid; fromPrior?: string; overrides?: Partial<VaultData["message.in"]>; author?: typeof AUTHOR; at?: string };

/** An authenticated receipt under its own resolution, of the given wire, its content the wire's own unless another is given. */
const observe = (scene: Scene, o: Observation) =>
  receipt(
    scene,
    { local: o.local, peer: o.peer, resolution: resolved(scene, o.local.didId, o.peer), wire: o.wire, fromPrior: o.fromPrior ?? null, overrides: { ...(o.body === undefined ? {} : { bodyCid: o.body }), ...o.overrides } },
    { author: o.author ?? AUTHOR, at: o.at }
  );

/** The inbound fold as comparable data: every execution by its verdicts and members, the observations no execution places. */
function picture(vault: VaultFold) {
  const { inbound } = vault;
  return {
    executions: [...inbound.executions.values()].map((execution) => ({
      id: execution.id,
      messageId: execution.messageId,
      channel: execution.channel,
      members: execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness]),
      siblings: execution.siblings.map(standingOf),
      intentCid: execution.intentCid,
      kind: execution.kind,
      status: execution.status,
      because: execution.status === "complete" ? null : execution.because,
      erased: execution.erased,
    })),
    anonymous: inbound.anonymous.map(({ event }) => event.cid),
    unplaced: inbound.unplaced.map(standingOf),
  };
}

const standingOf = (source: Source) => [source.event.cid, source.status, "because" in source ? source.because : null];

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

describe("an inbound input", () => {
  it("has one execution in its channel for every observation of it, in canonical event order; another channel or wire ID is another input", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const wire = uuidv7();
    const first = observe(scene, { local: a0, peer: b0, wire });
    const later = observe(scene, { local: a0, peer: b0, wire, author: AUTHOR2 });
    const atA1 = observe(scene, { local: a1, peer: b0, wire });
    const fromB1 = observe(scene, { local: a0, peer: b1, wire });
    const otherWire = observe(scene, { local: a0, peer: b0, wire: uuidv7() });
    const vault = await fold(scene, keys);
    const { inbound } = vault;
    expect(inbound.executions.size).toBe(4);
    const execution = inbound.ofMessage(first.data.messageId)!;
    expect(execution).toMatchObject({
      id: executionId(b0.did, a0.did, wire as WireMessageId),
      messageId: first.data.messageId,
      channel: { localDid: a0.did, peerDid: b0.did },
      wireMessageId: wire,
      siblings: [],
      intentCid: first.data.intentCid,
      kind: "application",
      status: "complete",
      erased: false,
    });
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness])).toEqual([
      [first.cid, true, { status: "complete" }],
      [later.cid, true, { status: "complete" }],
    ]);
    expect(inbound.executions.get(execution.id)).toBe(execution);
    expect(inbound.ofSource(later.cid)).toBe(execution);
    for (const other of [atA1, fromB1, otherWire]) {
      const own = inbound.ofSource(other.cid)!;
      expect(own).not.toBe(execution);
      expect(own.members.map(({ source }) => source.event.cid)).toEqual([other.cid]);
      expect(own.status).toBe("complete");
    }
    expect(inbound.ofSource(atA1.cid)!.id).toBe(executionId(b0.did, a1.did, wire as WireMessageId));
    expect(inbound.ofSource(fromB1.cid)!.id).toBe(executionId(b1.did, a0.did, wire as WireMessageId));
    expect(inbound.ofMessage(uuidv7() as VaultData["message.in"]["messageId"])).toBeNull();
    expect(inbound.anonymous).toEqual([]);
    expect(inbound.unplaced).toEqual([]);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("orders the observations of an input by their events' canonical order, whatever order and author recorded them, the first admitted complete one its witness", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const wire = uuidv7();
    const third = observe(scene, { local: a0, peer: b0, wire, author: AUTHOR, at: "2026-09-12T00:00:02.000Z" });
    const second = observe(scene, { local: a0, peer: b0, wire, author: AUTHOR2, at: "2026-09-12T00:00:01.000Z" });
    const first = observe(scene, { local: a0, peer: b0, wire, author: AUTHOR, at: "2026-09-12T00:00:00.000Z" });
    const vault = await fold(scene, keys);
    const execution = vault.inbound.ofMessage(third.data.messageId)!;
    expect(execution.members.map(({ source }) => source.event.cid)).toEqual([first.cid, second.cid, third.cid]);
    expect(execution.firstWitness!.source.event.cid).toBe(first.cid);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is in conflict for good when admitted observations carry different intents, whatever later becomes of their witnesses", async () => {
    const { scene, keys, peerKeys, a0, b0, b1, b2 } = await vaults();
    const wire = uuidv7();
    const plain = observe(scene, { local: a0, peer: b1, wire });
    const carried = observe(scene, { local: a0, peer: b1, wire, body: OTHER_BODY_CID, fromPrior: await proof(peerKeys, b0, b1) });
    let vault = await fold(scene, keys);
    const conflict = { status: "conflict", because: "2 intents are admitted for one input" };
    let execution = vault.inbound.ofMessage(plain.data.messageId)!;
    expect(execution).toMatchObject({ ...conflict, intentCid: null, kind: null });
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness])).toEqual([
      [plain.cid, true, { status: "complete" }],
      [carried.cid, true, { status: "complete" }],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    observe(scene, { local: a0, peer: b2, wire: uuidv7(), fromPrior: await proof(peerKeys, b0, b2) });
    blocked(scene, a0, b1);
    vault = await fold(scene, keys);
    execution = vault.inbound.ofMessage(plain.data.messageId)!;
    expect(vault.continuity.conflicted(execution.channel)).toBe(true);
    expect(execution.members.map(({ positive, witness }) => [positive, witness.status])).toEqual([
      [true, "complete"],
      [true, "conflict"],
    ]);
    expect(execution).toMatchObject(conflict);
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("takes no contradiction from, and lends no completion to, an observation whose proof is refused or not yet verified, since no admission of it is effective", async () => {
    const { scene, keys, peerKeys, a0, a1, b0, b1 } = await vaults();
    const wire = uuidv7();
    const shortIssuer = await resign(peerKeys, b0.didId, { alg: "EdDSA", typ: "JWT", kid: `${b0.did}${AUTHENTICATION_METHOD}` }, { iss: b0.did, sub: b1.longFormDid, iat: IAT });
    const refused = observe(scene, { local: a0, peer: b1, wire, body: OTHER_BODY_CID, fromPrior: "not a JWT" });
    const waiting = observe(scene, { local: a0, peer: b1, wire, body: OTHER_BODY_CID, fromPrior: shortIssuer });
    let vault = await fold(scene, keys);
    let execution = vault.inbound.ofMessage(refused.data.messageId)!;
    expect(execution).toMatchObject({ status: "pending", because: "no observation of the input is admitted", intentCid: null, kind: null });
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness])).toEqual([
      [refused.cid, false, { status: "invalid", because: expect.stringMatching(/^not a compact JWT/) }],
      [waiting.cid, false, { status: "pending", because: "the proof is not yet verified" }],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    const plain = observe(scene, { local: a0, peer: b1, wire });
    vault = await fold(scene, keys);
    execution = vault.inbound.ofMessage(refused.data.messageId)!;
    expect(execution).toMatchObject({ status: "complete", intentCid: plain.data.intentCid, kind: "application" });
    expect(execution.members.map(({ source, positive }) => [source.event.cid, positive])).toEqual([
      [refused.cid, false],
      [waiting.cid, false],
      [plain.cid, true],
    ]);
    expectSameOverEveryOrder(scene, vault.checks);

    resolved(scene, a1.didId, b0, { short: true });
    vault = await fold(scene, keys, readerOf(new Map([[b0.resolution.cid, b0.resolution.bytes]])));
    execution = vault.inbound.ofMessage(refused.data.messageId)!;
    expect(execution.members.map(({ source, positive, witness }) => [source.event.cid, positive, witness.status])).toEqual([
      [refused.cid, false, "invalid"],
      [waiting.cid, true, "complete"],
      [plain.cid, true, "complete"],
    ]);
    expect(execution).toMatchObject({ status: "conflict", because: "2 intents are admitted for one input", intentCid: null });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("lists an observation whose own authentication is incomplete or contradicted as a sibling of its input, or as unplaced, and an anonymous one apart", async () => {
    const { scene, keys, a0, b0, b1 } = await vaults();
    const wire = uuidv7();
    const complete = observe(scene, { local: a0, peer: b0, wire });
    const missingResolution = observe(scene, { local: a0, peer: b0, wire, overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const wrongResolution = receipt(scene, { local: a0, peer: b0, resolution: resolved(scene, a0.didId, b1), wire, presentedDid: b0.longFormDid });
    const alone = observe(scene, { local: a0, peer: b0, wire: uuidv7(), overrides: { peerResolutionEventCid: fakeEventCid() as VaultData["message.in"]["peerResolutionEventCid"] } });
    const anonymousWire = uuidv7() as WireMessageId;
    const anonymous = observe(scene, {
      local: a0,
      peer: b0,
      wire: anonymousWire,
      overrides: { messageId: anonymousMessageId(didKeyName(a0.didId, "key-agreement"), anonymousWire), peerResolutionEventCid: null, presentedDid: null, did: null },
    });
    const vault = await fold(scene, keys);
    const { inbound } = vault;
    const execution = inbound.ofMessage(complete.data.messageId)!;
    expect(execution.status).toBe("complete");
    expect(execution.members.map(({ source }) => source.event.cid)).toEqual([complete.cid]);
    expect(execution.siblings.map(standingOf)).toEqual([
      [missingResolution.cid, "incomplete", "the resolution it names is not here"],
      [wrongResolution.cid, "conflict", "the resolution it names is not of this sender at this key"],
    ]);
    expect(inbound.ofSource(missingResolution.cid)).toBe(execution);
    expect(inbound.ofSource(wrongResolution.cid)).toBe(execution);
    expect(inbound.unplaced.map(({ event }) => event.cid)).toEqual([alone.cid]);
    expect(inbound.ofSource(alone.cid)).toBeNull();
    expect(inbound.anonymous.map(({ event }) => event.cid)).toEqual([anonymous.cid]);
    expect(inbound.ofSource(anonymous.cid)).toBeNull();
    expect(inbound.ofSource(fakeEventCid())).toBeNull();
    expect(inbound.executions.size).toBe(1);
    expectSameOverEveryOrder(scene, vault.checks);

    const unseeded = await fold(scene, null);
    expect(unseeded.inbound.executions.size).toBe(0);
    expect(unseeded.inbound.unplaced.map(({ event, status }) => [event.cid, status])).toEqual([
      [complete.cid, "incomplete"],
      [missingResolution.cid, "incomplete"],
      [wrongResolution.cid, "conflict"],
      [alone.cid, "incomplete"],
    ]);
    expect(unseeded.inbound.anonymous.map(({ event }) => event.cid)).toEqual([anonymous.cid]);
    expectSameOverEveryOrder(scene, unseeded.checks);
  });

  it("reads the kind of the agreed intent, a pure ACK only in its exact shape, and marks an erased input", async () => {
    const { scene, keys, a0, b0 } = await vaults();
    const target = uuidv7();
    const pureAck: Partial<VaultData["message.in"]> = { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, attachmentCids: [], ack: [target], pleaseAck: null };
    const shapes: [string, Partial<VaultData["message.in"]>][] = [
      ["pure-ack", pureAck],
      ["empty", { ...pureAck, ack: [] }],
      ["empty", { ...pureAck, pleaseAck: [""] }],
      ["empty", { ...pureAck, bodyCid: cidOf("not empty") }],
      ["empty", { ...pureAck, attachmentCids: [cidOf("attachment")] }],
      ["empty", { msgType: EMPTY_MESSAGE_TYPE, bodyCid: EMPTY_CONTENT_CID, ack: [], pleaseAck: [""] }],
      ["ping-response", { msgType: PING_RESPONSE_TYPE, thid: target }],
      ["error", { msgType: PROBLEM_REPORT_TYPE, pthid: target }],
      ["application", { msgType: "https://didcomm.org/trust-ping/2.0/ping" }],
      ["application", {}],
    ];
    const observed = shapes.map(([kind, overrides]) => [kind, observe(scene, { local: a0, peer: b0, wire: uuidv7(), overrides })] as const);
    const erased = observed[0]![1];
    scene.add("message.erased", { messageId: erased.data.messageId, dropCids: [erased.data.bodyCid], because: "user" });
    const vault = await fold(scene, keys);
    for (const [kind, event] of observed) {
      expect(kindOf(event.data)).toBe(kind);
      const execution = vault.inbound.ofSource(event.cid)!;
      expect(execution).toMatchObject({ kind, status: "complete", erased: event === erased });
    }
    expectSameOverEveryOrder(scene, vault.checks);
  });
});
