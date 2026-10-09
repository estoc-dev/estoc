/**
 * A peer's DID document as the vault retains it. For a numalgo-4 DID
 * the retained document is fixed: the long form's own resolution
 * result, identified by the long form, with the short form appended to
 * `alsoKnownAs` and omitted controllers filled in — the same RFC 8785
 * bytes and CID whichever spelling the peer presents later. The
 * verification relationships of any retained document, numalgo 4 or
 * not, are read as `@estoc/did-peer` reads every DID document,
 * `from_prior` verification included: references resolved against the
 * document's `id`, keys taken from the exact retained entries.
 */

import { canonicalize, isJsonObject, parseStrict, type JsonObject, type JsonValue } from "@estoc/event-store";
import {
  DIDDocumentError,
  PeerDID4Error,
  VERIFICATION_RELATIONSHIPS,
  authorizedMethodIds as authorizedIn,
  decodeLongForm,
  definedMethod as definedIn,
  isLongForm,
  isShortForm,
  longToShort,
  serviceIds,
  validateInputDocument,
  type VerificationRelationship,
} from "@estoc/did-peer";
import { frozen, remembered } from "@estoc/did-peer/remembered";
import { base58 } from "@scure/base";
import { varint } from "multiformats";

import { rawCidOfBytes } from "./document.js";
import { InvalidDidDocument, InvalidPublicKey } from "./errors.js";
import { canonicalPublicKey } from "./public-key.js";
import { isDid, isUri } from "./syntax.js";
import type { Cid, Did, DidUrl, PublicKey } from "./types.js";

/** The retained resolution of one numalgo-4 long form: the canonical DID, the presented spelling, and the document as object, bytes and root. */
export type PeerResolution = { did: Did; presentedDid: Did; document: JsonObject; bytes: Uint8Array; cid: Cid };

const PEER4_PREFIX = "did:peer:4";
const MULTICODEC_JSON = 0x0200;

export type { VerificationRelationship };

/** The members a JWK carries only when it holds a private or symmetric key. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/**
 * What is wrong with an entry as a verification method, or null. Whether
 * the key it carries is of a supported type is decided where that key is
 * used, so a method of a type this vault never uses does not fail the
 * document.
 */
function methodFault(entry: unknown): string | null {
  if (!isJsonObject(entry)) return "is an object";
  if (typeof entry["id"] !== "string") return "has a string id";
  if (typeof entry["type"] !== "string") return "has a string type";
  const controller = entry["controller"];
  if (controller !== undefined && !isDid(controller)) return "has a DID controller if any";
  const multibase = entry["publicKeyMultibase"];
  const jwk = entry["publicKeyJwk"];
  if ((multibase === undefined) === (jwk === undefined)) return "carries one of publicKeyMultibase and publicKeyJwk";
  if (multibase !== undefined && typeof multibase !== "string") return "has a string publicKeyMultibase";
  if (jwk !== undefined) {
    if (!isJsonObject(jwk)) return "has an object publicKeyJwk";
    const secret = PRIVATE_JWK_MEMBERS.find((member) => jwk[member] !== undefined);
    if (secret !== undefined) return `has a publicKeyJwk without the private member ${secret}`;
  }
  return null;
}

function endpointFault(endpoint: unknown): string | null {
  if (typeof endpoint === "string") return isUri(endpoint) ? null : "has a serviceEndpoint that is a URI";
  if (isJsonObject(endpoint)) return null;
  return "has a serviceEndpoint that is a URI or an object";
}

