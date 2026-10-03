/**
 * The grant a replica-mediation account signs for one replica: a
 * lifetime binding of that replica's ID and DID to the account, its
 * arrangement and one mediator. The mediator enrolls the replica on it,
 * and every other holder of the seed takes the membership from it
 * without asking the mediator. It is a compact JWS whose protected
 * header is exactly `alg: EdDSA`, `typ` and a `kid` naming an
 * authentication method of the account that a mediator reads an
 * Ed25519 key from, over the RFC 8785 text of exactly the six members
 * of `GrantPayload`.
 *
 * Reading a grant checks its spelling only. The signature, that `kid`
 * is a method the account authorizes, and that the replica it names is
 * this seed's, are `verifyReplicaGrant`'s.
 */

import { InvalidJson, canonicalText, isJsonObject } from "@estoc/event-store";
import { CompactSign, base64url, compactVerify, decodeProtectedHeader, importJWK } from "jose";

import { IdentityMismatch, InvalidReplicaGrant } from "./errors.js";
import { checkReplicaKeys, mintReplicaDid, type Keys } from "./identity.js";
import { sameDid } from "./ids.js";
import { didcommServiceUris, peerResolution, splitDidUrl } from "./peer-document.js";
import { publicJwk, signingKey, signingMethod } from "./signing-method.js";
import { isCompactJwt, isDerivedId, isDid, isDidUrl, isMintedId, isPeer4Long, isPeer4Short } from "./syntax.js";
import type { Did, DidUrl, MediationId, ReplicaId } from "./types.js";

export const REPLICA_GRANT_TYP = "estoc/replica-grant+jws";

/** The longest compact JWS a grant may be, in characters: the mediator refuses a longer one unread. */
export const MAX_GRANT_JWS_CHARS = 16 * 1024;

/** The largest did:peer:4 long form a grant may carry, in UTF-8 bytes: the mediator refuses a larger one before decoding it. */
export const MAX_GRANT_LONG_FORM_BYTES = 8192;

const GRANT_MEMBERS = ["account", "mediation_id", "mediator", "replica_did", "replica_id", "replica_long_form"] as const;

type GrantPayload = { [member in (typeof GRANT_MEMBERS)[number]]: string };

/** What a grant says, as its signer wrote it. */
export type ReplicaGrant = {
  /** the account's did:peer:4, in its short form */
  account: Did;
  mediationId: MediationId;
  /** the mediator the replica's document names as its service, as the account spells it */
  mediator: Did;
  replicaId: ReplicaId;
  /** the replica's did:peer:4, in its short form */
  replicaDid: Did;
  replicaLongForm: Did;
  /** the account's authentication method the signature is under, the account in either spelling */
  kid: DidUrl;
};

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function refuse(what: string): never {
  throw new InvalidReplicaGrant(what);
}

function payloadOf(jws: string): GrantPayload {
  let text: string;
  let parsed: unknown;
  try {
    text = decoder.decode(base64url.decode(jws.split(".")[1] as string));
    parsed = JSON.parse(text);
  } catch {
    return refuse("the payload is JSON text");
  }
  if (!isJsonObject(parsed)) return refuse("the payload is a JSON object");
  if (Object.keys(parsed).sort().join() !== GRANT_MEMBERS.join()) return refuse(`the payload has exactly ${GRANT_MEMBERS.join(", ")}`);
  if (Object.values(parsed).some((value) => typeof value !== "string")) return refuse("every payload member is a string");
  let canonical: string;
  try {
    canonical = canonicalText(parsed);
  } catch (err) {
    if (err instanceof InvalidJson) return refuse(`the payload is I-JSON: ${err.message}`);
    throw err;
  }
  if (canonical !== text) return refuse("the payload is its own RFC 8785 text");
  return parsed as GrantPayload;
}

/** The grant a compact JWS spells, or `InvalidReplicaGrant`. Nothing is decoded beyond the JWS itself and no signature is checked. */
export function readReplicaGrant(jws: string): ReplicaGrant {
  if (!isCompactJwt(jws)) refuse("a grant is a compact JWS");
  if (jws.length > MAX_GRANT_JWS_CHARS) refuse(`a grant is at most ${MAX_GRANT_JWS_CHARS} characters`);
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    return refuse("the protected header is JSON");
  }
  const kid = header["kid"];
  if (Object.keys(header).sort().join() !== "alg,kid,typ" || header["alg"] !== "EdDSA" || header["typ"] !== REPLICA_GRANT_TYP || !isDidUrl(kid)) {
    refuse(`the protected header is exactly alg EdDSA, typ ${REPLICA_GRANT_TYP} and a kid`);
  }
  const payload = payloadOf(jws);
  const { account, mediator, replica_did: replicaDid, replica_long_form: replicaLongForm } = payload;
  if (!isPeer4Short(account)) refuse("account is a did:peer:4 short form");
  if (!isDerivedId(payload.mediation_id)) refuse("mediation_id is a canonical UUIDv5");
  if (!isMintedId(payload.replica_id)) refuse("replica_id is a canonical UUIDv7");
  if (!isDid(mediator)) refuse("mediator is a DID");
  if (!isPeer4Short(replicaDid) || replicaDid === account) refuse("replica_did is a did:peer:4 short form other than the account");
  if (!isPeer4Long(replicaLongForm) || !replicaLongForm.startsWith(`${replicaDid}:`)) refuse("replica_long_form is the long form of replica_did");
  const [signer, fragment] = splitDidUrl(kid as string);
  if (!fragment.startsWith("#") || (signer !== account && !(isPeer4Long(signer) && signer.startsWith(`${account}:`)))) refuse("kid names a method of the account");
  for (const longForm of [replicaLongForm, signer, mediator]) {
    if (encoder.encode(longForm).length > MAX_GRANT_LONG_FORM_BYTES) refuse(`a DID a grant carries is at most ${MAX_GRANT_LONG_FORM_BYTES} bytes`);
  }
  return {
    account: account as Did,
    mediationId: payload.mediation_id as MediationId,
    mediator: mediator as Did,
    replicaId: payload.replica_id as ReplicaId,
    replicaDid: replicaDid as Did,
    replicaLongForm: replicaLongForm as Did,
    kid: kid as DidUrl,
  };
}

