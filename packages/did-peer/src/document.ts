/**
 * What a DID document authorizes, read one way for any DID document, so
 * that the party that signs and every party that verifies name the same
 * method and find the same entry for its key. A reference resolves
 * against the document's `id`, an embedded method is defined where it
 * is listed, a reference into the document names a method the document
 * defines, and one ID defines one method.
 *
 * Reading checks what its answers depend on. Whether a document is one
 * an application keeps, every member the shape DID Core gives it, is the
 * application's policy.
 */

import serialize from "canonicalize";

import { isDid, isDidUrl, splitDidUrl } from "./did-url.js";
import type { PeerDocument } from "./did-peer-4.js";

export const VERIFICATION_RELATIONSHIPS = ["authentication", "assertionMethod", "keyAgreement", "capabilityDelegation", "capabilityInvocation"] as const;
export type VerificationRelationship = (typeof VERIFICATION_RELATIONSHIPS)[number];

export class DIDDocumentError extends Error {
  readonly name = "DIDDocumentError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function documentId(document: PeerDocument): string {
  const id = document["id"];
  if (!isDid(id)) throw new DIDDocumentError("the document id is a DID");
  return id;
}

/**
 * A reference resolved against the document's DID. Only fragment and
 * query references resolve: a DID has no path to resolve a
 * path-relative reference against.
 */
function resolved(reference: string, base: string): string {
  return reference.startsWith("#") || reference.startsWith("?") ? base + reference : reference;
}

/** A method reference as the document authorizes it: resolved, and a DID URL. */
function absolute(reference: unknown, base: string, at: string): string {
  if (typeof reference !== "string") throw new DIDDocumentError(`${at} is a DID URL`);
  const url = resolved(reference, base);
  if (!isDidUrl(url)) throw new DIDDocumentError(`${at} is a DID URL or a fragment reference: ${JSON.stringify(reference)}`);
  return url;
}

function entriesOf(document: PeerDocument, member: string): readonly unknown[] {
  const entries = document[member];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new DIDDocumentError(`${member} is an array`);
  return entries;
}

/**
 * A definition as RFC 8785 text, to compare it with another under its
 * ID. A value that has no such text, a lone surrogate or a number
 * beyond a double, cannot be shown to be the same as another.
 */
function comparable(definition: Record<string, unknown>): string {
  try {
    return serialize(definition) as string;
  } catch (err) {
    throw new DIDDocumentError(`${definition["id"]} is defined twice, with a value that has no RFC 8785 form: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Every method the document defines, by absolute ID, each entry with
 * its ID resolved. Two definitions under one ID must be the same method:
 * the same JSON value once their IDs are resolved, however each spells it.
 */
export function definedMethods(document: PeerDocument): Map<string, Record<string, unknown>> {
  const base = documentId(document);
  const methods = new Map<string, Record<string, unknown>>();
  const define = (entry: Record<string, unknown>, at: string) => {
    const definition = { ...entry, id: absolute(entry["id"], base, `${at}.id`) };
    const known = methods.get(definition.id);
    if (known === undefined) methods.set(definition.id, definition);
    else if (comparable(known) !== comparable(definition)) throw new DIDDocumentError(`two different verification methods are ${definition.id}`);
  };
  entriesOf(document, "verificationMethod").forEach((entry, i) => {
    if (!isRecord(entry)) throw new DIDDocumentError(`verificationMethod[${i}] is an object`);
    define(entry, `verificationMethod[${i}]`);
  });
  for (const relationship of VERIFICATION_RELATIONSHIPS) {
    entriesOf(document, relationship).forEach((entry, i) => {
      if (isRecord(entry)) define(entry, `${relationship}[${i}]`);
    });
  }
  return methods;
}

/**
 * The absolute IDs of the methods a relationship authorizes, each once
 * in document order: a reference resolved against the document's DID,
 * or an embedded method's own ID. A reference into this document must
 * name a method it defines; a reference into another DID is kept as
 * authorized, its key that DID's document's to give.
 */
export function authorizedMethodIds(document: PeerDocument, relationship: VerificationRelationship): string[] {
  const base = documentId(document);
  const defined = definedMethods(document);
  const ids = new Set<string>();
  entriesOf(document, relationship).forEach((entry, i) => {
    const at = `${relationship}[${i}]`;
    let id: string;
    if (typeof entry === "string") {
      id = absolute(entry, base, at);
      if (splitDidUrl(id)[0] === base && !defined.has(id)) throw new DIDDocumentError(`${at} references no verification method: ${id}`);
    } else if (isRecord(entry)) {
      id = absolute(entry["id"], base, `${at}.id`);
    } else {
      throw new DIDDocumentError(`${at} is a reference or an embedded verification method`);
    }
    ids.add(id);
  });
  return [...ids];
}

/** The method the document defines under an absolute ID: its entry, with the ID resolved. */
export function definedMethod(document: PeerDocument, id: string): Record<string, unknown> {
  const method = definedMethods(document).get(id);
  if (method === undefined) throw new DIDDocumentError(`the document defines no verification method ${id}`);
  return method;
}

/** RFC 3986 §4.3: a reference that begins with a scheme is an absolute URI. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The absolute IDs of the document's services, in document order;
 * every service has an ID of its own. A fragment or query reference
 * resolves against the document's DID, and any other ID is a URI as it
 * stands. Whether that URI is well formed, like the rest of a
 * service's shape, is the application's to check.
 */
export function serviceIds(document: PeerDocument): string[] {
  const base = documentId(document);
  const ids = new Set<string>();
  entriesOf(document, "service").forEach((service, i) => {
    if (!isRecord(service)) throw new DIDDocumentError(`service[${i}] is an object`);
    const reference = service["id"];
    if (typeof reference !== "string") throw new DIDDocumentError(`service[${i}].id is a string`);
    const id = resolved(reference, base);
    if (!SCHEME.test(id)) throw new DIDDocumentError(`service[${i}].id is a URI or a fragment or query reference: ${JSON.stringify(reference)}`);
    if (ids.has(id)) throw new DIDDocumentError(`two services are ${id}`);
    ids.add(id);
  });
  return [...ids];
}
