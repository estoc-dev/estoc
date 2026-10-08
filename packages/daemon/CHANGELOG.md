# Changelog

## Unreleased

- Completing an operation the input owes nothing, such as the reply to
  a Ping that asked for none, answers `none` and names the operation's
  skip code. A user's message now always goes out with `created_time`;
  the test corpus is regenerated.

- `@estoc/didcomm-node` moves to `^0.4.1-estoc.4`, the build that hands
  back the plaintext text `@estoc/agent-core` now reads messages from.

- **Successors are derived**: `rotate` and `rotateChannel` make the
  successor the vault's recipe names, on the predecessor's own route, and
  refuse a rotation this runtime cannot commit, one away from an address
  routed through an arrangement it is not a replica of. The pending work of
  a state lists `rotationCandidates`, the private addresses a peer's first
  messages call for and no decision records yet. Every `did.created` carries
  its `generation`; the test corpus is regenerated, and a vault written by an
  earlier daemon is read anew.
- **Arrangement IDs are derived**: `setMediator` names the arrangement by
  the ID the mediator's DID derives, so a reopened or restored runtime
  finds the arrangement that stands by its ID, and a mediator other than
  the one this runtime is a replica of is refused before anything is
  written. The test corpus is regenerated with derived arrangement IDs; a
  vault written by an earlier daemon is read anew.
- **No route entity**: new DIDs are minted through the selected
  arrangement itself, and `setMediator` records no route. The test
  corpus is regenerated without `route.configured` events; a vault
  written by an earlier daemon is read anew.
- **Every arrangement is a replica-mediation account**:
  `setMediator(mediatorDid)` makes the one arrangement with that
  mediator when none stands, enrolls this runtime in it as a replica
  and selects it; the arrangement that already stands with the mediator
  is the one selected again. A mediator that does not offer
  replica-mediation refuses the enrollment and the call fails. A
  backup restored into a fresh runtime enrolls that runtime as a replica
  of its own at its first connection, and each replica picks up its own
  copy of the account's mail. A runtime's files moved or copied as they
  are keep its replica: the copy is the same replica until an identity
  reset gives it another. Every runtime that receives a message answers
  it on its own, so two runtimes of one vault live on such an
  arrangement can each replace a private address and leave the peer no
  channel to write to: until one runtime alone is made to answer, the
  profile is for one live runtime at a time. Once its replica intent is
  recorded, a runtime enrolls only in that arrangement: asked for another
  mediator, `setMediator` refuses before writing anything. Two calls at
  once for one mediator make one arrangement.
- What the mediator confirmed is kept in the runtime's local options, so
  a reopened vault asks for none of it again. Nothing is taken off a
  mediator any more: a vault restored from before an address was made
  leaves that address held by the account, its mail discarded on
  arrival, and a daemon closing waits only for the requests its agent
  has out.
- A `MediationRecord` carries no `profile`; a `ConnectionRecord` carries
  `recipients`, what the connection had the account hold, in place of
  `reconciled` and `unknownRegistrations`. The test corpus is
  regenerated: its arrangement is enrolled in, with a `replica.created`
  of the recording runtime.

## 0.4.0 — 2026-09-29

The daemon behind the API of `@estoc/daemon-api`, in place of the RPC of
its own.

- **The RPC of `rpc.ts` and its codec are gone**, with the `phase`,
  `opened`, `changed`, `lines` and `log` events, the records they
  carried (`Snapshot`, `Lines`, `ContactSummary`, `MediationSummary`,
  `LocalDidSummary`), `DaemonEvents`, the `unreachable` phase, and
  `replayTo`: what a view is shown is the publisher's, as the API
  spells it, and a view attaches over `serveApi`. `createDaemon(host)`
  takes no `emit`, and `boot()` is the host's, once — a later call
  does nothing. A daemon of this version and a view of an earlier one
  do not speak: the first frame the daemon reads is no hello, and it
  closes the port; the SDK, at a daemon of an earlier version, reports
  `Incompatible`. `@estoc/daemon` exports the host's contract
  (`createDaemon`, `DaemonHost`, `DaemonStorage`, `VAULT_FILE`,
  `methodsOf`, `attachTo`, `limitsOf`, the publisher and the refusals)
  and the domain's `Daemon` interface, nothing a view would import.
