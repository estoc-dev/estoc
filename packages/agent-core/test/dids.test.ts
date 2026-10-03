import { describe, expect, it, test } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { InvalidIdentifier, didcommServiceUris, scanVault, vaultDraft, type DidId, type MediationId } from "@estoc/vault";

import { EntityConflict, OOB_INVITATION, Unregistered, Unusable, WrongMediator, canonicalDid, createDid, disclose, enroll, invitationUrl, parseInvitation, retireDid, routeOf, routeTargetOf } from "../src/index.js";
import { freshVault, mediatedRoute, newMediator, party } from "./helpers.js";

const ENDPOINT = "https://ingress.example/didcomm";
const DIRECT = { kind: "direct", endpoint: ENDPOINT } as const;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;

describe("routes", () => {
  test("a mediated route needs a usable arrangement; a direct one needs an absolute HTTPS or WSS endpoint", async () => {
    const p = await party(await newMediator());
    const route = mediatedRoute(p.mediationId);
    const ungranted = await scanVault(p.runtime.vault, p.keys);
    expect(() => routeTargetOf(ungranted, route)).toThrow(Unusable);
    expect(routeTargetOf(ungranted, DIRECT)).toEqual({ kind: "direct", endpoint: ENDPOINT });
    expect(routeTargetOf(ungranted, { kind: "direct", endpoint: "wss://ingress.example/ws" })).toEqual({ kind: "direct", endpoint: "wss://ingress.example/ws" });
    for (const endpoint of ["http://ingress.example", "/didcomm", "did:web:ingress.example"]) {
      expect(() => routeTargetOf(ungranted, { kind: "direct", endpoint })).toThrow(Unusable);
    }

    await enroll(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(routeTargetOf(await scanVault(p.runtime.vault, p.keys), route)).toEqual({ kind: "mediated", routingDid: p.mediator.did });
    const { minted } = await createDid(p.runtime, p.keys, route, DID);
    expect(routeOf((await scanVault(p.runtime.vault, p.keys)).dids.entities.get(DID)!)).toEqual(route);

    await p.runtime.vault.commit([], [vaultDraft("mediation.retired", { mediationId: p.mediationId, because: "gone" })]);
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(() => routeTargetOf(fold, route)).toThrow(Unusable);
    expect(fold.dids.entities.get(DID)).toMatchObject({ live: false, created: { did: minted.did }, mediation: null, faults: [`mediation ${p.mediationId} is retired`] });
    expect(routeOf(fold.dids.entities.get(DID)!)).toBeNull();
    await expect(createDid(p.runtime, p.keys, route)).rejects.toBeInstanceOf(Unusable);
    await expect(disclose(p.link, p.runtime, p.keys, DID, { as: "oob" }, p.confirmations)).rejects.toBeInstanceOf(Unusable);
    await p.runtime.close();
  });
});

describe("communication DIDs", () => {
  it("is minted from its ID and route alone: the document sends to the route, the same ID gives the same DID and writes nothing twice", async () => {
    const { runtime, keys } = await freshVault();
    const first = await createDid(runtime, keys, DIRECT, DID);
    expect(first.existed).toBe(false);
    expect(first.created.data).toEqual({ didId: DID, did: first.minted.did, longFormDid: first.minted.longFormDid });
    expect(didcommServiceUris(first.minted.inputDocument)).toEqual([ENDPOINT]);
    const doc = await resolveDIDCommDoc(first.minted.longFormDid);
    expect(doc?.keyAgreement).toEqual([`${first.minted.longFormDid}#key-2`]);

    const again = await createDid(runtime, keys, DIRECT, DID);
    expect(again.existed).toBe(true);
    expect(again.created.cid).toBe(first.created.cid);
    expect(again.minted.did).toBe(first.minted.did);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.set.of("did.created")).toHaveLength(1);
    expect(fold.dids.entities.get(DID)).toMatchObject({ live: true, routeTarget: DIRECT, mediation: null });
    expect(routeOf(fold.dids.entities.get(DID)!)).toEqual(DIRECT);
    await runtime.close();
  });

  it("is minted under a derived UUIDv5 as under a minted UUIDv7; an ID of another version is refused and nothing written", async () => {
    const { runtime, keys } = await freshVault();
    const derived = "019b0000-0000-5000-8000-00000000000c" as DidId;
    const { created, minted } = await createDid(runtime, keys, DIRECT, derived);
    expect(created.data.didId).toBe(derived);
    expect((await scanVault(runtime.vault, keys)).dids.entities.get(derived)).toMatchObject({ live: true, created: { did: minted.did } });
    await expect(createDid(runtime, keys, DIRECT, "019b0000-0000-4000-8000-00000000000c" as DidId)).rejects.toBeInstanceOf(InvalidIdentifier);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.set.of("did.created")).toHaveLength(1);
    expect(fold.dids.entities.size).toBe(1);
    await runtime.close();
  });

  it("cannot be recreated for another route, and is not minted for a route that is not usable", async () => {
    const { runtime, keys } = await freshVault();
    await createDid(runtime, keys, DIRECT, DID);
    await expect(createDid(runtime, keys, { kind: "direct", endpoint: "https://elsewhere.example/" }, DID)).rejects.toBeInstanceOf(EntityConflict);
    await expect(createDid(runtime, keys, { kind: "direct", endpoint: "http://elsewhere.example/" })).rejects.toBeInstanceOf(Unusable);
    await expect(createDid(runtime, keys, mediatedRoute("019b0000-0000-5000-8000-0000000000ff" as MediationId))).rejects.toThrow(/no mediation/);
    const p = await party(await newMediator());
    await expect(createDid(p.runtime, p.keys, mediatedRoute(p.mediationId))).rejects.toBeInstanceOf(Unusable);
    expect((await scanVault(p.runtime.vault, p.keys)).set.of("did.created")).toEqual([]);
    await runtime.close();
    await p.runtime.close();
  });

  it("retires once: new sending and disclosure stop, the record stays", async () => {
    const { runtime, keys } = await freshVault();
    await createDid(runtime, keys, DIRECT, DID);
    const retired = await retireDid(runtime, keys, DID, "user");
    expect(retired.data).toEqual({ didId: DID, because: "user" });
    expect((await retireDid(runtime, keys, DID, "again")).cid).toBe(retired.cid);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.dids.entities.get(DID)).toMatchObject({ live: false, retired: "user" });
    await expect(disclose(null, runtime, keys, DID, { as: "direct" })).rejects.toBeInstanceOf(Unusable);
    await runtime.close();
  });
});