function serviceFault(entry: unknown): string | null {
  if (!isJsonObject(entry)) return "is an object";
  if (typeof entry["id"] !== "string") return "has a string id";
  const type = entry["type"];
  if (typeof type !== "string" && !(Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string"))) return "has a type, a string or strings";
  const endpoint = entry["serviceEndpoint"];
  if (Array.isArray(endpoint)) {
    if (endpoint.length === 0) return "has a serviceEndpoint that is not empty";
    return endpoint.map(endpointFault).find((fault) => fault !== null) ?? null;
  }
  return endpointFault(endpoint);
}

function shaped(document: JsonObject): void {
  const each = (member: string, faultOf: (entry: unknown) => string | null) => {
    const entries = document[member];
    if (entries === undefined) return;
    if (!Array.isArray(entries)) throw new InvalidDidDocument(`${member} is an array`);
    entries.forEach((entry, i) => {
      const fault = faultOf(entry);
      if (fault !== null) throw new InvalidDidDocument(`${member}[${i}] ${fault}`);
    });
  };
  each("alsoKnownAs", (entry) => (typeof entry === "string" ? null : "is a string"));
  each("verificationMethod", methodFault);
  each("service", serviceFault);
  for (const relationship of VERIFICATION_RELATIONSHIPS) each(relationship, (entry) => (typeof entry === "string" ? null : methodFault(entry)));
}

/**
 * The input document a validated long form encodes. The method's own
 * decoder checks the hash and parses the bytes leniently, so its JSON
 * syntax errors are the spelling's fault too; the document is then
 * read again from the raw bytes under the event format's strict JSON,
 * since a lenient parse would retain a document another implementation
 * refuses, with invalid UTF-8 replaced and a duplicated member's last
 * value kept.
 */
function inputDocumentOf(longFormDid: string): JsonObject {
  if (!isLongForm(longFormDid)) throw new InvalidDidDocument("not a did:peer:4 long form");
  try {
    decodeLongForm(longFormDid);
  } catch (err) {
    if (err instanceof PeerDID4Error) throw new InvalidDidDocument(err.message);
    if (err instanceof SyntaxError) throw new InvalidDidDocument(`the encoded document is not JSON: ${err.message}`);
    throw err;
  }
  const encoded = base58.decode(longFormDid.slice(longFormDid.lastIndexOf(":") + 2));
  const [code, length] = varint.decode(encoded);
  if (code !== MULTICODEC_JSON) throw new InvalidDidDocument("the encoded document is not multicodec-tagged JSON");
  let input: unknown;
  try {
    input = parseStrict(encoded.subarray(length));
  } catch (err) {
    throw new InvalidDidDocument(`the input document is not strict JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(input)) throw new InvalidDidDocument("the input document is a JSON object");
  try {
    validateInputDocument(input);
  } catch (err) {
    if (err instanceof PeerDID4Error) throw new InvalidDidDocument(err.message);
    throw err;
  }
  shaped(input);
  return input;
}

/**
 * The DID a spelling names for folds and comparisons: a validated
 * numalgo-4 long form is its derived short form; every other DID is
 * the exact string, byte for byte.
 */
export function canonicalDidOf(presented: string): Did {
  if (!isDid(presented)) throw new InvalidDidDocument(`not a DID: ${JSON.stringify(presented)}`);
  if (!presented.startsWith(PEER4_PREFIX) || isShortForm(presented)) return presented as Did;
  retainedDocumentOf(presented);
  return longToShort(presented) as Did;
}

function withDefaultController(entry: JsonValue, did: Did): JsonValue {
  return isJsonObject(entry) && entry["controller"] === undefined ? { ...entry, controller: did } : entry;
}

/**
 * The document a validated long form resolves to, as retained, worked
 * out from its text; a throw
 * when the long form or its input document is not one. It is the long
 * form's own resolution result: identified by the long form, the short
 * form appended to `alsoKnownAs`, omitted controllers filled in and
 * everything else, relative references included, kept as the input has
 * it. Its verification relationships and services must read: every
 * reference into the document names a method it defines, and every
 * service has an ID of its own.
 */
export function retainedDocumentAnew(longFormDid: string): JsonObject {
  const input = inputDocumentOf(longFormDid);
  const long = longFormDid as Did;
  const document: JsonObject = { ...input, id: long, alsoKnownAs: [...((input["alsoKnownAs"] as string[] | undefined) ?? []), longToShort(longFormDid)] };
  for (const member of ["verificationMethod", ...VERIFICATION_RELATIONSHIPS]) {
    const entries = input[member];
    if (Array.isArray(entries)) document[member] = entries.map((entry) => withDefaultController(entry, long));
  }
  for (const relationship of VERIFICATION_RELATIONSHIPS) authorizedMethodIds(document, relationship);
  read(() => serviceIds(document));
  return document;
}

/**
 * The retained document of a spelling, kept by that spelling: every
 * scan asks for the document of each long form the events name, and
 * decoding one costs the square of its length. One spelling gives the
 * same document every time, frozen all the way down.
 */
const retainedDocumentOf = remembered(
  (longFormDid) => frozen(retainedDocumentAnew(longFormDid)),
  (error) => error instanceof InvalidDidDocument
);

/**
 * The retained resolution of a numalgo-4 long form: its document under
 * the RFC 8785 bytes and raw CID the vault stores it as. The document
 * is the one every resolution of this spelling shares, frozen: copy it
 * to change it. The bytes are the caller's own.
 */
export function peerResolution(longFormDid: string): PeerResolution {
  const document = retainedDocumentOf(longFormDid);
  let bytes: Uint8Array;
  try {
    bytes = canonicalize(document);
  } catch (err) {
    throw new InvalidDidDocument(`the document does not canonicalize: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { did: longToShort(longFormDid) as Did, presentedDid: longFormDid as Did, document, bytes, cid: rawCidOfBytes(bytes) };
}

/** What `@estoc/did-peer` refuses to read, as a document the vault refuses. */
function read<T>(reading: () => T): T {
  try {
    return reading();
  } catch (err) {
    if (err instanceof DIDDocumentError) throw new InvalidDidDocument(err.message);
    throw err;
  }
}

/** The absolute IDs of the methods a relationship authorizes, each once in document order, as `@estoc/did-peer` reads them. */
export function authorizedMethodIds(document: JsonObject, relationship: VerificationRelationship): DidUrl[] {
  return read(() => authorizedIn(document, relationship)) as DidUrl[];
}

/** The method the document defines under an absolute ID, as the exact retained entry. */
export function definedMethod(document: JsonObject, id: DidUrl): JsonObject {
  return read(() => definedIn(document, id)) as JsonObject;
}

/** The canonical public key of the method the document defines under an absolute ID. */
export function methodPublicKey(document: JsonObject, id: DidUrl): PublicKey {
  const method = definedMethod(document, id);
  const multibase = method["publicKeyMultibase"];
  const jwk = method["publicKeyJwk"];
  const key = typeof multibase === "string" && jwk === undefined ? multibase : isJsonObject(jwk) && multibase === undefined ? jwk : null;
  if (key === null) throw new InvalidDidDocument(`${id} carries one of publicKeyMultibase and publicKeyJwk`);
  try {
    return canonicalPublicKey(key);
  } catch (err) {
    if (err instanceof InvalidPublicKey) throw new InvalidDidDocument(`${id}: ${err.message}`);
    throw err;
  }
}

/**
 * The endpoint URIs of the document's DIDComm services, in document
 * order: `serviceEndpoint` as a string, as an object with a `uri`, or
 * as an array of either.
 */
export function didcommServiceUris(document: JsonObject): string[] {
  const uris: string[] = [];
  const uriOf = (endpoint: unknown, at: string): string => {
    if (typeof endpoint === "string") return endpoint;
    if (isJsonObject(endpoint) && typeof endpoint["uri"] === "string") return endpoint["uri"];
    throw new InvalidDidDocument(`${at} is a URI or an object with a uri`);
  };
  const services = document["service"];
  if (services !== undefined && !Array.isArray(services)) throw new InvalidDidDocument("service is an array");
  (services ?? []).forEach((service, i) => {
    if (!isJsonObject(service)) throw new InvalidDidDocument(`service[${i}] is an object`);
    const type = service["type"];
    if (type !== "DIDCommMessaging" && !(Array.isArray(type) && type.includes("DIDCommMessaging"))) return;
    const endpoint = service["serviceEndpoint"];
    const at = `service[${i}].serviceEndpoint`;
    if (Array.isArray(endpoint)) uris.push(...endpoint.map((entry, j) => uriOf(entry, `${at}[${j}]`)));
    else uris.push(uriOf(endpoint, at));
  });
  return uris;
}
