/**
 * Snapshot links as a view hands them over and reads them back: the
 * link as base64url JSON in the `snapshot` parameter of a URL's
 * fragment, which is what a QR code shows or a pasted link carries. A
 * fragment is not sent to the URL's host, so the key in it goes only
 * where the link is handed; the host is whichever Estoc the link is
 * meant to open in, and every Estoc reads only the parameter.
 */

import type { SnapshotLink } from "../contract/index.js";
import { snapshotLink } from "../contract/schemas/snapshot-links.js";
import { base64urlToUtf8, utf8ToBase64url } from "./base64url.js";

/** `<base>#snapshot=<base64url JSON>`. */
export function snapshotLinkUrl(base: string, link: SnapshotLink): string {
  const url = new URL(base);
  url.hash = new URLSearchParams({ snapshot: utf8ToBase64url(JSON.stringify({ url: link.url, hash: link.hash, key: link.key })) }).toString();
  return url.toString();
}

/**
 * The snapshot link in whatever was pasted or scanned: a URL carrying
 * it in its fragment, or the bare parameter. Anything else throws, with
 * the reason for a person.
 */
export function parseSnapshotLink(input: string): SnapshotLink {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error("nothing to read a snapshot link from");
  let encoded = trimmed;
  if (trimmed.includes("://")) {
    if (!URL.canParse(trimmed)) throw new Error("that is no URL");
    const param = new URLSearchParams(new URL(trimmed).hash.slice(1)).get("snapshot");
    if (param === null) throw new Error("that URL carries no snapshot link");
    encoded = param;
  }
  let value: unknown;
  try {
    value = JSON.parse(base64urlToUtf8(encoded));
  } catch {
    throw new Error("the snapshot link does not decode");
  }
  const parsed = snapshotLink.safeParse(value);
  if (!parsed.success) throw new Error(`the snapshot link is malformed: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "link"} ${issue.message}`).join("; ")}`);
  return parsed.data;
}
