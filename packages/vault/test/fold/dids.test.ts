import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { beforeAll, describe, expect, it } from "vitest";

import {
  Keys,
  VaultEventSet,
  foldMediations,
  foldDids,
  foldWithSeed,
  inputDocumentOf,
  mintDid,
  mintMediationDid,
  requiredReceivingSet,
  verifyDidKeys,
  type Did,
  type DidId,
  type KeyName,
  type DidFold,
  type VaultData,
} from "../../src/index.js";
import {
  DIRECT,
  DID_ID,
  DID_ID2,
  DID_ID3,
  MEDIATED,
  MEDIATION,
  MEDIATION2,
  OTHER_SEED,
  ROUTING_DID,
  ROUTING_DID2,
  Scene,
  checksOf,
  createdDid,
  expectOrderFree,
  foldChecked,
  mediatedRoute,
  openKeys,
  type KeyChecks,
} from "./helpers.js";

let keys: Keys;
let me: Did;
let me2: Did;

beforeAll(async () => {
  keys = await openKeys();
  me = (await mintMediationDid(keys, MEDIATION)).longFormDid;
  me2 = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
});

const unchecked = (set: VaultEventSet): DidFold => foldDids(set, foldMediations(set));
const checked = async (scene: Scene): Promise<DidFold> => (await foldWithSeed(scene.set(), keys)).dids;
const both = (set: VaultEventSet, checks: KeyChecks) => foldChecked(set, checks);

/** A DID entity whose document is the seed's, edited before the long form is computed. */
async function editedDid(scene: Scene, didId: DidId, edit: (document: Record<string, unknown>) => void, service: string | null = ROUTING_DID): Promise<VaultData["did.created"]> {
  const document = inputDocumentOf(await keys.didKeys(didId), service) as Record<string, unknown>;
  edit(document);
  const longFormDid = encodeLongForm(document as never) as Did;
  const data = { didId, did: longToShort(longFormDid) as Did, longFormDid };
  scene.add("did.created", data);
  return data;
}

const secondArrangement = (scene: Scene, routingDid = ROUTING_DID): void => {
  scene.add("mediation.created", { mediationId: MEDIATION2, mediatorDid: routingDid, me: { keyName: `mediation/${MEDIATION2}/me` as KeyName, did: me2 } });
  scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid });
};