/** Do two grants bind the same replica to the same account, arrangement and mediator, whichever key spelling each was signed under and however each spells the mediator? */
export function sameBinding(a: ReplicaGrant, b: ReplicaGrant): boolean {
  return a.account === b.account && a.mediationId === b.mediationId && sameDid(a.mediator, b.mediator) && a.replicaId === b.replicaId && a.replicaLongForm === b.replicaLongForm;
}

/** The arrangement a grant is signed for: what its `mediation.created` records. */
export type GrantingMediation = { mediationId: MediationId; mediatorDid: Did; me: { did: Did } };

/**
 * The grant of one replica in a replica-mediation arrangement, signed
 * with the account key the seed derives for it. The replica's DID is
 * the one its ID and the arrangement's mediator give, and `kid` is the
 * first method of the account's own document that a mediator reads the
 * key from, under the long form, so that the grant verifies wherever it
 * is carried.
 */
export async function signReplicaGrant(keys: Keys, mediation: GrantingMediation, replicaId: ReplicaId): Promise<string> {
  const account = peerResolution(mediation.me.did);
  const key = (await keys.mediationKeys(mediation.mediationId)).authentication;
  const methodId = signingMethod(account, key);
  if (methodId === undefined) throw new IdentityMismatch(`mediation ${mediation.mediationId} authorizes no authentication method a mediator reads the key the seed derives from`);
  const replica = await mintReplicaDid(keys, replicaId, mediation.mediatorDid);
  const payload: GrantPayload = {
    account: account.did,
    mediation_id: mediation.mediationId,
    mediator: mediation.mediatorDid,
    replica_did: replica.did,
    replica_id: replicaId,
    replica_long_form: replica.longFormDid,
  };
  const jws = await new CompactSign(encoder.encode(canonicalText(payload))).setProtectedHeader({ alg: "EdDSA", typ: REPLICA_GRANT_TYP, kid: methodId }).sign(await importJWK(key.privateJwk(), "EdDSA"));
  readReplicaGrant(jws);
  return jws;
}

/**
 * A grant against the seed and the account its arrangement's creation
 * records, by that record's long form: the grant's account is that
 * one, `kid` names, under either spelling of the account, a method its
 * document authorizes for authentication and that a mediator reads the
 * account key the seed derives for the grant's arrangement from, the
 * signature is
 * that key's, and the replica's document carries the keys the seed
 * derives for the replica's ID and sends to the grant's mediator
 * alone. `InvalidReplicaGrant`, `IdentityMismatch` or
 * `InvalidDidDocument` otherwise. Whether the mediator is the
 * arrangement's own is for whoever holds its creation.
 */
export async function verifyReplicaGrant(keys: Keys, jws: string, accountDid: Did): Promise<ReplicaGrant> {
  const grant = readReplicaGrant(jws);
  const account = peerResolution(accountDid);
  if (account.did !== grant.account) throw new IdentityMismatch(`the grant's account is ${grant.account}, not ${account.did}`);
  const [signer, fragment] = splitDidUrl(grant.kid);
  if (signer !== account.did && signer !== account.presentedDid) throw new InvalidReplicaGrant("kid spells the account as its short form or its recorded long form");
  const methodId = `${account.presentedDid}${fragment}` as DidUrl;
  const key = (await keys.mediationKeys(grant.mediationId)).authentication;
  if (signingKey(account.document, methodId) !== key.publicKey) {
    throw new IdentityMismatch(`kid names no authentication method of the account a mediator reads the key the seed derives for mediation ${grant.mediationId} from`);
  }
  try {
    await compactVerify(jws, await importJWK(publicJwk(key), "EdDSA"), { algorithms: ["EdDSA"] });
  } catch {
    throw new InvalidReplicaGrant(`the signature is not that of the account key the seed derives for mediation ${grant.mediationId}`);
  }
  const replica = peerResolution(grant.replicaLongForm);
  await checkReplicaKeys(keys, grant.replicaId, replica);
  const uris = didcommServiceUris(replica.document);
  if (uris.length !== 1 || !sameDid(uris[0]!, grant.mediator)) throw new IdentityMismatch(`replica ${grant.replicaId} sends to ${JSON.stringify(uris)}, not the grant's mediator`);
  return grant;
}
