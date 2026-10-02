import { describe, expect, it, test } from "vitest";

import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { inputDocumentOf, scanVault, vaultDraft, type Did, type DidId, type MediationProfile, type MessageId, type MintedDid } from "@estoc/vault";

import {
  ACCOUNT_REGISTER,
  Agent,
  RECIPIENT_ADD,
  REPLICA_ADD,
  STATUS_REQUEST,
  Unregistered,
  Unusable,
  addRecipients,
  canonicalDid,
  configureRoute,
  createDid,
  createMediation,
  disclose,
  dispatch,
  enroll,
  ensureRoute,
  holds,
  retireDid,
  selectMediation,
  send,
  transientConfirmations,
  type Confirmations,
} from "../src/index.js";
import type { FakeMediator } from "./fake-mediator.js";
import { didcomm, directParty, newMediator, party, posting, type Party } from "./helpers.js";

const PROFILE: MediationProfile = "replica-mediation/1.0";
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_ENDPOINT = "https://bob.example/didcomm";
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;

const sent = (mediator: FakeMediator, type: string): number => mediator.seenTypes.filter((seen) => seen === type).length;

/** A replica-mediation account with this runtime enrolled, its confirmations in the runtime's local options. */
async function enrolled(mediator: FakeMediator, fill = 1): Promise<Party & { confirmations: Confirmations; account: string }> {
  const p = await party(mediator, fill, {}, undefined, PROFILE);
  const confirmations = p.runtime.local.options;
  await enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId);
  return { ...p, confirmations, account: canonicalDid(p.created.data.me.did) };
}

async function address(p: Party): Promise<MintedDid> {
  return (await createDid(p.runtime, p.keys, await ensureRoute(p.runtime, p.keys, p.mediationId))).minted;
}