- **An invitation is a reusable address** (behaviour change):
  `createInvitation(goal?)` takes no use limit, and the snapshot's
  invitations carry `state` `available` or `unavailable` and no
  consumer: whoever holds a link writes under it, each in a
  conversation of their own, and the link stays open for the next.
- **The Node endpoint serves the API** (`@estoc/daemon-api`): every
  socket is a port of `serveApi`, from the bootstrap on — hello, welcome
  with the daemon's bounds, `attach` handed the state and lines
  published, then the method table. `methodsOf(core, limits)` is that
  table: each method's named input read into the domain's terms, a
  channel ID taken apart into its pair, and the answer spelled as the
  API does; `attachTo(publisher, session)` subscribes a session and
  hands it its baseline. The bounds follow from `maxBackupBytes`
  (`limitsOf`; 512 MiB unless the host sets it), an export over it is
  refused whole (`ResourceLimit`) before the file is built, or before
  one built within it is read whole, and leaves no file, and a socket
  that has not attached is one of at most sixteen. A frame a socket
  will not take — over the frame bound, text that is not UTF-8 —
  closes that socket and nothing else. The host boots the
  daemon: there is no `boot()` over the socket, and `boot` and `close`
  are no methods of the API.
- **A refusal has a code.** The daemon refuses with `WrongPhase`
  (no open vault, nothing to unlock, a vault standing already, the
  files another daemon's, no files), `StaleHold`, `RestoreUnexplained`
  and `InvalidArgument` (a DID that is none or the vault's own, a
  channel ID that is no pair's canonical text, a contact with no
  channel), each with `effect: "none"`; a condition found unmet before
  anything changed — a wrong passphrase, no mediator set, no such
  contact — is `OperationFailed` with `effect: "none"` (`Unmet`). A
  send the domain finds no target for is `NoTarget`, one to a channel
  that takes none is `SendClosed`; on `send` they have no effect, on
  `acceptInvitation` and `addContactByDid` a possible one, the contact
  being recorded first. Whatever else the domain throws is
  `OperationFailed` with a possible effect, its text kept for the
  host's log; so is a call of an intent that threw, which the
  procedure once answered as the `threw` outcome. An error of `send`,
  `retry`, `cancel` or a completion names its message when the state
  published shows it recorded.
- **`rotateChannel(channel)`**: the user's rotation away from a pair,
  the one DID of the vault at its local end resolved there; refused
  when none or more than one is. It answers the successor pair, which
  the API's `rotate` names by its channel ID.
- **A read that fails ends every attached session** with a
  `StateUnavailable` fault, and one that joins meanwhile the same way,
  after asking for the read that would make the state fit to attach
  to again. Damage to the history is not that: it is said as the
  `damaged` phase that follows, to every session still attached.
- **The token file is published whole**: a fresh token is written to a
  file of its own and linked under `daemon.token`, so that two daemons
  starting on a fresh folder at once end up with one token, and a
  file that holds no token — empty, or not base64url — keeps the
  endpoint from opening under it, and is left as it is.
- `serveDaemon()` hands back the `DaemonCore`, and takes `maxBackupBytes`
  and a `failed` callback for the host's log.
- **The snapshot is normalized, as the API spells it.** The published
  state is the API's `Snapshot`: every message, observation, channel
  and contact once, in a table of its own, the rest referring to them
  by ID, and a channel named everywhere by its `ChannelId`, the
  canonical text of its pair. The channel table has every pair anything
  names — a contact's membership and send choices, a message's or an
  observation's placement, a head, a pending item, an unplaced output's
  candidates — whether or not the pair has a message. `conversations`
  is the default projection: one per undeleted contact, with the
  channels its view shows and each one's `selected`, and one per
  nameless group of the channels no contact shows, under the head they
  lead to, writing only to that head when it is one of them and takes a
  send. A conversation's `claimedName` is the peer's latest readable
  claim across its channels, by time then message ID; an erased or
  missing claim gives no name. Every table sorts by its ID and every
  reference list by time then ID. A message carries `summary`, one line
  from its content for the types the daemon has a line for, and
  describes its attachments without their payloads. The lines a view is
  shown are the API's `Lines`.
- **One publisher orders the state.** `DaemonCore.publisher` holds the
  state as one value under an epoch and a revision, the runtime lines
  under their own revision of the same epoch, and log lines with their
  epoch; a fresh epoch comes with every runtime opened and every other
  change of phase or hold. The open state is read in one coherent cut
  under the vault's writer lock, once per burst of commits, from the
  event store's `changed` callback: a commit the dispatcher makes on
  its own timer, or a send's intent while the network is still owed an
  answer, is published without a call of the UI's. A read begun for
  one runtime or epoch is not published for another.
- **`refresh()` answers `{ epoch, revision }`**: where a state covering
  every change committed so far stands. With nothing unpublished it
  answers the state published, without another read; a read under way
  answers when its cut began late enough, and one that failed is made
  again. A view that joins is handed the state published, not a read of
  its own; damage the file meets out of band is found by the next read,
  which the next commit makes. A runtime that is locked, removed or
  closed while a `refresh()` waits on a read of it answers
  `StateChanged`, so the call that waits settles and the vault is let go
  of.
- **The lines come from the agent**: `AgentOptions.onLines` tells the
  daemon the connections, waiting deliveries and discards whole whenever
  they change — a socket the mediator drops among them — and the daemon
  publishes them as they come, with no call of the UI's and no read of
  the vault. Lines said while the runtime's first read is under way
  follow that read out, and an agent that takes another's place over
  the runtime, as after a merge, says its own first, empty or not.
- **A read that fails leaves the state stale**, not replaced: every view
  is told, one joining meanwhile is refused, and the next call or
  `refresh()` reads again.
- **`pending()` is gone**: `Snapshot.pending` is the same, as of the
  snapshot.
- **`addContactByDid(did, petname)`**: a contact by a DID handed over on
  its own, reached as an invitee is — a fresh DID of ours toward them, the
  contact selecting the pair, a Ping — the Ping naming no invitation. A DID
  of this vault's is refused, by this call and by `acceptInvitation`.
- **`publicDid()`**: the DID this vault hands out to anyone, in its long
  form: the live one disclosed directly for many uses, minted on the
  selected arrangement's route and disclosed when there is none. Calls
  that overlap share the one minting and get the same DID.
- `Snapshot.dids[]` carries `longFormDid` and `disclosures` (each
  disclosure's `as` and `uses`) in place of `disclosed`.
- **`forgetIdentity(hold)`** names the vault it removes. The `hold` is
  the daemon's name for the vault file, given when the file is found or
  made and kept through every phase until the file is removed; every
  published state carries it, `null` while no vault stands. A removal
  naming a vault since removed
  and remade is refused and leaves the new one as it is, and so is one
  naming none, as an app of an earlier version asks it.
- **Phase `foreign`**, in place of `unreadable` for what the host finds
  standing where the vault would be and is no vault of this version:
  the daemon takes nothing, and the host decides what becomes of it.
  `unreadable` is now only a vault the daemon could not open, such as
  one written under another schema version; `forgetIdentity` removes
  it. The host hook is `foreign()`.
- What the pass the agent runs as it opens admits, consumes or
  acknowledges is published like any other commit: an observation
  whose admission waited for evidence a merged backup brought in is
  shown admitted, with the message it carries and the response it
  earns listed as owed, without a call of the UI's.
- `Snapshot.observations` holds the agent's observation records, every
  observation with its disposition, named by
  `Snapshot.channels[].observationIds` and
  `Snapshot.unplaced.observationIds`; only admitted inputs appear among
  the incoming messages.
- `send` takes no `preRotation`: a channel a replacement of either end
  has moved on from takes no send, whoever asks.
- `Merged` has no `conflicts`: the version-4 vault has no same-ID
  conflicts to count. Records name events by `cid`.

- **Phase `damaged`**: a vault whose history no longer reads whole is
  not run. The daemon says so with the damage as the detail, whether it
  finds it locked, with its seed at hand, or while the vault runs,
  whichever read meets it first — the one a vault opens with, or the
  one after a change (the records short of the damaged event are not
  shown, the agent is stopped and the file let go of). `forgetIdentity` makes room for a
  restore. `DAMAGE_RECOURSE` is the explanation for a host with no
  words of its own.
- `mergeBackup` recovers from a forked author: when the backup and the
  vault both wrote under one replica ID, the vault is reopened under a
  fresh one and the merge made again, with no agent over it until the
  merge is over; `Merged.renewed` says so.
- `Lines.connections[].unknownRegistrations`, from the agent.
- `createContact` refuses an empty channel list: a contact is created
  with at least one channel.
- Node 26 is the oldest that runs it, which is what `@estoc/daemon-api`
  needs.

## 0.3.0 — 2026-09-20

The daemon over the version-3 vault, in place of the version-2 one.

- **Version 3 is the package.** What was `@estoc/daemon/v3` and
  `@estoc/daemon/v3/node` are now `@estoc/daemon` and
  `@estoc/daemon/node`, and the `./v3` entries are gone; every entry
  below that names them describes what these export now.
- **The version-2 daemon is removed**: its `createDaemon`, `Daemon`
  and `Snapshot`, the folder backup, and the Node host over `FsBackend`
  with its pid file, with the upstream `didcomm-node` and
  `@estoc/folder-object` dependencies. `guardedFetch` is the Node
  host's default fetch and is no longer exported.

- **`estoc-daemon` runs the version-3 daemon.** `runDaemon`,
  `installedApp` and `exitOnSignal` moved from `@estoc/daemon/node` to
  `@estoc/daemon/v3/node`, and the bin with them. A folder that holds a
  folder-format vault is refused at the start with nothing written to
  it. The token is `.estoc/daemon.token`; once the folder is the
  daemon's own, the socket's URL is left in `.estoc/daemon.url` until it
  closes, for a process on this machine the folder is refused to. The
  record is removed before the folder is let go, so a daemon that takes
  over keeps its own; a `runDaemon` that fails past listening closes
  what it opened before it rejects. `vaultDir` makes `.estoc` and closes
  one that stood open to others to 0700.
- **`Snapshot.anchor`**: the did:key the vault's seed derives.
- Node 22.13 is the oldest that runs it, which is what `node:sqlite`
  needs.

- **`@estoc/daemon/v3`** and **`@estoc/daemon/v3/node`**: the daemon
  over the version-3 vault, built beside the entries above, which stay
  as they are. The host provides SQLite files by name
  (`DaemonStorage`), to one daemon at a time from `storage()` to the
  storage's `close()`: the vault is `vault.sqlite`, a snapshot crosses
  as the bytes of its file, and a second daemon lands on `elsewhere`,
  refuses whatever would make, open or remove a file, and waits. The
  Node host keeps them in `<root>/.estoc/`, holds an empty
  `owner.sqlite` open there under SQLite's own lock for as long as the
  folder is its daemon's, says `unreadable` over a folder-format vault
  and writes nothing beside it, loads `@estoc/didcomm-node`, and gives
  the agent a fetch that refuses addresses that are not public.
- **One operation on the files at a time.** `createIdentity`,
  `restoreIdentity`, `unlock`, `lock`, `forgetIdentity`, `exportBackup`
  and `mergeBackup` run in the order asked, so of two vaults asked for
  at once one is made and the other refused with nothing removed, a
  lock of a locked vault changes nothing, and exports and merges asked
  for together each finish on a snapshot file of their own turn. A
  vault file is removed only by the call that made it or by
  `forgetIdentity` of the daemon that holds it. `close()` ends a wait
  for files held elsewhere, waits for the operation under way, lets go
  of everything, and answers the same to every caller; nothing is
  opened or said after it.
- **An agent let go of starts no request, and the ones it has are
  waited for.** When the daemon closes, locks, forgets the vault or
  replaces the agent after a merge, the agent's fetch refuses whatever
  it is asked next, new calls over the agent are refused, and what is
  under way is waited for before the vault closes or the next agent
  connects: every call over the agent, and every request it has out
  until its response is over, whether a call began it, a retry on its
  timer or a delivery down its socket. A removal on its way so lands
  before anything is registered next. A request is waited for as long
  as the deadline its caller set, which is how long `close()` can take;
  one that outlasts it may still take effect at the other end later,
  and a reconciliation after it sees and mends only what stands there
  at the time. A host may set the agent's retry policy
  (`agentOptions.retry`).
- **The text encoding carries any record as it was.** A record whose
  one key starts with `$` — `{"$bytes": "…"}` in a message body — came
  back as bytes or a Map, or failed to decode. Such a record now goes
  out with one more `$` on its key and comes back with one fewer;
  `decode` throws on a tag that is none of its own. Both ends of a
  socket need this version. A frame that does not decode closes the
  socket it came on (1007) rather than the process, and `serve` leaves
  unanswered whatever is no call — a record with a numeric `id`, a
  string `method` and an array of `args` — and answers a call only from
  its target's own methods.
- **`Snapshot`** is the vault as `@estoc/agent-core/v3` records off one
  fold — arrangements, local DIDs, contacts, each channel record once,
  unplaced observations, invitations, pending work — told whole as
  `opened` and again as `changed` after every call and every delivery;
  `lines` carries what only the running agent knows (connections,
  waiting and discarded deliveries).
- **Calls**: `setMediator`, `createInvitation`, `acceptInvitation`,
  contacts (`createContact`, `renameContact`, `setContactChannels`,
  `deleteContact`), `blockChannels`, `eraseMessage`, `send`, and the
  manual steps the records name: `retry`, `cancel`, `completeResponse`,
  `completeNotification`, `rotate`; `pending`, `refresh`, `reconnect`.
- **Restore**: `restoreIdentity` takes a portable snapshot's bytes and
  the passphrase of its own wrapped seed. Until `explainedRestore`, the
  snapshot says `restoreUnexplained` and `send`, `acceptInvitation`,
  `retry`, `completeResponse`, `completeNotification` and `rotate` are
  refused; pickup, reconciliation, receipts and their automatic effects
  go on. The mark is this runtime's own local option, so another
  process over the same file owes the explanation still.
- `serveDaemon`'s socket server moved to `node/socket.ts` (`serveOver`),
  shared by both versions; a served daemon that has `close()` is closed
  with its server.

- **`block(cid)`** reads a block of the vault's `blobs/` by CID — what
  the app's object-share renderer hands `verifyShare` as `held`. It read
  `blob(cid)` before, which is a *file* read: since a recorded share's
  blocks are in `blobs/` and its body names them by id (agent-core
  0.18 unreleased), the renderer read the share's directory nodes that
  way and every stored share failed to show, "not a file". `blob(root)`
  stays a file read, chunks rejoined, and is documented as one.

## 0.2.0 — 2026-09-01

The daemon over the version-2 vault (`@estoc/agent-core` 0.18,
`@estoc/vault` 0.2, `@estoc/event-store` 0.1).

- **Boot**: `inspectVault` holds the locked phase (folder open, keystore
  read, no seed); `NotAVault` — a version-1 folder, or a newer format —
  lands on `unreadable`. No config at all is onboarding.
- **`Snapshot`** is projected from the fold: `label`, `mediatorDid` /
  `did` off this device's mediation, contacts and invitations as v2
  records (retired invitations dropped), `messages` as
  `{ record, contactCid }[]` with the contact attributed by the fold,
  `deliveries` per outbound message, `damaged` = damaged log lines plus
  bodies that would not read back.
- **Backup**: export = `snapshot` + `zipFiles`; merge = `importVault` +
  `holdImported` + `keys.rebuildCache` under a reopen; restore =
  `restoreFolder` + `holdImported` — the restored copy is a fresh device
  and arranges its own mediation afterwards. `filesFromZip` runs before
  anything lands, and every refusal after `restoreFolder` wipes and
  rethrows, so each retry starts from the empty folder.
- **Trace** is served from the vault's `local/agent/` (`AgentTrace`),
  readable the moment the vault is open, locked included; the level lives
  in `local/agent/options.json`, so the host's `traceLevel` /
  `setTraceLevel` hooks are gone and forgetting the identity resets it.
- **Node host**: pid and token live in `.estoc/local/daemon/`; `wipe` is
  `rm .estoc` plus retaking the pid.
- **Events**: `delivery(delivery, record)` carries the fold's word;
  `invitation(record, gone)` uses `retired`.

## 0.1.0 — 2026-08-29

First release: `Daemon` (`src/api.ts`) — an agent and its vault behind
one interface a UI talks to, calls one way and `DaemonEvents` back —
with two hosts, the browser worker (in `@estoc/app`) and the Node host
behind a WebSocket (`estoc-daemon`, token on the socket, serves the app
itself); `traceOf(mid)`, `traceLevel` / `setTraceLevel`.
