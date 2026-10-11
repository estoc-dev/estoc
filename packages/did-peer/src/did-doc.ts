import bs58 from "bs58";

import type { DIDDoc, Service, VerificationMethod } from "./types.js";
import { absolutizeReferences, type PeerDocument } from "./did-peer-4.js";
import { authorizedMethodIds, definedMethods, DIDDocumentError } from "./document.js";

/**
 * Converts a W3C DID document into the flat DIDDoc shape didcomm-rust expects:
 * the relationships and methods as `authorizedMethodIds` and `definedMethod`
 * read them, every method the document defines hoisted into
 * `verificationMethod` wherever it is embedded, absolute DID URLs everywhere,
 * and only DIDCommMessaging services retained.
 */

export class DIDDocConversionError extends Error {
  readonly name = "DIDDocConversionError";
}

/** multicodec prefixes for the key types didcomm-rust can read from multibase */
const ED25519_PUB = Uint8Array.from([0xed, 0x01]);
const X25519_PUB = Uint8Array.from([0xec, 0x01]);

/**
 * The keys didcomm-rust reads from a `JsonWebKey2020` JWK, by `kty`: the
 * curves it reads, and the members that hold the public key on them.
 */
const JWK_KEYS: ReadonlyMap<unknown, { curves: ReadonlySet<unknown>; coordinates: readonly string[] }> = new Map([
  ["EC", { curves: new Set(["P-256", "secp256k1"]), coordinates: ["x", "y"] }],
  ["OKP", { curves: new Set(["Ed25519", "X25519"]), coordinates: ["x"] }],
]);

const BASE58_SUITES = new Set(["X25519KeyAgreementKey2019", "Ed25519VerificationKey2018"]);

type Material = Pick<VerificationMethod, "publicKeyJwk" | "publicKeyMultibase" | "publicKeyBase58">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the two-byte multicodec prefix from a base58btc multibase key. */
function multicodecPrefix(publicKeyMultibase: string): Uint8Array | null {
  if (!publicKeyMultibase.startsWith("z")) {
    return null;
  }
  try {
    const decoded = bs58.decode(publicKeyMultibase.slice(1));
    return decoded.length >= 2 ? decoded.slice(0, 2) : null;
  } catch {
    return null;
  }
}

function prefixMatches(prefix: Uint8Array | null, expected: Uint8Array): boolean {
  return (
    prefix !== null && prefix[0] === expected[0] && prefix[1] === expected[1]
  );
}

/**
 * The JWK as didcomm-rust imports it: the key type, the curve and the
 * members holding the public key, or null when it holds no key on a
 * curve didcomm-rust reads. askar, which imports it, fails on a member
 * its parser has no case for, such as `alg`, and builds the key from
 * these members alone; leaving the rest out keeps the key.
 */
function importableJwk(jwk: Record<string, unknown>): Record<string, unknown> | null {
  const { kty, crv } = jwk;
  const key = JWK_KEYS.get(kty);
  if (key === undefined || !key.curves.has(crv)) {
    return null;
  }
  const coordinates = key.coordinates.map((member) => [member, jwk[member]] as const);
  return coordinates.every(([, value]) => typeof value === "string")
    ? { kty, crv, ...Object.fromEntries(coordinates) }
    : null;
}

/**
 * The method's suite and material as didcomm-rust reads them. It reads
 * the first of a JWK, a multibase and a base58 value the method carries,
 * and only under the suite defined over that material: a JWK under
 * `JsonWebKey2020` holding a key on a curve it supports, a multibase key
 * under the 2020 suite of the key's own curve, a base58 key under the
 * older suites. It has no `Multikey` variant, so a Multikey method is
 * read under the 2020 suite of its multicodec prefix.
 *
 * Anything else becomes `Other`. didcomm-rust's VerificationMethodType
 * has no catch-all deserializer, so leaving an unknown type in place
 * fails deserialization of the *entire* DIDDoc, and a known type over
 * material it does not read fails whatever operation picks the method:
 * one unusable method in a counterparty's document would otherwise
 * break every operation. An `Other` method survives the round trip but
 * cannot be used for crypto.
 */
