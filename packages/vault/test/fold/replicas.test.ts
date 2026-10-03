import { longToShort } from "@estoc/did-peer";
import { base64urlnopad } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";

import {
  InvalidPayload,
  Keys,
  foldMediations,
  foldReplicas,
  mediationIdOf,
  mintMediationDid,
  signReplicaGrant,
  verifyMediationKeys,
  verifyReplicaGrants,
  type Did,
  type GrantingMediation,
  type KeyName,
  type MediationId,
  type ReplicaId,
  type VaultEventSet,
} from "../../src/index.js";
import { AUTHOR2, OTHER_SEED, ROUTING_DID, Scene, expectOrderFree, openKeys } from "./helpers.js";

const MEDIATOR = "did:web:mediator.example" as Did;
const MEDIATOR2 = "did:web:other.example" as Did;
const MEDIATION = mediationIdOf(MEDIATOR);
const MEDIATION2 = mediationIdOf(MEDIATOR2);
const REPLICA = "019b2a43-4a56-7c0f-862f-194c0c4124a0" as ReplicaId;
const REPLICA2 = "019b2a44-0b1c-7d2e-9f3a-4b5c6d7e8f90" as ReplicaId;
let keys: Keys;
let account: GrantingMediation;
let account2: GrantingMediation;
/** the account another seed derives for the first arrangement */
let foreign: Did;

beforeAll(async () => {
  keys = await openKeys();
  account = { mediationId: MEDIATION, mediatorDid: MEDIATOR, me: { did: (await mintMediationDid(keys, MEDIATION)).longFormDid } };
  account2 = { mediationId: MEDIATION2, mediatorDid: MEDIATOR2, me: { did: (await mintMediationDid(keys, MEDIATION2)).longFormDid } };
  foreign = (await mintMediationDid(await openKeys(OTHER_SEED), MEDIATION)).longFormDid;
});

const arrangement = (scene: Scene, mediation: GrantingMediation) =>
  scene.add("mediation.created", {
    mediationId: mediation.mediationId,
    mediatorDid: mediation.mediatorDid,
    me: { keyName: `mediation/${mediation.mediationId}/me` as KeyName, did: mediation.me.did },
  });

async function enrolled(scene: Scene, mediation: GrantingMediation, replicaId: ReplicaId, signer = keys) {
  const grant = await signReplicaGrant(signer, mediation, replicaId);
  return scene.add("replica.created", { replicaId, mediationId: mediation.mediationId, grant });
}

/** The fold with the seed's verdicts folded in. */
async function checked(scene: Scene, seed = keys): Promise<(set: VaultEventSet) => ReturnType<typeof foldReplicas>> {
  const grantChecks = await verifyReplicaGrants(seed, scene.set());
  return (set) => foldReplicas(set, { grantChecks });
}

