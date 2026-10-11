import { describe, expect, test } from "vitest";

import { parseStrict, type JsonObject } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import { KEY_AGREEMENT_METHOD, Keys, authorizedMethodIds, mintDid, peerResolution, sameDid, signFromPrior, type Did, type DidId, type DidUrl, type MintedDid, type RouteTarget } from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { ENCRYPTED_MIME, PLAIN_TYP, secretsResolverFor, unpackMessage, type DidcommApi, type IMessage, type UnpackMetadata } from "../src/protocol/didcomm.js";
import { FORWARD } from "../src/protocol/spec.js";
import { addressingOf, carry, recipientEndOf, seal, type Ends } from "../src/ends.js";
import { MismatchedEnds } from "../src/errors.js";
import { didcommDocumentOf } from "../src/evidence.js";
import { secretsOf } from "../src/keyring.js";
import { resolve } from "../src/resolver.js";
import { MEDIATOR_HTTP } from "./fake-mediator.js";
import { didcomm, holdAddresses, mediatedParty, newMediator, seedOf } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const ALICE_PRIOR = "019b0000-0000-7000-8000-00000000000b" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const ALICE_DIRECT: RouteTarget = { kind: "direct", endpoint: "https://alice.example/didcomm" };
const BOB_DIRECT: RouteTarget = { kind: "direct", endpoint: "https://bob.example/didcomm" };
const PROOF_IAT = 1_757_700_000;

/** Someone with no vault: the keys a seed derives, and one DID minted from them. */
interface Bare {
  keys: Keys;
  minted: MintedDid;
}

async function bare(fill: number, didId: DidId, route: RouteTarget): Promise<Bare> {
  const seedKey = await importSeed(seedOf(fill));
  const keys = await Keys.open(seedKey, await Keys.anchorOf(seedKey));
  return { keys, minted: await mintDid(keys, didId, route) };
}

/** The ends from `from`'s long form to `to`'s short form, made by hand. */
async function endsBetween(from: Bare, to: { did: Did; longFormDid: Did }, fromPrior: Ends["fromPrior"] = null): Promise<Ends> {
  const { keyAgreement: key } = await from.keys.didKeys(from.minted.didId);
  const answer = await resolve(to.longFormDid, () => null);
  if (answer.outcome !== "resolved") throw new Error(answer.reason);
  const recipient = recipientEndOf(to.did, answer.resolution, key);
  if (recipient === null) throw new Error(`${to.did} offers no key to seal to`);
  const { longFormDid } = from.minted;
  return { sender: { did: longFormDid, resolution: peerResolution(longFormDid), methodId: `${longFormDid}${KEY_AGREEMENT_METHOD}` as DidUrl, key }, recipient, fromPrior };
}

function plaintextOf(ends: Ends, over: JsonObject = {}): JsonObject {
  const { from, to, fromPrior } = addressingOf(ends);
  return { id: crypto.randomUUID(), typ: PLAIN_TYP, type: BASIC_MESSAGE, from, to, ...(fromPrior === null ? {} : { from_prior: fromPrior }), body: { content: "hello" }, ...over };
}

/** The envelope opened by the holder of `to`'s keys, who resolves every long form in `known` and verifies a `from_prior` as the binding does. */
async function openedBy(to: { keys: Keys } & Pick<MintedDid, "didId" | "did" | "longFormDid">, packed: string, known: readonly Did[]): Promise<[IMessage, UnpackMetadata]> {
  const { longFormDid, did, didId } = to;
  const { document } = peerResolution(longFormDid);
  const secrets = secretsOf(await to.keys.didKeys(didId), [longFormDid, did], { authentication: authorizedMethodIds(document, "authentication"), keyAgreement: authorizedMethodIds(document, "keyAgreement") });
  const resolver = {
    resolve: async (asked: string) => {
      const longForm = known.find((candidate) => sameDid(candidate, asked));
      return longForm === undefined ? null : didcommDocumentOf(peerResolution(longForm), asked);
    },
  };
  return unpackMessage(didcomm, packed, resolver, secretsResolverFor(secrets), { verify_from_prior: true });
}