function asRead(type: string, material: Material): Pick<VerificationMethod, "type"> & Material {
  const { publicKeyJwk: jwk, publicKeyMultibase: multibase, publicKeyBase58: base58 } = material;
  if (jwk !== undefined) {
    const key = type === "JsonWebKey2020" ? importableJwk(jwk) : null;
    return key === null ? { type: "Other", ...material } : { type, ...material, publicKeyJwk: key };
  }
  if (multibase !== undefined) {
    const prefix = multicodecPrefix(multibase);
    const suite = prefixMatches(prefix, ED25519_PUB)
      ? "Ed25519VerificationKey2020"
      : prefixMatches(prefix, X25519_PUB)
        ? "X25519KeyAgreementKey2020"
        : "Other";
    return { type: type === suite || type === "Multikey" ? suite : "Other", ...material };
  }
  return { type: base58 !== undefined && BASE58_SUITES.has(type) ? type : "Other", ...material };
}

function toVerificationMethod(
  method: Record<string, unknown>,
  documentId: string
): VerificationMethod | null {
  const { id, type } = method;
  if (typeof id !== "string" || typeof type !== "string") {
    return null;
  }

  const controller =
    typeof method.controller === "string" ? method.controller : documentId;

  const material: Material = {};
  if (isRecord(method.publicKeyJwk)) {
    material.publicKeyJwk = method.publicKeyJwk;
  }
  if (typeof method.publicKeyMultibase === "string") {
    material.publicKeyMultibase = method.publicKeyMultibase;
  }
  if (typeof method.publicKeyBase58 === "string") {
    material.publicKeyBase58 = method.publicKeyBase58;
  }

  return { id, controller, ...asRead(type, material) };
}

function firstEndpoint(serviceEndpoint: unknown): unknown {
  return Array.isArray(serviceEndpoint) ? serviceEndpoint[0] : serviceEndpoint;
}

function toService(service: Record<string, unknown>): Service | null {
  const { id, type } = service;
  if (typeof id !== "string" || type !== "DIDCommMessaging") {
    return null;
  }

  const endpoint = firstEndpoint(service.serviceEndpoint);

  // A bare string endpoint is the DIDComm v1 spelling of `{ uri }`.
  if (typeof endpoint === "string") {
    return { id, type, serviceEndpoint: { uri: endpoint, routingKeys: [] } };
  }

  if (!isRecord(endpoint) || typeof endpoint.uri !== "string") {
    return null;
  }

  const normalized: Service["serviceEndpoint"] = {
    uri: endpoint.uri,
    routingKeys: Array.isArray(endpoint.routingKeys)
      ? endpoint.routingKeys.filter((key): key is string => typeof key === "string")
      : [],
  };

  if (Array.isArray(endpoint.accept)) {
    normalized.accept = endpoint.accept.filter(
      (item): item is string => typeof item === "string"
    );
  }

  return { id, type, serviceEndpoint: normalized };
}

function read<T>(reading: () => T): T {
  try {
    return reading();
  } catch (err) {
    if (err instanceof DIDDocumentError) throw new DIDDocConversionError(err.message);
    throw err;
  }
}

/**
 * Convert a W3C DID document into the didcomm-rust DIDDoc shape.
 *
 * Relative references are absolutized against the document `id`, since
 * didcomm-rust derives a DID by splitting a `kid` on `#`. A method another
 * relationship embeds is hoisted too: didcomm-rust looks a `kid` up in
 * `verificationMethod` alone.
 */
export function toDIDCommDIDDoc(document: PeerDocument): DIDDoc {
  const id = document.id;
  if (typeof id !== "string") {
    throw new DIDDocConversionError("DID document has no string `id`");
  }

  const authentication = read(() => authorizedMethodIds(document, "authentication"));
  const keyAgreement = read(() => authorizedMethodIds(document, "keyAgreement"));
  const verificationMethod = [...read(() => definedMethods(document)).values()]
    .map((method) => toVerificationMethod(method, id))
    .filter((method): method is VerificationMethod => method !== null);

  const service: Service[] = [];
  const services = absolutizeReferences(document).service;
  if (Array.isArray(services)) {
    for (const entry of services) {
      if (!isRecord(entry)) {
        continue;
      }
      const normalized = toService(entry);
      if (normalized !== null) {
        service.push(normalized);
      }
    }
  }

  return { id, keyAgreement, authentication, verificationMethod, service };
}
