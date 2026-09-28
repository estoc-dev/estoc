import { GOAL_CONNECT, OOB_INVITATION, PLAIN_TYP, type Invitation } from "../contract/protocol.js";
import { invitation as invitationSchema } from "../contract/schemas/methods.js";

// Only these portable platform members are used. They stay out of the
// public declarations, so a consumer needs neither Node nor DOM types.
declare const URL: {
  new (input: string): { searchParams: { get(name: string): string | null; set(name: string, value: string): void }; toString(): string };
};
declare const TextEncoder: { new (): { encode(text: string): Uint8Array } };
declare const TextDecoder: { new (label: string, options: { fatal: boolean }): { decode(bytes: Uint8Array): string } };
declare function atob(text: string): string;
declare function btoa(text: string): string;

const BASE64URL = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}(?:==)?|[A-Za-z0-9_-]{3}=?)?$/;
const urlAlphabet = (base64: string): string => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function encode(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return urlAlphabet(btoa(binary));
}

function decode(encoded: string): string {
  if (encoded === "" || !BASE64URL.test(encoded)) throw new Error("_oob is not base64url");
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  // atob accepts nonzero unused bits; refuse those spellings as well.
  if (urlAlphabet(btoa(binary)) !== encoded.replace(/=+$/, "")) throw new Error("_oob is not base64url");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function read(value: unknown): Invitation {
  const parsed = invitationSchema.safeParse(value);
  if (!parsed.success) throw new Error("not a valid out-of-band 2.0 invitation");
  if (!parsed.data.from.startsWith("did:") || parsed.data.from.length === 4) throw new Error("the invitation names no DID to write to");
  return parsed.data;
}

/**
 * Format an already disclosed DID and invitation ID. This creates no
 * identity or disclosure and says nothing about whether it is usable.
 * A fresh invitation is obtained through the daemon's createInvitation.
 */
export function invitationOf(from: string, id: string, goal: string | null = null): Invitation {
  return read({ type: OOB_INVITATION, id, typ: PLAIN_TYP, from, body: { goal_code: GOAL_CONNECT, ...(goal === null ? {} : { goal }), accept: ["didcomm/v2"] } });
}

/** An absolute URL carrying the invitation as UTF-8 base64url in `_oob`; other parameters and the fragment are kept. */
export function invitationUrl(base: string, invitation: Invitation): string {
  const url = new URL(base);
  url.searchParams.set("_oob", encode(JSON.stringify(read(invitation))));
  return url.toString();
}

/**
 * Read pasted or scanned plaintext JSON, a bare base64url value (with
 * optional padding), or an absolute URL carrying `_oob`. Throws for
 * malformed input. Missing `typ` and `body` take the plaintext defaults;
 * malformed present fields are refused, unknown optional fields ignored.
 * The URL is never fetched and its host is not trusted as an identity.
 * Parsing does not resolve the DID or authorize accepting the invitation.
 */
export function parseInvitation(input: string): Invitation {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("nothing to read an invitation from");
  if (trimmed.startsWith("did:")) throw new Error("that is a DID, not an invitation");
  let json = trimmed;
  if (!trimmed.startsWith("{")) {
    let encoded = trimmed;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
      const parameter = new URL(trimmed).searchParams.get("_oob");
      if (parameter === null) throw new Error("that URL carries no _oob invitation");
      encoded = parameter;
    }
    json = decode(encoded);
  }
  const message: unknown = JSON.parse(json);
  if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("not an out-of-band 2.0 invitation");
  const fields = message as Record<string, unknown>;
  return read({ ...fields, typ: fields["typ"] === undefined ? PLAIN_TYP : fields["typ"], body: fields["body"] === undefined ? {} : fields["body"] });
}
