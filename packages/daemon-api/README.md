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
| `@estoc/daemon-api/views` | What a view computes with no daemon in reach: the snapshot read by ID with each conversation's records assembled, a conversation followed across snapshots, invitations as links and back, the message contents a view composes, a mediator named by a person read as far as text goes |

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

`indexSnapshot(snapshot)` reads the snapshot's tables by ID and assembles
every conversation with the channels, messages and observations its
record names, in the record's order, throwing on a reference the
snapshot does not hold; `successorOf(before, after, id)` follows a
conversation whose ID moved, to the one conversation now showing a
channel it showed, and to nothing when several do or the snapshots are
of different vaults. `parseInvitation` reads an out-of-band invitation
from a link, its `_oob` parameter or its plaintext, `invitationUrl` and
`invitationOf` write one; `basicMessage` and `profileMessage` are the
contents a view sends, `announcedName` the name an introduction claims;
`mediatorInputOf` reads a mediator's DID off what a person pasted, or
gives the URL to ask at, and `mediatorHost` the host a mediator's DID
names. None of these rescans events, decides continuity or grants a send.

`pnpm consumer-check` packs the package, installs it into an empty
project outside the workspace, compiles and runs a small view against
it with no Node or DOM types, a client stopping at an incompatible daemon
included, and fails when any package of the daemon side came along.
