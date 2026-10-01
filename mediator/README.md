# didcomm-mediator

A DIDComm v2 mediator anyone can run.

TypeScript, standard protocols over plain HTTP/WebSocket transport, no
accounts to create and no vendor SDK to adopt — authentication is the
envelope itself.

Two deployment targets share one protocol implementation:

- **Cloudflare Workers** — D1 for storage, a Durable Object holding the live
  WebSockets; there is no server, no secret, and no URL to configure at all.
- **Node + Docker** — one process, SQLite on a volume.

Either way the mediator's whole identity is two private keys in its own
database, minted on first contact; every DID it answers to is derived from
those keys, so **keep the database, keep the mediator**.

## Quick start (Cloudflare Workers)

The mediator is built from the [estoc workspace](../README.md) it is part
of, so deploy from a clone of the whole repository:

```sh
git clone https://github.com/estoc-net/estoc && cd estoc
pnpm install
cd mediator
pnpm exec wrangler d1 create mediator    # paste database_id into wrangler.jsonc
pnpm run deploy
pnpm run smoke https://your-worker.example.workers.dev
```

The Workers deployment is URL-agnostic: it answers every host that routes to
it as that host's own `did:web` — `your-worker.example.workers.dev` on day
one, and if you later attach a custom domain in the dashboard, that domain
becomes a second, equally live DID off the same keys. Locally, `pnpm run
dev:workers` serves `did:web:localhost%3A8787` the same way.

`pnpm run smoke <url>` drives a real client through the whole surface —
grant, keylist, anonymous forward, pickup, WebSocket live delivery — against
any running mediator, whichever target it is.

## Quick start (Docker)

```sh
git clone https://github.com/estoc-net/estoc && cd estoc/mediator
MEDIATOR_PUBLIC_URL=https://mediator.example.com docker compose up -d
curl -s https://mediator.example.com/
```

On Node the public URL is configuration (`MEDIATOR_PUBLIC_URL`), and the
default method is the same as on Workers: did:web — the mediator's name *is*
its domain. That assumes an https URL (or localhost, for development); for a
URL the world cannot fetch, such as plain http on a LAN, set
`MEDIATOR_DID_METHODS=peer2` for the self-contained method that works
anywhere. Either way the DID is derived from the keys *and* the URL, so
changing the URL renames the mediator (the keys stay). Keep the
`mediator-data` volume and the URL, keep the DID; delete the volume and the
next start mints fresh keys.

The image is built from the workspace root, and the Compose project is named
`didcomm-mediator` wherever the file sits. A deployment started from the
former `didcomm-mediator` repository with default settings therefore keeps
its volume (`didcomm-mediator_mediator-data`), and with it its keys,
accounts and queued messages: stop it there (`docker compose down`, which
leaves volumes alone), then `docker compose up -d --build` here. One started
under another project name (`-p <name>` or `COMPOSE_PROJECT_NAME`) keeps
that name here the same way: `docker compose -p <name> up -d --build`.

TLS is out of scope: put any reverse proxy (Caddy, nginx) in front and point
`MEDIATOR_PUBLIC_URL` at the public HTTPS address. The proxy must also pass
WebSocket upgrades on the same path.

## The mediator's DIDs

One key set, up to three names — each method's DID is a deterministic function
of the stored keys and a public URL:

- **`peer2`** — self-contained: the whole document, endpoint included, is
  encoded in the DID and resolves offline. Works anywhere, plain-http LANs
  included. Changing the URL or the keys means a new DID.
- **`peer4`** — the same trade-offs in did:peer:4's long-form encoding.
- **`web`** (the default) — the DID *is* the domain:
  `https://mediator.example.com` becomes `did:web:mediator.example.com`, and
  keys and endpoints live in the document served at `/.well-known/did.json`
  (also `/did.json`), so both can rotate without changing the DID. Requires
  an https public URL — resolvers fetch did.json over https, nothing else —
  and clients that resolve did:web.

Which names are active is configuration, not storage: `MEDIATOR_DID_METHODS`
is an ordered list (`peer2,web`). The first is the primary — what GET / and
the invitation advertise — and the rest are aliases the mediator answers to
equally: a client is always answered *as the DID it addressed*, and its
mediation grant hands out that same DID for routing. Flipping the order later
changes what new clients see while everyone bound to the other name keeps
working — the migration path from a peer DID to did:web without stranding
anyone. (The peer aliases are still the keys in encoded form, so rotating a
did:web identity's keys renames them; the alias is a bridge, not a place to
stay.)

On Workers the URL half of every derivation is the origin the request arrived
on, so one deployment answers each of its hosts as that host's own DID —
nothing is configured, and no name is more real than another.

## Protocols