describe("the DID fold", () => {
  it("makes an entity live when its record is consistent, the seed derives its keys, its document sends through a usable arrangement or to an endpoint, and nothing retired it", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, MEDIATED);
    const direct = await createdDid(scene, keys, DID_ID2, DIRECT);
    const disclosure = scene.add("did.disclosed", { didId: DID_ID, as: "oob", oobId: "019b2a57-a947-7502-8fee-4d80d949dbcb", goal: null });
    const dids = await checked(scene);
    const did = dids.entities.get(DID_ID)!;
    expect(did).toMatchObject({
      created,
      live: true,
      conflict: false,
      faults: [],
      retired: null,
      identity: "verified",
      routeTarget: MEDIATED,
      mediations: [MEDIATION],
      keyNames: { authentication: `did/${DID_ID}/authentication`, keyAgreement: `did/${DID_ID}/key-agreement` },
      methodIds: { authentication: [`${created.longFormDid}#key-1`], keyAgreement: [`${created.longFormDid}#key-2`] },
    });
    expect(did.disclosures).toEqual([disclosure]);
    expect(did.resolution?.did).toBe(created.did);
    expect(dids.entities.get(DID_ID2)).toMatchObject({ live: true, routeTarget: DIRECT, mediations: [], disclosures: [] });
    expect(dids.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
    expect(dids.entityOfKey(`did/${DID_ID2}/authentication` as KeyName)).toBe(DID_ID2);
    expect(dids.entityOfKey(`did/${DID_ID3}/authentication` as KeyName)).toBeNull();
    expect(dids.entityOfDid(created.did)).toBe(DID_ID);
    expect(dids.entityOfDid(created.longFormDid)).toBe(DID_ID);
    expect(dids.entityOfDid(direct.did)).toBe(DID_ID2);
    expect(dids.entityOfDid("did:web:bob.example")).toBeNull();
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).dids);
  });

  it("grants nothing to an entity the seed has not confirmed: no verdict map, a map without the ID, or a document another seed made", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, MEDIATED);
    await createdDid(scene, await openKeys(OTHER_SEED), DID_ID2, MEDIATED);
    const mediations = foldMediations(scene.set(), { keyChecks: new Map([[MEDIATION, "verified"]]) });
    for (const dids of [foldDids(scene.set(), mediations), foldDids(scene.set(), mediations, { keyChecks: new Map() }), foldDids(scene.set(), mediations, { keyChecks: new Map([[DID_ID2, "verified"]]) })]) {
      expect(dids.entities.get(DID_ID)).toMatchObject({ live: false, conflict: false, identity: "unchecked", faults: ["the keys are not yet checked against the seed"] });
      expect(dids.receipt(DID_ID)).toBe("pending");
      expect(dids.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
      expect(dids.entityOfDid(created.did)).toBe(DID_ID);
    }
    expect(foldDids(scene.set(), mediations).entities.get(DID_ID2)?.live).toBe(false);
    const keyChecks = await verifyDidKeys(keys, foldDids(scene.set(), mediations));
    expect(keyChecks).toEqual(new Map([[DID_ID, "verified"], [DID_ID2, "mismatch"]]));
    const dids = foldDids(scene.set(), mediations, { keyChecks });
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: true, identity: "verified", faults: [] });
    expect(dids.entities.get(DID_ID2)).toMatchObject({ live: false, conflict: true, identity: "mismatch", faults: ["the seed does not derive the entity's keys"] });
    expect(dids.entityOfKey(`did/${DID_ID2}/key-agreement` as KeyName)).toBe(DID_ID2);
    expect(dids.entityOfDid(dids.entities.get(DID_ID2)!.created!.did)).toBeNull();
    expect(dids.receipt(DID_ID2)).toBe("terminal");
    expect(foldDids(scene.set(), foldMediations(scene.set()), { keyChecks }).entities.get(DID_ID)).toMatchObject({ live: false, mediations: [], faults: [`mediation ${MEDIATION} is pending`] });
  });

  it("keeps an entity from being live while no arrangement routes through its DID, while that arrangement is not usable, and once it is retired", async () => {
    const scene = new Scene();
    const created = await createdDid(scene, keys, DID_ID, MEDIATED);
    expect((await checked(scene)).entities.get(DID_ID)).toMatchObject({ live: false, conflict: false, faults: [`no mediation arrangement routes through ${ROUTING_DID}`], routeTarget: MEDIATED, mediations: [] });
    scene.add("mediation.created", { mediationId: MEDIATION, mediatorDid: ROUTING_DID, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    expect((await checked(scene)).entities.get(DID_ID)).toMatchObject({ live: false, faults: [`no mediation arrangement routes through ${ROUTING_DID}`] });
    scene.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    expect((await checked(scene)).entities.get(DID_ID)).toMatchObject({ live: true, faults: [], mediations: [MEDIATION] });
    scene.add("mediation.retired", { mediationId: MEDIATION, because: "moved" });
    expect((await checked(scene)).entities.get(DID_ID)).toMatchObject({ live: false, faults: [`mediation ${MEDIATION} is retired`], routeTarget: MEDIATED, mediations: [], created });
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).dids);
  });

  it("holds an entity pending, with every arrangement required, while several usable arrangements route through its DID", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    secondArrangement(scene);
    const created = await createdDid(scene, keys, DID_ID, MEDIATED);
    const { mediations, dids } = await foldWithSeed(scene.set(), keys);
    expect(mediations.through(ROUTING_DID).map((mediation) => mediation.mediationId)).toEqual([MEDIATION, MEDIATION2]);
    expect(mediations.through(ROUTING_DID2)).toEqual([]);
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: false, conflict: false, created, mediations: [MEDIATION, MEDIATION2], faults: [`several arrangements route through ${ROUTING_DID}: ${MEDIATION}, ${MEDIATION2}`] });
    expect(dids.receipt(DID_ID)).toBe("pending");
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION, MEDIATION2]));
    scene.add("mediation.retired", { mediationId: MEDIATION2, because: "replaced" });
    const settled = await foldWithSeed(scene.set(), keys);
    expect(settled.dids.entities.get(DID_ID)).toMatchObject({ live: true, mediations: [MEDIATION] });
    expect(requiredReceivingSet(settled.mediations, settled.dids)).toEqual(new Set([MEDIATION]));
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).dids);
  });

  it("makes a document that names no one route a conflict: no DIDComm service, or an endpoint that is neither a DID nor an HTTPS or WSS URL", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    await editedDid(scene, DID_ID, () => {}, null);
    await editedDid(scene, DID_ID2, () => {}, "http://ingress.example/didcomm");
    await createdDid(scene, keys, DID_ID3, { kind: "direct", endpoint: "wss://ingress.example/ws" });
    const dids = await checked(scene);
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: false, conflict: true, identity: "verified", routeTarget: null, faults: ["the document does not send to exactly one endpoint"] });
    expect(dids.entities.get(DID_ID2)).toMatchObject({ live: false, conflict: true, routeTarget: null, faults: ["the document sends to http://ingress.example/didcomm, neither a DID nor an HTTPS or WSS URL"] });
    expect(dids.entities.get(DID_ID3)).toMatchObject({ live: true, routeTarget: { kind: "direct", endpoint: "wss://ingress.example/ws" } });
    expect(dids.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
    expect(dids.receipt(DID_ID)).toBe("terminal");
    expect(dids.receipt(DID_ID2)).toBe("terminal");
  });

  it("takes a service for a routing DID only when it is a DID: a bare `did:` or a DID URL, which no grant could name, is a conflict and never a wait", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    await editedDid(scene, DID_ID, () => {}, "did:");
    await editedDid(scene, DID_ID2, () => {}, `${ROUTING_DID}#key-1`);
    await editedDid(scene, DID_ID3, () => {}, `${ROUTING_DID}/inbox?v=1`);
    const dids = await checked(scene);
    for (const [didId, uri] of [[DID_ID, "did:"], [DID_ID2, `${ROUTING_DID}#key-1`], [DID_ID3, `${ROUTING_DID}/inbox?v=1`]] as const) {
      expect(dids.entities.get(didId)).toMatchObject({ live: false, conflict: true, identity: "verified", routeTarget: null, mediations: [], faults: [`the document sends to ${uri}, neither a DID nor an HTTPS or WSS URL`] });
      expect(dids.receipt(didId)).toBe("terminal");
    }
  });

  it("records a document whose service or key does not read as that entity's conflict and folds and verifies every other entity", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const noEndpoint = await editedDid(scene, DID_ID, (document) => {
      (document.service as Record<string, unknown>[])[0]!.serviceEndpoint = {};
    });
    const badKey = await editedDid(scene, DID_ID2, (document) => {
      (document.verificationMethod as Record<string, unknown>[])[0]!.publicKeyMultibase = "z2Bad";
    });
    const good = await createdDid(scene, keys, DID_ID3, MEDIATED);
    const before = unchecked(scene.set());
    expect(before.entities.get(DID_ID)).toMatchObject({ conflict: true, created: noEndpoint, resolution: null });
    expect(before.entities.get(DID_ID)?.faults[0]).toMatch(/serviceEndpoint|service/i);
    expect(before.entities.get(DID_ID2)).toMatchObject({ conflict: false, created: badKey });
    const keyChecks = await verifyDidKeys(keys, before);
    expect(keyChecks).toEqual(new Map([[DID_ID2, "mismatch"], [DID_ID3, "verified"]]));
    const dids = await checked(scene);
    expect(dids.entities.get(DID_ID)).toMatchObject({ conflict: true, live: false });
    expect(dids.entities.get(DID_ID2)).toMatchObject({ conflict: true, live: false, identity: "mismatch" });
    expect(dids.entities.get(DID_ID3)).toMatchObject({ conflict: false, live: true, created: good, identity: "verified" });
  });

  it("makes disagreeing creations, an unreadable record or a shared spelling a conflict that leaves the spelling map but still answers to its key names", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, MEDIATED);
    const elsewhere = await mintDid(keys, DID_ID, DIRECT);
    scene.add("did.created", { ...created, did: elsewhere.did, longFormDid: elsewhere.longFormDid });
    const minted = await mintDid(keys, DID_ID2, MEDIATED);
    scene.add("did.created", { didId: DID_ID2, did: minted.did, longFormDid: `${minted.did}:z2Broken` as Did });
    const third = await createdDid(scene, keys, DID_ID3, MEDIATED);
    scene.add("did.created", { ...third, didId: "019b6a10-12c0-7410-89ab-38e54b097c22" as DidId });
    const dids = await checked(scene);
    expect(dids.entities.get(DID_ID)).toMatchObject({ conflict: true, live: false, created: null, resolution: null, faults: ["creations disagree"], methodIds: { authentication: [], keyAgreement: [] } });
    expect(dids.entities.get(DID_ID2)).toMatchObject({ conflict: true, live: false, resolution: null });
    expect(dids.entities.get(DID_ID2)?.faults[0]).toMatch(/long form|resolve|multibase|hash/i);
    expect(dids.entities.get(DID_ID3)).toMatchObject({ conflict: true, live: false, faults: [`${third.did} is also entity 019b6a10-12c0-7410-89ab-38e54b097c22`, `${third.longFormDid} is also entity 019b6a10-12c0-7410-89ab-38e54b097c22`] });
    for (const didId of [DID_ID, DID_ID2, DID_ID3]) expect(dids.entityOfKey(`did/${didId}/key-agreement` as KeyName)).toBe(didId);
    expect(dids.entityOfDid(third.did)).toBeNull();
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).dids);
  });

  it("counts a spelling claimed by any creation of a conflicted entity against the entity that also records it, in either canonical order", async () => {
    for (const ownFirst of [true, false]) {
      const scene = new Scene();
      mediatedRoute(scene, { me });
      const own = await mintDid(keys, DID_ID, MEDIATED);
      const other = await createdDid(scene, keys, DID_ID2, MEDIATED);
      const claims = [
        { didId: DID_ID, did: own.did, longFormDid: own.longFormDid },
        { ...other, didId: DID_ID },
      ];
      for (const claim of ownFirst ? claims : claims.reverse()) scene.add("did.created", claim);
      const dids = await checked(scene);
      expect(dids.entities.get(DID_ID)).toMatchObject({ conflict: true, live: false });
      expect(dids.entities.get(DID_ID)?.faults).toContain("creations disagree");
      expect(dids.entities.get(DID_ID2)).toMatchObject({ conflict: true, live: false, faults: [`${other.did} is also entity ${DID_ID}`, `${other.longFormDid} is also entity ${DID_ID}`] });
      expect(dids.entityOfDid(other.did)).toBeNull();
      expect(dids.entityOfKey(`did/${DID_ID2}/key-agreement` as KeyName)).toBe(DID_ID2);
      const checks = await checksOf(scene.events, keys);
      expectOrderFree(scene.events, (set) => both(set, checks).dids);
    }
  });

  it("retires an entity out of liveness and the desired set while keeping it in the reverse maps", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    const created = await createdDid(scene, keys, DID_ID, MEDIATED);
    scene.add("did.retired", { didId: DID_ID, because: "contact-deleted" });
    scene.add("did.retired", { didId: DID_ID2, because: "never created" });
    const dids = await checked(scene);
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: false, conflict: false, retired: "contact-deleted", faults: [] });
    expect(dids.entities.get(DID_ID2)).toMatchObject({ live: false, created: null, faults: ["no creation"], retired: "never created" });
    expect(dids.entityOfKey(`did/${DID_ID}/key-agreement` as KeyName)).toBe(DID_ID);
    expect(dids.entityOfDid(created.did)).toBe(DID_ID);
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).dids);
  });

  it("lists disclosures in canonical order", async () => {
    const scene = new Scene();
    mediatedRoute(scene, { me });
    await createdDid(scene, keys, DID_ID, MEDIATED);
    await createdDid(scene, keys, DID_ID2, MEDIATED);
    const later = scene.add("did.disclosed", { didId: DID_ID, as: "oob", oobId: "019b2a57-a947-7502-8fee-4d80d949dbcb", goal: null }, { at: "2026-09-14T00:00:00.000Z" });
    const earlier = scene.add("did.disclosed", { didId: DID_ID, as: "direct", oobId: null, goal: "hi" }, { at: "2026-09-12T00:00:00.000Z" });
    const dids = await checked(scene);
    expect(dids.entities.get(DID_ID)?.disclosures).toEqual([earlier, later]);
    const checks = await checksOf(scene.events, keys);
    expectOrderFree(scene.events, (set) => both(set, checks).dids);
  });
});

