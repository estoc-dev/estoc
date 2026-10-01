import type { DIDDoc } from "@estoc/did-peer";

import { canonicalDid, provenDid, signedPayload } from "./replica-grant.js";

/**
 * The proof a communication DID signs to be added to a replica-mediation
 * account: that this DID's own controller wants its mail routed to that
 * account at that mediator. It names no request and no time, so it stays
 * good for every retry of the one addition it allows.
 */

export const RECIPIENT_PROOF_TYP = "estoc/recipient-add+jws";

const PROOF_FIELDS = ["account", "aud", "recipient"];

export interface RecipientProof {
  /** Both in their short form when they are did:peer:4, however the proof spelled them. */
  account: string;
  mediator: string;
}

/**
 * What `jws` allows, once an authentication key of `recipientDoc` has signed
 * it for that same DID; null otherwise. Whether the account and mediator are
 * the ones the request came from and went to is the caller's to compare.
 */
export async function verifyRecipientProof(
  jws: unknown,
  recipientDoc: DIDDoc
): Promise<RecipientProof | null> {
  const payload = await signedPayload(jws, RECIPIENT_PROOF_TYP, PROOF_FIELDS, recipientDoc);
  if (payload === null) {
    return null;
  }

  const account = provenDid(payload.account);
  const mediator = provenDid(payload.aud);
  if (
    account === null ||
    mediator === null ||
    provenDid(payload.recipient) !== canonicalDid(recipientDoc.id)
  ) {
    return null;
  }
  return { account, mediator };
}