describe("disclosure", () => {
  test("a direct address is disclosed without a mediator; an oob disclosure carries the long form in an invitation", async () => {
    const { runtime, keys } = await freshVault();
    const { minted } = await createDid(runtime, keys, DIRECT, DID);
    const oob = await disclose(null, runtime, keys, DID, { as: "oob", goal: "Write to Alice" });
    expect(oob.disclosed.data).toMatchObject({ didId: DID, as: "oob", goal: "Write to Alice" });
    expect(oob.invitation).toEqual({ type: OOB_INVITATION, id: oob.disclosed.data.oobId, typ: "application/didcomm-plain+json", from: minted.longFormDid, body: { goal_code: "connect", goal: "Write to Alice", accept: ["didcomm/v2"] } });
    expect(parseInvitation(invitationUrl("https://estoc.net/i", oob.invitation!))).toEqual(oob.invitation);
    const direct = await disclose(null, runtime, keys, DID, { as: "direct" });
    expect(direct.disclosed.data).toEqual({ didId: DID, as: "direct", oobId: null, goal: null });
    expect(direct.invitation).toBeNull();
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.dids.entities.get(DID)?.disclosures).toHaveLength(2);
    await runtime.close();
  });

  it("republishes an invitation under its oobId, in sequence or concurrently, and refuses the ID for anything else", async () => {
    const { runtime, keys } = await freshVault();
    await createDid(runtime, keys, DIRECT, DID);
    const other = await createDid(runtime, keys, DIRECT);
    const invitation = { as: "oob", oobId: "invite-1", goal: "Write to Alice" } as const;
    const first = await disclose(null, runtime, keys, DID, invitation);
    const again = await disclose(null, runtime, keys, DID, invitation);
    expect(again.disclosed.cid).toBe(first.disclosed.cid);
    expect(again.invitation).toEqual(first.invitation);
    const [x, y] = await Promise.all([disclose(null, runtime, keys, DID, { ...invitation, oobId: "invite-2" }), disclose(null, runtime, keys, DID, { ...invitation, oobId: "invite-2" })]);
    expect(y.disclosed.cid).toBe(x.disclosed.cid);
    await expect(disclose(null, runtime, keys, DID, { ...invitation, goal: "Write to Bob" })).rejects.toBeInstanceOf(EntityConflict);
    await expect(disclose(null, runtime, keys, other.created.data.didId, invitation)).rejects.toThrow(/another DID/);
    expect((await scanVault(runtime.vault, keys)).set.of("did.disclosed").map((event) => event.data.oobId)).toEqual(["invite-1", "invite-2"]);
    await runtime.close();
  });

  test("a mediated address is disclosed only once the mediator holds it, over the arrangement's own link", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    await enroll(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    const route = mediatedRoute(p.mediationId);
    const { minted } = await createDid(p.runtime, p.keys, route, DID);
    await expect(disclose(null, p.runtime, p.keys, DID, { as: "oob" }, p.confirmations)).rejects.toBeInstanceOf(WrongMediator);
    mediator.refuseShared.add(minted.did);
    await expect(disclose(p.link, p.runtime, p.keys, DID, { as: "oob" }, p.confirmations)).rejects.toBeInstanceOf(Unregistered);
    expect((await scanVault(p.runtime.vault, p.keys)).dids.entities.get(DID)?.disclosures).toEqual([]);
    mediator.refuseShared.delete(minted.did);
    const disclosed = await disclose(p.link, p.runtime, p.keys, DID, { as: "oob", oobId: "invite-1" }, p.confirmations);
    expect(disclosed.invitation?.id).toBe("invite-1");
    expect(disclosed.invitation?.from).toBe(minted.longFormDid);
    expect(mediator.sharedRecipients.get(minted.did)).toBe(canonicalDid(p.created.data.me.did));
    await p.runtime.close();
  });
});
