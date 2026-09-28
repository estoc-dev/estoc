# @estoc/daemon-api

The public contract between an Estoc daemon and its views: the web app,
a terminal, a bot. A view installs this package and nothing of the
daemon side; the daemon adapts its domain results into the shapes
declared here. Records decide nothing: the daemon rechecks every
operation when it executes.

| Entry point | What it owns |
| --- | --- |
| `@estoc/daemon-api/contract` | Identifiers, the published state, the snapshot's records, runtime lines, the method table, error codes, the bootstrap exchange, the application frames, protocol constants, and a schema for each |
| `@estoc/daemon-api/client` | The view's side of a session: negotiation and attachment on a port, the daemon's methods typed from the method table, the refresh barrier, local connection state, a `CallError` for every failure with `isCallError` to narrow it, and a client that reconnects |
| `@estoc/daemon-api/wire` | What the client and the daemon share below the API: reading a value as wire data with its size and depth budget, bytes on a text port, frame reading and writing, port adapters, and the daemon's side of a session |
| `@estoc/daemon-api/views` | Pure snapshot lookups, conversation record joins, navigation successors, invitation parsing and links, message-content builders and protocol constants |

The types and JSDoc of the entry point define the API. The `schemas`
namespace holds a zod schema per declared type; each is annotated with
the type it produces, so the declarations and the runtime checks cannot
drift apart. Unknown members of a record are ignored, message bodies
pass through with every key kept, and an error code the schema does not
know still reads as a failure with the effect it states.

The wire reads every value the same way on both transports: a plain,
finite, acyclic tree, negative zero as zero, an undefined member left
out, bytes only where a method's schema places them and copied to the
view selected. A request is charged as it is read and refused at the
advertised bound before the rest is read, the whole frame counted,
the attachment request like any other. `serveApi` answers calls from
the method table alone, puts the attachment baseline ahead of every
later publication, and replaces, drops or ends what a slow port cannot
take: a newer state or lines of the same epoch takes the place of an
unsent one, logs go first, and a port that can no longer take what it
is owed is closed. A baseline or a state that cannot be written ends
the session with a `StateUnavailable` fault. The WebSocket adapter
waits for the socket to drain below a bound before it takes the next
frame, since a socket's `send` only queues; the message port adapter
closes with the port's other end.

`connect(port)` gives a client that says hello, attaches after the
welcome and is `connected` once the attachment's baseline is in; before
that, and after the connection ends, a call is refused as `NotConnected`.
`client.daemon` holds one method per entry of the method table, each
checked against the advertised bounds before the port takes it, and
`client.refresh()` resolves once a state covering every change committed
before the request is consumed, or rejects with `StateChanged` when the
epoch moves first. Every failure is a `CallError`: the daemon's own
under `origin: "daemon"`, the SDK's under `origin: "client"`, with the
effect the operation may have had; a reply lost with the connection is
`TransportDisconnected` with a possible effect, none for a refresh. The
last state stays in place through a disconnection, stale, until a new
baseline replaces it. A daemon that stops speaking the contract ends the
session as a `ProtocolError`. `reconnecting(openPort)` opens another
port after a delay whenever a connection ends, negotiates and attaches
afresh, and never resends a call the old connection lost.

`indexSnapshot(snapshot)` indexes each published table by its primary
ID. `conversationOf(index, id)` joins a conversation to its contact,
channels, messages, unadmitted observations and send choices, retaining
the original records and published order. An absent conversation gives
null; a broken relationship throws. Treat records as read-only and
create a new index for every snapshot. The helpers derive no names,
summaries, admission decisions or send eligibility.

For navigation within the same vault anchor, keep the selected ID when
it still exists. Otherwise `successorOf(before, after, id)` returns the
sole new conversation sharing any of the old one's shown channels,
including derived history. It returns null across anchors, for an absent
old conversation, or for zero or several matches. Drafts remain the
view's responsibility.

`parseInvitation(text)` accepts plaintext JSON, base64url or a URL with
`_oob`, validates the API invitation shape and throws on malformed input.
Omitted `typ` and `body` take plaintext defaults; malformed present fields
are refused. `invitationUrl(base, invitation)` encodes a link, and
`invitationOf(from, id, goal?)` formats an already disclosed DID and ID.
Neither resolves a DID or creates a disclosure. `basicMessage(text)` and
`profileMessage(displayName)` build `MessageContent` for a command with
the text kept exactly. Protocol constants are also exported from `/views`;
received messages already carry the daemon's `summary` and name claims.

`pnpm consumer-check` packs the package, installs it into an empty
project outside the workspace, compiles and runs a small view against
all four entry points with no Node or DOM types, including record joins,
navigation, invitations and a client stopping at an incompatible daemon,
and fails when any package of the daemon side came along. A separate
`/views` consumer also checks its full declaration graph with
`skipLibCheck: false` under the same ES2022-only libraries.
