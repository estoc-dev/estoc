# Daemon API: a contract for views

Status: **design draft; implementation is not yet conformant**. The target is
API version 1. This document defines the boundary between an Estoc daemon and
its web, terminal and programmatic clients, called **views**. It defines the
public data model, session behaviour and transport obligations; it does not
change the [vault model](replica-model/README.md), event identity, admission,
continuity, dispatch authority or portable backup format.

The capitalized requirement words have their BCP 14 meanings. The TypeScript
shapes describe public data, not imports from the current implementation.
Normative rules apply equally to an embedded daemon and an attached one.

## 1. Responsibilities and trust

A daemon owns one vault, its unlocked keys, domain procedures and read
projections. A view renders records and requests named operations. Only the
daemon reads or changes the live vault; a view MUST NOT open its SQLite file,
compose vault events or infer permission to send from presentation state.

The daemon decides which observations are admitted, what continuity is
verified, which channels are eligible for a send and which work remains.
These decisions are rechecked when an operation executes. A view decides
layout, navigation, grouping by date, localization, drafts and scroll position.
The same vault state can support different screens without changing facts or
granting different authority.

Normal API records and replies MUST NOT contain plaintext seeds, private
keys, keystore handles or runtime objects. Portable backups are an explicit
exception to the record boundary: they contain raw events, retained content
and the encrypted seed wrapper required by the
[export contract](replica-model/vault-sqlite.md#snapshot-and-export).
Their history is plaintext; the passphrase protects the seed wrapper only.

A token authorizes the entire daemon interface. A view holding it is a
trusted client, not a sandboxed renderer. A view that handles a passphrase
and a backup can disclose material sufficient to recover the identity.
Neither a worker boundary nor the absence of a plaintext-seed method prevents
that disclosure. Views MUST keep passphrases out of persistent storage and
logs, and keep tokens in private storage. Backup delivery is an intentional
release of recovery material to the person or their chosen program.

## 2. Packages and type ownership

`@estoc/daemon-api` is the public package a view installs. It has four entry
points in one package:

| Entry point | Owns |
| --- | --- |
| `/contract` | Public identifiers, records, method inputs/results, events, stable error codes, runtime schemas and API version |
| `/client` | The typed proxy, negotiation, attachment, pending calls and local connection state |
| `/wire` | Framing, validation, encoding, port adapters and the server dispatcher over an explicit public handler table |
| `/views` | Pure record lookup, navigation helpers and invitation/message helpers usable without a daemon runtime |

The following arrows mean source dependencies, not network calls:

```mermaid
flowchart LR
    V[web / terminal / bot] --> C[daemon-api/client]
    C --> W[daemon-api/wire]
    W --> P[daemon-api/contract]
    V --> H[daemon-api/views]
    H --> P
    D[daemon] --> W
    D --> P
    D --> A[agent-core]
    A --> S[vault]
```

`vault` and `agent-core` retain their domain types and MUST NOT depend on
`daemon-api`. The daemon adapts their results into API-owned data transfer
objects (DTOs). Public records MUST NOT be aliases, re-exports or declaration
references to backend types. Similar fields may have separate declarations;
the adapter, schemas and conformance cases keep their meanings aligned.
An internal refactor does not by itself change the public API.

Public IDs are opaque strings with documented roles. API declarations MAY
brand them for TypeScript callers, independently of backend brands. A brand
is not validation or authority. The adapter preserves validated domain ID
spellings; request decoding checks syntax, and the domain procedure checks
existence, ownership and current eligibility. Views compare and return IDs;
they do not reconstruct event or execution IDs.

Installing the API package MUST suffice to compile and run a view without
installing the daemon, vault, event store, DIDComm WASM or keystore. Its
dependencies MAY include small portable validation or encoding libraries.
There is no requirement to reimplement a standard algorithm to achieve zero
dependencies. The contract and pure helpers perform no filesystem, network
or cryptographic identity operation. Client adapters acquire platform
resources only when explicitly constructed.

First-party view code imports only the API entry points for this boundary.
The host that embeds the daemon is separate: a browser worker or Node host
may import `@estoc/daemon` and its runtime dependencies. The host contract
remains owned by `@estoc/daemon`; it is not part of the public client package.

## 3. Host lifecycle, vault state and connection state

### 3.1 The host owns startup

The host creates and starts the daemon independently of whether any view is
attached. Startup begins in `booting`, publishes progress and may wait in
`elsewhere` while another runtime holds the files. An endpoint can answer
negotiation and attachment during that wait. Taking and releasing the files
obeys [exclusive ownership](replica-model/vault-sqlite.md#ownership-and-lifecycle).

There is no public `boot()` or host `close()` RPC. Opening another view does
not start another agent. Detaching or losing the last attached view does not
lock the vault or stop the daemon. An embedding host may shut down with its
own page or worker; that is a host lifetime decision.

The host's close operation stops accepting work, quiesces ongoing domain
operations under their existing deadline and ownership rules, closes the
files and then releases their ownership. Dropping a client's socket alone
does not cancel an operation already admitted to execution.

### 3.2 State is one value

```ts
type Hold = string;
type Epoch = string;
type Revision = number;

type NonOpenPhase =
  | "booting" | "elsewhere" | "onboarding" | "foreign"
  | "unreadable" | "damaged" | "locked";

type StateValue =
  | { phase: NonOpenPhase; hold: Hold | null; detail: string | null }
  | { phase: "open"; hold: Hold; snapshot: Snapshot };

interface State {
  epoch: Epoch;
  revision: Revision;
  value: StateValue;
}
```

`state(State)` replaces the entire previous value. It replaces the separate
`phase`, `opened` and `changed` events. A non-open value contains no snapshot;
a view MUST remove its live snapshot and all derived live records when it
receives one. A view MUST NOT manufacture an open state from a successful
unlock reply or optimistically patch a snapshot after a command.

| Phase | Meaning and available recourse |
| --- | --- |
| `booting` | Startup is in progress; no vault operation is ready yet |
| `elsewhere` | Another runtime owns the files; this daemon waits and refuses file mutations |
| `onboarding` | The daemon owns the location and no vault stands there; create or restore is available |
| `foreign` | The host found an incompatible layout; the daemon takes and removes nothing; recourse belongs to the host |
| `unreadable` | The vault or location could not be opened; removal is available only with a non-null hold on a vault file |
| `damaged` | Valid-version history is damaged; ordinary writes stop; recovery restores a validated backup into a new vault |
| `locked` | The daemon holds the vault without unlocked identity use; unlock or explicitly guarded removal is available |
| `open` | A complete snapshot is available; operations still check their own preconditions |

`detail` explains the condition to a person and is not a branch key.
`damaged` must explain that only history in a usable backup returns, and
that the seed alone cannot recover missing history. No phase promises a
backup can be exported from an unreadable or damaged runtime.

`hold` names the particular vault file held by this daemon. It is stable
through lock/unlock and other phases while that file remains held, and is
retired when it is removed or released. A new daemon ownership period or a
replacement file gets a new hold even if its anchor is the same. It is not
a portable vault ID or a capability token. `forgetIdentity({ hold })` MUST
compare the caller's captured hold under the lifecycle exclusion that also
removes the file. A stale confirmation MUST NOT remove a replacement vault.

### 3.3 Connection state is local to the client

The client exposes `connecting`, `connected`, `disconnected` or
`incompatible`, separately from the last daemon state. `connected` means
negotiation and initial attachment have completed, not merely that a socket
is open. `unreachable` is therefore not a daemon phase.

On disconnection a view MAY retain its last display, marked stale. The SDK
MUST reject new remote operations until a fresh attachment completes. On
reconnection it replaces the old state before enabling operations. Callbacks
from an older socket or worker connection MUST NOT update the new session.
A daemon-originated non-open state still clears the snapshot; a stale display
is not permission to retain live records after a received lock transition.

## 4. Negotiation and attachment

Every port begins with a bootstrap exchange. These JSON record shapes and
their meaning remain stable across application API versions:

```ts
type Hello = { kind: "hello"; wire: 1; apis: number[] };
type Welcome = {
  kind: "welcome";
  wire: 1;
  api: number;
  implementation: string;
  limits: { maxFrameBytes: number; maxBackupBytes: number };
};
type Incompatible = {
  kind: "incompatible";
  wire: 1;
  supported: number[];
  message: string;
};
```

The daemon speaks one application API version and selects it only if it is
in `apis`; otherwise it returns `incompatible` and closes the port. A view
MUST NOT continue after a mismatch. Implementation text is informational.
No records, runtime lines, logs or public method calls precede successful
negotiation. Each new physical connection negotiates again. The daemon must
answer the bootstrap in every phase without waiting for file ownership.

After `welcome`, the client calls `attach()`. The daemon registers that
port and queues one result containing `{ state: State, lines: LinesState }`
as a single ordered publication step. That result is the session's initial
baseline. Subsequent events follow it on the port; events already represented
by the baseline are not replayed behind it. There is no application-visible
read-then-subscribe gap and no independent snapshot read for each new view.
The baseline's state and lines must belong to the same epoch.

Attachment uses the current complete published state, which may be `booting`
or `elsewhere`. If a commit is not represented yet, the publisher's scheduled
update follows. A port attaches once; a second call returns `AlreadyAttached`.
Other public methods before attachment return `NotAttached`. Closing the
port unregisters only that session. Existing views receive no replay because
another one joined.

The server exposes an explicit method table. Host operations, prototype
methods and internal helpers never become callable through object spreading
or reflection. Unknown method names return `NoSuchMethod`.

## 5. Publishing state

### 5.1 Epochs, revisions and coherent reads

One publisher owns state ordering for all views. It installs a fresh opaque
epoch on daemon startup and whenever `(phase, hold)` changes. Revisions are
positive safe integers, beginning at 1 in each epoch. Epochs are unequal
tokens, not sortable clocks; revisions compare only within one epoch. Neither
is a vault event CID, receipt ordinal, portable identity or durable cursor.
An implementation installs a fresh epoch before exhausting its revision range.

The publisher MUST satisfy all of these invariants:

1. A snapshot describes one coherent read of domain events, retained content
   and the local options affecting the view, including the restore gate.
2. Within an epoch, a later revision never represents an older read cut.
   Reusing a revision means exactly the same state value.
3. A change of epoch invalidates every unfinished build from the old epoch.
   Such a build cannot publish after the transition, even if it finishes later.
4. Each attached port sees its initial baseline followed by increasing
   revisions of that epoch, or a new epoch's complete state. Intermediate
   revisions may be coalesced. Old-epoch state never follows a new epoch.

A sufficient implementation serializes snapshot capture and publication.
It reads under the vault's operation lock, capturing all inputs needed for
the DTOs before releasing that protection. An implementation may instead
build from an immutable, pinned read cut with equivalent guarantees. Reading
events at one cut and bodies or erasure state at another is not equivalent.
No network wait occurs while holding the vault's operation lock.

Lifecycle transitions and publisher work also coordinate ownership: a
runtime cannot close while a protected capture still reads it. Before
publishing, the builder rechecks its epoch and hold. Assigning a larger
revision to a stale result does not make that result current.

The publisher retains its current immutable state. Attachment copies that
published baseline in the same ordering mechanism used to register future
updates. It does not start a second read and then flush an arbitrary queue
of whole snapshots behind it.

### 5.2 Automatic updates and coalescing

Every committed change that can affect public records MUST invalidate the
projection and schedule publication. This includes user commands, inbound
receipt/admission, dispatch completion, background recovery, import, content
repair/erasure and relevant local options. Notification belongs at the write
boundary; watching only completed view calls or inbound delivery callbacks
is insufficient. Failed calls that committed something also invalidate it.

The daemon MAY combine several commits into one complete snapshot. It MUST
make progress while changes continue: a completed current-epoch capture may
be published even if another capture is already needed. Changes during a
build schedule a subsequent build; they cannot clear its dirty notification.
Once writes quiesce, a healthy connected view eventually receives a state
covering all of them without a call to `refresh()` or a visibility event.

Command replies report the procedure's result, independently of when a view
renders the corresponding state. Views MUST NOT infer rollback from an
error or assume a reply is the next snapshot. `refresh()` requests a fresh
publication and returns its `{ epoch, revision }` after that state is queued
to the calling port. A later already-queued state may subsume it. If the epoch
changes before this barrier completes, the call fails with `StateChanged`;
the new epoch's state arrives through the normal stream.

### 5.3 Runtime lines and logs

`lines` is a complete replacement of the agent's transient connection,
waiting-delivery and bounded-discard diagnostics. It is not vault history.

```ts
interface Lines {
  connections: ConnectionRecord[];
  waiting: WaitingDeliveryRecord[];
  discarded: DiscardRecord[];
}

interface LinesState {
  epoch: Epoch;
  revision: Revision;
  value: Lines;
}

interface LogLine {
  epoch: Epoch;
  line: string;
}
```

Connection records retain mediation identity, live/unreachable status,
reconciliation and drain results, and bounded unknown registrations. Waiting
records retain their delivery key, pickup/direct source, reason and whether
bytes are held for retry. Discard records retain source and reason, without
envelope bytes. These are API-owned records, not exported agent types.

Lines have their own revision counter, starting at 1 in every state epoch.
They belong to the current state epoch and their three lists are empty in
non-open phases. An epoch transition initializes its lines before a port can
attach, queues the new state before that epoch's lines, clears the prior
lines, and invalidates old
agent callbacks. An attached view MUST NOT apply lines from another epoch.
Changes in runtime lines publish automatically without rebuilding the vault
snapshot. Updating state and lines is not a cross-stream atomic observation.

`log(LogLine)` appends a display line with its epoch. It has no authority,
is not an audit log and has no replay guarantee. A session's logs cannot precede its
initial baseline or arrive from a retired epoch. Views own bounded log
buffers; no application decision depends on receiving every line.

Each port has bounded output buffering. A slow view cannot delay the agent,
the writer lock or other views. The daemon may replace an unsent state or
lines update with a newer complete value of the same epoch. It MUST preserve
attachment baselines, epoch transitions and RPC replies; it may drop logs.
If these obligations no longer fit its buffer limit, it closes that port.
A state too large to encode or a failed coherent read produces a terminal
`StateUnavailable` fault, rather than a silently incomplete snapshot. This
does not relabel an otherwise healthy vault as `damaged`.

## 6. Public records and projections

### 6.1 One copy of each record

The snapshot is normalized within one complete value. Normalization does not
introduce diffs, subscriptions to individual records or cross-snapshot caches.

```ts
interface Snapshot {
  anchor: string;
  label: string;
  restoreUnexplained: boolean;
  mediations: MediationRecord[];
  dids: LocalDidRecord[];
  contacts: ContactRecord[];
  channels: ChannelRecord[];
  messages: MessageRecord[];
  observations: ObservationRecord[];
  conversations: ConversationRecord[];
  invitations: InvitationRecord[];
  pending: PendingWork;
  unplaced: {
    observationIds: string[];
    outputs: { messageId: string; candidateChannelIds: string[] }[];
  };
}

interface ConversationRecord {
  id: string;
  contactId: string | null;
  petname: string | null;
  claimedName: { name: string; messageId: string } | null;
  channels: { channelId: string; selected: boolean }[];
  writeTo: string[];
  defaultWriteTo: string | null;
  messageIds: string[];
  unadmittedObservationIds: string[];
  diagnostics: string[];
}
```

The API owns complete schemas for every named DTO above. The record inventory
fixes the public information to preserve and the normalization to apply:

| Record | Public information |
| --- | --- |
| `MediationRecord` | `mediationId`, mediator DID, selection, usability, retirement and diagnostics |
| `LocalDidRecord` | `didId`, canonical DID, liveness, retirement, disclosure and diagnostics |
| `ContactRecord` | `contactId`, origin, petname, flags, shown channel references with `selected`, eligible `writeTo`, `defaultWriteTo`, saved DID preference and diagnostics |
| `ChannelRecord` | `id`, canonical local/peer pair, head reference, superseded/blocked/conflicted state, send gate, sourced peer name claim, submitted-profile ID, message and observation reference lists |
| `MessageRecord` | `messageId`, direction, nullable channel reference, exact selecting contact IDs, display time `at`, agreed headers, body availability/content/attachments, protocol kind, effect type, execution/delivery status, ACK/late/verification state, available manual steps, diagnostics and summary |
| `ObservationRecord` | `sourceEventCid`, logical `messageId`, nullable channel reference, `at`, authentication/verification state, admission disposition and contradiction indicator; no message body |
| `InvitationRecord` | Disclosure CID, OOB ID, local DID entity/string, use policy, availability and consumer |
| `PendingWork` | Pending outbounds, missing responses/notifications, notification conflicts and waiting proofs, retaining the IDs and explicit manual entries needed to act on each |

Contact and channel DTOs contain references rather than embedded message,
observation or channel records. `messages` has one record per `messageId`,
`observations` one per `sourceEventCid`, and `channels` one per canonical
pair. Messages include admitted inputs and placed or unplaced outputs;
an unadmitted observation MUST NOT cause a placeholder accepted message.
Bodies and attachments appear only in their owning message record.

Channel `id` is the canonical JSON text of `[localDid, peerDid]` under the
[channel identity rule](replica-model/channels.md#channel-identity).
Views treat it as opaque. The channel table includes every pair referenced
by contact membership, message/observation placement, heads, send choices
and unplaced-output candidates, even when a pair has no messages.

Relationship lists MUST resolve within the same snapshot: conversation and
channel `messageIds` resolve in `messages`, observation lists in
`observations`, and channel references in `channels`. In contrast, a logical
`messageId` carried by an unadmitted observation or pending proof names a
domain entity and need not have an accepted MessageRecord. Normalization
MUST NOT manufacture facts just to fill such references.

The arrays of records sort by their primary IDs using literal string
comparison. Message reference lists sort by ascending `(at, messageId)`;
observation reference lists sort by ascending `(at, sourceEventCid)`.
These are deterministic presentation orders, not arrival order, causality
or authority. Equal timestamps do not leave iteration order as a tie-break.

### 6.2 Conversations

The daemon builds the default conversation projection as a pure derivation
over the captured read model. It follows
[contact views](replica-model/channels.md#display-relationships) and
[send selection](replica-model/channels.md#fixed-outbound-channel):

1. Each undeleted contact has one conversation. Its ID is `contact:` followed
   by the contact ID. It shows every channel in that contact's derived view,
   including related history, preserving each `selected` flag. Its send
   choices, preference result and diagnostics are the contact's domain
   results. A display-only contact-merge hint does not merge these records.
2. Mark every channel **shown** by any contact conversation as assigned,
   including channels with `selected: false`. Group remaining channels by
   `head ?? id`. Each group has a conversation whose ID is `channel:` followed
   by that key, with null contact and petname.
3. A nameless group writes only to its head when that head is a member of
   the group and its send gate is open. Otherwise its `writeTo` is empty and
   `defaultWriteTo` is null. It never falls back to a superseded predecessor.
4. A conversation's messages are the union of its shown channels' message
   references, each once in the defined display order. Its unadmitted list
   similarly unions observations whose disposition is not `admitted`.

For example, a contact selecting H while showing predecessor P through
verified continuity contains both `{H, selected: true}` and
`{P, selected: false}`. P does not also become a nameless conversation merely
because it is not selected. If two contacts show P, both may reference its
history; the underlying records still occur once in the snapshot.

A channel's peer name is a claim derived under the supported profile
protocol from effectively admitted, consistent source evidence. It retains
the claiming message ID. For a conversation, take these non-null channel
claims and select the largest `(claiming MessageRecord.at, messageId)` by
literal string comparison. A candidate must resolve to an available claiming
message in its source channel. No candidates means null. Erased or missing
content supplies no name. With two claims at the same time, the greater
message ID wins; IDs otherwise express no chronology. A claim never renames
a contact or establishes a relationship.

Conversation IDs are projection keys, not saved chain identities. A nameless
key can change after rotation or naming. `/views` provides `successorOf`:
for snapshots with the same anchor, collect the old conversation's channel
IDs and find new conversations sharing any of them. Return the sole match,
otherwise null, including when there are no matches. A view first retains
an existing conversation ID when it still exists. This helper preserves
navigation only; it does not move drafts automatically or authorize a send.

### 6.3 Presentation helpers

`MessageRecord.summary` is a nullable fallback string derived from available
content by a handler for that message type. An unknown type, unavailable body
or conflicting interpretation yields null. A basic message supplies its
string content; a profile supplies `name: ` followed by its recognized name.
CRLF, CR, LF, U+2028 and U+2029 are replaced with spaces to form one line.
Renderers treat summaries and peer text as text, never executable markup or
terminal control instructions. Views choose localization and visual truncation.

The daemon remains responsible for admission and protocol interpretation.
Pure SDK helpers resolve IDs, assemble a selected conversation's records,
parse invitations and expose protocol constants used by commands. They MUST
NOT rescan events, reimplement continuity or decide send eligibility.
Views may organize multiple conversations differently while preserving each
message's source attribution and each operation's concrete target.

Drafts, selection, read markers and scroll positions remain view-owned,
namespaced by the vault anchor where they are per vault. Nothing in this
contract makes such UI state part of the portable vault history.

## 7. Commands, results and failures

### 7.1 Public operations

Operations use API-owned, named input objects. A method taking no arguments
receives `{}` on the wire. The initial inventory preserves these capabilities:

| Methods | Input and result responsibility |
| --- | --- |
| `attach`, `refresh` | Establish a baseline/subscription; request a publication barrier |
| `createIdentity` | Name and passphrase; create only in `onboarding` |
| `restoreIdentity` | Complete backup bytes and its passphrase; restore only into an unused destination |
| `unlock`, `lock` | Unlock with a passphrase; lock by stopping identity use and forgetting cached unlocked key material |
| `forgetIdentity` | Explicit captured `hold`; remove only that held vault file |
| `exportBackup`, `mergeBackup` | Deliver a complete validated portable file; import a same-anchor file and return added/duplicate/object/repair counts plus whether the local author was renewed |
| `explainedRestore` | Record that the person has received the required recovery explanation |
| `setMediator`, `createInvitation`, `acceptInvitation` | Configure mediation; create an OOB invitation under its use policy; accept one with a petname and return contact/message/channel identity plus the send result |
| `createContact`, `renameContact`, `setContactChannels` | Create or update explicit contact naming and selected canonical pairs |
| `deleteContact`, `blockChannels`, `eraseMessage` | Apply the requested deletion, denial/successor policy or erasure without deriving broader targets from display grouping |
| `send`, `retry`, `cancel` | Submit a new intent to a concrete pair or contact selection; act on an existing message ID without retargeting it |
| `completeResponse`, `completeNotification`, `rotate` | Name the execution/effect, rotation decision or local DID/peer context; return the procedure's result |
| `pending`, `reconnect`, `traceLevel`, `setTraceLevel` | Inspect current pending work; reconnect mediator transports; read or set trace policy |

`reconnect` concerns the daemon's mediator connections, not the client's port.
`pending` is a read of the same domain projection used in `Snapshot.pending`;
its result does not patch a view's snapshot. Trace levels are `off`, `normal`
and `verbose`. The initial API schemas must explicitly describe every method's
fields, nullability, result and known error codes before version 1 is released;
the inventory is not permission to forward arbitrary backend arguments.

Requests operate on this daemon's vault. Views invalidate outstanding UI
actions when its hold changes, and destructive confirmations carry the hold
captured when shown. The SDK MUST NOT replace an explicit old hold with its
new current one. Per-vault entity IDs never grant authority in another vault.

File lifecycle operations are mutually exclusive and recheck phase, hold
and destination occupancy within that exclusion. They cannot close or remove
a runtime beneath an operation using it. Domain procedures retain their
operation-lock and per-message ordering rules. Concurrent calls may complete
out of order; the API does not promise that a whole network procedure is one
atomic transaction or impose a global FIFO of network waits across views.

When a snapshot says `restoreUnexplained`, the daemon MUST refuse user sends
and manual dispatch, including invitation acceptance and rotation paths that
send, until `explainedRestore` has committed. A view explains the restore
limitation before offering that call. Receiving, reconciliation and work the
runtime independently owes retain their domain rules. Likewise, `writeTo`,
manual-action lists and displayed send gates are hints for presenting actions;
the daemon revalidates every action against current evidence and policy.

### 7.2 Procedure outcomes are data

```ts
interface Outcome {
  outcome:
    | "submitted" | "pending" | "failed" | "uncertain" | "expired"
    | "spent" | "threw" | "none" | "refused" | "existing" | "cancelled";
  because: string | null;
}

interface SendResult extends Outcome {
  messageId: string;
  channel: { localDid: string; peerDid: string };
}
```

Each method's schema restricts this union to the outcomes it can return.
`submitted` means the transport acceptance the domain recorded, not a peer
application ACK. `pending` is deferred work; `none`, `refused`, `spent` and
`existing` retain their procedure-specific no-new-action meanings.
`failed` is a non-acceptance transport answer; `uncertain` is a transport
attempt whose arrival is unknown. `expired` and `cancelled` describe the
recorded termination. `threw` reports a procedure attempt that raised an
exception after the message was identified; it does not assert rollback.
`because` is explanatory text. Clients branch on the outcome tag, not that text.

A normal result is distinct from an RPC failure. A view must surface the
actual outcome, including failure or uncertainty, rather than announce every
resolved promise as sent. A bot follows the same distinctions even without
a screen. A retry by message ID preserves the domain's existing package;
another `send` may create a new message and is not an equivalent retry.

### 7.3 Stable RPC errors

```ts
interface ApiError {
  code: string;
  message: string;
  effect: "none" | "possible";
}
```

`code` is protocol vocabulary independent of exception class names. `message`
is text for a person or log. `effect: "none"` may be reported only when the
daemon knows the requested operation caused no domain mutation or external
side effect; otherwise it reports `possible`. An exception after an earlier
commit is not a refusal with no effect. Error details contain no secret or
raw thrown object. Internal stacks stay on the host.

The baseline codes are:

| Code | Meaning |
| --- | --- |
| `NotAttached`, `AlreadyAttached` | Session precondition failed |
| `NoSuchMethod`, `InvalidArgument` | Unknown public method or invalid input; no method invocation |
| `WrongPhase`, `StaleHold`, `RestoreUnexplained` | A lifecycle or recovery guard refused the requested operation |
| `NoTarget`, `SendClosed` | Current contact selection or channel policy supplies no permitted target |
| `StateChanged` | A refresh barrier lost its epoch |
| `ResourceLimit` | The operation exceeds the advertised size bounds |
| `OperationFailed` | An operation failed outside a normal procedure outcome; inspect `effect` |
| `StateUnavailable` | A complete state cannot be published; terminal session fault |

`NoTarget` or `SendClosed` may arise after earlier steps of a compound
procedure, so the code alone does not imply `effect: "none"`. Unknown codes
are displayed as failures with their supplied effect uncertainty. There is
no generic `retryable` bit authorizing a fresh business operation.

### 7.4 Lost replies

The SDK ends every pending call when its port closes. A request known never
to have been handed to the transport can fail locally with no effect. Once
handed over, a missing reply is `TransportDisconnected` with effect unknown,
even if the daemon may have finished the operation. A client timeout or
abandoned wait does not cancel work at the daemon.

The SDK and view MUST NOT automatically resubmit a side-effecting call after
such a failure. Reconnection negotiates and attaches to a fresh baseline;
it restores observation, not unacknowledged commands. Results arriving from
a previous connection are ignored. The original request ID is neither a
durable operation ID nor a cross-connection deduplication key.

For example, `send` may commit and dispatch M before its result is lost.
Reattaching may show M but cannot prove which old call produced it merely
from equal content or a timestamp. The view reports that the request's result
is unknown; it must not create another send automatically. A new request is
an explicit user or program decision under current state. Durable command
lookup/deduplication requires a separate future design and is not promised here.

## 8. Wire values and framing

### 8.1 A transport-independent data domain

Wire values are finite, acyclic JSON data trees: null, booleans, strings,
finite numbers, dense arrays and own string-keyed plain records. Negative
zero is normalized to zero on both transports. Object identity, property
insertion order and shared references carry no meaning. An optional member
with value `undefined` is omitted; undefined array elements or required
values are invalid. Getters, custom prototypes, functions, dates, maps,
sets, bigint and non-finite numbers are not wire data.

Schemas restrict numbers further where required, including IDs used for
correlation, counters and sizes. Both the embedded and text paths run the
same input validation and normalization before invoking a method. The client
validates outgoing values before JSON encoding; encoding MUST NOT silently
turn `NaN` into null. The daemon also validates received frames and inputs.
Unknown optional record fields are ignored within a compatible API version.
Validation never changes message-body JSON keys or interprets them as tags.

Backup byte parameters/results are explicit schema locations. On the wire
they contain `{ encoding: "base64", data: string }`, using standard padded
base64. The SDK presents those particular locations as `Uint8Array` and the
adapter translates them in both directions. The same shape inside arbitrary
message JSON is ordinary user content. There is no recursive `$bytes`/`$map`
tag recognizer and no escaping of user keys beginning with `$`.

Both transports use these wire records: a structured-clone port clones them,
and a text port encodes one record as one JSON text. Embedded transport does
not widen the contract to all values structured clone happens to support.
The full-frame representation includes backup base64 even on an embedded
port; a binary or streaming extension needs an explicit future contract.

### 8.2 Application frames

After bootstrap, API version 1 uses these envelopes. `JsonValue` and
`JsonObject` denote the validated domain above; the method/event schema
determines their actual fields.

```ts
type Frame =
  | { kind: "call"; id: number; method: string; input: JsonObject }
  | { kind: "result"; id: number; value: JsonValue }
  | { kind: "error"; id: number; error: ApiError }
  | { kind: "event"; name: "state" | "lines" | "log"; value: JsonValue }
  | { kind: "fault"; error: ApiError };
```

Call IDs are positive safe integers, unique for the lifetime of one port.
Each valid dispatched call produces one result or error with that ID while
the port remains writable; delivery is not guaranteed after a connection
failure. A void method returns `value: null`. Events have no replies. A fault
is terminal and the daemon closes that port; unresolved calls remain uncertain.

Malformed encoding or frame structure closes the port and becomes a local
`ProtocolError`; it is never passed to a public handler. A valid call envelope
with invalid method input receives `InvalidArgument`. Frames in the wrong
direction, repeated bootstrap and duplicate in-flight IDs are protocol errors.
Replies for an already-settled ID are ignored, never matched to a new call.

Ports preserve send order. The SDK installs its handlers before sending
bootstrap and attachment, consumes the attachment result as the baseline,
then applies later events. A locally synthesized connection error is not
misrepresented as a daemon's `Outcome` or remote `ApiError` reply.

### 8.3 Bounds and backup delivery

The welcome message advertises positive safe-integer `maxFrameBytes` and
`maxBackupBytes`. Frame size is the UTF-8 byte length of the JSON encoding,
including for structured-clone ports; backup size is the decoded byte count.
Both endpoints reject excess input before invoking a method. Encoders,
decoders and backup construction enforce bounds before unbounded allocation;
base64 expansion and envelope overhead count against the frame bound.

Limits must allow the advertised maximum backup plus its encoding and
envelope overhead. An export exceeding a bound returns `ResourceLimit` and
does not deliver a partial backup. Bounds also apply to inbound restore and
merge before the destination is changed. A backup is reported delivered to
the view only when its entire validated reply arrives. Saving it durably to
a user-selected destination is a separate responsibility of that view.

The existing [bounded export requirement](replica-model/vault-sqlite.md#snapshot-and-export)
still applies. An implementation may fail a bounded whole-file export; it
cannot omit events or content to make an apparently complete backup fit.
State records likewise are never silently truncated to meet a frame limit.

## 9. Ports, authorization and discovery

An embedded host transfers a dedicated port to its chosen view. The host is
responsible for that recipient; possession of the port grants the same full
API authority as an authenticated attached connection. Public SDK helpers
do not acquire vault ownership or start a daemon as a side effect of import.

The default Node endpoint binds loopback. A WebSocket upgrade requires the
configured token in `?token=` before any protocol exchange. HTTP and upgrade
requests must also have a valid `Host` matching the configured names or local
addresses and bound port. A foreign name resolving to loopback is not thereby
allowed. `Origin` alone is not authorization: explicitly trusted views may
be served elsewhere, and terminal clients need not be browser origins.

The token is an unguessable bearer secret, generated with the platform's
cryptographically secure random API. Use maintained platform/library APIs
for token comparison, encoding and protocol parsing. The default persistent
token is kept in `.estoc/daemon.token`, accessible only to the operating-system
user (`0600` inside a `0700` directory on POSIX, or equivalent protection).
Creating or replacing token material must be serialized; competing starts
must not overwrite the owner's credential. A waiting endpoint may use a
host-provided credential without changing the owned folder.

The folder owner publishes its token-bearing endpoint in
`.estoc/daemon.url` with the same file protection. It writes and removes that
hint only while it owns the folder, before releasing ownership. It never
removes a successor owner's hint. A stale file is discovery information,
not proof of a running daemon or authorization to take the vault. Clients
still authenticate, negotiate and attach. `foreign` does not authorize the
host to rewrite an incompatible folder for discovery.

Connection links are an intentional credential handoff. Views remove tokens
from visible navigation URLs after consuming them and redact them from
diagnostics, copied status text and ordinary logs. Hosts may explicitly print
a private connection link for the person launching them. Passphrases, backup
bytes and message bodies must not appear in transport diagnostics.

Binding beyond loopback requires explicit host configuration and protected
transport for credentials and vault data. Provisioning remote certificates,
accounts or narrower per-client permissions is outside this draft. The host
also bounds unauthenticated connections, bootstrap size and negotiation time;
advertised application limits do not leave bootstrap unbounded.

## 10. Versioning

The first release of this contract is API version 1. An existing unversioned
daemon is not assumed compatible. Bootstrap `wire: 1` has its own stable
decoder, so an endpoint can report application-version incompatibility
without first interpreting that application's records.

Within a version, fields may be added only when their absence is valid for
the receiving implementation. Clients ignore unknown optional record fields;
they do not discard arbitrary keys inside message content. New methods may
be added when clients handle `NoSuchMethod` without an unsafe fallback.
Required fields, removed methods, changed meanings and new members of closed
discriminated unions require a new API version. Error codes are an explicitly
open vocabulary: unknown codes remain failures with the stated effect
uncertainty. Implementation version text does not substitute for negotiation.

A daemon serves one application version at a time. A view may implement
several and advertises only those it can decode and honour completely. No
partial match, silent downgrade of method semantics or mutation probe is used
to discover compatibility. Reconnection always negotiates again.

## 11. Implementation sequence and acceptance

The migration is complete only when a view can be built and operated using
the public package alone. The work is staged in this order:

1. Define API-owned DTOs, exact method/event schemas and explicit daemon
   adapters. Freeze field meanings, nullability and method outcomes before
   releasing version 1. Build a consumer outside the workspace to check that
   installed runtime code and declarations contain no backend dependency.
2. Move startup into hosts and implement the shared publisher, commit
   invalidation, epoch fencing, bounded session queues and attachment. Adapt
   the existing web view to the client connection state and state stream.
3. Introduce the normalized projection and pure lookup/navigation helpers.
   Exercise selected and derived channel history, ambiguous placement,
   erasure and profile ties against the same captured read model.
4. Build a small terminal view using only `daemon-api` to attach, unlock,
   list conversations, read one and request a send. Its outcome display and
   reconnect behaviour must use the same contract as the web view.

A temporary adapter for an older first-party view must remain explicitly
outside version 1. Legacy events and new frames are never mixed within a
negotiated session. Moving a type into the API package does not justify
moving the domain decision that produced it into a view.

The implementation must demonstrate these cases through package checks and
focused integration tests; this draft does not claim they pass today:

| Case | Required observation |
| --- | --- |
| Independent consumer | A web/terminal consumer compiles and runs from the installed API package without backend, SQLite or DIDComm dependencies |
| Boundary and trust | Normal records exclude key/runtime objects; backup transfer is explicit and retains the complete portable file, including its encrypted seed wrapper |
| Startup and mismatch | Negotiation and attachment work during startup and ownership waits; incompatible clients receive no records; host-only methods cannot be invoked |
| Attachment race | A commit between connection and attachment appears either in the baseline or a subsequent update, without rollback or replaying older whole values |
| Slow capture | A delayed read cannot publish after a later cut or after lock, replacement or restart; stale agent callbacks cannot repopulate lines |
| Background progress | Receipt, retries, dispatch completion, erasure and local-option commits publish without a view call; sustained writes still produce progress and quiescence produces the final cut |
| Slow view | A blocked port cannot stall other views or the daemon; bounded buffering preserves required frames or closes that port, and oversized state is an explicit fault |
| Normalized projection | Selected H and derived predecessor P stay in one contact conversation; overlapping contacts share references, nameless groups never write through an assigned predecessor, and all relationship references resolve |
| Deterministic display | Equal-time profile claims use message ID, erased claims disappear, and record/reference ordering is stable across rebuilds |
| Transport equivalence | Embedded and WebSocket paths accept the same valid values, reject non-finite or cyclic data before invocation, preserve literal user keys and carry backup bytes identically |
| Unknown result | Dropping a reply after a send commits rejects the wait with uncertainty; reconnecting does not resubmit that send or treat a matching body as proof of its identity |
| Lifecycle guards | A stale removal confirmation cannot delete a replacement vault; concurrent lifecycle calls recheck occupancy; every user-dispatch entry point enforces the restore explanation gate |
| Complete backup | Export and import enforce advertised decoded and frame bounds, reject partial or invalid data, and never report a truncated file as complete |

Delta streams, per-conversation subscriptions, durable command lookup,
exactly-once execution, scoped client tokens, streaming backup transfer and
multi-vault routing are future designs. None is required to establish this
boundary. Whole snapshots, explicit outcomes and one owned vault keep the
first contract small enough to implement and independently exercise.
