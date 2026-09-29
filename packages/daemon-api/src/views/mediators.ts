/**
 * What a person hands over to name a mediator, read as far as text
 * goes: a DID as it is, an invitation URL for the DID it discloses, and
 * a bare URL for the view to ask for a description at. The host a
 * mediator's DID names is read off the DID itself: the did:web domain,
 * or the HTTP endpoint a did:peer:2 inlines.
 */

import { base64urlToUtf8 } from "./base64url.js";
import { parseInvitation } from "./invitations.js";

/** A DID read off the input, or a URL to ask for one. */
export type MediatorInput = { did: string; url: null } | { did: null; url: string };

export function mediatorInputOf(input: string): MediatorInput {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("paste an invitation URL, a mediator URL, or a DID");
  if (trimmed.startsWith("did:")) return { did: trimmed, url: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("not a DID or a URL");
  }
  if (url.searchParams.has("_oob")) return { did: parseInvitation(trimmed).from, url: null };
  return { did: null, url: trimmed };
}

const PEER2 = "did:peer:2";

/** The service endpoints a did:peer:2 inlines under `S`, each a URI. */
function peer2Endpoints(did: string): string[] {
  const endpoints: string[] = [];
  for (const segment of did.slice(PEER2.length).split(".")) {
    if (!segment.startsWith("S")) continue;
    let service: unknown;
    try {
      service = JSON.parse(base64urlToUtf8(segment.slice(1)));
    } catch {
      continue;
    }
    const endpoint = typeof service === "object" && service !== null ? (service as { s?: unknown }).s : undefined;
    const uri = typeof endpoint === "string" ? endpoint : typeof endpoint === "object" && endpoint !== null ? (endpoint as { uri?: unknown }).uri : undefined;
    if (typeof uri === "string") endpoints.push(uri);
  }
  return endpoints;
}

/** The host a mediator's DID names; null for a DID that names none a person would recognize. */
export function mediatorHost(did: string): string | null {
  if (did.startsWith("did:web:")) {
    try {
      return decodeURIComponent(did.slice("did:web:".length).split(":")[0] as string) || null;
    } catch {
      return null;
    }
  }
  if (!did.startsWith(PEER2)) return null;
  for (const endpoint of peer2Endpoints(did)) {
    if (!endpoint.startsWith("http")) continue;
    try {
      return new URL(endpoint).host;
    } catch {
      continue;
    }
  }
  return null;
}
