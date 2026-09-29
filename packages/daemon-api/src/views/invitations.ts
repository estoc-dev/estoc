/**
 * Out-of-band invitations as a view hands them over and reads them
 * back: a plaintext message, carried base64url-encoded in the `_oob`
 * query parameter of a URL, which is what a QR code shows or a link
 * opens. The URL's host is whoever the link is meant to open in; every
 * Estoc reads only the parameter, so an invitation minted at one
 * deployment opens at any other. Nothing here resolves a DID or
 * touches a daemon.
 */

import { GOAL_CONNECT, OOB_INVITATION, PLAIN_TYP, type Invitation } from "../contract/index.js";
import { base64urlToUtf8, utf8ToBase64url } from "./base64url.js";

/** `<base>?_oob=<base64url plaintext>`. */
export function invitationUrl(base: string, invitation: Invitation): string {
  const url = new URL(base);
  url.searchParams.set("_oob", utf8ToBase64url(JSON.stringify(invitation)));
  return url.toString();
}

/** The invitation that discloses `longFormDid` under `oobId` for a conversation between people, as the daemon issues it. */
export function invitationOf(longFormDid: string, oobId: string, goal: string | null): Invitation {
  return { type: OOB_INVITATION, id: oobId, typ: PLAIN_TYP, from: longFormDid, body: { goal_code: GOAL_CONNECT, ...(goal === null ? {} : { goal }), accept: ["didcomm/v2"] } };
}

/**
 * The invitation in whatever was pasted or scanned: a URL carrying
 * `_oob`, the bare base64url parameter, or the plaintext JSON itself.
 * Anything else — a DID, a mediator URL, an unrelated message — throws,
 * with the reason for a person.
 */
export function parseInvitation(input: string): Invitation {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("nothing to read an invitation from");
  if (trimmed.startsWith("did:")) throw new Error("that is a DID, not an invitation");
  let json: string;
  if (trimmed.startsWith("{")) {
    json = trimmed;
  } else {
    let encoded = trimmed;
    if (trimmed.includes("://")) {
      const param = new URL(trimmed).searchParams.get("_oob");
      if (param === null) throw new Error("that URL carries no _oob invitation");
      encoded = param;
    }
    try {
      json = base64urlToUtf8(encoded);
    } catch {
      throw new Error("_oob does not decode");
    }
  }
  let message: unknown;
  try {
    message = JSON.parse(json);
  } catch {
    throw new Error("_oob does not decode to a JSON message");
  }
  if (typeof message !== "object" || message === null) throw new Error("not an out-of-band 2.0 invitation");
  const { type, id, from, body } = message as Record<string, unknown>;
  if (type !== OOB_INVITATION) throw new Error("not an out-of-band 2.0 invitation");
  if (typeof from !== "string" || !from.startsWith("did:")) throw new Error("the invitation names no DID to write to");
  if (typeof id !== "string" || id === "") throw new Error("the invitation has no id");
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    type: OOB_INVITATION,
    id,
    typ: PLAIN_TYP,
    from,
    body: {
      ...(typeof fields["goal_code"] === "string" ? { goal_code: fields["goal_code"] } : {}),
      ...(typeof fields["goal"] === "string" ? { goal: fields["goal"] } : {}),
      ...(Array.isArray(fields["accept"]) && fields["accept"].every((item) => typeof item === "string") ? { accept: fields["accept"] as string[] } : {}),
    },
  };
}
