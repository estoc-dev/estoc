import type { Event } from "@estoc/event-store";
import { describe, expect, it } from "vitest";

import { VaultEventSet, foldVault, foldVaultChecked, mintMediationDid, type Did, type KeyName, type Keys, type ReadObject, type VaultChecks, type VaultFold } from "../../src/index.js";
import { MEDIATION, MEDIATION2, ROUTING_DID, expectOrderFree, type Scene } from "./helpers.js";
import { invitation, noObjects, receipt, resolved, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

/** A proof-free receipt from the peer at one of our DIDs, following the invitation. */
const follower = (scene: Scene, local: Local, peer: Peer, oobId: string) => receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), overrides: { pthid: oobId } });

const picture = (vault: VaultFold) => [...vault.invitations.invitations.values()].map(({ oobId, localDid, status }) => ({ oobId, localDid, status }));

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

describe("an invitation", () => {
  it("is every OOB disclosure and no direct one, available while its DID is live, whoever and however many wrote under it", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const disclosure = invitation(scene, a0);
    const again = invitation(scene, a0);
    scene.add("did.disclosed", { didId: a1.didId, as: "direct", oobId: null, goal: null });
    follower(scene, a0, b0, disclosure.data.oobId!);
    follower(scene, a0, b1, disclosure.data.oobId!);
    follower(scene, a0, b0, disclosure.data.oobId!);
    const vault = await fold(scene, keys);
    expect(picture(vault)).toEqual([
      { oobId: disclosure.data.oobId, localDid: a0.did, status: { status: "available" } },
      { oobId: again.data.oobId, localDid: a0.did, status: { status: "available" } },
    ]);
    expect(vault.invitations.invitations.get(disclosure.cid)).toMatchObject({ disclosure, didId: a0.didId });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is unavailable while its ID names more than one disclosure, on one DID or two, while the DIDs and what was received under it are as they were", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const first = invitation(scene, a0);
    invitation(scene, a0, first.data.oobId!);
    invitation(scene, a1, first.data.oobId!);
    const apart = invitation(scene, a0);
    const fromB0 = follower(scene, a0, b0, first.data.oobId!);
    const fromB1 = follower(scene, a0, b1, first.data.oobId!);
    const vault = await fold(scene, keys);
    const twice = { status: "unavailable", because: "the invitation's ID names more than one disclosure" };
    expect(picture(vault)).toEqual([
      { oobId: first.data.oobId, localDid: a0.did, status: twice },
      { oobId: first.data.oobId, localDid: a0.did, status: twice },
      { oobId: first.data.oobId, localDid: a1.did, status: twice },
      { oobId: apart.data.oobId, localDid: a0.did, status: { status: "available" } },
    ]);
    expect(vault.routes.dids.get(a0.didId)!.live).toBe(true);
    for (const source of [fromB0, fromB1]) expect(vault.channels.sources.get(source.cid)).toMatchObject({ localDidId: a0.didId, standing: { status: "complete" } });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is unavailable on a retired or unknown DID, whatever was received under it", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const retired = invitation(scene, a0);
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    follower(scene, a0, b0, retired.data.oobId!);
    const unknown = invitation(scene, { didId: "019b7000-0000-7000-8000-00000000ffff" as Local["didId"], did: a1.did, longFormDid: a1.longFormDid });
    const vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(retired.cid)).toMatchObject({ localDid: a0.did, status: { status: "unavailable", because: "the disclosed DID is retired" } });
    expect(vault.invitations.invitations.get(unknown.cid)).toMatchObject({ localDid: null, status: { status: "unavailable", because: "the disclosed DID has no consistent creation here" } });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is unavailable once its DID's mediation is retired, while a second arrangement routes through the same DID, and while the grant is missing", async () => {
    const { scene, keys, a0 } = await vaults();
    const disclosure = invitation(scene, a0);
    const over = async (events: readonly Event[]) => (await foldVaultChecked(VaultEventSet.of(events), keys, noObjects)).invitations.invitations.get(disclosure.cid)!.status;
    const settled = [...scene.events];

    expect(await over([...settled, scene.add("mediation.retired", { mediationId: MEDIATION, because: "gone" })])).toEqual({ status: "unavailable", because: "the disclosed DID's mediation is terminal" });

    const me2 = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
    const second = [...settled, scene.add("mediation.created", { mediationId: MEDIATION2, mediatorDid: "did:web:mediator.example" as Did, me: { keyName: `mediation/${MEDIATION2}/me` as KeyName, did: me2 } }), scene.add("mediation.granted", { mediationId: MEDIATION2, routingDid: ROUTING_DID })];
    expect(await over(second)).toEqual({ status: "unavailable", because: `several arrangements route through ${ROUTING_DID}: ${MEDIATION}, ${MEDIATION2}` });

    const ungranted = settled.filter((event) => event.type !== "mediation.granted");
    expect(await over(ungranted)).toEqual({ status: "unavailable", because: `no mediation arrangement routes through ${ROUTING_DID}` });
    expect(await over(settled)).toEqual({ status: "available" });
    const vault = await fold(scene, keys);
    expectOrderFree(ungranted, (set) => picture(foldVault(set, vault.checks)));
  });
});
