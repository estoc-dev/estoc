import { canonicalText } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import { base64urlnopad } from "@scure/base";
import { encodeLongForm } from "@estoc/did-peer";
import { CompactSign, decodeProtectedHeader, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  IdentityMismatch,
  InvalidReplicaGrant,
  Keys,
  MAX_GRANT_JWS_CHARS,
  MAX_GRANT_LONG_FORM_BYTES,
  REPLICA_GRANT_TYP,
  didcommServiceUris,
  mintDid,
  mintMediationDid,
  mintReplicaDid,
  peerResolution,
  readReplicaGrant,
  replicaKeyName,
  sameBinding,
  signReplicaGrant,
  verifyReplicaGrant,
  type Did,
  type DidId,
  type GrantingMediation,
  type LocalKey,
  type MediationId,
  type ReplicaId,
} from "../src/index.js";

const MEDIATION = "019b2a51-118f-7e46-b31b-c63cd090c92c" as MediationId;
const MEDIATION2 = "019b2a52-3c11-7a08-9d55-0f40b1a3e2d7" as MediationId;
const REPLICA = "019b2a43-4a56-7c0f-862f-194c0c4124a0" as ReplicaId;
const REPLICA2 = "019b2a44-0b1c-7d2e-9f3a-4b5c6d7e8f90" as ReplicaId;
const DID_ID = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
const MEDIATOR = "did:web:mediator.example" as Did;

const encoder = new TextEncoder();

async function open(seed: Uint8Array): Promise<Keys> {
  const seedKey = await importSeed(seed);
  return Keys.open(seedKey, await Keys.anchorOf(seedKey));
}

let keys: Keys;
let mediation: GrantingMediation;

beforeAll(async () => {
  keys = await open(new Uint8Array(32).fill(7));
  mediation = { mediationId: MEDIATION, mediatorDid: MEDIATOR, me: { did: (await mintMediationDid(keys, MEDIATION)).longFormDid } };
});

async function signed(payload: Record<string, string>, key: LocalKey, kid: string): Promise<string> {
  return new CompactSign(encoder.encode(canonicalText(payload))).setProtectedHeader({ alg: "EdDSA", typ: REPLICA_GRANT_TYP, kid }).sign(await importJWK(key.privateJwk(), "EdDSA"));
}

const payloadOf = (jws: string) => JSON.parse(new TextDecoder().decode(base64urlnopad.decode(jws.split(".")[1] as string))) as Record<string, string>;

describe("a replica's DID", () => {
  it("is the one its ID and its mediator give: the keys of its one name, the mediator as its only service", async () => {
    const replica = await mintReplicaDid(keys, REPLICA, MEDIATOR);
    const { authentication, keyAgreement } = await keys.replicaKeys(REPLICA);
    expect(authentication.name).toBe(replicaKeyName(REPLICA));
    expect(keyAgreement.name).toBe(replicaKeyName(REPLICA));
    expect(peerResolution(replica.longFormDid).did).toBe(replica.did);
    expect(didcommServiceUris(replica.inputDocument)).toEqual([MEDIATOR]);
    expect(await mintReplicaDid(keys, REPLICA, MEDIATOR)).toEqual(replica);
    expect((await mintReplicaDid(keys, REPLICA2, MEDIATOR)).did).not.toBe(replica.did);
    expect((await mintReplicaDid(keys, REPLICA, "did:web:other.example" as Did)).did).not.toBe(replica.did);
    expect((await mintMediationDid(keys, REPLICA as unknown as MediationId)).did).not.toBe(replica.did);
  });
});

describe("signReplicaGrant", () => {
  it("binds the replica the seed derives to the arrangement's account and mediator, under the account's own method by its long form", async () => {
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const replica = await mintReplicaDid(keys, REPLICA, MEDIATOR);
    const account = peerResolution(mediation.me.did);
    expect(decodeProtectedHeader(jws)).toEqual({ alg: "EdDSA", typ: "estoc/replica-grant+jws", kid: `${account.presentedDid}#key-1` });
    expect(payloadOf(jws)).toEqual({ account: account.did, mediation_id: MEDIATION, mediator: MEDIATOR, replica_did: replica.did, replica_id: REPLICA, replica_long_form: replica.longFormDid });
    expect(readReplicaGrant(jws)).toEqual({
      account: account.did,
      mediationId: MEDIATION,
      mediator: MEDIATOR,
      replicaId: REPLICA,
      replicaDid: replica.did,
      replicaLongForm: replica.longFormDid,
      kid: `${account.presentedDid}#key-1`,
    });
    expect(await signReplicaGrant(keys, mediation, REPLICA)).toBe(jws);
    await expect(verifyReplicaGrant(keys, jws, mediation.me.did)).resolves.toEqual(readReplicaGrant(jws));
  });

  it("refuses an arrangement whose recorded account is not the seed's", async () => {
    const other = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
    await expect(signReplicaGrant(keys, { ...mediation, me: { did: other } }, REPLICA)).rejects.toThrow(IdentityMismatch);
  });
});

