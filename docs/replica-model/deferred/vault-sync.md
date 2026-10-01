# vault-sync/1.0

> Deferred candidate; not implemented, outside the current replica-mediation
> scope and not part of the [phase-1 contract](../README.md). The detailed rules
> below describe one peer-message design, not a selected synchronization
> interface. Revisit the [deferred sync work](README.md#deferred-vault-sync)
> before adoption, including the choice between event/object transfer and
> encrypted portable SQLite snapshots over blob-store.

[Replica mediation](replica-mediation.md) can be implemented and tested as an
independent transport milestone. It requires none of this draft's `hello`,
inventory, transfer or receipt messages. Until a sync design is adopted,
initial history uses existing portable recovery/import; missing history remains
pending rather than being inferred complete from successful registration.

[Suite guide](../README.md) · [Identity](replica-mediation.md#identity-model) ·
[Messages](#messages) · [Durability](#durability-and-acknowledgments) ·
[Conformance](#required-conformance-cases)

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT** and
**MAY** are interpreted as in BCP 14 when written in capitals.

<a id="reading-guide"></a>

## Reading guide

| Task | Sections |
| --- | --- |
| Understand the boundary | [Purpose](#what-it-is-for), [identities and authorization](#roles-and-dependencies) |
| Transfer current work | [Messages](#messages), [incremental publication](#publishing-local-objects) |
| Repair or add a device | [Inventory](#full-inventory), [application](#applying-remote-objects), [bootstrap](#bootstrap-and-recovery) |
| Handle crashes and erasure | [Durability](#durability-and-acknowledgments), [retention](#retention-and-erasure), [failure](#quota-and-availability) |

<a id="what-it-is-for"></a>

## 1. Purpose and boundary

Full replicas of one vault exchange immutable events and the raw objects their
merged state retains. Each replica has its own local database, event author and
DID. A replica sends an encrypted sync message to another replica DID through
their selected mediator; the destination picks it up, verifies it and imports
its contents. This works while the two devices are connected at different
times, within the mediator's retention and retry limits.

The mediator routes opaque messages. It does not implement event inventory,
object lookup, event merge, sync cursors or a remote reset operation. Those
requests are answered by replicas. Mailbox acceptance is not a sync receipt,
and a mailbox with finite retention is not a permanent backup.

[Replica mediation](replica-mediation.md#protocol-boundary) owns membership,
shared incoming-mail fan-out and pickup. This protocol owns transfer, peer
reconciliation and acknowledgement of imported vault data. It uses the same
mediator without another account-wide sync key, custom encrypted-container
format, upload-ticket API or server-side vault event index.

### 1.1 Synchronized data

The first profile synchronizes the main vault event store, preserving every
validated event's canonical envelope, CID and historical author, together with
currently held DASL objects. Domain data includes receipt/admission history,
outbound records, contacts, communication routes, rotation evidence, replica
membership and erasure facts. Unknown main-store event types follow the event
store and vault's existing preservation/retention rules; their names alone do
not authorize application execution.

It does not copy SQLite pages, local `replica_id`, store generation, seed
wrapper, passphrase, private keys, local options, traces, caches, connections,
pickup delivery IDs or synchronization progress. The vault anchor and supported
format identify the peer data; they do not overwrite destination metadata.
Separate extension stores require a later negotiated profile and MUST NOT be
silently opened or treated as the main vault.

A thin client without the seed is not a full replica or a sync peer. Initial
seed transfer and backup recovery remain separate from event synchronization.

### 1.2 Meaning of convergence

Event merge is set union by verified CID, not replay of user commands. Copies
of one event deduplicate; independently authored observations of the same
external message may be different events. CID deduplication alone cannot
resolve conflicting domain decisions.

Given eventual delivery and compatible domain rules, replicas holding the same
events and required objects must derive the same portable state. Neither wall
clock order, inventory order nor network receipt order establishes causality or
a globally current view. Pulling before dispatch is not a lock on another
replica's rotation. The [multi-replica domain revision](README.md#adoption-work)
is required before claiming application convergence or concurrent automatic
execution.

<a id="roles-and-dependencies"></a>

## 2. Identities, authorization and transport

The [identity model and signed replica grant](replica-mediation.md#replica-authorization)
are shared with replica mediation. No second sync identity or independently
maintained membership registry exists. A client uses its own replica DID as
sender and one authorized active peer's replica DID as recipient.
The selected account must have the verified replica-mediation profile intent;
an ordinary Coordinate Mediation account or grant cannot authorize this exchange.

All sync messages MUST be authcrypted end to end between those DIDs using
DIDComm Messaging 2.1. If routed, the outer Routing 2.0 `forward.body.next`
is the destination replica DID. These are private deliveries, never the
shared communication-address fan-out path. The mediator can decrypt its routing
layer and pickup controls but cannot open the sync payload.

Every plaintext sync body contains `vault_anchor` equal to the local immutable
vault anchor. Authentication also verifies that the sender matches a valid
replica grant under the already-known selected mediation arrangement. A wrong
anchor, invalid or conflicting binding, or wrong authenticated sender is
rejected before staging vault data. Verified Peer long/short forms are normalized
before identity comparison. A request cannot introduce a new trusted vault or
mediation account by asserting it in its own body.

`hello` is the only message accepted from a not-yet-known replica DID. It
carries the signed grant and long-form resolution material through that grant.
To decrypt a first `hello`, resolve its sender's long-form DID key identifier
locally, as for the account sender in
[replica registration](replica-mediation.md#replica-lifecycle),
then verify the grant inside. The encrypted grant cannot be its own decryption
prerequisite. A reply to a pending `hello` is accepted only from its expected
peer and must pass the same binding checks.
The receiver independently verifies the known-account signature, document,
seed-derived replica keys and absence of conflicting local bindings. A
successful grant check permits synchronization while the peer's genuine `replica.created` event is
being fetched; it does not synthesize that event or trust the mediator's list.

A known peer has durable local operational state containing its verified grant
and document, vault/mediation binding, supported vault version and latest
negotiated peer limits. This state is scoped to the local and peer replica DIDs;
it is not tied to a socket or copied into another incarnation. A normal restart
recovers it and does not make the peer unknown. Every message still checks
authentication, the vault binding and current local identity-conflict state;
persisted verification never overrides a conflicting binding.

Replica retirement belongs to
[deferred administration](replica-mediation.md#deferred-administration).
This initial profile has no retirement notification or terminal-receipt exception.
All accepted batches and receipts use the ordinary authorization and durability
rules. Being offline or absent from a mediator snapshot does not revoke a
locally verified peer binding.

<a id="messages"></a>

## 3. Message family

Message types have prefix `https://estoc.dev/vault-sync/1.0/`.
DIDComm `id`, `type`, authenticated `from` and a single-recipient `to` are
required. Responses use `thid` equal to the request message ID; responses to
batched transfers also name their stable batch ID. These control IDs are not
portable event identities.

| Suffix | Direction and purpose |
| --- | --- |
| `hello` / `hello-result` | Authenticate the replica binding and agree on format/limits |
| `inventory` / `inventory-result` | Enumerate a fixed snapshot of event CIDs, in pages |
| `want` | Request missing events or ranges of a needed raw object |
| `events` | Push or answer with an exact batch of complete events |
| `objects` | Deliver one requested range of a raw object |
| `stored` | Confirm that an entire event batch has been durably applied |
| `unavailable` | Explicitly report requested data that this peer cannot supply |

All bodies and attachments are inside the encrypted sync envelope. For this
profile the body schemas are closed; unrecognized fields or message types are
an explicit unsupported/invalid response, not an alternate interpretation.
Examples below show plaintext before DIDComm encryption. Strings containing
`...` are explanatory placeholders, not valid DID/CID test vectors.

### 3.1 `hello` / `hello-result`

`hello` carries:

```json
{
  "vault_anchor": "did:key:z...anchor",
  "grant": "<compact replica-grant JWS>",
  "vault_version": 4,
  "limits": {
    "max_events_per_batch": 128,
    "max_inventory_page": 256,
    "max_plaintext_bytes": 262144,
    "max_object_chunk_bytes": 131072
  }
}
```

`hello-result` has the same fields with the responder's own grant and limits.
The vault version must match the receiving profile. Each positive integer limit
is a receiver's bound; a sender uses the smaller local/peer bound and accounts
for encoded attachment and DIDComm/routing overhead when fitting the mediator's
wire limit. A failed size check changes no synchronization progress.

Crossed `hello` messages are independent exchanges. A receiver MUST answer each
valid `hello` with `hello-result`, including while its own `hello` to that peer
is pending. Only a verified `hello-result` whose `thid` matches the local pending
request completes that request; the incoming `hello` does not stand in for it.
Process inbound requests and replies without waiting for the local exchange
to complete. Use the limits in the most recently received valid `hello` or
matching `hello-result` from that peer; unsolicited or obsolete results do not
replace negotiated state.

Persist the pending request ID and expected peer binding before sending
`hello`. Durably record a verified peer's grant, document, version and limits
before sending its `hello-result`, or before treating a matching result as
completing the local exchange. Recover those records after a normal restart;
pending exchanges remain retryable and completed exchanges remain usable.

The example values are illustrative. Before adoption, the owning event profile
must define a canonical event byte ceiling and the corresponding plaintext and
mediator wire floors in the [adoption work](README.md#adoption-work). A peer or
transport whose bounds cannot carry a maximum-sized event plus the complete
single-event batch and transport overhead fails negotiation explicitly; it
cannot claim support and leave otherwise valid events permanently unsendable.

The limits govern each message/page; implementations also enforce bounded
staging and concurrency as specified below. Reopening a connection reuses the
durable verified peer state; a new `hello` is not required solely because a
connection or runtime restarted. A fresh incarnation establishes its own
exchange instead of inheriting another incarnation's negotiation.

<a id="full-inventory"></a>

### 3.2 `inventory` / `inventory-result`

A new request has `vault_anchor`, `inventory_id: null`, `cursor: null` and a
positive `limit`. The responder captures its accepted event CID set at one
local cut. It assigns a fresh opaque `inventory_id`, sorts CIDs by canonical
CID text and returns a page:

```json
{
  "vault_anchor": "did:key:z...anchor",
  "inventory_id": "019b2b00-0000-7000-8000-000000000001",
  "event_cids": ["bafk...event"],
  "next_cursor": null
}
```

A continuation request carries that inventory ID and the previous
`next_cursor`. The responder binds the session to the authenticated requester,
vault and frozen cut. Pages contain every CID from that cut exactly once; a
concurrent append cannot move an entry between pages or get silently skipped.
The last page has `next_cursor: null`; an empty inventory is one empty final
page. Ordering has no domain meaning.

The receiver durably records both each page's entries and the next cursor
before acknowledging its delivery. Repeated pages are idempotent. A missing or
expired snapshot returns `inventory-expired`, including after a source restart
that lost session state. The receiver starts a fresh inventory and retains any
already verified events; it never treats an interrupted listing as complete.

An inventory includes all accepted main-store event CIDs, including events
whose objects were released. It is not filtered by event timestamp, current
author or a UI view. Absence of a local event in the peer's inventory does not
delete it. Object availability is discovered after evaluating the event union.

The event store's local `ChangeToken` stays local. A peer inventory token is
not that token, not portable history and not a global sequence. Changes after
the captured cut are sent by incremental publication or a subsequent inventory.

### 3.3 `want`

The body has `vault_anchor`, `event_cids` and `objects`, with at least one entry
and no duplicates. Each object request is `{ "cid": <raw CID>, "offset": <n>,
"max_bytes": <n> }`. Offsets are nonnegative safe integers; byte limits are
positive and bounded by negotiation. The total number of event and object
entries is at most the negotiated `max_events_per_batch`; object requests also
obey the negotiated chunk size. A zero-length object is requested at
offset zero and may be answered with an empty attachment.

Event requests are answered by one or more `events` messages; object requests
by `objects` messages. Unknown or unavailable items get an explicit
`unavailable` response. Each response is correlated to the request. Requests
are bounded by the negotiated event/page and chunk limits; sending a large
list is not permission to allocate unbounded memory or response work.

Requests and replies both travel through private replica mailboxes. A replica
MUST continue handling peer requests while awaiting its own replies or batch
receipts; waiting for mutual completion would deadlock two offline-capable peers.

### 3.4 `events`

An event batch may be unsolicited incremental publication or a `want` response:

```json
{
  "vault_anchor": "did:key:z...anchor",
  "batch_id": "019b2b00-0000-7000-8000-000000000002",
  "events": [
    {
      "cid": "bafk...event",
      "at": "2026-10-01T00:00:00.000Z",
      "author": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
      "type": "replica.label",
      "roots": [],
      "data": {
        "replicaId": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
        "name": "Phone"
      }
    }
  ]
}
```

`batch_id` is a fresh UUIDv7 for this sender's immutable nonempty event batch.
Events are unique and sorted by CID for a stable batch representation. Each
complete event is validated using the event store's canonical-envelope and CID
rules. The receiver never substitutes its own author/time or hashes just `data`.
The CID still names the five-field canonical envelope, excluding `cid` itself.

A receiver keys batch progress by `(sender replica DID, batch_id)`. Reusing it
with different canonical event contents is an error, even if both event sets
would separately be valid. Repeating the same contents resumes staging or
repeats the existing `stored` receipt. Batch identity is independent of the
DIDComm wire message ID, so expiry/repackaging need not create a new logical
batch. Retries of one already-packed wire message keep its exact bytes and
routing ID; repackaging uses a fresh wire ID.

Receipt of this message stages data for the [application algorithm](#applying-remote-objects).
A batch is a transfer/receipt identity, not a required database transaction
size. Its events may be combined with other batches or split across bounded
atomic imports, each with its required objects; staging alone is never visible
accepted history.

### 3.5 `objects`

The body has `vault_anchor`, `cid`, `total_bytes`, `offset` and `attachment_id`.
The message carries exactly one DIDComm attachment with that ID and
`data.base64` containing the requested byte range, encoded as unpadded
base64url. This first profile uses inline encrypted chunks, not public links
or a separate blob-storage protocol.

`cid` is the canonical raw DASL CID of the entire object. Sizes/offsets are
safe integers, within negotiated/local bounds; the range lies within the total
and answers an outstanding request from this authenticated source. A chunk is
nonempty except for the canonical empty-object transfer at offset/total zero.
Transport chunks have no portable IDs and are not independent DASL objects.

The receiver durably stages ranges under the peer, CID and total length.
Repeated or overlapping bytes must agree exactly. A conflicting total or
range fails that source transfer; it is not silently overwritten. Out-of-order
ranges are allowed. Only complete coverage followed by verification of the
whole raw CID produces an accepted object. A partial or hash-failing object
is never published to the vault.

After interruption, missing ranges can be requested again. An object may be
retried with another authorized source, with each source's staging isolated;
whole-object CID verification still decides acceptance. A receiver does not
accept unsolicited object storage just because a peer knows its DID.

### 3.6 `stored`

The body has `vault_anchor` and `batch_id`. Authentication identifies the peer
that stored the batch; `thid` names the answered `events` message as a correlation
hint. The sender MUST match progress by `(authenticated peer DID, batch_id)`
within this vault. An unknown or old `thid`, including after repackaging, is
not grounds to reject an otherwise valid receipt for that known immutable
batch and intended peer. An unknown batch or wrong peer never advances progress.
This receipt means every event in that exact batch is durably in the receiver's
accepted event set, and the required held objects were present at each event's
atomic import boundary. All batch CIDs must be accepted before issuing it,
even when several imports were needed. Objects released by validated retention
rules need not be present. Partial success MUST NOT produce `stored`.

The sender accepts the receipt only for a known immutable batch and that
intended peer. It durably records progress before pickup-ACKing the receipt.
`stored` itself is not acknowledged by another sync receipt; ordinary pickup
ACK plus retrying the original batch recovers a lost response without an
ACK-of-ACK loop.

This is evidence of that peer's state at a past boundary, not a promise that
it will keep every object forever, execute the events, or retain a backup after
its own storage loss. A later reconciliation may establish missing data again.

### 3.7 `unavailable`

The body has `vault_anchor`, `events` and `objects`. An event entry is
`{ "cid": <event CID>, "reason": <reason> }`; an object entry additionally
has `offset` equal to the unanswered requested range's start. Reasons are
`unknown`, `not-held`, `missing-bytes`, `damaged` and `limit`.
The arrays partition only the unsupplied requested items; successfully
supplied items are handled by their ordinary responses. An implementation
keeps unresolved request progress until every item is answered, retried or
explicitly abandoned locally.

`not-held` reports the source's retention decision; it is not an erasure event
or proof that the receiver may delete its own data. No unavailable response
advances a batch to `stored` or silently skips an inventory entry. The client
can obtain additional history or try another peer/backup.

<a id="client-synchronization-algorithm"></a>
<a id="publishing-local-objects"></a>

## 4. Incremental publication and reconciliation

Every durable event commit can wake a sync worker. The worker reads accepted
local additions using `changes()` and retains durable per-peer batch/retry
progress. The wake-up signal is advisory: after restart, rescan from durable
progress or perform inventory reconciliation. A commit followed by a crash
before notification must not strand an event.

Persist the immutable batch and its progress before sending it. A local change
cursor may advance only after the corresponding work is durably discoverable
for retry; it is not proof of peer storage. Only the intended peer's `stored`
receipt completes that batch's replication attempt. A mediator 2xx and a
pickup ACK are separate boundaries.

Events learned by ingest may be relayed to another peer, including historical
events authored by other incarnations. Track which CIDs a peer has
advertised/acknowledged to avoid echoing everything indefinitely.
Transport/control messages, inventory
pages and progress updates MUST NOT be appended as ordinary `message.in`,
`message.out`, admission or delivery events. A duplicate CID causes no new
portable event merely to record its arrival.

Reconcile newly learned membership as part of worker discovery. Creating a
batch for a new peer first verifies its grant and rejects conflicting local
bindings. A mediator's `identity-conflict` response suspends only operational
sends to the affected incarnation and exposes a diagnostic. It does not change
portable membership. Recover the binding evidence from verified local history,
an authorized peer or backup. Operational suspension does not erase pending
CIDs or count them as stored. If later authenticated reconciliation shows a
matching grant and there is no local identity conflict, sending may resume.

At startup, reconnection, a new peer, lost progress or uncertain remote state,
run a full inventory comparison. While active, repeat reconciliation at a
bounded implementation-defined interval; otherwise a silently expired queue
item could remain missing forever. Each direction compares independently:
A listing B does not tell B everything A holds. Retry uses bounded backoff,
quota-aware batching and fresh wire envelopes when a previous one has expired.

An acknowledged batch may be discarded from the retry queue, since its events
remain in the local event store and inventory can rediscover a later need.
A peer's restored/empty store invalidates assumptions of permanent completion;
the sender serves requested known events even if an older receipt says that
peer once held them. No local timestamp is a safe lower bound for missing
historical events.

<a id="applying-remote-objects"></a>

## 5. Applying remote data

Network handling first verifies authorization and shape, then durably stages
valid event batches outside the visible vault. Staging is operational state,
not accepted event history. It may be reconstructed by retransmission; a
retained uncompleted batch must remain discoverable across a normal restart.

For a full reconciliation or initial catch-up:

1. Obtain the complete fixed event inventory and stage every missing event
   from it. Several batches may be in flight; servicing requests and staging
   later batches MUST NOT wait for earlier batches' `stored` receipts.
2. Plan against current accepted events and the complete learned cut. Follow
   the vault's domain validation, retained-root and erasure-closure rules;
   preserve existing references and historical admissions.
3. Choose a bounded subset of staged events for the next atomic import. It
   may cross batch boundaries or contain only part of a batch. When learned
   erasure/release facts change its retention requirements, import the required
   evidence first or include it in that subset. Do not omit known release
   evidence merely to fetch or publish obsolete bytes.
4. Let `targetBeforeImport` be the current accepted event set and `union` be
   that set plus the chosen subset. Compute the import byte requirement:

   ```text
   requiredRoots =
       roots retained by newly accepted subset events in union
       ∪ (heldRoots(union) − heldRoots(targetBeforeImport))
   ```

   Every required root needs verified staged bytes or sound accepted target
   bytes. Fetch missing/damaged required objects and any available repairs for
   other union-held objects. Assemble and verify them outside the database
   transaction; network I/O MUST NOT hold the writer lock or a write transaction.
5. Under the writer lock, re-plan the chosen subset against current accepted
   events, all learned release evidence, membership bindings/conflicts and
   object health. Recompute both held-root folds and `requiredRoots`. If prerequisites changed,
   release the lock and obtain missing data or discard newly released staging.
6. Atomically publish that subset and its required object additions or repairs
   using the vault's import boundary. Apply the existing sound-target reuse
   rules; a failed check publishes none of this chosen import. Previously
   completed independent imports remain accepted.
7. Reconcile/invalidate folds and views, and emit `stored` only for batches whose
   entire event set has now passed these imports. Repeat with other subsets;
   the inventory cut is complete only when all its events have been accepted
   and its required object work has completed. Missing work remains explicitly
   incomplete. Imported history does not mint a live input, send a pending
   message or regenerate an old reply.

The receiver chooses subset bounds from its local import resource budget,
including event and required-object work. These bounds are independent of
`max_events_per_batch`, which limits wire messages, not database transactions.

During this full reconciliation, learn the event cut before scheduling its
object downloads or replaying old local object-transfer work. This lets the
known erasure facts participate in the plan. New commits after that cut remain
eligible for a later pass; this is not a global snapshot or completeness proof.

Missing event references alone do not block event-set union. Their affected
projections and effects remain incomplete until the exact evidence arrives;
no placeholder or rewritten reference is created. Missing required bytes block
only candidate subsets whose prospective union requires them, including roots
newly held by existing target events. Other independently valid subsets MUST
remain eligible for import. A partly applied batch remains visibly incomplete
in durable progress, retaining its unapplied events in staging and receiving
no `stored` receipt until complete.

Incremental publication uses the same subset and byte checks without obtaining
an entire new inventory. Combine events where domain or release evidence is
needed, and request/reconcile missing history. An independently applicable
erasure subset is not blocked merely because another is awaiting
content. Invalid data is surfaced explicitly without holding unrelated work
indefinitely or silently marking the inventory complete.

The current [portable import boundary](../event-store.md#import-into-an-existing-vault)
and [object merge rules](../vault-events.md#object-merge) require complete atomic
publication of each import. This protocol proposes several such operations,
not visible sub-transactions of one import: accepted subsets are valid partial
history with their required objects, while network staging remains invisible.
The [adoption work](README.md#adoption-work) must define this staged-input
integration without weakening complete portable SQLite source validation.
Raw `EventStore.ingest` alone is not the application integration.

Repairing an object already held by accepted local events may publish verified
bytes with no new events, using the same lock/retention/publication checks.
Its local request completes on durable repair; it needs no invented event or
`stored` batch receipt. If a pending event batch depends on that repair, the
batch is acknowledged only after its full application checks also pass.

An unseen incoming event under the target's own author is `ForkedAuthor`, not
a reason to change that event's author or accept it partially. Preserve pending
material and surface recovery through a fresh local incarnation and enrollment
before retrying. Existing historical events and peer identities remain distinct.

<a id="durability-and-acknowledgments"></a>

## 6. Durability and acknowledgments

| Boundary | What it establishes |
| --- | --- |
| Sender's local commit | Local durable event/object state |
| Mediator accepts the encrypted forward | Bounded queued transport, not destination import |
| Destination pickup ACK | That delivery need not remain in the queue |
| Destination `stored` | Every event in that exact batch passed an atomic import with its required objects |
| Domain peer ACK | Application-protocol receipt, independent of synchronization |

A receiver may pickup-ACK a valid sync message after either durable application
or durable staging of the complete message and the work needed to continue it.
It MUST NOT send `stored` while the batch is only staged. For an object chunk,
ACK requires durable range staging; for an inventory page, durable page/progress;
for a `stored` receipt, durable sender-side progress. If local capacity or a
write failure prevents persistence, leave the delivery unacknowledged.

Malformed or unauthorized traffic may be terminally rejected and pickup-ACKed
without imported events, with a bounded local diagnostic. Temporary missing
peer/history/key prerequisites are deferred, not misclassified as permanent
rejection. Valid but incompatible data produces an explicit failure response;
it is never represented as successful storage.

A crash after import but before sending `stored` is recovered by reexamining
the accepted CIDs/required objects when the batch is retried. A crash after
staging and pickup ACK resumes local work; if operational state was deliberately
reset, source retries and inventory comparisons recover it. Neither side
requires a distributed transaction with the mediator.

Sync progress belongs to durable local operational storage with an explicit
rebuild path. It is not a disposable cache whose loss may silently advance a
cursor. Clearing it forces reconciliation instead of assuming peers are current.
Resetting batch or inventory progress preserves the durable peer authorization
and negotiation records. Portable restore instead creates a fresh incarnation
and performs enrollment with new peer exchanges.

<a id="retention-and-erasure"></a>

## 7. Retention and erasure

Send all immutable events, including erasure and closure events. Send raw object
bytes only when the current source fold still holds that object. Recheck this
before every object response/retry; cancel queued local chunks containing
newly released data. Ciphertext already accepted by the mediator may remain
until its normal ACK/expiry; this protocol does not promise instant deletion
from remote queues or previously authorized peers.

The receiver computes held roots from the prospective union, not from the
source's claim that a CID is needed. It repeats the check under the writer lock
before object publication and collection. Incoming obsolete objects do not
revive erased message content. An object retained by another valid relation
may still be required; erasure of one relation is not global CID deletion.

Unheld partial transfers are discarded. A held object whose bytes no peer can
supply remains visibly unavailable; neither a successful inventory nor a
`not-held` response turns missing content into an intentional erasure.
Raw CIDs, event roots and metadata are inside end-to-end encrypted messages;
they are not mediator storage keys.

<a id="bootstrap-and-recovery"></a>

## 8. Bootstrap and recovery

The first replica of a new arrangement records a fresh replica-mediation account
intent and replica grant in its existing vault, then uses the account DID to
register directly with the mediator. That transaction creates the account and
its first replica without Coordinate Mediation. It needs no peer to initialize
the account; synchronization starts when another authorized replica joins.

Enrollment of another device starts from an authorized portable encrypted
SQLite backup/restore containing the seed, vault anchor, selected
replica-mediation arrangement and an initial event cut. A backup containing only
ordinary mediation must first obtain the new arrangement's verified account
intent through authorized bootstrap, or explicitly create a new arrangement;
it cannot convert or reuse the ordinary account as replica authority.
The destination retains its own seed wrapper/passphrase according to the
restore procedure and obtains a fresh
replica ID, replica DID and store generation. Ordinary sync never transmits
another replica's wrapper or runtime control rows.

Enrollment proceeds as follows:

1. Verify the restored anchor against the unlocked seed and select the known
   replica-mediation arrangement. Build the new replica document and
   account-signed grant; durably record the proposed membership.
2. Send `register` from the account DID, naming the new replica in its grant.
   Verify the response's account, mediation, replica and routing bindings.
   The replica DID then picks up its private inbox and shared-mail deliveries;
   only shared packages first accepted after registration are eligible for that
   replica. The new device can queue/stage this mail while catching up, but
   receiving it does not replace the required history synchronization.
3. Discover peers through the mediator list and known portable membership.
   Exclude conflicting identities, verify each remaining grant locally, and
   establish `hello` with usable peers.
4. Reconcile complete event inventories and required objects, including
   membership and erasure facts learned since the backup. Reconcile registrations
   accordingly. CIDs already restored are ordinary duplicates.
5. Continue incremental sync and drain shared mail queued since registration
   once its required history and domain prerequisites are available. Keep
   historical catch-up/import separate from live application execution. The
   domain revision defines when the new runtime may enable automatic effects.

Recipient reconciliation re-sends one account-authenticated `recipient-add`
per locally validated binding without querying the mediator. The same
recipient-signed proof can be reused across requests; an existing binding
returns `no_change`. Recipient identities unknown locally must come from vault
history or backup. Learning DID retirement or route withdrawal does not remove
an address from the mediator; it changes domain eligibility independently.
Imported old ordinary-mediation history retains its original routes and does
not claim those addresses or queued messages for this account.

Registering before peer inventory allows mail arriving during catch-up to
remain queued. Mail accepted before registration is never backfilled by the
mediator, even if its ciphertext has not expired. Earlier history must come
from a peer or backup that holds it. Fixed inventory cuts plus subsequent
incremental/full passes cover available events created during enrollment.
No step requires all replicas to be online simultaneously, but progress requires
an authorized data source to become available within a sequence of successful
transfers. Queued new mail is not evidence that history catch-up is complete.

A seed and an empty mediator cannot reconstruct deleted history. If every
history-holding replica and backup is lost, this protocol provides no recovery
archive. A new device with no responding peer reports pending synchronization;
it does not infer an empty, complete vault.

<a id="quota-and-availability"></a>

## 9. Limits, failure and privacy

Implementations bound active inventory sessions, page size, event batches,
object/chunk sizes, pending requests, retry queues and total staging bytes.
When a limit prevents safe progress, report the blocking item/state and keep
it unsatisfied. Do not skip it, advance past it, truncate the transfer or split
one logical raw object into independently stored chunk objects.

Sync problem reports use prefix `e.estoc.vault-sync.` with suffixes
`invalid-message`, `unauthorized-peer`, `wrong-vault`, `unsupported-version`,
`inventory-expired`, `batch-conflict`, `invalid-event`, `invalid-object`,
`incomplete-history`, `quota` and `message-too-large`. Problem reports reference
the original request; any involved batch remains pending/failed, never stored.
Responses disclose no vault data to an unauthenticated or unauthorized sender.
`unauthorized-peer` reports a failed binding/authorization check or known local
identity conflict, not a lost connection or normal restart. Recovered peer
state remains subject to the checks in §2.

The authenticated sync worker is scheduled independently of user-message
outbounds and application effects. Its protocol retries do not authorize
retries of an ordinary application message. Long-offline peers, expired
mailboxes, mediator outages and identity conflicts are surfaced independently
of whether a user's local commit succeeded.

The shared mediator can correlate registered replicas, endpoints, sizes and
timing. End-to-end encryption protects contents; this profile does not promise
traffic anonymity. Sender protection is an independent feature. No bespoke
cryptography, deterministic JWE randomness or server decryption is needed for
replication; exact event identity is preserved inside ordinary randomized
authcrypted envelopes.

<a id="required-conformance-cases"></a>

## 10. Required conformance scenarios

These are proposed requirements; application-effect convergence requires the
separate domain revision as well as transport tests.

1. Peers with the same anchor and verified grants exchange data. A forged
   discovery entry, wrong seed/account/anchor, mismatched sender or conflicting
   identity cannot obtain plaintext vault data.
2. Reordered and repeated identical events preserve exact CIDs/authors and
   add no extra portable events. Reusing a batch ID for different contents fails.
3. A local commit followed by a crash before worker notification is eventually
   discovered and sent; a mediator acceptance without `stored` does not complete it.
4. Drop a sync envelope or `stored` receipt, expire it in a mailbox, restart
   either peer and reset local progress: retry/reconciliation still finds the
   missing data without producing an ACK-of-ACK or portable sync-event loop.
5. Append during a paged inventory; the frozen cut has no gaps/duplicates and
   later work discovers the new CID. Lose/expire the inventory session and retry
   from a fresh cut without deleting local-only events.
6. Two peers request each other's history simultaneously; both continue serving
   requests before their own outbound batches are acknowledged.
7. Deliver an object in reordered/repeated chunks, interrupt and resume it,
   supply conflicting overlapping bytes and a bad final digest. Only a complete
   verified object can become visible in the vault.
8. Deliver dependent event batches before their objects and prerequisite events.
   Stage and combine them, then atomically publish events plus required objects;
   a publication failure exposes none of that import and sends no `stored`.
9. Import succeeds and the response is lost; retry sends the receipt without
   rewriting events or dispatching historical messages/effects.
10. A stale peer offers content erased by the learned union. Full reconciliation
    learns the event cut first, and current retention prevents publishing the
    released relation's bytes; independently retained objects remain available.
11. A source no longer holds requested bytes; explicit unavailability leaves
    progress incomplete and permits another peer or backup to repair it.
12. Restore a new device while other replicas append and external mail arrives.
    Its author is fresh; only packages first accepted after its registration
    create shared deliveries for it. New mail can remain queued while vault
    sync obtains available earlier history. That queue does not replace catch-up
    or authorize effects; the current profile never silently enables multiple
    executors.
13. A maximum legal event fits a single-event batch at the negotiated plaintext
    and mediator wire floors. Smaller limits fail negotiation. Oversized legacy
    events need the adoption policy; no event is truncated or given a new CID.
    Object/queue/staging limits keep blocked work visibly unsatisfied without
    falsely acknowledging it as stored.
14. Repair missing bytes for an already accepted held root without any new event;
    only the verified repair becomes visible, and no synthetic sync event is made.
15. An unseen current-author event refuses the import with no partial publication;
    recovery creates a new incarnation instead of rewriting incoming authors.
16. No source/target cursor, wrapper, local option, trace, device key or operational
    receipt is imported as another replica's runtime state.
17. One batch contains independent events and an event requiring unavailable
    bytes. Import the independent subset; retain the rest as incomplete without
    `stored`. Unimported event references defer projections, not event union.
    Apply learned release evidence before or with affected subsets, and check
    roots newly held by existing target events at each atomic boundary.
18. Cross `hello` requests while both peers wait for their own result. Each sends
    the other's correlated `hello-result`; neither treats `hello` as that result
    nor blocks inbound handling on its own exchange.
19. Repackage an immutable batch under a fresh wire ID and discard the old ID.
    A delayed valid `stored` still advances only the matching peer/batch progress;
    the same batch ID from another peer or an unknown batch advances nothing.
20. A mediator identity-conflict response suspends operational sends without
    changing portable membership or completing a batch. Missing discovery rows
    and offline peers do not remove verified membership; authenticated binding
    reconciliation can resume suspended work once the conflict is resolved.
21. Restart a receiver after a completed `hello` exchange, then deliver an
    existing batch without another `hello`. It recovers the verified binding
    and limits and completes the batch without human intervention. Resetting
    batch/inventory progress preserves that peer state; a newly learned local
    identity conflict still prevents traffic under that binding. A crash during
    `hello` leaves either a retryable pending exchange or durable verified state, never a
    successful reply whose peer state existed only in memory.
22. Initialize an account without Coordinate Mediation, then restore and enroll
    a second replica using that verified account intent. Account registration
    and replica pickup use their respective DIDs. Ordinary account evidence
    cannot substitute for the replica-mediation intent or transfer old mail.
    Synchronizing retired communication DIDs preserves their recipient bindings
    without authorizing new application work through those DIDs.
