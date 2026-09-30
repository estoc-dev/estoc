import type { Event } from "@estoc/event-store";
import { describe, expect, it } from "vitest";

import { VaultEventSet, foldVault, foldVaultChecked, type Keys, type ReadObject, type VaultChecks, type VaultFold } from "../../src/index.js";
import { ENDPOINT, MEDIATION, ROUTE, expectOrderFree, type Scene } from "./helpers.js";
import { invitation, noObjects, receipt, resolved, vaults, type Local, type Peer } from "./scene.js";

const fold = (scene: Scene, keys: Keys | null, readObject: ReadObject = noObjects) => foldVaultChecked(scene.set(), keys, readObject);

/** A proof-free receipt from the peer at one of our DIDs, following the invitation. */
const follower = (scene: Scene, local: Local, peer: Peer, oobId: string, ordinal: number) => receipt(scene, { local, peer, resolution: resolved(scene, local.didId, peer), ordinal, overrides: { pthid: oobId } });

/** The invitations as comparable data. */
const picture = (vault: VaultFold) => [...vault.invitations.invitations.values()].map(({ oobId, localDid, status }) => ({ oobId, localDid, status }));

const expectSameOverEveryOrder = (scene: Scene, checks: Required<VaultChecks>) => expectOrderFree(scene.events, (set) => picture(foldVault(set, checks)));

describe("an invitation", () => {
  it("is every OOB disclosure and no direct one, available while its DID is live, whoever and however many wrote under it", async () => {
    const { scene, keys, a0, a1, b0, b1 } = await vaults();
    const disclosure = invitation(scene, a0);
    const again = invitation(scene, a0);
    scene.add("did.disclosed", { didId: a1.didId, as: "direct", oobId: null, goal: null });
    follower(scene, a0, b0, disclosure.data.oobId!, 1);
    follower(scene, a0, b1, disclosure.data.oobId!, 2);
    follower(scene, a0, b0, disclosure.data.oobId!, 3);
    const vault = await fold(scene, keys);
    expect(picture(vault)).toEqual([
      { oobId: disclosure.data.oobId, localDid: a0.did, status: { status: "available" } },
      { oobId: again.data.oobId, localDid: a0.did, status: { status: "available" } },
    ]);
    expect(vault.invitations.invitations.get(disclosure.cid)).toMatchObject({ disclosure, didId: a0.didId });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is unavailable on a retired or unknown DID, whatever was received under it", async () => {
    const { scene, keys, a0, a1, b0 } = await vaults();
    const retired = invitation(scene, a0);
    scene.add("did.retired", { didId: a0.didId, because: "done" });
    follower(scene, a0, b0, retired.data.oobId!, 1);
    const unknown = invitation(scene, { didId: "019b7000-0000-7000-8000-00000000ffff" as Local["didId"], did: a1.did, longFormDid: a1.longFormDid });
    const vault = await fold(scene, keys);
    expect(vault.invitations.invitations.get(retired.cid)).toMatchObject({ localDid: a0.did, status: { status: "unavailable", because: "the disclosed DID is retired" } });
    expect(vault.invitations.invitations.get(unknown.cid)).toMatchObject({ localDid: null, status: { status: "unavailable", because: "the disclosed DID has no consistent creation here" } });
    expectSameOverEveryOrder(scene, vault.checks);
  });

  it("is unavailable once its DID's route is retired, misconfigured or on a retired mediation, and while the mediation's grant is missing", async () => {
    const { scene, keys, a0 } = await vaults();
    const disclosure = invitation(scene, a0);
    const vault = await fold(scene, keys);
    const over = (events: readonly Event[]) => foldVault(VaultEventSet.of(events), vault.checks).invitations.invitations.get(disclosure.cid)!.status;

    const retired = scene.add("route.retired", { routeId: ROUTE, because: "moved" });
    expect(over(scene.events)).toEqual({ status: "unavailable", because: "the bound route is retired" });
    const settled = scene.events.filter((event) => event !== retired);

    expect(over([...settled, scene.add("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: ENDPOINT })])).toEqual({ status: "unavailable", because: "the bound route's configurations disagree" });
    expect(over([...settled, scene.add("mediation.retired", { mediationId: MEDIATION, because: "gone" })])).toEqual({ status: "unavailable", because: "the bound route's mediation is terminal" });

    const ungranted = settled.filter((event) => event.type !== "mediation.granted");
    expect(over(ungranted)).toEqual({ status: "unavailable", because: `mediation ${MEDIATION} is pending` });
    expect(over(settled)).toEqual({ status: "available" });
    expectOrderFree(ungranted, (set) => picture(foldVault(set, vault.checks)));
  });
});
