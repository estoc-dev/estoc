# @estoc/daemon

The Estoc daemon: an agent and its vault behind the API of
[`@estoc/daemon-api`](../daemon-api). `createDaemon(host)` is the daemon
itself, in the domain's terms (`Daemon`, `src/api.ts`); a `DaemonHost`
says where it runs; `methodsOf(daemon, limits)` is the API's method table
answered from it, and `attachTo(daemon.publisher, session)` hands a
session what the daemon has published. A host puts those behind
`serveApi` of `@estoc/daemon-api/wire`, one session per port, and boots
the daemon; a view installs `@estoc/daemon-api` alone and reaches
nothing here. Everything that crosses is a plain record or bytes — no
vault, no key, no agent.

Two hosts ship:

- **A browser worker** (the app's `src/daemon/worker.ts`): the vault is one
  SQLite database in a pool of access handles over OPFS
  (`openSqlitePool` from `@estoc/event-store/browser`), the seed in
  IndexedDB, the DIDComm WASM as Vite loads it. Each message port the page
  hands the worker is one view's session, over structured clone.
- **A Node process** (`@estoc/daemon/node`; the `estoc-daemon` command):
  `nodeHost(root)`, whose vault is `<root>/.estoc/vault.sqlite`
  (`openNodeSqlite` from `@estoc/event-store/node`), the seed in memory
  only (every start is locked until a view types the passphrase),
  `@estoc/didcomm-node`, and one HTTP server that serves the app and takes
  the app's WebSocket on the same origin, each socket a session over text
  frames. The app is `@estoc/app` (the built files), an optional peer:
  `estoc serve` from `@estoc/cli` brings both together; `estoc-daemon`
  alone serves the app if `@estoc/app` is installed beside it (or
  `--app-dir`), else prints a link to app.estoc.dev.

```
cd ~/my-vault && estoc init && estoc serve   # open the link it prints: http://127.0.0.1:37862/?token=…
estoc-daemon . --port 0 --app http://localhost:5173   # also a ?_daemon= link for a dev server
```

The token (kept in `.estoc/daemon.token`) is the one key to the
socket, whoever asks: the page the daemon serves finds the socket at its
own origin (index.html is sent with a `<meta name="estoc-daemon">`) and
takes the token from the `?token=` in the link, remembering it for reloads
and other tabs; any other origin — a dev server, app.estoc.dev — connects
with the `?_daemon=` link, which carries the socket URL with the token,
and remembers it until `?_daemon=off`. Being a page of the daemon's own
buys nothing: a browser on the machine (or on the network, when bound
wider) that has no link has no socket. On top of that `Host` must be a
name of this server's (a loopback name, the bound address, or an address
of this machine when bound to all); anything else, such as an attacker's
name pointed at 127.0.0.1 (DNS rebinding), gets 421 and no socket. A
socket that has said hello and not yet attached is one of at most
sixteen; the token is minted once, whole, however many daemons start on a
fresh folder at once, and a token file that holds no token keeps the
endpoint from opening.

## The folder

`runDaemon`, the command itself, refuses a folder-format `.estoc` before
writing anything, and once the folder is its own it leaves the socket's
URL, token included, in `.estoc/daemon.url` (mode 0600, removed when it
closes) for a process on this machine that finds the folder taken,
which is how `estoc status` and `estoc init` reach it.

A host hands its files to one daemon at a time, from `storage()` to the
storage's `close()`; the Node host keeps an empty `owner.sqlite` open
beside the vault for that, under SQLite's own lock, so a second daemon
on the folder says `elsewhere`, refuses what would make, open or remove
a file, and waits. Within a daemon those calls — `createIdentity`,
`restoreIdentity`, `unlock`, `lock`, `forgetIdentity`, `exportBackup`,
`mergeBackup`, and the export of `publishSnapshotLink` and the restore
of `restoreFromLink` — run one at a time in the order asked, and
`close()` ends a wait for files held elsewhere. The vault file has a name for
as long as it stands, the `hold` every published state carries;
`forgetIdentity(hold)` removes the vault so named and refuses once
another stands there, so a confirmation one view left open while a
second view removed and remade the vault removes nothing.

## What a view is shown

