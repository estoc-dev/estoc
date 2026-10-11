/**
 * The two ends of an envelope, and what the wire does with them: a
 * plaintext sealed as authcrypt from the sender's key-agreement key to
 * the recipient's, and the envelope carried to where the recipient's
 * document says it receives. How the ends were chosen — a channel's
 * admission, continuity and rotation, or anything else — is their
 * builder's. Sealing and carrying read nothing but what they are
 * handed, and every document didcomm resolves while it seals is one
 * the ends hold.
 */

import { DIDDocConversionError, splitDidUrl } from "@estoc/did-peer";
import { parseStrict, type JsonObject } from "@estoc/event-store";
import { InvalidDidDocument, InvalidPublicKey, agreementKey, sameDid, type Addressing, type Did, type DidUrl, type LocalKey, type PeerResolution, type PublicKey } from "@estoc/vault";

import { ENCRYPTED_MIME, PLAIN_TYP, endpointOf, packEncrypted, secretsResolverFor, type DIDResolver, type DidcommApi, type IMessage } from "./protocol/didcomm.js";
import { FORWARD } from "./protocol/spec.js";
import { MismatchedEnds } from "./errors.js";
import { authorizedKeys, didcommDocumentOf } from "./evidence.js";
import { secretOf } from "./keyring.js";
import { bounded } from "./link.js";
import { resolve, type KnownLongForms, type Resolution, type ResolverOptions, type Resolved } from "./resolver.js";

export interface SenderEnd {
  /** the plaintext's `from`, and the DID of the key ID the envelope's `skid` names */
  did: Did;
  /** the sender's own document */
  resolution: PeerResolution;
  /** the key-agreement method sealed from, under the document's own spelling */
  methodId: DidUrl;
  /** that method's key */
  key: LocalKey;
}

export interface RecipientEnd {
  /** the plaintext's one `to`, and the `next` of a forward to it */
  did: Did;
  /** the recipient's document, naming the service it receives at */
  resolution: Resolution;
  /** the key-agreement method sealed to, under the document's own spelling */
  methodId: DidUrl;
  /** that method's key */
  publicKey: PublicKey;
}

export interface Ends {
  sender: SenderEnd;
  recipient: RecipientEnd;
  /** the frozen proof the sender carries as a successor, with the document of its issuer: didcomm verifies the proof against it before it seals */
  fromPrior: { proof: string; issuer: PeerResolution } | null;
}

/** The plaintext's addressing the ends make: from the sender, to the recipient alone, with the proof when there is one. */
export function addressingOf({ sender, recipient, fromPrior }: Ends): Addressing {
  return { from: sender.did, to: [recipient.did], fromPrior: fromPrior?.proof ?? null };
}

/**
 * The recipient at `did` as `key` can seal to it: at the first method,
 * in document order, the resolved document authorizes for key
 * agreement, didcomm can seal to, and on `key`'s own curve. Null when
 * there is none. The document may authorize more: a method of a suite
 * didcomm does not pack with, which its projection marks `Other`, or a
 * key on another curve, since didcomm agrees both ends over one curve;
 * or a key that agrees nothing, a signing key or a low-order point.
 * Each is authorized and still unusable here, and naming it as the
 * recipient key ID would fail the seal.
 */
export function recipientEndOf(did: Did, resolution: Resolution, key: LocalKey): RecipientEnd | null {
  const projected = didcommDocumentOf(resolution, resolution.document["id"] as string);
  const packable = new Set(projected.verificationMethod.filter((method) => method.type !== "Other").map((method) => method.id));
  for (const [methodId, publicKey] of authorizedKeys(resolution, "keyAgreement")) {
    if (packable.has(methodId) && agrees(publicKey, key.type)) return { did, resolution, methodId, publicKey };
  }
  return null;
}

function agrees(key: PublicKey, type: LocalKey["type"]): boolean {
  try {
    return agreementKey(key).type === type;
  } catch (err) {
    if (err instanceof InvalidPublicKey) return false;
    throw err;
  }
}

/**
 * The plaintext sealed as authcrypt from the sender end to the
 * recipient end, each named as a key ID under the spelling the
 * plaintext carries, so that didcomm seals from and to exactly those
 * methods. A plaintext addressed otherwise than the ends is refused
 * before anything is sealed.
 */
export async function seal(ends: Ends, plaintext: JsonObject, didcomm: DidcommApi): Promise<string> {
  refuseMisaddressed(ends, plaintext);
  const senderKid = ends.sender.did + splitDidUrl(ends.sender.methodId)[1];
  const recipientKid = ends.recipient.did + splitDidUrl(ends.recipient.methodId)[1];
  const secrets = secretsResolverFor([secretOf(senderKid, ends.sender.key)]);
  const [packed] = await packEncrypted(didcomm, plaintext as unknown as IMessage, recipientKid, senderKid, null, resolverOf(ends), secrets, { forward: false });
  return packed;
}

