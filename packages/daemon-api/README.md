# @estoc/daemon-api

The public contract between an Estoc daemon and its views: the web app,
a terminal, a bot. A view installs this package and nothing of the
daemon side; the daemon adapts its domain results into the shapes
declared here. Records decide nothing: the daemon rechecks every
operation when it executes.

| Entry point | What it owns |
| --- | --- |
| `@estoc/daemon-api/contract` | Identifiers, the published state, the snapshot's records, runtime lines, the method table, error codes, the bootstrap exchange, the application frames, protocol constants, and a schema for each |
| `@estoc/daemon-api/wire` | What the client and the daemon share below the API: reading a value as wire data with its size and depth budget, bytes on a text port, frame reading and writing, port adapters, and the daemon's side of a session |

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

`pnpm consumer-check` packs the package, installs it into an empty
project outside the workspace, compiles and runs a small view against
it with no Node or DOM types, and fails when any package of the daemon
side came along.
