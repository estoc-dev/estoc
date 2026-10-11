# @estoc/did-web

did:web under a network policy. Whoever presents a did:web chooses the host
its document is fetched from, so a resolver that fetches on someone else's
word goes wherever that word points. This package derives the one URL a
did:web names, refuses the ones that name no public host, and fetches the
document over a transport you supply: no redirect followed, no cache
answering, a bounded body within a deadline, and the document kept only when
its `id` is the presented DID byte for byte.

The main entry runs unchanged in Node (22 or later), Cloudflare workerd and
the browser. `@estoc/did-web/node` adds `guardedFetch`, a transport for Node
that checks every address a name resolves to.

```sh
npm install @estoc/did-web
```

## Usage

```ts
import { fetchWebDid } from "@estoc/did-web";
import { guardedFetch } from "@estoc/did-web/node";

const fetched = await fetchWebDid("did:web:example.com", { fetch: guardedFetch });
switch (fetched.outcome) {
  case "resolved": // fetched.document, asked for at fetched.url
  case "unavailable": // no answer now: try again later
  case "definitive": // an answer from the network that closes the attempt
  case "refused": // the policy fetches nothing for this DID, and nothing was asked
}
```

## What's in

- **`webDidUrl(did, insecureLoopback?)`**: the URL a did:web names,
  `https://<host>/.well-known/did.json` or `https://<host>/<path>/did.json`,
  or why it is refused before any request: not a did:web by DID syntax, an
  authority that is more than a host and a port, a path segment that is
  empty, a dot segment or holds a delimiter, an IP literal, a reserved name
  (`.localhost`, `.local`, `.internal`, `.home.arpa`, reverse DNS) or a
  loopback host. With `insecureLoopback`, `localhost` and `127.0.0.1` are
  allowed over plain http, for a service run on the same machine during
  development.
- **`didWebFromUrl(publicUrl)`**: the inverse, for a service that names
  itself: the did:web whose document `webDidUrl` finds at that URL, or a
  throw when there is none, as for plain http to a public name.
- **`fetchWebDid(did, options)`**: the fetch. `fetch` is the transport;
  `maxBytes` bounds the body (`MAX_DOCUMENT_BYTES`, 256 KiB, by default);
  `timeoutMs` bounds the whole fetch, to the parsed document
  (`DEFAULT_TIMEOUT_MS`, 10 s, by default); `insecureLoopback` is as above;
  `parse` reads the body as JSON, fatal UTF-8 and `JSON.parse` by default,
  and a stricter parser can refuse what that one lets through, such as a
  member given twice.
- **`DEFINITIVE_TRANSPORT_CODES`**: the codes a transport puts on a failure
  that is final.
- **`@estoc/did-web/node`**: `guardedFetch`, and `isPublicAddress`, the
  check it makes on each address.

## Outcomes

| Outcome | When |
| --- | --- |
| `resolved` | a 2xx whose body fits the bound and parses to a JSON object whose `id` is the DID |
| `unavailable` | HTTP 408, 429 or 5xx; a transport failure without a final code; the deadline |
| `definitive` | a redirect; 404, 410 or any other status; a body past the bound; no JSON object; another `id`; a transport failure with a final code |
| `refused` | a DID `webDidUrl` refuses |

## The transport

A check on the name binds nothing on its own: where a name points is seen
only where the connection is made, and it may point elsewhere by the next
connection. So the network policy holds in the transport, and
`fetchWebDid` takes one under this contract:

- It refuses what its policy forbids, and marks the refusal with the code
  `EBLOCKED` (`DEFINITIVE_TRANSPORT_CODES.refused`), on the error or down
  its `cause` chain.
- It marks a name with no address, NXDOMAIN or NODATA for every usable
  address family, with `ENXDOMAIN`. A transport that cannot tell a missing
  name from a lookup that failed leaves the code off, and the failure counts
  as no answer now.
- It follows no redirect and answers from no cache (`fetchWebDid` asks for
  `redirect: "manual"` and `cache: "no-store"`), and it honours `signal`.

`guardedFetch` is that transport for Node. It resolves the name, refuses
every address that is not public unicast, at each connection, and refuses an
IP literal in the URL that is not, or a scheme other than http and https,
before connecting. In a browser or a Worker the platform's `fetch` makes the
connection, and the checks on the name are what this package holds there.

`web-did-resolver` is not wrapped: it fetches through its own transport,
follows redirects and reads a body without a bound.

## Development

```
pnpm test       # vitest
pnpm build      # tsc → dist/
```

## License

Apache-2.0