| Protocol | Role |
| --- | --- |
| [coordinate-mediation/3.0](https://didcomm.org/coordinate-mediation/3.0) | mediate-request → grant/deny, recipient-update/query |
| [messagepickup/3.0](https://didcomm.org/messagepickup/3.0) | status, delivery, acknowledgement, live delivery over WebSocket |
| [routing/2.0](https://didcomm.org/routing/2.0) | inbound forward for mediated recipients |
| [discover-features/2.0](https://didcomm.org/discover-features/2.0) | protocol disclosure |
| [trust-ping/2.0](https://didcomm.org/trust-ping/2.0) | liveness |
| [out-of-band/2.0](https://didcomm.org/out-of-band/2.0) | invitation issuing (`GET /invitation`, `?_oob=` URL) |
| `https://estoc.dev/blob-store/1.0` | content-addressed blobs one mediation holds and anyone may fetch; on when blob storage is configured |
| `https://estoc.dev/replica-mediation/1.0` | one account, several replicas that each pick up their own copy of its mail ([below](#replica-mediation)); on when `MEDIATOR_REPLICA_MEDIATION=true` |

## Transport

Everything hangs off the service endpoint URI, which is all a standard client
knows:

- `POST /` — a DIDComm envelope in, the reply (if the exchange has one) in
  the HTTP response body — but only when the message declares
  `return_route: "all"`, as messagepickup 3.0 requires of clients. Without
  it the request still runs and the response is an empty 202. Over a
  WebSocket the header is set once and marks the socket as the return route
  for its lifetime.
- `GET /` + WebSocket upgrade — same dispatch over a socket; enabling
  live delivery (`live-delivery-change`) turns the socket into a push channel
  for incoming forwards.
- `GET /` (plain) — the mediator's DID, its out-of-band invitation URL, and
  the protocol list as JSON; a browser (`Accept: text/html`) gets a
  human-readable page instead.
- `GET /invitation` — the out-of-band 2.0 invitation as a plaintext JWM. The
  same invitation, base64url-encoded, rides the `?_oob=` parameter of the
  invitation URL — the string to put in a QR code for any standard wallet.
- `GET /health`.

Anonymous (anoncrypt) envelopes may only carry `forward` — the outer envelope
of a forward is anonymous by design. Everything that grants or writes state
requires an authcrypt envelope, and the proven sender DID *is* the account.

A did:peer larger than 8192 UTF-8 bytes is not resolved, in either method and
for every protocol, whatever registration allows: decoding one costs time that
grows faster than its length, and it would be paid before the sender is known.
The size is judged before anything is decoded, and equally for a long form the
mediator kept and reads back for a short one. An envelope that needs such a
DID to be opened fails like any other that cannot be unpacked: a **400** over
HTTP, dropped on a socket.

### What a forward must be

A forward is queued whole or not at all, and the HTTP status of the call says
which — a 2xx always means queued mail:

- It arrives encrypted to the mediator, names its recipient in `body.next`,
  and carries exactly one attachment holding one DIDComm encrypted message,
  as `data.json` or as `data.base64` (never both, never `links`). A
  `media_type` left out or null says nothing and changes nothing of what
  follows; one that is given is `application/didcomm-encrypted+json`.
  Anything else is a **400**.
- The envelope is looked at, never opened. It is the General JWE JSON
  Serialization: `protected`, `iv`, `ciphertext`, `tag` and every
  recipient's `encrypted_key` are unpadded base64url, and each recipient
  names its key in `header.kid`. For every recipient the protected, shared
  and per-recipient headers share no name and together give `alg` and `enc`
  as non-empty strings; which algorithms they name is the recipient's
  business. `base64` content is base64url (padded or not) of UTF-8 JSON. No
  object in the forward repeats a member name, whichever way the envelope is
  carried. Members the mediator does not know are kept. All of these are a
  **400** too.
- What is queued, and what pickup later hands over, is the envelope's
  [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) form, read from the
  sender's own JSON text: the same JSON spelled another way or carried the
  other way is the same bytes, numbers included. That form is held to
  `MEDIATOR_MAX_MESSAGE_BYTES` as well (a number can grow in it): **413**.
- `(account, body.next, forward id)` names the package. The same forward
  again is accepted and queued once; the same id with another envelope is
  refused and the first stays. An ordinary recipient's name is free again
  once its mail has been picked up and acknowledged, or has expired, and so
  is a replica's own. A shared package's name stays taken until the package
  expires, even after every target replica has acknowledged it.
- A recipient nobody here holds, a full queue and a reused id are one answer,
  **422**, which does not tell the three apart. A 202 does tell the sender
  that this recipient takes mail here right now; it says nothing of the
  recipient having received it.

Over a WebSocket there is no status: a refused forward is dropped.

## Replica mediation

`https://estoc.dev/replica-mediation/1.0` is for an owner who reads the same
mail on several devices. What follows is the whole contract; the body of
every message is a type in `src/protocols/replica-mediation.ts`, the two
signed objects are in `replica-grant.ts` and `recipient-proof.ts`, and
`test/replica-mediation.test.ts` reads as the list of what is accepted and
refused.

Three kinds of DID take part, all did:peer:4, and none of them can also be
an ordinary (coordinate-mediation) account or recipient here:

- The **account** DID manages the arrangement: it sends the controls below
  and never picks up mail.
- A **replica** DID is one device. It picks up, acknowledges and is pushed
  mail under its own key, and can be forwarded to directly.
- A **recipient** DID is an address the owner gave out. Mail forwarded to it
  waits once for every replica the account holds at that moment.

A did:peer:4 is the same DID in its long and short form. The mediator keeps
the long form the first time it sees one, so first contact uses the long
form and anything later may use the short one.

### Controls

A control is authcrypted by the account DID to exactly one mediator DID and
carries exactly the body members listed. The answer is sealed to the
account with the request's `id` as `thid`: the reply named here, or a
problem-report whose code is `e.estoc.replica-mediation.` plus one of
`invalid-message`, `invalid-grant`, `invalid-recipient`, `account-refused`,
`unknown-account`, `identity-conflict`, `quota`.

| Request | Body | Reply | Body |
| --- | --- | --- | --- |
| `register` | `grant` | `registered` | `account`, `mediation_id`, `routing_did`, `replica_id`, `replica_did`, `state`, `registered_time`, `limits` |
| `list` | `cursor`, `limit` | `replicas` | `entries` (`grant`, `state`, `registered_time`), `next_cursor` |
| `recipient-add` | `recipient_did`, `resolution_material`, `proof` | `recipient-added` | `recipient_did`, `status` |

**`register`** enrolls one replica, and the first one creates the account
with it, both or neither. No mediate-request comes before it. `grant` is a
compact JWS signed by one of the account's authentication keys (header
exactly `alg: EdDSA`, `typ: estoc/replica-grant+jws`, `kid`) over the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) text of exactly
`account`, `mediation_id`, `mediator`, `replica_id`, `replica_did` and
`replica_long_form`. The two ids are UUIDv7. The replica's document must
name the granted mediator as its service and hold Ed25519 authentication and
X25519 key-agreement keys. An account is bound for good to the mediation id
and the mediator DID of its first grant; another name of the same deployment
is another mediator. An exact repeat answers as the first time did. A replica
enrolled later receives nothing forwarded before it.

**`list`** pages the account's grants in enrollment order. `cursor` is null
to begin and then the previous `next_cursor`; `limit` is at most
`max_membership_page`. One listing is the replicas enrolled when it began,
and its cursors never expire.

**`recipient-add`** routes one recipient DID to the account. `proof` is a
compact JWS signed by the *recipient's* authentication key
(`typ: estoc/recipient-add+jws`) over exactly `account`, `aud` (the mediator)
and `recipient`; it is checked on every request and names no time, so the
same proof serves every retry. `resolution_material` is the recipient's long
form, or null once the mediator keeps it. `status` is `added`, or
`no_change` when the account already held it.

Nothing here is undone: there is no control that removes a replica or a
recipient, and none that lists recipients.

### Mail

A forward whose `next` is a recipient or a replica follows
[the same rules](#what-a-forward-must-be) as any other, with the same
statuses. It is kept once and counted once against its account
(`max_retained_messages`, `max_retained_bytes`), and waits until
`message_retention_seconds` have passed or, if sooner, until the forward's
own `expires_time`; one already past is refused. A forward to the account
DID itself is refused like one to a stranger.

A replica uses messagepickup/3.0 unchanged, authcrypted under its own DID.
Each replica sees a shared envelope under an attachment id of its own, and
its `messages-received` ends its own copy only. `recipient_did` narrows
`status-request` and `delivery-request` to mail forwarded to that DID. A
request the replica only signed is not answered. The account DID asking for
pickup is told `e.estoc.replica-mediation.replica-required`.

Turning the protocol off stops controls and new mail; replicas already
enrolled can still pick up what waits.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEDIATOR_PUBLIC_URL` | — (required; Node only) | Public URL the DIDs derive from — Workers use each request's own origin instead |
| `MEDIATOR_DID_METHODS` | `web` | Ordered list of active methods (`peer2,peer4,web`); first = primary. Set `peer2` for a non-loopback http URL |
| `MEDIATOR_PORT` / `MEDIATOR_HOST` | `8080` / `0.0.0.0` | Listen address |
| `MEDIATOR_DATA_DIR` | `/data` in Docker, `./data` otherwise | Identity + SQLite |
| `MEDIATOR_OPEN_REGISTRATION` | `true` | Grant mediation to any DID that asks |
| `MEDIATOR_CORS_ORIGIN` | `*` | CORS for browser agents |
| `MEDIATOR_MESSAGE_TTL_SECONDS` | 7 days | Unclaimed messages expire |
| `MEDIATOR_MAX_MESSAGES_PER_ACCOUNT` | `1000` | Inbox quota. Advertised as `maxMessagesPerAccount` in `GET /` |
| `MEDIATOR_MAX_MESSAGE_BYTES` | `1048576` (1 MiB) | Largest envelope accepted on the wire; larger gets HTTP 413 (dropped on a socket). Advertised as `maxMessageBytes` in `GET /` |
| `MEDIATOR_REPLICA_MEDIATION` | `false` | `true` turns on replica-mediation/1.0 (accounts, replica enrollment, shared recipients, and mail queued per replica that each replica picks up, acknowledges and is pushed under its own DID). Off, a forward to one of its recipients or replicas is refused; a replica enrolled earlier can still pick up what was queued |
| `MEDIATOR_MAX_ACTIVE_REPLICAS` | `16` | Replicas one replica-mediation account may enroll; enrollment is never undone. This and the three limits below must be positive integers, or the mediator refuses to start |
| `MEDIATOR_MAX_MEMBERSHIP_PAGE` | `16` | Largest page of a replica listing |
| `MEDIATOR_MAX_SHARED_RECIPIENTS` | `10000` | Communication DIDs one replica-mediation account may add; an addition is never undone |
| `MEDIATOR_MAX_RETAINED_BYTES` | `67108864` (64 MiB) | Envelope bytes one replica-mediation account may have waiting, across shared and private mail; a shared envelope counts once however many replicas it waits for. `MEDIATOR_MAX_MESSAGES_PER_ACCOUNT` bounds the count the same way |
| `MEDIATOR_ABUSE_EMAIL` | unset | Abuse contact shown in the invitation page's footer |
| `MEDIATOR_BLOB_DIR` | `<data dir>/blobs` (Node only) | Where blob-store/1.0 keeps blob bytes; `off` disables blobs. On Workers, blobs are on iff an R2 bucket is bound as `BLOBS` |
| `MEDIATOR_BLOB_RETAIN_SECONDS` | 30 days | How long one `put` keeps a blob; a repeat `put` by the same mediation renews |
| `MEDIATOR_BLOB_MAX_BYTES` | `104857600` (100 MiB) | Largest blob accepted (the upload is one PUT through the mediator) |
| `MEDIATOR_BLOB_QUOTA_BYTES` | `1073741824` (1 GiB) | Bytes one mediation may hold at once (its own blobs; nothing is shared between mediations) |

## Development

```sh
pnpm install                             # at the workspace root
pnpm --filter @estoc/did-peer run build  # the one workspace library it imports
cd mediator
MEDIATOR_PUBLIC_URL=http://localhost:8080 pnpm run dev:node
pnpm test
pnpm run typecheck
```

## Design notes

- **One inbox per account.** Every recipient DID an account binds routes to
  the same queue; pickup always reads the authenticated sender's own inbox.
  A replica of a replica-mediation account reads the deliveries queued for
  it alone, and there `recipient_did` narrows a request to one recipient; it
  must authcrypt the request, a signature alone opens no replica's queue.
- **A WebSocket belongs to the first DID proven on it.** Its live mode is
  that DID's and its mail is what gets pushed; pickup from any other DID on
  the same socket is refused with `e.p.msg.connection-bound`.
- **Bindings are exclusive and squat-resistant.** A recipient DID binds to one
  account, first-come; binding the mediator's DID, a non-DID, or a DID that
  holds its own account here is refused — and on the forward path a local
  account always outranks a binding, so registering a DID reclaims it from any
  squatter.
- **Sender identity is what the envelope proves**, never what the plaintext
  claims: grants and reads key off the authcrypt key's DID.
- **Live delivery pushes but never hands off.** A pushed message stays queued
  until `messages-received`; a dropped socket loses nothing.
- **The runtimes differ only where they must.** The wire surface is one Hono
  app (`src/app.ts`) and the protocol layer is runtime-free; Node keeps live
  sockets in process memory, Workers keep them in a Durable Object, and the
  didcomm WASM is the same Rust either way.

The DIDComm layer (pack/unpack via
[@estoc/didcomm-node](https://github.com/estoc-net/didcomm-rust), did:peer:2/4 and did:web
resolution) is shared lineage with
[didcomm-http](https://github.com/estoc-net/didcomm-http).

## Status

Experimental. This mediator and the didcomm libraries under it have not
received an independent security audit, and the protocol surface may still
change. Run your own instance freely; don't yet rely on one to carry anything
you can't afford to lose.

## License

Apache-2.0
