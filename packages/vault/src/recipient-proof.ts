/**
 * The proof a communication DID signs to have a replica-mediation
 * account hold it: that the DID's own controller wants its mail routed
 * to that account at that mediator. It is a compact JWS whose protected
 * header is exactly `alg: EdDSA`, `typ` and a `kid` naming an
 * authentication method of the DID that a mediator reads an Ed25519
 * key from, over the RFC 8785 text of exactly `account`, `aud` and
 * `recipient`. It names no request and no time: the binding it allows
 * is permanent and adding it again changes nothing, so one proof
 * serves every retry.
 */

import { canonicalText } from "@estoc/event-store";
import { CompactSign, importJWK } from "jose";

import { IdentityMismatch } from "./errors.js";
import { didDocumentOf, type Keys } from "./identity.js";
import { peerResolution } from "./peer-document.js";
import { signingMethod } from "./signing-method.js";
import type { Did, VaultData } from "./types.js";

export const RECIPIENT_PROOF_TYP = "estoc/recipient-add+jws";

/**
 * The proof of one of the vault's own communication DIDs for the
 * account whose long form is `account`, at `mediatorDid`, signed with
 * the authentication key the seed derives for the entity. The account
 * and the recipient are named by their short forms, the mediator as
 * the arrangement spells it, and `kid` is under the recipient's long
 * form, so that the proof verifies wherever the long form is carried
 * beside it.
 */
export async function signRecipientProof(keys: Keys, recipient: Pick<VaultData["did.created"], "didId" | "did" | "longFormDid">, account: Did, mediatorDid: Did): Promise<string> {
  const resolution = didDocumentOf(recipient);
  const key = (await keys.didKeys(recipient.didId)).authentication;
  const methodId = signingMethod(resolution, key);
  if (methodId === undefined) throw new IdentityMismatch(`DID entity ${recipient.didId} authorizes no authentication method a mediator reads the key the seed derives from`);
  const payload = { account: peerResolution(account).did, aud: mediatorDid, recipient: resolution.did };
  return new CompactSign(new TextEncoder().encode(canonicalText(payload))).setProtectedHeader({ alg: "EdDSA", typ: RECIPIENT_PROOF_TYP, kid: methodId }).sign(await importJWK(key.privateJwk(), "EdDSA"));
}
