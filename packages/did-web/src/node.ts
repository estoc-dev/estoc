import dns from "node:dns";
import net from "node:net";

import ipaddr from "ipaddr.js";
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

import { DEFINITIVE_TRANSPORT_CODES } from "./fetch.js";

/**
 * A fetch for URLs somebody else chose. A Node process, unlike a browser
 * tab, reaches whatever its network can: a service on localhost, a cloud
 * instance's metadata endpoint, the rest of a private network. So every
 * connection is checked as it is opened, on the address it goes to: a
 * name at lookup, on every address the name has, and an IP literal before
 * it is dialled, since Node dials a literal without a lookup. Anything not
 * a public unicast address is refused with the code
 * `DEFINITIVE_TRANSPORT_CODES.refused`. No redirect is followed: a 3xx is
 * the answer, or an error when the request asks for `redirect: "error"`.
 */

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function refusal(message: string): Error {
  return Object.assign(new Error(`refused: ${message}`), { code: DEFINITIVE_TRANSPORT_CODES.refused });
}

const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, found) => {
    if (err) {
      callback(err, []);
      return;
    }
    const bad = found.find((a) => !isPublicAddress(a.address));
    const first = found[0];
    if (bad !== undefined || first === undefined) {
      callback(refusal(`${hostname} resolves to ${bad?.address ?? "nothing"}, not a public address`), []);
      return;
    }
    if (options.all) callback(null, found);
    else callback(null, first.address, first.family);
  });
};

const connectLooked = buildConnector({ lookup: guardedLookup });

const dispatcher = new Agent({
  connect(options, callback) {
    if (net.isIP(options.hostname) !== 0 && !isPublicAddress(options.hostname)) {
      callback(refusal(`${options.hostname} is not a public address`), null);
      return;
    }
    connectLooked(options, callback);
  },
});

/**
 * The URL and init of the request fetch would make, in a form the
 * package's undici takes: a `Request` of Node's own fetch is not one of
 * undici's, so its parts go over one by one, with `init` merged in by
 * fetch's rules first. Its body is read whole so the request still
 * carries its length.
 */
async function undiciRequest(input: RequestInfo | URL, init: RequestInit | undefined): Promise<[string, UndiciRequestInit]> {
  if (!(input instanceof Request)) return [String(input), { ...(init as UndiciRequestInit) }];
  const request = new Request(input, init);
  return [
    request.url,
    {
      method: request.method,
      headers: [...request.headers],
      body: request.body === null ? null : await request.arrayBuffer(),
      signal: request.signal,
      redirect: request.redirect,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    },
  ];
}

export const guardedFetch: typeof fetch = async (input, init) => {
  const [href, request] = await undiciRequest(input, init);
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw refusal(`${url.protocol} is not a scheme fetched here`);
  try {
    const response = await undiciFetch(url, { ...request, redirect: request.redirect === "error" ? "error" : "manual", dispatcher });
    return response as unknown as Response;
  } catch (err) {
    // undici says "fetch failed" and keeps the reason as the cause; the
    // reason is what a log should show, a refusal above all
    const cause = (err as { cause?: unknown }).cause;
    throw cause instanceof Error ? cause : err;
  }
};
