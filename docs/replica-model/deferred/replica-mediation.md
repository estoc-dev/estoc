# replica-mediation/1.0

> Proposed multi-replica contract; not implemented and not part of the
> [phase-1 contract](../README.md). The current runtime remains single-writer.
> The [adoption work](README.md#adoption-work) must be completed before enabling
> this profile. Candidate events and key names below are not phase-1 API.

[Suite guide](../README.md) · [Identity model](#identity-model) ·
[Protocol boundary](#protocol-boundary) · [Conformance](#required-conformance-cases)

This document defines standalone mediation accounts, vault-authorized replica
membership, append-only communication recipients, fan-out of external mail and
independently acknowledged pickup. Each replica has its own DID. Ordinary
Message Pickup 3.0 authenticates that DID; a caller cannot select another
replica's queue by supplying a replica ID in a body.
[Vault sync](vault-sync.md) exchanges events and objects between those replicas
using ordinary encrypted messages through the same mediator.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT** and
**MAY** are interpreted as in BCP 14 when written in capitals.

<a id="reading-guide"></a>

## Reading guide

| Task | Sections |
| --- | --- |
| Identify a vault, address or writer | [Identity model](#identity-model), [authorization](#replica-authorization) |
| Add or retire a device | [Portable membership](#portable-replica-events), [registration](#replica-lifecycle) |
| Implement the mediator | [Recipient registration](#shared-recipients), [routing](#routing-and-mailbox-storage-extension), [pickup](#message-pickup-3-0-replica-profile) |
| Implement synchronization | [Protocol boundary](#protocol-boundary), [vault-sync](vault-sync.md) |
| Enable multiple active application runtimes | [Adoption work](README.md#adoption-work); transport membership does not choose an executor |

<a id="what-it-is-for"></a>
<a id="protocol-boundary"></a>

## 1. Purpose and protocol boundary

An external sender addresses one of the vault's communication DIDs. The
mediator retains the encrypted application envelope once and creates a delivery
for every replica that is active at first package acceptance, subject to the
account's storage limits. That delivery set does not expand later. A new
replica obtains earlier history through vault synchronization or backup. The
sender does not need a device list or this extension. Every receiving replica decrypts the
original envelope with the vault's communication keys and performs its own
receive procedure once the required history and domain prerequisites are met.

A replica sends synchronization traffic to a particular replica DID. That
message gets exactly one destination queue. It MUST NOT be fanned out to the
vault, passed through the ordinary application receive/effect pipeline, or
turned into another portable sent/received-message record.

| Responsibility | Owner |
| --- | --- |
| Create the mediation account; register, list and retire replica delivery targets | This protocol |
| Add permanent shared communication-address bindings | This protocol's recipient control |
| Fan-out, per-replica pickup, retention and delivery ACK | This protocol and Message Pickup |
| Exchange exact events, objects, inventories and durable sync receipts | [Vault sync](vault-sync.md) |
| Decide application admission, automatic replies, rotation and dispatch | The vault/domain and runtime specifications; pending multi-replica revision |
| Bootstrap the seed and initial history | Portable encrypted SQLite recovery; [sync bootstrap](vault-sync.md#bootstrap-and-recovery) |

```text
external peer -> shared communication DID -> mediator -> A's delivery
                                                   -> B's delivery

replica A -> encrypted sync for replica B's DID -> mediator -> B's delivery
```

Receiving raw mail and importing an existing receipt are different operations.
Neither fan-out nor event union grants a new live action for historical work.
This protocol does not select a leader, promise exactly-once effects, or permit
outbox takeover. Multiple active automatic executors remain subject to the
[adoption work](README.md#adoption-work).

<a id="dependencies"></a>

## 2. Dependencies and initial deployment profile

The transport uses [DIDComm Messaging 2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/),
Routing 2.0, [Message Pickup 3.0](https://didcomm.org/messagepickup/3.0/) and
Problem Report 2.0. Account creation and recipient management belong to this
protocol; no Coordinate Mediation request or pre-existing mediation grant is
required.
Control message types use `https://estoc.dev/replica-mediation/1.0/`.
Each request has a DIDComm `id`, authenticated `from`, and one `to` naming the
mediator. Replies are authcrypted from that mediator to the requesting DID and
use the request ID as `thid`. Body schemas in this profile are closed. Peer DID
comparisons use the verified canonical short form, including an authenticated
sender or key identifier originally carried in long form.

| Request / response suffix | Authenticated requester | Operation |
| --- | --- | --- |
| `register` / `registered` | Account DID | Create the account if absent and enroll one replica |
| `list` / `replicas` | Account DID | List a fixed membership snapshot |
| `retire` / `retired` | Account DID | Record terminal replica retirement |
| `recipient-add` / `recipient-added` | Account DID | Add one communication recipient idempotently |

The account DID manages the account; replica DIDs authenticate pickup and
peer synchronization. Account controls do not give the account a pickup queue.
Control replies return through the originating request/response transport
exchange, not through queued mail to the account DID. If that exchange is lost,
the client retries the idempotent mutation or reissues the read request.

The initial profile uses one selected mediation arrangement for replica
membership and sync delivery. Existing historical communication routes may
still need draining under the vault's route rules. Membership across several
mediators and a live transfer between membership authorities are later work;
a client MUST NOT treat registration at one mediator as registration at another.

The mediator advertises this protocol using Discover Features. Successful
registration, rather than discovery alone, establishes support. A new
arrangement uses a fresh account DID and mediation ID, separate from every
ordinary Coordinate Mediation account. Its delivery model is per-replica from
creation; there is no account-mode switch or legacy recipient/mail import.
The mediator MUST reject creation under an ordinary account DID and reject
ordinary Coordinate Mediation controls or account-scoped pickup against a
replica-mediation account. This separation is enforced in account state and
authorization, not just by distinct message type names.

Old accounts, recipient bindings, queued packages and ACK domains remain
independent. A communication DID already bound to an old account cannot be
claimed by the new account. Existing addresses continue using their old paths;
new addresses use the new arrangement. Moving old addresses or queues is a
separate migration protocol, outside this profile.

<a id="terms-and-trust-model"></a>
<a id="identity-model"></a>

## 3. Identities and trust

| Identity | Meaning | Lifetime and visibility |
| --- | --- | --- |
| Vault anchor | `vault_meta.anchor`, derived from the shared seed | Same for every copy; carried inside encrypted sync, not required in mediator control messages |
| Communication DID | An external peer's rendezvous or pairwise address for the vault | Shared across replicas, subject to the existing channel and rotation rules |
| Replica ID | The UUIDv7 in `store_state.replica_id` | One independently writable incarnation; equals the author of its newly committed events |
| Replica DID | The incarnation's DIDComm address and pickup principal | One immutable `did:peer:4` document bound to that replica ID; used for internal synchronization |
| Mediation account DID | The vault-controlled identity of the selected replica-mediation arrangement | Creates the standalone account and authorizes recipient registration and replica membership |
| Store generation | The local event store's cursor generation | Local only; neither a DID nor membership authority |

A vault anchor is not a public contact address. A communication DID is not a
writer ID. An event author is a replica ID, never a replica DID. Synchronizing
an event preserves its original author, timestamp, CID and references, even
when another replica relays it.

A replica DID MUST NOT replace the external message's `to`, channel endpoint,
or source-evidence identity. The original application ciphertext remains
addressed to the shared communication DID; the outer pickup response is
addressed to the replica DID. A full replica has keys for both layers.

### 3.1 Replica key and document

This candidate profile adds the asymmetric key name:

```text
replica/<replicaId>/me
```

It uses the existing keystore-v3 named-key derivation, including its independent
Ed25519 authentication and X25519 key-agreement material. It adds no KDF,
shared sync-account key or custom encryption algorithm. Implementations MUST
use maintained DID, JOSE and DIDComm libraries for document construction,
signature verification and encryption.

The replica document uses the same immutable `did:peer:4` construction as a
mediation identity, with those public keys and one DIDComm service whose URI
is the selected mediator DID. Its verified short form is `replicaDid`; the
long form is retained for offline resolution. Clients MUST verify both the
short/long-form binding and the seed-derived keys before treating the document
as their own replica identity. Re-creating the document with different bytes
under the same replica ID is a conflicting identity, not an update.

A new independently writable copy MUST obtain a fresh replica ID, replica DID
and store generation before connecting or writing. An exact move may keep
them only when the old writer is permanently stopped. A document/key/route
change requires explicit enrollment of a new incarnation; historical event
authors and former replica documents remain unchanged.

### 3.2 Full-replica trust

All full replicas hold the same seed and can derive the vault's communication,
mediation and replica keys. Distinct replica DIDs separate delivery and
ordinary client behavior; they are not isolation from another seed holder.
Retirement stops delivery membership. It does not revoke a copied seed or
remove the ability of its holder to create a new identity.

<a id="replica-authorization"></a>

## 4. Vault authorization

A mediator list is discovery information, not sufficient authority for a
client to send vault data to a listed DID. Each member carries a portable
grant signed by the selected replica-mediation account. This candidate profile
adds `profile: "replica-mediation/1.0"` to that arrangement's `mediation.created`
data. Commit this intent before the first network request, using a fresh
`mediationId` and the existing `mediation/<mediationId>/me` named-key derivation
to create a fresh account DID. An existing ordinary arrangement is never
retagged. Records without this profile identify ordinary mediation and cannot
authorize replica membership.

That independently verified intent and seed-derived account key bind the
account to the vault; they do not assert that the mediator has accepted it.
Sync clients MUST NOT accept an unknown account supplied by a mediator. The
owning event schemas must adopt the profile field and registration-observation
rules before implementation; this draft does not extend phase-1 schemas.

A grant is compact JWS with these protected headers:

- `alg`: `EdDSA`, using Ed25519 under RFC 8037;
- `typ`: `estoc/replica-grant+jws`;
- `kid`: an authentication key of the known mediation account document.

Its payload is RFC 8785 canonical JSON with exactly these fields:

```json
{
  "account": "did:peer:4...account",
  "mediation_id": "019b2a51-118f-7e46-b31b-c63cd090c92c",
  "mediator": "did:web:mediator.example",
  "replica_id": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
  "replica_did": "did:peer:4...replica",
  "replica_long_form": "did:peer:4...replica:...input-document"
}
```

DID strings containing `...` in examples are explanatory placeholders.

The grant authorizes this exact incarnation to join this exact account and
mediator, use its private inbox and receive shared mail. It is a lifetime
identity binding, not an expiring bearer token. Account authentication
authorizes enrollment; using the inbox or syncing as the replica requires its
own key. Retirement is terminal. There is no `iat` or expiry-dependent renewal
that could resurrect a retired ID.

Before registering a replica the mediator MUST verify:

1. The authenticated requester is the grant's account DID. An existing account
   belongs to this protocol and has the same mediation ID; an absent account
   is eligible for creation under the mediator's account-creation policy.
2. The JWS uses the permitted algorithm, type and key from that account's
   authenticated document, with no key fetched from a supplied `jku`/`x5u`.
3. Every field has the specified form; `replica_id` and `mediation_id` are
   canonical UUIDv7s, and `mediator` equals the DID addressed by the request.
4. The replica long form resolves locally to the stated short form and its
   service names that mediator. The replica DID differs from the account,
   mediator and shared communication recipients.
5. The account and replica documents resolve with verified canonical bindings.
   The account DID is not already a recipient, replica or mediator destination.
   Account authentication and the verified grant authorize the target replica;
   `register` does not require a second request signed or sent by that replica.
6. Neither replica ID nor replica DID is retired or bound to a conflicting
   identity. One account uses one `mediation_id` for this registration domain.

Sync clients independently verify the grant against their own known
replica-mediation record and its mediator, and compare the replica document's
keys with their seed-derived replica keys. That key comparison establishes the
vault binding; the grant supplies the mediator's account authorization and is not a substitute
for deriving and checking the keys. Clients also check local retirement facts.
They do not need to trust a mediator's account-membership assertion. The same
signed binding can be carried during peer discovery even when the recipient
has not yet received its `replica.created` event.

Signature verification MUST use the library's verification API with an
explicit algorithm allowlist and the already-authorized key. Decoding a JWS
payload or comparing a DID string is not signature verification.

<a id="portable-replica-events"></a>

## 5. Portable membership and local state

These schemas are proposed additions to the vault's owning event specification;
they do not yet extend the phase-1 closed payload schemas.

### 5.1 `replica.created`

```json
{
  "type": "replica.created",
  "roots": [],
  "data": {
    "replicaId": "019b2a43-4a56-7c0f-862f-194c0c4124a0",
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "grant": "<compact JWS>"
  }
}
```

The two IDs MUST match the verified grant. The event records authorized
membership intent, not that a remote registration succeeded. Its author is the
writer that committed it; other replicas may relay it without rewriting it.
Equivalent verified bindings for one replica ID merge as one member even when
the event envelopes differ. Different DID/account/document bindings for one
replica ID are a conflict; no canonical-order winner is chosen.

### 5.2 `replica.label`

`roots` is empty; `data` is `{ "replicaId": <UUIDv7>, "name": <string> }`.
The latest label by canonical event order wins. Labels are local display
metadata synchronized inside encrypted vault data; the mediator does not need
them.

### 5.3 `replica.retired`

`roots` is empty; `data` is `{ "replicaId": <UUIDv7>, "because": <reason> }`.
Reasons are `user`, `replaced`, `lost`, `fork-recovery` and `other`.
Retirement dominates creation regardless of arrival or event order. A retirement
learned before creation is a tombstone; later creation does not reactivate it.
Existing events authored by that replica remain valid history and may be
relayed by any still-authorized replica.

A runtime learning that its current incarnation is retired MUST stop new
application work, sync publication and pickup under that incarnation, except
for the final notification phase of an already recorded local self-retirement
operation below. It MAY preserve/export unsynchronized local history. It MUST
NOT silently mint a new ID to undo retirement; rejoining is an explicit
new-enrollment operation.

For an orderly local self-retirement:

1. Quiesce application work and durably record the fixed local history cut,
   known active peers and bounded deadlines for history transfer and final
   notification. Resume the same plan and deadlines after a crash.
2. Attempt to synchronize that history with each peer using ordinary bounded
   batches and object requests. Wait for `stored` receipts or the history
   deadline; surface any unconfirmed history for preservation/export.
3. Commit the local `replica.retired` event. Its single-event batch is the last
   publication to each still-active known peer. Until the notification deadline,
   the runtime may send/retry only that batch and pick up its sync receipts.
   Receiving peers follow the terminal `stored` receipt rule in
   [sync authorization](vault-sync.md#roles-and-dependencies).
4. After those receipts or the notification deadline, request mediator removal
   using the account identity and stop all replica publication and pickup.
   Mediator failure does not extend the deadline or resume application work.

The exception applies only to the local retirement event committed in step 3;
learning a retirement from elsewhere cancels the plan and stops work immediately.
The notification exception cannot be recreated merely from a retirement event
found in restored history.
A lost or damaged incarnation is retired by another active replica, which
publishes the event under its own identity. Neither path
promises to recover history that no remaining peer or backup has received.
Retiring an ID after fork recovery retires every clone using it; both clones
need explicit enrollment with distinct fresh identities to continue writing.

### 5.4 Ownership of state

| Portable vault data | Local or mediator operational state |
| --- | --- |
| Account intent and first grant observation | Account registration retry progress |
| Replica creation/grant, label, retirement | Registration request progress, actual remote membership status |
| Communication routes, receipts, admissions and other domain events | Live connections, delivery IDs, pickup ACK progress |
| Event CIDs and currently held raw objects | Verified peer grants/limits, sync retries, peer receipts, inventory sessions, staged transfers, change tokens |

A desired portable state and a remote side effect are reconciled, not committed
in a distributed transaction. Commit account and membership intent before
registration and retirement before requesting removal. For local self-retirement,
make the removal request after the bounded notification phase. Any active full
replica may reconcile known retirements using the shared account key.
Per-replica registration responses and retries remain operational state and
MUST NOT generate an endless stream of portable registration/synchronization records.

<a id="replica-lifecycle"></a>

## 6. Registration and retirement

```text
absent -> active -> retired
             retirement is terminal for both replica ID and DID
```

This profile has explicit retirement and bounded mail retention, not an
inactivity lease. Being offline does not change the portable member identity.

### 6.1 `register` / `registered`

The client sends `register` authcrypted from the account DID to the mediator.
The body has exactly `{ "grant": <compact JWS> }`, naming one target replica.
The same request creates a new account and its first replica or enrolls another
replica in an existing account. No earlier Coordinate Mediation exchange occurs.
Registration starts eligibility for future shared packages; it creates no
deliveries for packages accepted before that registration commits.

For first contact the caller supplies the account sender's long-form DID in
the DIDComm envelope key identifier. The mediator resolves and validates it
locally to authenticate/decrypt the request, then verifies the enclosed grant
with that account's authorized key. The encrypted grant is not a prerequisite
for decrypting itself. Its replica long form identifies the enrollment target,
not the request sender. All authorization checks precede mutation and account
and destination conflicts are rechecked in the transaction.

In one transaction the mediator MUST:

1. If absent, create the standalone account bound to its account DID,
   `mediation_id` and this mediator, with an empty shared mailbox and recipient
   set. Otherwise verify that exact existing account binding.
2. Bind the new replica ID/DID/grant and provision its private destination
   with an empty delivery queue.

There is no intermediate account-only success: failure leaves neither a new
account nor a partial replica registration. Concurrent first registrations for
the same account and mediation ID share one account; different bindings fail.

An exact repeat for an active member is idempotent and preserves its original
registration boundary and all pending/acknowledged delivery state. It neither
adds deliveries for older packages nor resets ACKs. Reconnection resumes pickup
of that replica's existing queue; re-registration is not a mailbox repair step.
A retired or conflicting identity fails without mutation. Shared-recipient and
private-replica destinations cannot overlap or steal an existing destination.

The `registered` response is authcrypted to the requesting account DID, uses
`thid` equal to the request ID, and includes `account`, `mediation_id`,
`routing_did`, `replica_id`, `replica_did`, `state: "active"`, original
`registered_time`, and enforced `limits`.

In this initial profile `routing_did` is the addressed mediator DID, matching
the service used to construct replica documents before enrollment. A client
checks that value and all echoed bindings before recording success. Adoption
must permit a matching `registered` to establish `mediation.granted` for this
profile and use that routing DID for new communication routes; it does not
synthesize a Coordinate Mediation exchange. Record the account's first grant
observation once; later matching responses reuse it. Replica membership success
remains operational state, rather than another event for every registration retry.

### 6.2 `list` / `replicas`

`list` is authcrypted from the account DID and requires an existing account.
Its body has `cursor: null` for a new listing, or a previously returned opaque cursor, plus
a positive `limit` no greater than `max_membership_page`. A new listing captures
a fixed roster; subsequent cursors are bound to that snapshot and account.
`replicas` contains `entries` and `next_cursor` (null for the final page).
An active entry has `grant`, `state: "active"` and `registered_time` (UTC Epoch
Seconds). A retired entry is a compact tombstone with exactly `replica_id`,
`replica_did` and `state: "retired"`; it needs no long-form document or grant.
Repeated pages are stable; an expired snapshot returns `list-expired` and the
client starts a fresh listing. The mediator may shorten a page to fit its wire
limit, but cannot omit an entry from a successfully completed listing.

No other account's identities are disclosed. Active bindings and compact
tombstones have separate capacity budgets. Tombstones retain both canonical
IDs so neither a replayed replica ID nor a reused replica DID can reactivate
the incarnation; storing only the replica ID would lose the latter check.

Clients verify active grants before contacting listed peers and reconcile local
retirements before publishing to them. A listed tombstone suspends operational
sends to that identity but does not create a portable retirement event.
A missing row is not proof of retirement or data loss; the mediator may have
been restored from an older database.
No response is proof that a peer is online or has complete vault history.

### 6.3 `retire` / `retired`

`retire` is authcrypted from the shared mediation account. Its body is
`{ "replica_id": <UUIDv7>, "grant": <compact JWS> }`; the grant identifies the
exact binding even if registration has not yet reached the mediator.
The account, mediator and replica ID MUST match the request and verified grant.
It uses the account authentication, grant/document validation and account
isolation checks of `register`, allowing an existing matching replica tombstone.
If the account is absent, a valid `retire` creates the same standalone account
and records the tombstone in one transaction, subject to the same creation policy.
This lets recovery restore known retirements before active registrations even
after account-state loss. The first successful `register` or `retire` binds the
account's `mediation_id`; later grants must match it even if no active members
remain. Neither operation converts an ordinary mediation account.

The mediator atomically records the terminal ID/DID pair, disables its private
routing and pickup, and removes its pending deliveries. After commit it closes
the replica's live subscriptions; connections do not override durable retirement
state. Bytes already sent over a socket cannot be recalled. It retains shared
ciphertext for other replicas' existing deliveries and package deduplication.
An authorized retirement of an absent binding records a tombstone, so a late
`register` cannot undo it.
The retired DID remains reserved in the mediator's destination namespace.
Conflicting bindings fail without mutation.
Repeating the same retirement succeeds. `retired` echoes the bound IDs and
`state: "retired"` under the request's `thid`.

Retirement does not withdraw already downloaded data or other replicas'
authored events. The account and mediation arrangement remain bound at account
scope; together with the compact ID/DID pair they identify the terminal binding.
Every presented grant still undergoes signature and document validation before
comparison. The mediator may discard a retired member's grant and long form,
but retains its ID/DID pair for the identity lifetime. After remote-state loss,
clients reconcile their known retirements before replaying active registrations.

<a id="shared-recipients"></a>

## 7. Shared communication recipients

The standalone account owns an append-only set of communication recipients.
Replica DIDs are provisioned by `register`, not added as shared recipients.
A communication recipient maps to one account at a mediator; a private replica
DID maps to one replica. Destination ownership is unique across both this
protocol and ordinary mediation accounts. Account DIDs, shared recipients,
private replica DIDs and mediator identities MUST NOT overlap.

The mediator treats rendezvous and pairwise communication addresses alike; it
is not given contact IDs or an address's public/private role. This profile uses
the current immutable Peer channel model. Mutable application DIDs still
require the separate [mutable-channel proposal](did-web-channels.md).

<a id="recipient-control-proof"></a>

### 7.1 `recipient-add` / `recipient-added`

`recipient-add` is authcrypted from the account DID. The account must already
exist under this protocol. Its body has exactly `recipient_did`,
`resolution_material` and `proof`, naming one communication recipient. Multiple
recipients require separate requests. These are native replica-mediation
messages, not Coordinate Mediation recipient updates.

Every request proves control of its recipient DID. `proof` is compact JWS with
protected `alg: EdDSA`, `typ: estoc/recipient-add+jws`, and `kid` naming an
authentication key of that recipient. The RFC 8785 payload is exactly:

```json
{
  "account": "did:peer:4...account",
  "aud": "did:web:mediator.example",
  "recipient": "did:peer:4...communication-address"
}
```

The proof fields MUST match the enclosing request as follows:

| Proof payload | Enclosing request |
| --- | --- |
| `account` | Authenticated account `from` |
| `aud` | Mediator `to` |
| `recipient` | Body `recipient_did` |

Compare DIDs after verified canonicalization. Verification uses the recipient's
authorized key, not the account's key, with the signature-verification
requirements in §4. This reusable proof authorizes only addition of the named
recipient to the named account at that mediator. It has no expiry or request-ID
binding: the same proof may be used in later authenticated requests because
the recipient binding is permanent and addition is idempotent. It never
authorizes a different account, mediator or recipient, nor replaces account
authentication. DIDComm request IDs still correlate requests and replies.

For Peer DIDs, `resolution_material` is the long form, or null only when the
mediator already has verified resolution material. The mediator recomputes the
short form, contextualizes verification methods and verifies control locally.
Long-form aliases normalize to the verified short form before comparison.
The supplied document is not an
arbitrary URL to fetch. Other DID methods require an explicitly supported,
constrained resolver and control-proof profile; this document does not authorize
unrestricted network resolution or mutable-channel use.

After verifying the recipient and its proof, the mediator atomically applies
these rules:

| Current destination binding | Result |
| --- | --- |
| Absent | Bind the recipient to this account; `added` |
| Already a shared recipient of this account | Preserve the binding; `no_change` |
| Another account, a private replica, an account DID or the mediator | Refuse the request without mutation |

Proof and resolution checks apply even when the binding already exists.
Recheck destination ownership and capacity in the transaction so concurrent
adds cannot bind one DID to two accounts or partially publish a failed add.
An existing binding consumes no additional recipient capacity. The response
body is `{ "recipient_did": <canonical DID>, "status": "added" | "no_change" }`.

The binding is identified by the canonical recipient DID and its account.
There is no per-registration UUID, generation or replacement token. If two
replicas add the same DID to their shared account concurrently, the first
committed request adds it and the other returns `no_change`. Retrying after a
lost response has the same effect and changes no delivery/ACK state.

### 7.2 Append-only reconciliation

Clients send one `recipient-add` for each newly validated communication DID
whose immutable route binds this arrangement. On startup, reconnection,
suspected remote-state loss and periodic reconciliation, replay the adds for
all locally known validated bindings without querying the mediator first.
Both `added` and `no_change` complete that recipient's attempt; failed or lost
responses remain retryable without undoing other completed adds. A previous
success is not proof that the mediator retained the binding after storage loss.

This includes historical DIDs with later DID or route retirement facts:
validate their original identity/route binding without treating current
application eligibility as a condition for keeping the transport registration.
The protocol does not enumerate remote recipients. Bindings unknown to a
replica remain untouched; their identities and route evidence are recovered
through vault synchronization or backup, not a mediator listing.

Recipient bindings remain for the account's lifetime. This protocol has no
recipient remove, replacement, expiry or tombstone operation. DID retirement,
channel blocking, rotation, route withdrawal and replica retirement do not
delete them. Rotation adds a successor DID while the old DID remains routed to
the account; retiring a replica only removes that replica's delivery membership.
Neither another replica's incomplete history nor an old request can undo an add.

Keeping an address registered permits further transport delivery, not application
admission, new outbound use or automatic effects. Those remain subject to local
domain rules. Ordinary package ACK/expiry still removes mail; permanent recipient
registration is not permanent ciphertext retention. This candidate behavior
replaces phase-1 removal from the mediator when a DID leaves the live desired set;
the owning specifications must adopt that separation before this profile is used.

<a id="routing-and-mailbox-storage-extension"></a>

## 8. Routing and durable fan-out

The accepted-envelope, normalization, package-idempotency and transport-status
rules of [distributed delivery](../distributed-delivery.md#phase-1-mediator-envelope-and-storage-profile)
apply to this account's opaque packages. Account creation, destination ownership
and delivery selection follow this protocol; the phase-1 account-inbox rule
does not apply. A local event/object CID is not a routing identifier.

Routing classification is determined by the registered `forward.body.next`:

| Destination | Storage and delivery |
| --- | --- |
| Shared communication DID | One immutable shared mailbox package; a fixed set of deliveries for all replicas active at first acceptance |
| Active replica DID | One private mailbox package and delivery for that replica only |
| Retired replica, unknown or unauthorized destination | Refuse without partial storage or fan-out |

For a new shared package, selecting all active replicas, checking account
capacity, inserting the package and creating every target's delivery MUST be
atomic with registration and retirement. If registration commits first, the
new replica participates in that selection; if package acceptance commits first, it does
not. Transaction order defines the boundary, not a sender timestamp or a
comparison of second-resolution registration times.
There is at most one delivery per `(mailbox package, replica DID)`. The set of
delivery targets is fixed at first acceptance. Later registration, reconnection,
queue drainage or a duplicate forward MUST NOT add targets or reset ACKs.

Account retained-byte/message limits may refuse the whole new package. There
is no per-replica queue quota: an accepted shared package creates a delivery
for every active replica, including offline replicas and those with a backlog.
If account capacity is insufficient or any delivery cannot be committed,
refuse the whole package without partial storage, deliveries or an acceptance
record. If there are no active replicas, likewise refuse the new package.
These failures use the ordinary non-enumerating routing refusal.

A private sync envelope is opaque to the mediator. It is routed by the replica
DID just like other mail; its encrypted protocol type or contents are not
inspected. It is never copied to a newly enrolled replica. Requests, replies
and sync receipts all use this private path.

Shared package deduplication retains the original recipient and `forward.id`
key within its account. Private deduplication is scoped to its destination
replica DID and `forward.id`. Equal IDs do not combine different recipients'
delivery/ACK state. A repeated package with different normalized bytes is a
conflict. Retransmission of an acknowledged shared package before expiry MUST
NOT recreate that member's delivery or create one for a later member. A valid
duplicate preserves the original acceptance result even if its delivery targets
have since retired; it does not perform a fresh target selection or extend
the original retention deadline.

The mediator never rewrites the inner application envelope's recipients or
re-encrypts its contents. A live push references committed delivery state;
failed sockets or pushes do not consume mail.

<a id="message-pickup-3-0-replica-profile"></a>

## 9. Pickup and acknowledgments

A replica authcrypts standard Message Pickup 3.0 requests to the mediator from
its replica DID. The mediator selects the private inbox plus shared deliveries
belonging to that authenticated principal. The body carries no `replica_id`
selector. Supplying another ID cannot broaden access. Shared-account pickup
is always refused for these accounts. Ordinary accounts keep their separate
pickup and ACK domains; their requests cannot consume this account's mail.

`status-request`, `delivery-request` and their replies retain standard shapes.
An optional `recipient_did` MUST filter by the original `forward.body.next`
within this replica's deliveries. It is not an authorization selector. Requests
without it see all this replica's pending deliveries. An empty delivery result
returns `status`.

Each attachment ID is an opaque delivery ID with at least 128 bits of
unpredictability. It remains stable across polling, redelivery and live push.
Different replicas get different IDs for one shared package. Pickup responses
are encrypted to the replica DID; attachment bytes remain the original inner
encrypted envelope.

`messages-received.message_id_list` affects only this authenticated replica's
deliveries. Repeating an ACK is harmless; unknown, already acknowledged and
other replicas' IDs have no effect. A shared ACK marks that delivery consumed
without deleting the shared ciphertext or another delivery. A private ACK may
remove the private package. No application or sync end-to-end receipt is
implied by either operation.

For application mail, the client follows the existing
[receive and commit boundaries](../distributed-delivery.md#cross-layer-commit-and-acknowledgment-table):
ACK after durable receipt/evidence storage, or a terminal pre-vault rejection
with no portable message or effect. Recoverable missing-key/history/state cases
remain queued. Application admission and automatic effects remain separate
from transport ACK.

For sync mail, the client follows [sync durability](vault-sync.md#durability-and-acknowledgments).
A raw event receipt does not mean its dependent objects or the entire vault are
synchronized.

Live-delivery state belongs to the authenticated replica connection. Multiple
connections for the same replica may see the same delivery and share its ACK
domain. Connecting as B never subscribes to A's deliveries. Reconnection also
drains durable queued mail; live push is not a replacement for pickup.

<a id="retention-and-limits"></a>

## 10. Retention, limits and failure

Shared mail expires at the earlier of mediator acceptance time plus its
advertised retention window and the outer forward's explicit expiry, if any.
A past expiry is refused. Until that deadline, pending deliveries remain
available only to their original target replicas. The shared package remains
for duplicate detection even after all its deliveries have been acknowledged
or removed by retirement; retention never authorizes new delivery targets.
Private mail remains until its own ACK or deadline.

Expiry is independent of slow/offline replicas. This is bounded mail storage,
not a history source for newly enrolled replicas. Earlier history and expired
deliveries require vault sync or backup recovery where that data is still
available. Transport acceptance alone is not delivery to a replica or completion
of history catch-up.

`registered.limits` MUST disclose positive bounds for `message_retention_seconds`,
`max_message_bytes`, `max_active_replicas`, `max_retired_replicas`, `max_membership_page`,
`max_shared_recipients`, `max_retained_bytes`, `max_retained_messages` and
`max_deliveries_per_request`. Byte and message quotas apply to all of the
account's private and shared packages together. A shared package counts once
toward both quotas regardless of its number of deliveries; a private package
uses the same account budget and creates one delivery for its target replica.
Exhausting the account budget refuses new shared and private packages without
partial publication. Limits are checked in the publication transaction.
`max_deliveries_per_request` bounds one pickup response, not a replica's backlog.
Delivery and ACK state remain independent for each replica.

Only active bindings count toward `max_active_replicas`. Compact retired ID/DID
pairs use `max_retired_replicas`, which MUST be at least 1024 times the active
limit. Every active binding reserves one slot in that tombstone budget, so
retiring it cannot fail because other retirements filled the budget. New
registration or retirement of an absent binding requires an unreserved slot;
the retired count plus active reservations cannot exceed that budget.
Repeating an existing retirement consumes none. No operation may discard a
tombstone or re-enable an incarnation to make room.

Deployments MUST support increasing the tombstone budget without changing
the account, replica identities or stored history. An exhausted budget reports
an actionable capacity diagnostic and refuses new identities, while existing
members keep routing and can retire using their reserved slots. This remains
bounded storage, but ordinary device turnover does not consume the active
device allowance or require a mediator migration to raise the capacity.

Protocol failures use Problem Report 2.0 with code prefix
`e.estoc.replica-mediation.` and these suffixes:

| Suffix | Meaning |
| --- | --- |
| `invalid-message` | Message type, body shape or request fields are invalid |
| `invalid-grant` | Binding, signature, document, sender or destination check failed |
| `invalid-recipient` | Recipient identity, resolution or control proof is invalid |
| `account-refused` | The mediator declines creation of a new account |
| `unknown-account` | An operation requiring an existing replica-mediation account names none |
| `identity-conflict` | ID/DID or destination already has another binding |
| `retired` | This exact incarnation is terminal |
| `replica-required` | Pickup was attempted with the account identity |
| `list-expired` | Membership snapshot is no longer available; start a fresh listing |
| `quota` | An account storage, membership or recipient capacity limit prevents the operation |
| `message-too-large` | Envelope exceeds the transport limit |

Authenticated control failures disclose only the caller's account state.
Anonymous routing failures retain the existing non-enumerating behavior.

<a id="privacy-and-security"></a>

## 11. Privacy boundary

The mediator may observe account and replica DIDs, their grouping, communication
recipients, ciphertext sizes, transport addresses and delivery timing. It does
not receive the vault seed, plaintext events, content CIDs or human-readable
device labels through this protocol. Synchronization payloads are encrypted
end to end between replica DIDs, including any embedded original mail.

The deployment may use the same mediator for both paths. Sender protection is
an independent interoperability/privacy feature, not a prerequisite to this
profile and not a way to hide an explicitly registered replica group.
Default logs MUST NOT contain decrypted control bodies, mail ciphertext,
attachment bytes, vault content or private keys. A mediator must not be given
application content keys or represent device retirement as seed revocation.

<a id="required-conformance-cases"></a>

## 12. Required conformance scenarios

These are proposed requirements, not claims about the current implementation.

1. Two restored writable copies have different replica IDs/DIDs and preserve
   historical event authors; an exact move cannot leave a second writer alive.
2. An account-authenticated `register` with a valid matching account-signed
   grant creates an account and its first replica without Coordinate Mediation.
   A failure creates neither; a lost response and retry return the same binding.
   The reply returns to the account over the request's transport exchange,
   without requiring an account pickup queue.
   A forged list entry, wrong account/mediator, altered document or replica-DID
   requester does not enroll a replica. Pickup still authenticates the replica.
3. Ordinary and replica-mediation accounts use different identities and state.
   Neither registration path converts the other account kind; ordinary controls
   and ACKs cannot mutate the new account. Old recipients and queued mail stay
   with their old account. New recipients require control proof from creation.
4. With A already active, register B and accept a shared package in both
   transaction orders. If B registers first, the accepted package creates one
   delivery for B. If acceptance commits first, B gets none, even when it joins
   before package expiry. Re-registration and duplicate forwards preserve
   that original target set and existing ACK state.
5. A and B receive identical original shared ciphertext with different delivery
   IDs. A's ACK, including an attempted B ID, cannot consume B's delivery.
6. Sync addressed to B is delivered only to B and never copied to C when C
   joins. A replica DID cannot be registered as a shared recipient.
7. Recipient filters narrow both status and pickup within the caller's queue;
   they cannot reach another principal. Disconnecting live push loses no mail.
8. Retire before register and register before retire both end retired. A delayed
   grant cannot reactivate the identity; historical authored events remain usable.
   With an absent account, authorized retirement atomically creates the account
   and tombstone before a later active registration can reactivate that identity.
   Active retirement succeeds using reserved tombstone capacity; exhausted
   tombstone capacity does not halt existing members. Increasing that budget
   permits new identities without clearing the old ID/DID pairs.
9. C joins after a shared package was accepted, while it is still retained:
   C receives no delivery whether the original targets have ACKed it or not.
   C obtains available earlier history through vault sync or backup. After all
   original targets ACK or retire, an identical forward before expiry remains
   a duplicate and creates no deliveries; changed bytes under that key conflict.
10. An accepted shared package creates one delivery for every active replica,
    including an offline replica with a backlog, while counting its ciphertext
    and package only once against the account budget. Shared and private mail
    consume that same budget. Account storage exhaustion or a delivery-write
    failure publishes no package, partial deliveries or acceptance record.
    With no active replicas, new shared mail is refused. A refused package may
    be submitted later once the account has capacity and an active target.
    Pickup response limits do not cap a replica's backlog. SQLite and D1 enforce
    the same registration and fan-out transaction boundaries.
11. A restored mediator list cannot authorize a fabricated sync recipient, and
    known local tombstones are reconciled before registration/publication.
12. No delivery or membership operation independently authorizes historical
    application effects or changes a committed application's channel/package.
13. A local self-retirement drains history within its deadline and sends its
    final retirement batch before its mediator removal request. Crash/restart
    preserves the deadlines; unconfirmed history stays visible. Retirement learned from
    another replica stops work immediately without starting a new drain.
14. A creates and registers a communication DID while B lacks its entity.
    B's replay of its own known bindings leaves A's recipient untouched.
    Missing or account-key-signed recipient proofs fail. For another previously
    unregistered DID known to both replicas, concurrent adds produce one
    permanent binding: one `added`, one `no_change`, with no registration churn.
    Another account cannot claim the DID, including an ordinary account.
15. A DID or route retires, a channel is blocked, or a replica leaves: existing
    recipient bindings remain. Rotation adds the new address while old addresses
    remain transport destinations; application eligibility is checked separately.
    A remove/replacement request fails without mutation. Package ACK and expiry
    still clear mail without deleting recipients.
16. Reconcile by independently re-sending known recipient adds without a remote
    listing. Existing bindings return `no_change`; a failed request leaves
    other successful adds intact. After remote-state loss, restore validated
    historical bindings even when their DIDs no longer serve new application
    work. A lost add response is recovered by retrying the same binding.
17. Two first registrations for different replicas race under the same account
    and mediation ID: both share one account. Conflicting account bindings,
    cross-protocol account reuse and recipient/private-destination collisions
    fail atomically.
18. Reuse a recipient proof in later account-authenticated requests with new
    request IDs: it remains valid without a time check, and replies correlate
    to their enclosing requests. A mismatched request account, mediator or
    recipient is refused, and altering the proof's payload invalidates its
    signature. Proof checks also apply to an existing binding. A batch-shaped
    body is invalid and changes no recipient binding; each valid request and
    response names one recipient.