describe("adding recipients", () => {
  it("adds each address of the arrangement once, under a proof the address signed, and asks for none again", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const [a, b] = [await address(p), await address(p)];
    const first = await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(first.wanted).toEqual([a.did, b.did].sort());
    expect(first.added).toEqual(first.wanted);
    expect(first.refused).toEqual([]);
    expect(mediator.sharedRecipients).toEqual(
      new Map([
        [a.did, p.account],
        [b.did, p.account],
      ])
    );
    const again = await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(again).toMatchObject({ wanted: first.wanted, added: [], refused: [] });
    expect(sent(mediator, RECIPIENT_ADD)).toBe(2);
    expect(holds(again, a.did)).toBe(true);

    const c = await address(p);
    expect((await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId)).added).toEqual([c.did]);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(3);
    expect((await p.trace.read({ stream: "diag" })).filter((entry) => entry.type === "diag.recipients")).toHaveLength(3);
    await p.runtime.close();
  });

  it("asks for nothing before the mediator confirmed this runtime's own replica", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    await address(p);
    await expect(addRecipients(p.link, p.runtime, p.keys, transientConfirmations(), p.mediationId)).rejects.toBeInstanceOf(Unusable);
    const unregistered = await party(mediator, 2, {}, undefined, PROFILE);
    await expect(addRecipients(unregistered.link, unregistered.runtime, unregistered.keys, unregistered.runtime.local.options, unregistered.mediationId)).rejects.toBeInstanceOf(Unusable);
    const ordinary = await party(mediator, 3);
    await expect(addRecipients(ordinary.link, ordinary.runtime, ordinary.keys, ordinary.runtime.local.options, ordinary.mediationId)).rejects.toBeInstanceOf(Unusable);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(0);
    for (const each of [p, unregistered, ordinary]) await each.runtime.close();
  });

  it("holds a retired address still, and no address of another arrangement or of a direct route", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const retired = await createDid(p.runtime, p.keys, await ensureRoute(p.runtime, p.keys, p.mediationId));
    await retireDid(p.runtime, p.keys, retired.created.data.didId, "no longer given out");
    const direct = await configureRoute(p.runtime, p.keys, { kind: "direct", endpoint: "https://alice.example/didcomm" });
    await createDid(p.runtime, p.keys, direct.data.routeId);
    const other = await createMediation(p.runtime, p.keys, mediator.did as Did, undefined, PROFILE);
    const recipients = await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(recipients.wanted).toEqual([retired.minted.did]);
    expect([...mediator.sharedRecipients.keys()]).toEqual([retired.minted.did]);
    expect((await scanVault(p.runtime.vault, p.keys)).mediations.mediations.has(other.data.mediationId)).toBe(true);
    await p.runtime.close();
  });

  test("an address the mediator refuses stops no other, and is asked for again by the next run alone", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const [a, b] = [await address(p), await address(p)];
    mediator.refuseShared.add(a.did);
    const first = await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(first.added).toEqual([b.did]);
    expect(first.refused).toEqual([{ did: a.did, because: expect.stringMatching(/recipient-add was refused: .*quota/) }]);
    expect(holds(first, a.did)).toBe(false);
    expect(holds(first, b.did)).toBe(true);
    mediator.refuseShared.clear();
    expect((await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId)).added).toEqual([a.did]);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(3);
    await p.runtime.close();
  });

  test("an address whose document names no method a proof is signed under stops no other, and is not held", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const sound = await createDid(p.runtime, p.keys, await ensureRoute(p.runtime, p.keys, p.mediationId));
    const didId = "019b0000-0000-7000-8000-0000000000d1" as DidId;
    const input = inputDocumentOf(await p.keys.didKeys(didId), mediator.did);
    (input.verificationMethod as { type: string }[])[0]!.type = "Ed25519VerificationKey2018";
    const longFormDid = encodeLongForm(input);
    const unsigned = longToShort(longFormDid) as Did;
    await p.runtime.vault.commit([], [vaultDraft("did.created", { didId, did: unsigned, longFormDid: longFormDid as Did, boundRouteId: sound.created.data.boundRouteId })]);
    expect((await scanVault(p.runtime.vault, p.keys)).routes.dids.get(didId)).toMatchObject({ identity: "verified" });

    const recipients = await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(recipients.wanted).toEqual([sound.minted.did, unsigned].sort());
    expect(recipients.added).toEqual([sound.minted.did]);
    expect(recipients.refused).toEqual([{ did: unsigned, because: expect.stringMatching(/authentication method/) }]);
    expect(holds(recipients, unsigned)).toBe(false);
    expect([...mediator.sharedRecipients.keys()]).toEqual([sound.minted.did]);
    expect((await disclose(p.link, p.runtime, p.keys, sound.created.data.didId, { as: "oob" }, p.confirmations)).invitation?.from).toBe(sound.minted.longFormDid);
    await expect(disclose(p.link, p.runtime, p.keys, didId, { as: "oob" }, p.confirmations)).rejects.toBeInstanceOf(Unregistered);
    await p.runtime.close();
  });

  test("a run given up while a proof is being signed begins no request for it", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const a = await address(p);
    let signing = false;
    let givenUp = false;
    const keys = Object.assign(Object.create(p.keys) as typeof p.keys, {
      didKeys: async (didId: DidId) => {
        if (signing) givenUp = true;
        return p.keys.didKeys(didId);
      },
    });
    const proceed = (): void => {
      if (givenUp) throw new Error("given up");
      signing = true;
    };
    await expect(addRecipients(p.link, p.runtime, keys, p.confirmations, p.mediationId, proceed)).rejects.toThrow("given up");
    expect(sent(mediator, RECIPIENT_ADD)).toBe(0);
    expect(mediator.sharedRecipients.size).toBe(0);
    expect((await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId)).added).toEqual([a.did]);
    await p.runtime.close();
  });

  test("a mediator that stops answering leaves what it confirmed confirmed, and the rest to the next run", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const [a, b] = [await address(p), await address(p)];
    const [first, second] = [a.did, b.did].sort() as [Did, Did];
    mediator.intercept = (msg) => {
      if (msg.type === RECIPIENT_ADD && (msg.body as { recipient_did: string }).recipient_did === first) p.offline.reason = "no route to host";
      return undefined;
    };
    await expect(addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId)).rejects.toThrow(/no route to host/);
    mediator.intercept = null;
    p.offline.reason = null;
    const resumed = await addRecipients(p.link, p.runtime, p.keys, p.confirmations, p.mediationId);
    expect(resumed.added).toEqual([second]);
    expect(holds(resumed, first)).toBe(true);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(2);
    await p.runtime.close();
  });
});

