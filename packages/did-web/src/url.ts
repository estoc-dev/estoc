import ipaddr from "ipaddr.js";

const WEB_PREFIX = "did:web:";
/** DID syntax for the method: segments of idchar joined by colons, the last one not empty. */
const DID_WEB = /^did:web:(?:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})*:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/;
/**
 * The hosts plain http may name when the caller allows it: a service run
 * on this machine for development. `[::1]` is not one of them: `localhost`
 * already reaches a server bound to it, and a DID could carry the literal
 * only percent-encoded, which nothing here mints.
 */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1"]);
/** Name suffixes that name no public host: loopback, mDNS, private naming, reverse DNS. */
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"];

/**
 * The one URL a did:web is fetched from, or why it is refused before any
 * network is touched: not a did:web by DID syntax, an authority that is
 * more than a host and an optional port, a path segment that would move
 * the path, an IP literal, a reserved name, or a loopback host unless
 * `insecureLoopback` allows it, which also makes it plain http.
 */
export function webDidUrl(did: string, insecureLoopback = false): { url: URL } | { refused: string } {
  if (!DID_WEB.test(did)) return { refused: "not a did:web" };
  let segments: string[];
  try {
    segments = did
      .slice(WEB_PREFIX.length)
      .split(":")
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return { refused: "the method-specific ID is not percent-encoded UTF-8" };
  }
  const [authority = "", ...path] = segments;
  if (authority === "" || /[@/?#\\]/.test(authority)) return { refused: "the authority is a host name and an optional port, nothing else" };
  for (const segment of path) {
    if (segment === "" || segment === "." || segment === ".." || /[/?#\\]/.test(segment)) return { refused: `the path segment ${JSON.stringify(segment)} is not one` };
  }
  let url: URL;
  try {
    url = new URL(`https://${authority}/`);
  } catch {
    return { refused: `the authority ${JSON.stringify(authority)} is not a host` };
  }
  const name = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const literal = name.startsWith("[") ? name.slice(1, -1) : name;
  if (LOOPBACK_NAMES.has(name)) {
    if (!insecureLoopback) return { refused: "a loopback authority" };
    // parsed anew rather than given another protocol: a :443 that https
    // dropped as its default is a port of its own on http
    url = new URL(`http://${authority}/`);
  } else if (ipaddr.isValid(literal)) {
    return { refused: "an IP-literal authority" };
  } else if (RESERVED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return { refused: `a reserved name: ${url.hostname}` };
  }
  url.pathname = path.length === 0 ? "/.well-known/did.json" : `/${path.map((segment) => encodeURIComponent(segment)).join("/")}/did.json`;
  return { url };
}

/** A path element as DID syntax has it: everything but a letter, a digit, `.`, `-` and `_` percent-encoded. */
function idchars(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The did:web of a service at `publicUrl`: the host with its port
 * percent-encoded, then one segment per path element, a trailing slash
 * aside. It is the inverse of `webDidUrl` with loopback allowed, and a
 * URL that `webDidUrl` would not give back is refused with a throw: an
 * http URL to anything but a loopback host, an https one to a loopback
 * host, an IP literal, a reserved name, a path element that is empty or
 * no segment, or one written otherwise than `webDidUrl` writes it, since
 * a server may tell `a:b` from `a%3Ab`.
 */
export function didWebFromUrl(publicUrl: string | URL): string {
  const url = new URL(publicUrl);
  const host = url.port === "" ? url.hostname : `${url.hostname}%3A${url.port}`;
  const elements = url.pathname.split("/").slice(1);
  if (elements.at(-1) === "") elements.pop();
  const did = ["did:web", host, ...elements.map((element) => idchars(decodeURIComponent(element)))].join(":");
  const derived = webDidUrl(did, true);
  if ("refused" in derived) throw new Error(`${url.href} has no did:web: ${derived.refused}`);
  const document = new URL(elements.length === 0 ? "/.well-known/did.json" : `/${elements.join("/")}/did.json`, url);
  if (derived.url.href !== document.href) throw new Error(`${url.href} has no did:web: its document is fetched from ${derived.url.href}`);
  return did;
}