`DaemonCore.publisher` holds what every view is shown: the state as one
value under an epoch and a revision — the phase the vault dictates, its
hold, and for an open vault the snapshot — the runtime lines under a
revision of the same epoch, and log lines. A fresh epoch comes with every
runtime opened and every other change of phase or hold. The open state is
the API's `Snapshot`, normalized: every message, observation, channel and
contact once, in a table of its own, the rest referring to them by ID; a
channel named everywhere by its `ChannelId`, the canonical text of its
pair; `conversations` one per contact and one per nameless group of
channels under a head; a `summary` on each message the daemon has a line
for. It is read in one cut under the vault's writer lock after every
commit, whoever made it — a call of a view's, a delivery, a retry the
dispatcher made on its own — once per burst of commits, from the event
store's `changed` callback, and shared by every view. A view that attaches
is handed the state published, not a read of its own; `refresh()` answers
where a state covering every commit so far stands, and reads nothing when
none is unpublished. A read that fails leaves the state standing, stale:
every attached session ends with `StateUnavailable`, one joining
meanwhile is refused, and the next commit or `refresh()` reads again.
Damage the history is found to have stops the vault, said as the
`damaged` phase. The lines come from the agent as they change, with no
read of the vault.

Nothing is sent on open: what an earlier run left unfinished is in
`snapshot.pending`, each entry naming the call that takes it up. A vault
restored from a snapshot opens with `restoreUnexplained`: it receives,
holds its addresses and answers from the first moment, and refuses the user's
sends and every manual dispatch until the view has shown what a restore
cannot bring back — local DIDs made after the snapshot, peers known only
by a short form, continuity the snapshot predates, forks a competing
rotation leaves — and called `explainedRestore()`.

## Refusals

A refusal has a code, which the API carries: `WrongPhase` (no open
vault, nothing to unlock, a vault standing already, the files another
daemon's), `StaleHold`, `RestoreUnexplained`, `InvalidArgument`, each
with no effect; a condition found unmet before anything changed — a
wrong passphrase, no mediator set, no such contact — is
`OperationFailed` with no effect (`Unmet`). A send the domain finds no
target for is `NoTarget`, one to a channel that takes none is
`SendClosed`. Whatever else the domain throws is `OperationFailed` with
a possible effect, its text kept for the host's log (`failed`); so is a
call of an intent that threw after the intent was committed. An export
over `maxBackupBytes` (512 MiB unless the host sets it, from which the
other bounds a view is told follow) is refused whole before the file is
built, or before one built within it is read.

## Snapshot links

A new device can take the vault from a link instead of a file.
`publishSnapshotLink()` exports the vault as a backup is exported,
seals it under an AES-256-GCM key of its own and puts it at the selected
mediator as this runtime's replica's blob: it counts against that
replica's quota and goes when the replica is removed. A snapshot over
what a blob there holds once sealed is refused whole as `ResourceLimit`;
the backup file is the way to carry that one. The link is the blob's
URL, the name of the sealed bytes and the key, and not the passphrase:
whoever holds it reads the vault's events and objects in the clear
until the mediator lets the blob go, and signs nothing.
`@estoc/daemon-api/views` writes a link into a URL's fragment and reads
it back.

What is put is kept in the runtime's local state, the key among it, and
not in the vault: pending before the put, with where it goes and
until when once the mediator answers, published once the bytes are
uploaded. `snapshotLinks()` lists what the mediator keeps or may keep,
pending ones included, so that a link is shown again after a restart
and a snapshot whose upload failed can still be revoked;
`revokeSnapshotLink(hash)` deletes the blob and forgets the record. A
put the mediator refuses leaves nothing kept. Removing the vault removes
these records and not the blobs: a link not revoked before then reads
until the mediator lets its blob go.

`restoreFromLink(link, passphrase, maxBytes)`, on a daemon with no
vault, reads the blob, at most `maxBytes` and the sealing beside it,
within ten minutes and with no redirect followed, checks the bytes
against the name, opens them and restores what they hold as
`restoreIdentity` does. A link that reads nothing, bytes over the
bound, bytes that are not the ones named, a key that does not open
them and a wrong passphrase each refuse it with nothing written.

## The trace

The agent keeps what it observes on the way in and out — frames,
envelopes, the rituals with mediators — in the runtime's local state,
which no snapshot carries. How much is kept is a preference of this
runtime, `off` / `normal` / `verbose`: `traceLevel()` and
`setTraceLevel(level)`.

## Fetching what others name

A browser tab cannot reach a private network; a process can. Every
address the agent is given — a mediator's, a peer's endpoint, a
`did:web` document's — is somebody else's word, so the Node host's
default `fetch` (`src/node/guarded-fetch.ts`) resolves the name, checks
every address it has — and the literal in the URL — against `ipaddr.js`
ranges, and connects only to public unicast. Redirects are not
followed. A mediator on this machine needs `nodeHost(root, { fetch })`
with a fetch that reaches it.