describe("ends made by hand, with no vault behind them", () => {
  test("seal names the sender's long form as the envelope's sender, the recipient opens it, and carry forwards it to the recipient's queue at its mediator", async () => {
    const mediator = await newMediator();
    const bob = await mediatedParty(mediator, 2, BOB);
    await holdAddresses(bob);
    const alice = await bare(1, ALICE, ALICE_DIRECT);
    const ends = await endsBetween(alice, bob);
    const plaintext = plaintextOf(ends);
    const packed = await seal(ends, plaintext, didcomm);

    const [opened, metadata] = await openedBy(bob, packed, [alice.minted.longFormDid]);
    expect(metadata.encrypted_from_kid).toBe(`${alice.minted.longFormDid}${KEY_AGREEMENT_METHOD}`);
    expect(opened).toEqual(plaintext);

    const carried = await carry({ did: ends.recipient.did, service: ends.recipient.resolution.service }, packed, "forward-1", () => null, { didcomm, fetch: mediator.fetch }, AbortSignal.timeout(5000));
    if (!("endpoint" in carried)) throw new Error(`not carried: ${JSON.stringify(carried)}`);
    expect(carried.endpoint).toBe(MEDIATOR_HTTP);
    expect(carried.forward?.message).toMatchObject({ id: "forward-1", type: FORWARD, to: [mediator.did], body: { next: bob.did } });
    const answer = await mediator.fetch(carried.endpoint, { method: "POST", headers: { "Content-Type": ENCRYPTED_MIME }, body: carried.body });
    expect(answer.status).toBe(202);
    expect((mediator.queues.get(bob.replica.did) ?? []).map((queued) => parseStrict(queued.packed))).toEqual([parseStrict(packed)]);
    await bob.runtime.close();
  });

  test("seal verifies a successor's proof against the issuer's document the ends hold, and the recipient verifies it too", async () => {
    const alice = await bare(1, ALICE, ALICE_DIRECT);
    const prior = await mintDid(alice.keys, ALICE_PRIOR, ALICE_DIRECT);
    const proof = await signFromPrior(alice.keys, { didId: ALICE_PRIOR, longFormDid: prior.longFormDid }, alice.minted.longFormDid, PROOF_IAT);
    const bob = await bare(2, BOB, BOB_DIRECT);
    const ends = await endsBetween(alice, bob.minted, { proof, issuer: peerResolution(prior.longFormDid) });
    const packed = await seal(ends, plaintextOf(ends), didcomm);

    const [opened, metadata] = await openedBy({ keys: bob.keys, ...bob.minted }, packed, [alice.minted.longFormDid, prior.longFormDid]);
    expect(opened.from_prior).toBe(proof);
    expect(metadata.from_prior).toMatchObject({ iss: prior.longFormDid, sub: alice.minted.longFormDid });
  });

  test("seal resolves no document the ends do not hold: a proof whose issuer's document is not in them is not sealed", async () => {
    const alice = await bare(1, ALICE, ALICE_DIRECT);
    const prior = await mintDid(alice.keys, ALICE_PRIOR, ALICE_DIRECT);
    const proof = await signFromPrior(alice.keys, { didId: ALICE_PRIOR, longFormDid: prior.longFormDid }, alice.minted.longFormDid, PROOF_IAT);
    const bob = await bare(2, BOB, BOB_DIRECT);
    const ends = await endsBetween(alice, bob.minted, { proof, issuer: peerResolution(alice.minted.longFormDid) });

    await expect(seal(ends, plaintextOf(ends), didcomm)).rejects.toThrow(/from_prior issuer DIDDoc not found/);
  });

  test("seal refuses a plaintext whose from, to or from_prior is not the ends', before anything is sealed", async () => {
    const unsealable = {
      Message: class {
        constructor() {
          throw new Error("sealed");
        }
      },
    } as unknown as DidcommApi;
    const alice = await bare(1, ALICE, ALICE_DIRECT);
    const bob = await bare(2, BOB, BOB_DIRECT);
    const carol = (await bare(3, CAROL, BOB_DIRECT)).minted;
    const ends = await endsBetween(alice, bob.minted);

    const misaddressed: JsonObject[] = [{ from: carol.longFormDid }, { from: alice.minted.did }, { to: [carol.did] }, { to: [bob.minted.longFormDid] }, { to: [bob.minted.did, carol.did] }, { from_prior: "a proof the ends do not carry" }];
    for (const over of misaddressed) {
      await expect(seal(ends, plaintextOf(ends, over), unsealable)).rejects.toThrow(MismatchedEnds);
    }
  });
});
