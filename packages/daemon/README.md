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
  hands the worker is one view's session, its frames CBOR.
- **A Node process** (`@estoc/daemon/node`; the `estoc-daemon` command):
  `nodeHost(root)`, whose vault is `<root>/.estoc/vault.sqlite`
  (`openNodeSqlite` from `@estoc/event-store/node`), the seed in memory
  only (every start is locked until a view types the passphrase),
  `@estoc/didcomm-node`, and one HTTP server that serves the app and takes
  the app's WebSocket on the same origin, each socket a session over binary
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
`mergeBackup`, the export of `publishSnapshotLink`, the restore of
`restoreFromLink` and the merge of `importFromLink` — run one at a time
in the order asked, and `close()` ends a wait for files held elsewhere.
The vault file has a name for
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
other bounds a view is told follow) is refused whole, as
`ResourceLimit`, before an object is read.

## Backups

A backup is a snapshot of `@estoc/event-store`: one CAR file with the
vault's seed part and its content part, which `exportBackup()` hands
back as bytes named `<label>-<date>.estoc.car`, and writes nowhere.
`restoreIdentity` restores a vault from the seed part and refuses a
snapshot without one; `mergeBackup` imports the content part into the
open vault and refuses a snapshot without it. Either reads the bytes
once, and they are the daemon's from then on. What is no snapshot this
version reads, a backup of the earlier SQLite format among it, is
refused with nothing written.

## Snapshot links

A new device can take the vault from a link instead of a file, and a
vault open elsewhere can import one. `publishSnapshotLink(part)`
exports a snapshot of one part, seals it under an AES-256-GCM key of
its own and puts it at the selected mediator as this runtime's
replica's blob: it counts against that replica's quota and goes when
the replica is removed. The link is the blob's URL, the name of the
sealed bytes and the key, and not the passphrase: whoever holds it
reads the snapshot's events and objects in the clear until the mediator
lets the blob go, and signs nothing. `@estoc/daemon-api/views` writes a
link into a URL's fragment and reads it back.

The part is what the snapshot carries. `seed` is what a new device
restores from: the seed, sealed under the passphrase, and the events a
new replica enrolls from (`ENROLLMENT_EVENT_TYPES` of `@estoc/vault`):
the vault's name, its arrangements and its replicas, which name no
object when well formed; one malformed keeps its roots, as it would in
any snapshot. It is held to `maxSeedBytes`, an option of `createDaemon`
(1 MiB unless set), and to what a blob at the mediator holds once
sealed, whichever is less; one over `maxSeedBytes` is refused with
nothing put, saying to carry that vault by backup file. A device
restored from it is an ordinary replica: it registers at the preferred
arrangement, picks up and stays live. Mail it receives before it holds
the vault's DIDs is discarded there, and recorded by the replicas that
received it too; the history, that mail among it, comes by importing a
`content` snapshot, which another replica sends it (see below).
`content` is the vault's history with no seed: a device of the vault
imports it, and no vault is restored from it. One over what a blob
holds once sealed is refused whole as `ResourceLimit`; the backup file
is the way to carry that one.

What is put is kept in the runtime's local state, the key among it, and
not in the vault: pending before the put, with where it goes and
until when once the mediator answers, published once the bytes are
uploaded. `snapshotLinks()` lists what the mediator keeps or may keep,
pending ones included, so that a link is shown again after a restart
and a snapshot whose upload failed can still be revoked;
`revokeSnapshotLink(hash)` deletes the blob and forgets the record,
after a publish still under way has settled: once it answers, the link
reads nothing, however far the upload had got. A put the mediator
refuses leaves nothing kept. Removing the vault removes these records
and not the blobs: a link not revoked before then reads until the
mediator lets its blob go.

Only the replica that put a blob may delete it, so each record keeps
the replica ID and the arrangement it was put under. A runtime that
takes a fresh replica ID, as a merge has it do when a copy of it wrote
under the same one, cannot revoke what it published before: those
links stay listed as not `revocable`, revoking one is refused, and they
read until the mediator lets their blobs go. What it had not finished
putting is dropped, its key having gone to no one.

`restoreFromLink(link, passphrase)`, on a daemon with no vault, reads
the blob, at most `maxSeedBytes` and the sealing beside it, within ten
minutes and with no redirect followed, checks the bytes against the
name, opens them and restores what they hold as `restoreIdentity` does.
A link that reads nothing, bytes over the bound, bytes that are not the
ones named, a key that does not open them, a snapshot with no seed and
a wrong passphrase each refuse it with nothing written.

`importFromLink(link, maxBytes)`, on a daemon with a vault open, reads
the blob the same way, at most `maxBytes`, and merges what it holds as
`mergeBackup` does: the result counts what it brought, and an import of
the same snapshot again brings nothing. A failed read, a snapshot with
no content and another vault's snapshot each leave the vault as it
was, and so does a vault let go of while the blob is read: the merge
goes into the vault open when it was asked, or none, though the same
vault, or one restored from the same backup, is open again by then. Past those checks a merge fails as `mergeBackup`
does, with what it may have done said as its effect. Each record a
daemon keeps says what its snapshot carries, so the list can show it;
a record kept without it is none this daemon wrote, and is forgotten.

## Replicas and the history between them

Which replicas the vault has is the mediator's word: the daemon asks it
(`replica-list`, each grant checked under the seed) once the preferred
arrangement is connected or set, on `reconnect()`, before it sends
history, and on `refreshReplicas()`. The last answer is kept in the
runtime's local state and shown on the arrangement's record, `self` on
the runtime's own and `removed` on one the mediator holds no more, so
that it is shown while the mediator is out of reach; the vault never
holds it. A time the mediator gives whose year runs past four digits,
as no view spells one, is shown as none.

`sync(replicaId?)` publishes a `content` snapshot as
`publishSnapshotLink` does and mails its link through the mediator to
`replicaId`, or to every other replica the mediator holds when it is
left out (`replica-channel`, sealed between the two replica DIDs). It is
refused before anything is put when the mediator holds no such replica.
It answers the replicas the mediator took the mail for, and keeps what
came of each, sent or why not, for the records; nothing is sent again
on its own, and the link stays listed and revocable as any other.

A runtime takes such a link only from another replica of the seed at
the same arrangement, and only at an https URL that mediator serves,
and imports it as the link arrives, asking nobody: the sender holds the
seed, and a snapshot of another vault is refused as a pasted one is.
The import runs in the background, so the delivery that brought the
link waits for none of it: the read takes no turn of the files, at most
what a blob at the mediator holds, and the merge, as `importFromLink`
does it, waits for the work under way over the agent it replaces. A
second one of the same history brings nothing. How the last one
received went, importing, what it brought or why it failed, is kept in
the local state with the replica it came from and shown as
`historyReceived`. One received earlier that ends later still merges
what it brings, and is logged rather than shown over it. An import the
vault was locked under is shown as failed once it is unlocked, and one
a daemon stopped in the middle of as failed when the vault next opens.
A link lost on the way, or one whose import fails, is sent again by
hand.

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
default `fetch` (`guardedFetch` from `@estoc/did-web/node`) resolves
the name, checks every address it has — and the literal in the URL —
against `ipaddr.js` ranges, and connects only to public unicast.
Redirects are not followed. A mediator on this machine needs
`nodeHost(root, { fetch })` with a fetch that reaches it.