describe("an address of a replica-mediation arrangement", () => {
  it("is disclosed only once its account holds it, which needs the runtime's confirmations", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const { minted, created } = await createDid(p.runtime, p.keys, await ensureRoute(p.runtime, p.keys, p.mediationId));
    const didId = created.data.didId;
    await expect(disclose(p.link, p.runtime, p.keys, didId, { as: "oob" })).rejects.toBeInstanceOf(Unusable);
    mediator.refuseShared.add(minted.did);
    await expect(disclose(p.link, p.runtime, p.keys, didId, { as: "oob" }, p.confirmations)).rejects.toBeInstanceOf(Unregistered);
    expect((await scanVault(p.runtime.vault, p.keys)).routes.dids.get(didId)?.disclosures).toEqual([]);
    mediator.refuseShared.clear();
    const disclosed = await disclose(p.link, p.runtime, p.keys, didId, { as: "oob" }, p.confirmations);
    expect(disclosed.invitation?.from).toBe(minted.longFormDid);
    expect(mediator.sharedRecipients.get(minted.did)).toBe(p.account);
    await p.runtime.close();
  });

  it("is added by the agent's connection after the enrollment, and by a disclosure through the agent", async () => {
    const mediator = await newMediator();
    const p = await party(mediator, 1, {}, undefined, PROFILE);
    const options = { didcomm, fetch: p.linkOptions.fetch as typeof fetch, WebSocket: mediator.WebSocket, trace: p.trace, confirmations: p.runtime.local.options, liveDelivery: false };
    const agent = await Agent.open(p, options);
    await agent.enroll(p.mediationId);
    await selectMediation(p.runtime, p.keys, p.mediationId);
    const a = await address(p);
    const [connection] = await agent.connect();
    expect(connection?.recipients).toMatchObject({ wanted: [a.did], added: [a.did], refused: [] });
    const b = await createDid(p.runtime, p.keys, await ensureRoute(p.runtime, p.keys, p.mediationId));
    await agent.disclose(b.created.data.didId, { as: "direct" });
    expect(mediator.sharedRecipients.has(b.minted.did)).toBe(true);
    agent.close();
    expect(mediator.seenTypes).toEqual([ACCOUNT_REGISTER, REPLICA_ADD, RECIPIENT_ADD, STATUS_REQUEST, RECIPIENT_ADD]);
    await p.runtime.close();
  });

  it("is held by its account before a package first discloses it as a sender", async () => {
    const mediator = await newMediator();
    const alice = await enrolled(mediator);
    const from = await address(alice);
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const wire = posting(() => new Response(null, { status: 202 }));
    const links = (mediationId: string) => (mediationId === alice.mediationId ? alice.link : null);
    const message = await send(alice.runtime, alice.keys, { channel: { localDid: from.did, peerDid: bob.longFormDid } }, { type: "https://didcomm.org/basicmessage/2.0/message", body: { content: "hello" } }, { messageId: MESSAGE });

    const unconfirmed = await dispatch(alice.runtime, alice.keys, message.action, { didcomm, fetch: wire.fetch, links });
    expect(unconfirmed).toMatchObject({ outcome: "pending" });
    expect((unconfirmed as { because: string }).because).toMatch(/could not be asked to hold/);
    mediator.refuseShared.add(from.did);
    const refused = await dispatch(alice.runtime, alice.keys, message.action, { didcomm, fetch: wire.fetch, links, confirmations: alice.confirmations });
    expect((refused as { because: string }).because).toMatch(/does not hold/);
    expect(wire.posts).toEqual([]);
    mediator.refuseShared.clear();
    expect(await dispatch(alice.runtime, alice.keys, message.action, { didcomm, fetch: wire.fetch, links, confirmations: alice.confirmations })).toMatchObject({ outcome: "submitted" });
    expect(mediator.sharedRecipients.get(from.did)).toBe(alice.account);
    expect(wire.posts).toHaveLength(1);
    await alice.runtime.close();
    await bob.runtime.close();
  });
});