describe("readReplicaGrant", () => {
  it("refuses a payload that is not I-JSON as a grant, like any other misspelling", async () => {
    const [header, body] = (await signReplicaGrant(keys, mediation, REPLICA)).split(".") as [string, string];
    const text = new TextDecoder().decode(base64urlnopad.decode(body));
    for (const escape of ["\\ud800", "\\uffff"]) {
      const lone = `${header}.${base64urlnopad.encode(encoder.encode(text.replace(MEDIATOR, `did:web:${escape}`)))}.c2ln`;
      expect(() => readReplicaGrant(lone)).toThrow(InvalidReplicaGrant);
    }
  });

  it("refuses a grant longer than the mediator reads, which the signer never returns", async () => {
    const { authentication, keyAgreement } = await keys.mediationKeys(MEDIATION);
    const method = (id: string, publicKey: LocalKey) => ({ id, type: "Multikey", publicKeyMultibase: publicKey.publicKey });
    const mediatorOf = (padding: number) =>
      encodeLongForm({
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
        verificationMethod: [method("#key-1", authentication), method("#key-2", keyAgreement)],
        authentication: ["#key-1"],
        keyAgreement: ["#key-2"],
        description: "x".repeat(padding),
      }) as Did;
    const fits = await signReplicaGrant(keys, { ...mediation, mediatorDid: mediatorOf(1000) }, REPLICA);
    expect(fits.length).toBeLessThanOrEqual(MAX_GRANT_JWS_CHARS);
    const large = mediatorOf(3100);
    expect(encoder.encode(large).length).toBeLessThanOrEqual(MAX_GRANT_LONG_FORM_BYTES);
    await expect(signReplicaGrant(keys, { ...mediation, mediatorDid: large }, REPLICA)).rejects.toThrow(/at most 16384 characters/);
    const [header, , signature] = fits.split(".") as [string, string, string];
    expect(() => readReplicaGrant(`${header}.${"A".repeat(MAX_GRANT_JWS_CHARS)}.${signature}`)).toThrow(/at most 16384 characters/);
  });
});

