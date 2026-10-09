/**
 * The authentication methods a mediator verifies a compact JWS under.
 * A mediator reads an Ed25519 key only under the method types it
 * supports for the key's encoding, so the same key under any other
 * type signs what no mediator takes.
 */

import { splitDidUrl } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store";
import { base64urlnopad } from "@scure/base";

import type { LocalKey } from "./identity.js";
import { authorizedMethodIds, definedMethod, methodPublicKey, type PeerResolution } from "./peer-document.js";
import { decodePublicKey } from "./public-key.js";
import type { DidUrl, PublicKey } from "./types.js";

const MULTIBASE_SIGNING_TYPES: ReadonlySet<unknown> = new Set(["Multikey", "Ed25519VerificationKey2020"]);

/** The Ed25519 key a mediator verifies with when `kid` names this authentication method, or null when it would refuse the method. */
export function signingKey(document: JsonObject, methodId: DidUrl): PublicKey | null {
  if (!authorizedMethodIds(document, "authentication").includes(methodId)) return null;
  const method = definedMethod(document, methodId);
  const readable = method["publicKeyJwk"] === undefined ? MULTIBASE_SIGNING_TYPES.has(method["type"]) : method["type"] === "JsonWebKey2020";
  if (!readable) return null;
  const key = methodPublicKey(document, methodId);
  return decodePublicKey(key).type === "Ed25519" ? key : null;
}

/** The first method of the signer's own document that a mediator reads `key` from, under the spelling the document was read by. */
export function signingMethod(signer: PeerResolution, key: LocalKey): DidUrl | undefined {
  return authorizedMethodIds(signer.document, "authentication").find((id) => splitDidUrl(id)[0] === signer.presentedDid && signingKey(signer.document, id) === key.publicKey);
}

export const publicJwk = (key: LocalKey) => ({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(key.publicKeyBytes()) });