function refuseMisaddressed(ends: Ends, plaintext: JsonObject): void {
  const { from, to, fromPrior } = addressingOf(ends);
  const addressed = plaintext["to"];
  if (plaintext["from"] !== from) throw new MismatchedEnds("from");
  if (!Array.isArray(addressed) || addressed.length !== to.length || addressed.some((did, i) => did !== to[i])) throw new MismatchedEnds("to");
  if ((plaintext["from_prior"] ?? null) !== fromPrior) throw new MismatchedEnds("from_prior");
}

/** didcomm's resolver for one seal: each document the ends hold, under any spelling of its own DID, and nothing else. */
function resolverOf({ sender, recipient, fromPrior }: Ends): DIDResolver {
  const documents: PeerResolution[] = [sender.resolution, recipient.resolution, ...(fromPrior === null ? [] : [fromPrior.issuer])];
  return {
    resolve: async (did: string) => {
      const found = documents.find((document) => sameDid(document.did, did));
      if (found === undefined) return null;
      try {
        return didcommDocumentOf(found, did);
      } catch (err) {
        if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey || err instanceof DIDDocConversionError) return null;
        throw err;
      }
    },
  };
}

/** Where a recipient receives: its DID, which a forward names as `next`, and the DIDComm service its document names. */
export interface Destination {
  did: Did;
  service: string | null;
}

/** What goes on the wire and where: the envelope itself, or the forward sealed around it. */
export interface Carried {
  endpoint: string;
  body: string;
  forward: { packed: string; message: IMessage } | null;
}

export interface CarryOptions extends ResolverOptions {
  didcomm: DidcommApi;
}

/**
 * To a direct endpoint, the envelope itself. To a mediator, a forward
 * under `id` whose `next` is the recipient, carrying the envelope as
 * JSON, sealed anonymously to the mediator's key-agreement key and
 * carried to its HTTP endpoint; a short-form mediator resolves through
 * `known`. The mediator's document is resolved for this attempt alone:
 * it is how the envelope travels, not evidence about the recipient.
 * `because` says the envelope cannot be carried there, `reason` that
 * it could not be now.
 */
export async function carry(to: Destination, envelope: string, id: string, known: KnownLongForms, options: CarryOptions, deadline: AbortSignal): Promise<Carried | { because: string } | { reason: string }> {
  const hop = hopOf(to.service);
  if (hop === null) return { because: to.service === null ? "the recipient's document names no DIDComm service" : `the recipient's service ${to.service} is nothing this runtime carries to` };
  if (hop.kind === "direct") return { endpoint: hop.endpoint, body: envelope, forward: null };
  const { routingDid } = hop;
  let answer: Resolved;
  try {
    answer = await bounded(deadline, () => resolve(routingDid, known, options));
  } catch (err) {
    return { reason: `the mediator ${routingDid} did not resolve in time: ${messageOf(err)}` };
  }
  if (answer.outcome === "unavailable") return { reason: `the mediator ${routingDid} did not resolve now: ${answer.reason}` };
  if (answer.outcome === "definitive") return { because: `the mediator ${routingDid} does not resolve: ${answer.reason}` };
  const document = didcommDocumentOf(answer.resolution);
  const endpoint = endpointOf(document, "http");
  if (endpoint === null) return { because: `the mediator ${routingDid} names no HTTP endpoint` };
  const message = {
    id,
    typ: PLAIN_TYP,
    type: FORWARD,
    to: [routingDid],
    body: { next: to.did },
    attachments: [{ media_type: ENCRYPTED_MIME, data: { json: parseStrict(envelope) } }],
  } as unknown as IMessage;
  const resolver = { resolve: async (did: string) => (did === routingDid ? document : null) };
  try {
    const [packed] = await bounded(deadline, () => packEncrypted(options.didcomm, message, routingDid, null, null, resolver, secretsResolverFor([]), { forward: false }));
    return { endpoint, body: packed, forward: { packed, message } };
  } catch (err) {
    if (deadline.aborted) return { reason: `the forward to ${routingDid} was not sealed in time` };
    return { because: `the forward to ${routingDid} cannot be sealed: ${messageOf(err)}` };
  }
}

type Hop = { kind: "direct"; endpoint: string } | { kind: "forward"; routingDid: Did };

/** The service a resolution names, as a hop a call can take: an HTTP endpoint, or a DID whose mediator takes a forward; null for anything else. */
function hopOf(service: string | null): Hop | null {
  if (service === null) return null;
  if (service.startsWith("did:")) return { kind: "forward", routingDid: service as Did };
  try {
    const { protocol } = new URL(service);
    return protocol === "https:" || protocol === "http:" ? { kind: "direct", endpoint: service } : null;
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
