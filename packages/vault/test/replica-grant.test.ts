import { canonicalText } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import { base64urlnopad } from "@scure/base";
import { CompactSign, decodeProtectedHeader, importJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  IdentityMismatch,
  InvalidReplicaGrant,
  Keys,
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

/** A grant whose payload is `payload`, signed by `key` under `kid`. */
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
    await expect(verifyReplicaGrant(keys, jws)).resolves.toEqual(readReplicaGrant(jws));
  });

  it("refuses an arrangement whose recorded account is not the seed's", async () => {
    const other = (await mintMediationDid(keys, MEDIATION2)).longFormDid;
    await expect(signReplicaGrant(keys, { ...mediation, me: { did: other } }, REPLICA)).rejects.toThrow(IdentityMismatch);
  });
});

describe("verifyReplicaGrant", () => {
  it("takes the same binding signed under the account's short form as the same binding", async () => {
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const account = peerResolution(mediation.me.did);
    const short = await signed(payloadOf(jws), (await keys.mediationKeys(MEDIATION)).authentication, `${account.did}#key-1`);
    expect(short).not.toBe(jws);
    const grant = await verifyReplicaGrant(keys, short);
    expect(sameBinding(grant, readReplicaGrant(jws))).toBe(true);
    expect(sameBinding(grant, readReplicaGrant(await signReplicaGrant(keys, mediation, REPLICA2)))).toBe(false);
  });

  it("refuses a signature that is not the account key's: another seed, another arrangement's key, a communication key, an altered payload", async () => {
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const payload = payloadOf(jws);
    const kid = decodeProtectedHeader(jws).kid as string;
    await expect(verifyReplicaGrant(await open(new Uint8Array(32).fill(8)), jws)).rejects.toThrow(InvalidReplicaGrant);
    await expect(verifyReplicaGrant(keys, await signed(payload, (await keys.mediationKeys(MEDIATION2)).authentication, kid))).rejects.toThrow(InvalidReplicaGrant);
    await expect(verifyReplicaGrant(keys, await signed(payload, (await keys.didKeys(DID_ID)).authentication, kid))).rejects.toThrow(InvalidReplicaGrant);
    const [header, , signature] = jws.split(".");
    const altered = `${header}.${base64urlnopad.encode(encoder.encode(canonicalText({ ...payload, mediator: "did:web:other.example" })))}.${signature}`;
    await expect(verifyReplicaGrant(keys, altered)).rejects.toThrow(InvalidReplicaGrant);
  });

  it("refuses a replica the seed does not derive for that ID, or one that sends elsewhere than the grant's mediator", async () => {
    const account = (await keys.mediationKeys(MEDIATION)).authentication;
    const jws = await signReplicaGrant(keys, mediation, REPLICA);
    const payload = payloadOf(jws);
    const kid = decodeProtectedHeader(jws).kid as string;
    const other = await mintReplicaDid(keys, REPLICA2, MEDIATOR);
    await expect(verifyReplicaGrant(keys, await signed({ ...payload, replica_did: other.did, replica_long_form: other.longFormDid }, account, kid))).rejects.toThrow(IdentityMismatch);
    const communication = await mintDid(keys, DID_ID, { kind: "mediated", routingDid: MEDIATOR });
    await expect(verifyReplicaGrant(keys, await signed({ ...payload, replica_did: communication.did, replica_long_form: communication.longFormDid }, account, kid))).rejects.toThrow(IdentityMismatch);
    await expect(verifyReplicaGrant(keys, await signed({ ...payload, mediator: "did:web:other.example" }, account, kid))).rejects.toThrow(/not the grant's mediator/);
  });
});