describe("receipt eligibility and the required receiving set", () => {
  async function scene(): Promise<{ scene: Scene; created: VaultData["did.created"]; retiredDid: VaultData["did.created"] }> {
    const s = new Scene();
    mediatedRoute(s, { me });
    mediatedRoute(s, { me: me2 }, MEDIATION2, ROUTING_DID2);
    s.add("mediation.selected", { mediationId: MEDIATION });
    const created = await createdDid(s, keys, DID_ID, MEDIATED);
    const retiredDid = await createdDid(s, keys, DID_ID2, { kind: "mediated", routingDid: ROUTING_DID2 });
    s.add("did.retired", { didId: DID_ID2, because: "rotated" });
    return { scene: s, created, retiredDid };
  }

  it("lets a live entity and a retired entity receive alike, and holds the retired one waiting, not ended, once the arrangement under it is retired", async () => {
    const { scene: s } = await scene();
    const dids = await checked(s);
    expect(dids.receipt(DID_ID)).toBe("eligible");
    expect(dids.receipt(DID_ID2)).toBe("eligible");
    expect(dids.receipt(DID_ID3)).toBe("terminal");
    expect(dids.entities.get(DID_ID2)).toMatchObject({ live: false, retired: "rotated" });
    s.add("mediation.retired", { mediationId: MEDIATION2, because: "moved" });
    expect((await checked(s)).receipt(DID_ID2)).toBe("pending");
    expect((await checked(s)).entities.get(DID_ID2)).toMatchObject({ mediations: [], faults: [`mediation ${MEDIATION2} is retired`] });
  });

  it("waits, rather than ends, when every arrangement known to name its routing DID is retired or ungranted: the grant that routes it may not have arrived, and routes it once it does", async () => {
    const s = new Scene();
    mediatedRoute(s, { me });
    s.add("mediation.retired", { mediationId: MEDIATION, because: "replaced" });
    s.add("mediation.created", { mediationId: MEDIATION2, mediatorDid: ROUTING_DID, me: { keyName: `mediation/${MEDIATION2}/me` as KeyName, did: me2 } });
    const created = await createdDid(s, keys, DID_ID, MEDIATED);
    let { mediations, dids } = await foldWithSeed(s.set(), keys);
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: false, conflict: false, created, mediations: [], faults: [`mediation ${MEDIATION} is retired`] });
    expect(dids.receipt(DID_ID)).toBe("pending");
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set());
    const grant = s.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    ({ mediations, dids } = await foldWithSeed(s.set(), keys));
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: true, mediations: [MEDIATION2], faults: [] });
    expect(dids.receipt(DID_ID)).toBe("eligible");
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION2]));
    expect((await foldWithSeed(VaultEventSet.of(s.events.filter((event) => event !== grant)), keys)).dids.receipt(DID_ID)).toBe("pending");
    const checks = await checksOf(s.events, keys);
    expectOrderFree(s.events, (set) => both(set, checks).dids);
  });

  it("settles what is terminal before what is missing: keys the seed does not derive are terminal without any arrangement, a retired entity without one only waits", async () => {
    const s = new Scene();
    const retiredDid = await createdDid(s, keys, DID_ID, MEDIATED);
    s.add("did.retired", { didId: DID_ID, because: "rotated" });
    expect((await checked(s)).entities.get(DID_ID)).toMatchObject({ created: retiredDid, faults: [`no mediation arrangement routes through ${ROUTING_DID}`] });
    expect((await checked(s)).receipt(DID_ID)).toBe("pending");
    const elsewhere = new Scene();
    await createdDid(elsewhere, await openKeys(OTHER_SEED), DID_ID2, MEDIATED);
    const dids = await checked(elsewhere);
    expect(dids.entities.get(DID_ID2)).toMatchObject({ identity: "mismatch", conflict: true });
    expect(dids.receipt(DID_ID2)).toBe("terminal");
  });

  it("defers while a recoverable prerequisite is missing and rejects a conflicted entity for good", async () => {
    const s = new Scene();
    await createdDid(s, keys, DID_ID, MEDIATED);
    expect((await checked(s)).receipt(DID_ID)).toBe("pending");
    s.add("mediation.created", { mediationId: MEDIATION, mediatorDid: ROUTING_DID, me: { keyName: `mediation/${MEDIATION}/me` as KeyName, did: me } });
    expect((await checked(s)).receipt(DID_ID)).toBe("pending");
    s.add("mediation.granted", { mediationId: MEDIATION, routingDid: ROUTING_DID });
    expect(unchecked(s.set()).receipt(DID_ID)).toBe("pending");
    expect((await checked(s)).receipt(DID_ID)).toBe("eligible");
    const mediations = (await foldWithSeed(s.set(), keys)).mediations;
    expect(foldDids(s.set(), mediations, { keyChecks: new Map([[DID_ID, "mismatch"]]) }).receipt(DID_ID)).toBe("terminal");
    s.add("mediation.retired", { mediationId: MEDIATION, because: "gone" });
    expect((await checked(s)).receipt(DID_ID)).toBe("pending");
  });

  it("requires the preferred mediation and every mediation a live or retired DID is routed by", async () => {
    const { scene: s } = await scene();
    const bare = both(s.set(), { mediations: new Map(), dids: new Map() });
    expect(requiredReceivingSet(bare.mediations, bare.dids)).toEqual(new Set());
    let { mediations, dids } = await foldWithSeed(s.set(), keys);
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("did.retired", { didId: DID_ID, because: "done" });
    ({ mediations, dids } = await foldWithSeed(s.set(), keys));
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("mediation.selected", { mediationId: MEDIATION2 });
    ({ mediations, dids } = await foldWithSeed(s.set(), keys));
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION, MEDIATION2]));
    s.add("mediation.retired", { mediationId: MEDIATION, because: "moved" });
    ({ mediations, dids } = await foldWithSeed(s.set(), keys));
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION2]));
    const checks = await checksOf(s.events, keys);
    expectOrderFree(s.events, (set) => {
      const folded = both(set, checks);
      return [...requiredReceivingSet(folded.mediations, folded.dids)];
    });
  });

  it("keeps a dependency whose DID only waits for the seed's verdict, and drops it once the verdict is a mismatch", async () => {
    const { scene: s } = await scene();
    const { mediations } = await checksOf(s.events, keys);
    const waiting = both(s.set(), { mediations, dids: new Map() });
    expect(waiting.dids.receipt(DID_ID2)).toBe("pending");
    expect(requiredReceivingSet(waiting.mediations, waiting.dids)).toEqual(new Set([MEDIATION, MEDIATION2]));
    const verified = both(s.set(), { mediations, dids: new Map([[DID_ID2, "verified"]]) });
    expect(verified.dids.receipt(DID_ID2)).toBe("eligible");
    expect(requiredReceivingSet(verified.mediations, verified.dids)).toEqual(new Set([MEDIATION, MEDIATION2]));
    const mismatch = both(s.set(), { mediations, dids: new Map([[DID_ID2, "mismatch"]]) });
    expect(mismatch.dids.receipt(DID_ID2)).toBe("terminal");
    expect(requiredReceivingSet(mismatch.mediations, mismatch.dids)).toEqual(new Set([MEDIATION]));
    s.add("mediation.retired", { mediationId: MEDIATION2, because: "moved" });
    const retired = both(s.set(), { mediations: (await checksOf(s.events, keys)).mediations, dids: new Map() });
    expect(retired.dids.receipt(DID_ID2)).toBe("pending");
    expect(requiredReceivingSet(retired.mediations, retired.dids)).toEqual(new Set([MEDIATION]));
  });

  it("drops a mediation from the required set once it is unusable, whatever depends on it", async () => {
    const { scene: s } = await scene();
    s.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID });
    const { mediations, dids } = await foldWithSeed(s.set(), keys);
    expect(requiredReceivingSet(mediations, dids)).toEqual(new Set([MEDIATION]));
    expect(dids.receipt(DID_ID2)).toBe("pending");
    expect(dids.entities.get(DID_ID)).toMatchObject({ live: true, mediations: [MEDIATION] });
  });
});
