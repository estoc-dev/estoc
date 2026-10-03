import { canonicalText } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import { base64urlnopad } from "@scure/base";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { IdentityMismatch, Keys, RECIPIENT_PROOF_TYP, mediationIdOf, mintDid, mintMediationDid, peerResolution, signRecipientProof, splitDidUrl, type Did, type DidId, type MintedDid } from "../src/index.js";

const DID_ID = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
const DID_ID2 = "019b2a55-7f10-7b6a-8c21-5d3e9a0f4b17" as DidId;
const MEDIATOR = "did:web:mediator.example" as Did;
const MEDIATION = mediationIdOf(MEDIATOR);

async function open(seed: Uint8Array): Promise<Keys> {
  const seedKey = await importSeed(seed);
  return Keys.open(seedKey, await Keys.anchorOf(seedKey));
}

let keys: Keys;
let account: Did;
let recipient: MintedDid;

beforeAll(async () => {
  keys = await open(new Uint8Array(32).fill(7));
  account = (await mintMediationDid(keys, MEDIATION)).longFormDid;
  recipient = await mintDid(keys, DID_ID, { kind: "mediated", routingDid: MEDIATOR });
});

describe("a recipient proof", () => {
  it("is exactly the account, the mediator and the recipient, in RFC 8785 text, under the recipient's own authentication key", async () => {
    const jws = await signRecipientProof(keys, recipient, account, MEDIATOR);
    const header = decodeProtectedHeader(jws);
    expect(Object.keys(header).sort()).toEqual(["alg", "kid", "typ"]);
    expect(header).toMatchObject({ alg: "EdDSA", typ: RECIPIENT_PROOF_TYP });
    expect(splitDidUrl(header.kid as string)[0]).toBe(recipient.longFormDid);
    const key = (await keys.didKeys(DID_ID)).authentication;
    const { payload } = await compactVerify(jws, await importJWK({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(key.publicKeyBytes()) }, "EdDSA"));
    const said = { account: peerResolution(account).did, aud: MEDIATOR, recipient: recipient.did };
    expect(new TextDecoder().decode(payload)).toBe(canonicalText(said));
  });

  it("is the same proof every time, so that a retry carries what the first request did", async () => {
    expect(await signRecipientProof(keys, recipient, account, MEDIATOR)).toBe(await signRecipientProof(keys, recipient, account, MEDIATOR));
  });

  it("is not signed for an entity whose document the seed does not derive, or whose short form is another's", async () => {
    const other = await mintDid(await open(new Uint8Array(32).fill(8)), DID_ID, { kind: "mediated", routingDid: MEDIATOR });
    await expect(signRecipientProof(keys, other, account, MEDIATOR)).rejects.toBeInstanceOf(IdentityMismatch);
    const second = await mintDid(keys, DID_ID2, { kind: "mediated", routingDid: MEDIATOR });
    await expect(signRecipientProof(keys, { ...recipient, did: second.did }, account, MEDIATOR)).rejects.toBeInstanceOf(IdentityMismatch);
  });
});
