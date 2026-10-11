# Changelog

## Unreleased

did:web under a network policy, taken out of `@estoc/agent-core` and
`@estoc/mediator`, which each had their own.

- **`webDidUrl`**: the one URL a did:web names, or why it is refused
  before any request. A DID that is not a did:web by DID syntax is
  refused. Plain http is allowed with `insecureLoopback` to `localhost`
  and `127.0.0.1` only; `[::1]` is an IP literal like any other.
- **`didWebFromUrl`**: the did:web of a service at a public URL, the
  inverse of `webDidUrl`; a URL `webDidUrl` would not give back is
  refused with a throw.
- **`fetchWebDid`**: the fetch over a transport the host supplies,
  under the contract its README states. Its outcome is `resolved`,
  `unavailable`, `definitive`, or `refused` when the policy settled it
  before any request.
- **`@estoc/did-web/node`**: `guardedFetch`, the Node transport that
  refuses every address that is not public unicast. It now checks an IP
  literal as each connection is made, puts the code `EBLOCKED` on every
  refusal, a literal or a scheme included, follows no redirect whatever
  the request asks, and sends a `Request` with its method, headers, body
  and signal.