describe("verifyReplicaGrant", () => {
  it("takes the same binding signed under the account's short form as the same binding", async () => {
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const account = peerResolution(mediation.me.did);
    const short = await signed(payloadOf(jws), (await keys.mediationKeys(MEDIATION)).authentication, `${account.did}#key-1`);
    expect(short).not.toBe(jws);
    const grant = await verifyReplicaGrant(keys, short, mediation.me.did);
    expect(sameBinding(grant, readReplicaGrant(jws))).toBe(true);
    expect(sameBinding(grant, readReplicaGrant(await signReplicaGrant(keys, mediation, REPLICA2)))).toBe(false);
  });

  it("refuses a signature that is not the account key's: another seed, another arrangement's key, a communication key, an altered payload", async () => {
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const payload = payloadOf(jws);
    const kid = decodeProtectedHeader(jws).kid as string;
    await expect(verifyReplicaGrant(await open(new Uint8Array(32).fill(8)), jws, mediation.me.did)).rejects.toThrow(IdentityMismatch);
    await expect(verifyReplicaGrant(keys, await signed(payload, (await keys.mediationKeys(MEDIATION2)).authentication, kid), mediation.me.did)).rejects.toThrow(InvalidReplicaGrant);
    await expect(verifyReplicaGrant(keys, await signed(payload, (await keys.didKeys(DID_ID)).authentication, kid), mediation.me.did)).rejects.toThrow(InvalidReplicaGrant);
    const [header, , signature] = jws.split(".");
    const altered = `${header}.${base64urlnopad.encode(encoder.encode(canonicalText({ ...payload, mediator: "did:web:other.example" })))}.${signature}`;
    await expect(verifyReplicaGrant(keys, altered, mediation.me.did)).rejects.toThrow(InvalidReplicaGrant);
  });

  it("holds kid to a method the account's recorded document authorizes for authentication, under either spelling of the account", async () => {
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const payload = payloadOf(jws);
    const account = peerResolution(mediation.me.did);
    const key = (await keys.mediationKeys(MEDIATION)).authentication;
    for (const kid of [`${account.did}#does-not-exist`, `${account.did}#key-2`, `${account.presentedDid}#key-2`]) {
      await expect(verifyReplicaGrant(keys, await signed(payload, key, kid), mediation.me.did)).rejects.toThrow(IdentityMismatch);
    }
    await expect(verifyReplicaGrant(keys, await signed(payload, key, `${account.did}:z2Abc#key-1`), mediation.me.did)).rejects.toThrow(InvalidReplicaGrant);
    await expect(verifyReplicaGrant(keys, jws, (await mintMediationDid(keys, MEDIATION2)).longFormDid)).rejects.toThrow(IdentityMismatch);

    const { authentication, keyAgreement } = await keys.mediationKeys(MEDIATION);
    const method = (id: string, publicKey: LocalKey) => ({ id, type: "Multikey", publicKeyMultibase: publicKey.publicKey });
    const custom = encodeLongForm({
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      verificationMethod: [method("#signing", authentication), method("#agreement", keyAgreement)],
      authentication: ["#signing"],
      keyAgreement: ["#agreement"],
    }) as Did;
    const own = await signReplicaGrant(keys, { ...mediation, me: { did: custom } }, REPLICA);
    expect(decodeProtectedHeader(own).kid).toBe(`${custom}#signing`);
    await expect(verifyReplicaGrant(keys, own, custom)).resolves.toEqual(readReplicaGrant(own));
    await expect(verifyReplicaGrant(keys, await signed(payloadOf(own), key, `${peerResolution(custom).did}#signing`), custom)).resolves.toMatchObject({ replicaId: REPLICA });
    await expect(verifyReplicaGrant(keys, await signed(payloadOf(own), key, `${custom}#key-1`), custom)).rejects.toThrow(IdentityMismatch);
  });

  it("signs under, and takes kid from, only a method whose type and encoding a mediator reads an Ed25519 key from", async () => {
    const { authentication, keyAgreement } = await keys.mediationKeys(MEDIATION);
    const jwk = { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(authentication.publicKeyBytes()) };
    const accountWith = (...methods: Record<string, unknown>[]) =>
      encodeLongForm({
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
        verificationMethod: [...methods, { id: "#agreement", type: "Multikey", publicKeyMultibase: keyAgreement.publicKey }],
        authentication: methods.map((method) => method["id"] as string),
        keyAgreement: ["#agreement"],
      }) as Did;
    const multibase = (id: string, type: string) => ({ id, type, publicKeyMultibase: authentication.publicKey });

    for (const readable of [multibase("#key", "Multikey"), multibase("#key", "Ed25519VerificationKey2020"), { id: "#key", type: "JsonWebKey2020", publicKeyJwk: jwk }]) {
      const account = accountWith(readable);
      const jws = await signReplicaGrant(keys, { ...mediation, me: { did: account } }, REPLICA);
      await expect(verifyReplicaGrant(keys, jws, account)).resolves.toMatchObject({ kid: `${account}#key` });
    }

    for (const unreadable of [
      multibase("#key", "JsonWebKey2020"),
      multibase("#key", "Ed25519VerificationKey2018"),
      multibase("#key", "UnknownKeyType"),
      { id: "#key", type: "Multikey", publicKeyJwk: jwk },
      { id: "#key", type: "Ed25519VerificationKey2020", publicKeyJwk: jwk },
    ]) {
      const account = accountWith(unreadable);
      await expect(signReplicaGrant(keys, { ...mediation, me: { did: account } }, REPLICA)).rejects.toThrow(/no authentication method/);
      const payload = { ...payloadOf(await signReplicaGrant(keys, mediation, REPLICA)), account: peerResolution(account).did };
      await expect(verifyReplicaGrant(keys, await signed(payload, authentication, `${account}#key`), account)).rejects.toThrow(/no authentication method/);
    }

    const both = accountWith(multibase("#legacy", "Ed25519VerificationKey2018"), multibase("#key-1", "Multikey"));
    const jws = await signReplicaGrant(keys, { ...mediation, me: { did: both } }, REPLICA);
    expect(decodeProtectedHeader(jws).kid).toBe(`${both}#key-1`);
    await expect(verifyReplicaGrant(keys, jws, both)).resolves.toEqual(readReplicaGrant(jws));
    await expect(verifyReplicaGrant(keys, await signed(payloadOf(jws), authentication, `${both}#legacy`), both)).rejects.toThrow(/no authentication method/);
  });

  it("refuses a replica the seed does not derive for that ID, or one that sends elsewhere than the grant's mediator", async () => {
    const account = (await keys.mediationKeys(MEDIATION)).authentication;
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const payload = payloadOf(jws);
    const kid = decodeProtectedHeader(jws).kid as string;
    const other = await mintReplicaDid(keys, REPLICA2, MEDIATOR);
    await expect(verifyReplicaGrant(keys, await signed({ ...payload, replica_did: other.did, replica_long_form: other.longFormDid }, account, kid), mediation.me.did)).rejects.toThrow(IdentityMismatch);
    const communication = await mintDid(keys, DID_ID, { kind: "mediated", routingDid: MEDIATOR });
    await expect(verifyReplicaGrant(keys, await signed({ ...payload, replica_did: communication.did, replica_long_form: communication.longFormDid }, account, kid), mediation.me.did)).rejects.toThrow(IdentityMismatch);
    await expect(verifyReplicaGrant(keys, await signed({ ...payload, mediator: "did:web:other.example" }, account, kid), mediation.me.did)).rejects.toThrow(/not the grant's mediator/);
  });
});