describe("the replica fold", () => {
  it("makes a replica a member of its arrangement by its grant and the seed's verdict, before any grant from the mediator, and pending before either", async () => {
    const scene = new Scene();
    const created = await enrolled(scene, account, REPLICA);
    expect(foldReplicas(scene.set()).replicas.get(REPLICA)).toMatchObject({ status: "pending", mediationId: MEDIATION, identity: "unchecked", faults: [] });
    expect((await checked(scene))(scene.set()).replicas.get(REPLICA)).toMatchObject({ status: "pending", identity: "unchecked", faults: [] });
    arrangement(scene, account);
    const unchecked = foldReplicas(scene.set());
    expect(unchecked.replicas.get(REPLICA)).toMatchObject({ status: "pending", identity: "unchecked" });
    expect(unchecked.members(MEDIATION)).toEqual([]);
    const fold = (await checked(scene))(scene.set());
    const grant = created.data.grant;
    expect(fold.replicas.get(REPLICA)).toMatchObject({ status: "member", mediationId: MEDIATION, grants: [grant], identity: "verified", faults: [] });
    expect(fold.replicas.get(REPLICA)?.longFormDid?.startsWith(`${fold.replicas.get(REPLICA)?.did}:`)).toBe(true);
    expect(fold.members(MEDIATION).map((replica) => replica.replicaId)).toEqual([REPLICA]);
    expect(fold.members(MEDIATION2)).toEqual([]);
    expectOrderFree(scene.events, await checked(scene));
  });

  it("counts the same grant recorded twice, by whichever writers, as one member, and each replica of an arrangement once", async () => {
    const scene = new Scene();
    arrangement(scene, account);
    const first = await enrolled(scene, account, REPLICA);
    scene.add("replica.created", first.data, { author: AUTHOR2 });
    await enrolled(scene, account, REPLICA2);
    const fold = (await checked(scene))(scene.set());
    expect(fold.replicas.get(REPLICA)).toMatchObject({ status: "member", grants: [first.data.grant] });
    expect(fold.members(MEDIATION).map((replica) => replica.replicaId)).toEqual([REPLICA, REPLICA2].sort());
    expectOrderFree(scene.events, await checked(scene));
  });

  it("makes one replica ID bound two ways a conflict that names no winner", async () => {
    const scene = new Scene();
    arrangement(scene, account);
    arrangement(scene, account2);
    await enrolled(scene, account, REPLICA);
    await enrolled(scene, account2, REPLICA);
    const fold = (await checked(scene))(scene.set());
    expect(fold.replicas.get(REPLICA)).toMatchObject({ status: "conflict", mediationId: null, did: null, longFormDid: null, grants: [], faults: ["grants disagree"] });
    expect(fold.members(MEDIATION)).toEqual([]);
    expect(fold.members(MEDIATION2)).toEqual([]);
    expectOrderFree(scene.events, await checked(scene));
  });

  it("refuses a binding that is not its arrangement's: another mediator, an arrangement whose creations disagree", async () => {
    const moved = new Scene();
    arrangement(moved, account2);
    await enrolled(moved, { ...account2, mediatorDid: MEDIATOR }, REPLICA);
    expect((await checked(moved))(moved.set()).replicas.get(REPLICA)).toMatchObject({ status: "conflict", faults: ["the grant's mediator is not the arrangement's"] });

    const conflicted = new Scene();
    arrangement(conflicted, account);
    arrangement(conflicted, { ...account, me: { did: foreign } });
    await enrolled(conflicted, account, REPLICA);
    expect((await checked(conflicted))(conflicted.set()).replicas.get(REPLICA)).toMatchObject({ status: "conflict", faults: [`the creations of mediation ${MEDIATION} disagree`] });
  });

  it("takes a grant spelling a did:peer:4 mediator by its short form as the arrangement's whose creation spells the long form", async () => {
    const long = (await mintMediationDid(await openKeys(OTHER_SEED), MEDIATION2)).longFormDid;
    const mediationId = mediationIdOf(long);
    const peer: GrantingMediation = { mediationId, mediatorDid: long, me: { did: (await mintMediationDid(keys, mediationId)).longFormDid } };
    const scene = new Scene();
    arrangement(scene, peer);
    await enrolled(scene, { ...peer, mediatorDid: longToShort(long) as Did }, REPLICA);
    expect((await checked(scene))(scene.set()).replicas.get(REPLICA)).toMatchObject({ status: "member", mediationId, identity: "verified", faults: [] });
  });

  it("keeps a member whatever the mediator's routing grants say, while the arrangement they contradict carries no mail", async () => {
    const members = async (grants: readonly Did[]) => {
      const scene = new Scene();
      arrangement(scene, account);
      await enrolled(scene, account, REPLICA);
      for (const routingDid of grants) scene.add("mediation.granted", { mediationId: MEDIATION, routingDid });
      expectOrderFree(scene.events, await checked(scene));
      const keyChecks = await verifyMediationKeys(keys, foldMediations(scene.set()));
      return {
        replica: (await checked(scene))(scene.set()).replicas.get(REPLICA)?.status,
        mediation: foldMediations(scene.set(), { keyChecks }).mediations.get(MEDIATION)?.status,
      };
    };
    expect(await members([])).toEqual({ replica: "member", mediation: "pending" });
    expect(await members([MEDIATOR])).toEqual({ replica: "member", mediation: "usable" });
    expect(await members([ROUTING_DID])).toEqual({ replica: "member", mediation: "conflict" });
    expect(await members([MEDIATOR, ROUTING_DID])).toEqual({ replica: "member", mediation: "conflict" });
  });

  it("sets aside a grant whose payload is not I-JSON as an invalid event, and folds the events around it", async () => {
    const scene = new Scene();
    arrangement(scene, account);
    const [header, body] = (await signReplicaGrant(keys, account, REPLICA2)).split(".") as [string, string];
    const text = new TextDecoder().decode(base64urlnopad.decode(body)).replace(MEDIATOR, "did:web:\\ud800");
    const bad = scene.foreign("replica.created", { replicaId: REPLICA2, mediationId: MEDIATION, grant: `${header}.${base64urlnopad.encode(new TextEncoder().encode(text))}.c2ln` });
    await enrolled(scene, account, REPLICA);
    const set = scene.set();
    expect(set.invalid.map((invalid) => [invalid.event, invalid.error.constructor])).toEqual([[bad, InvalidPayload]]);
    const fold = (await checked(scene))(set);
    expect(fold.members(MEDIATION).map((replica) => replica.replicaId)).toEqual([REPLICA]);
    expect(fold.replicas.has(REPLICA2)).toBe(false);
  });

  it("refuses a grant another seed signed, and leaves a retired arrangement's replicas its members", async () => {
    const foreign = new Scene();
    const other = await openKeys(OTHER_SEED);
    const theirs: GrantingMediation = { ...account, me: { did: (await mintMediationDid(other, MEDIATION)).longFormDid } };
    arrangement(foreign, theirs);
    await enrolled(foreign, theirs, REPLICA, other);
    expect((await checked(foreign))(foreign.set()).replicas.get(REPLICA)).toMatchObject({ status: "conflict", identity: "mismatch" });
    expect((await checked(foreign, other))(foreign.set()).replicas.get(REPLICA)).toMatchObject({ status: "member", identity: "verified" });

    const retired = new Scene();
    arrangement(retired, account);
    await enrolled(retired, account, REPLICA);
    retired.add("mediation.retired", { mediationId: MEDIATION as MediationId, because: "replaced" });
    expect((await checked(retired))(retired.set()).members(MEDIATION).map((replica) => replica.replicaId)).toEqual([REPLICA]);
  });
});
