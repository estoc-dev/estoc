/**
 * The spellings of a DID and a DID URL, held to the DID Core grammar
 * exactly as written.
 */

// DID Core ABNF: `did:` a method name of lowercase letters and digits, then
// colon-separated segments of ALPHA / DIGIT / "." / "-" / "_" / pct-encoded.
const DID_SYNTAX = "did:[a-z0-9]+:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+";
const DID = new RegExp(`^${DID_SYNTAX}$`);
// A DID URL is a DID followed by RFC 3986 path-abempty, query and fragment:
// every component is built from pchar, so a percent sign
// must begin a two-digit escape, and a space or a second `#` is not a URL.
// The only general URL parser in the platform, WHATWG `URL`, escapes and
// normalizes what it is given instead of refusing it, so it cannot decide
// whether the exact spelling is one.
const PCHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})";
const QUERY_OR_FRAGMENT = `(?:${PCHAR}|[/?])*`;
const DID_URL = new RegExp(`^${DID_SYNTAX}(?:/${PCHAR}*)*(?:\\?${QUERY_OR_FRAGMENT})?(?:#${QUERY_OR_FRAGMENT})?$`);

export const isDid = (value: unknown): value is string => typeof value === "string" && DID.test(value);
export const isDidUrl = (value: unknown): value is string => typeof value === "string" && DID_URL.test(value);

/** A DID URL split at its first path, query or fragment delimiter: the DID, and the rest as written. */
export function splitDidUrl(url: string): [did: string, pathQueryFragment: string] {
  const end = url.search(/[/?#]/);
  return end < 0 ? [url, ""] : [url.slice(0, end), url.slice(end)];
}
