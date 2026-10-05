# replica-mediation/1.0

> Proposed multi-replica contract; not implemented and not part of the
> [phase-1 contract](../README.md). The current runtime remains single-writer.
> The [replica-mediation adoption work](README.md#replica-mediation-adoption)
> must be completed before enabling this profile. Vault synchronization is
> deferred and is not a dependency. Candidate events and key names below are
> not phase-1 API.

> The mediator side is implemented in `mediator/`. Its wire contract is the
> [mediator README](../../../mediator/README.md#replica-mediation), which
> takes precedence wherever this document differs from it. It differs at
> least here: creating the account and enrolling a replica are two controls,
> `account-register` and `replica-add`, in place of `register`, so an account
> can exist with no replica; `list` is `replica-list`; and membership and
> recipients are not append-only. A replica can be removed
> (`replica-remove`), a recipient can be removed (`recipient-remove`), and
> recipients are listed by `recipient-list`. An account can be deleted whole
> (`account-delete`), after which the mediator keeps nothing of it. No
> control carries `mediation_id` or `replica_id`: the mediator knows an
> account and a replica by their DIDs, `replica-remove` names `replica_did`,
> and the two ids a grant names are neither kept apart from the grant nor
> compared with anything.

> The vault side has adopted from this document the `replica/<replicaId>/me`
> key name, the grant and `replica.created`; every arrangement of the vault is
> such an account, so `mediation.created` carries no `profile`. They are
> specified in
> [vault events](../vault-events.md#replica-created), which takes precedence
> wherever this document differs. `replica.label` is not adopted.

[Suite guide](../README.md) · [Identity model](#identity-model) ·
[Protocol boundary](#protocol-boundary)

This document defines standalone mediation accounts, vault-authorized replica
membership, append-only communication recipients, fan-out of external mail and
independently acknowledged pickup. Each replica has its own DID. Ordinary
Message Pickup 3.0 authenticates that DID; a caller cannot select another
replica's queue by supplying a replica ID in a body.
[Vault sync](vault-sync.md) is a separate deferred design. Registration,
recipient management, routing and pickup can be implemented and tested without
a synchronization worker or any vault-sync message.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT** and
**MAY** are interpreted as in BCP 14 when written in capitals.

<a id="reading-guide"></a>

## Reading guide

| Task | Sections |
| --- | --- |
| Identify a vault, address or writer | [Identity model](#identity-model), [authorization](#replica-authorization) |
| Add a device | [Portable membership](#portable-replica-events), [registration](#replica-lifecycle) |
| Implement the mediator | [Recipient registration](#shared-recipients), [routing](#routing-and-mailbox-storage-extension), [pickup](#message-pickup-3-0-replica-profile) |
| Plan later synchronization | [Protocol boundary](#protocol-boundary), [deferred vault-sync work](README.md#deferred-vault-sync) |
| Enable multiple active application runtimes | [Domain adoption work](README.md#application-concurrency-adoption); transport membership does not choose an executor |

<a id="what-it-is-for"></a>
<a id="protocol-boundary"></a>

## 1. Purpose and protocol boundary

An external sender addresses one of the vault's communication DIDs. The
mediator retains the encrypted application envelope once and creates a delivery
for every replica that is active at first package acceptance, subject to the
account's storage limits. That delivery set does not expand later. A new
replica obtains available earlier history through portable backup/restore or
import; automatic history synchronization is deferred. The sender does not
need a device list or this extension. Every receiving replica decrypts the
original envelope with the vault's communication keys and performs its own
receive procedure once the required history and domain prerequisites are met.
Registration does not establish those prerequisites; missing history remains
pending even when new mail is queued.

A private envelope addressed to a particular replica DID gets exactly one
destination queue. Its client handling belongs to the payload's protocol;
future synchronization may use this path. Internal replica traffic MUST NOT
be fanned out to the vault, passed through the ordinary application
receive/effect pipeline, or turned into another portable sent/received-message
record.

| Responsibility | Owner |
| --- | --- |
| Create the mediation account; register and list replica delivery targets | This protocol |
| Add permanent shared communication-address bindings | This protocol's recipient control |
| Fan-out, per-replica pickup, retention and delivery ACK | This protocol and Message Pickup |
| Synchronize vault history | [Deferred vault-sync work](README.md#deferred-vault-sync); outside this protocol's implementation and conformance |
| Decide application admission, automatic replies, rotation and dispatch | The vault/domain and runtime specifications; pending multi-replica revision |
| Bootstrap the seed and initial history | Existing [portable SQLite recovery](../vault-sqlite.md#restore-and-import) |

```text
external peer -> shared communication DID -> mediator -> A's delivery
                                                   -> B's delivery

replica A -> private envelope for replica B's DID -> mediator -> B's delivery
```

Receiving raw mail and importing an existing receipt are different operations.
Neither fan-out nor event union grants a new live action for historical work.
This protocol does not select a leader, promise exactly-once effects, or permit
outbox takeover. Multiple active automatic executors remain subject to the
[domain adoption work](README.md#application-concurrency-adoption).

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
| `recipient-add` / `recipient-added` | Account DID | Add one communication recipient idempotently |

The account DID manages the account; replica DIDs authenticate pickup and
private replica traffic. Account controls do not give the account a pickup queue.
Control replies return through the originating request/response transport
exchange, not through queued mail to the account DID. If that exchange is lost,
the client retries the idempotent mutation or reissues the read request.

The initial profile uses one selected mediation arrangement for replica
membership and mail delivery. Existing historical communication routes may
still need draining under the vault's route rules. Membership across several
mediators and a live transfer between membership authorities are later work;
a client MUST NOT treat registration at one mediator as registration at another.

This initial profile assumes the mediator preserves its committed state.
Mediator state loss or rollback is an operational incident requiring manual
handling; automatic detection and reconstruction are outside this profile.
Ordinary disconnection and retries of unconfirmed requests remain supported.

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
| Vault anchor | `vault_meta.anchor`, derived from the shared seed | Same for every copy; verified locally, not required in mediator control messages |
| Communication DID | An external peer's rendezvous or pairwise address for the vault | Shared across replicas, subject to the existing channel and rotation rules |
| Replica ID | The UUIDv7 in `store_state.replica_id` | One independently writable incarnation; equals the author of its newly committed events |
| Replica DID | The incarnation's DIDComm address and pickup principal | One immutable `did:peer:4` document bound to that replica ID; also its private delivery destination |
| Mediation account DID | The vault-controlled identity of the selected replica-mediation arrangement | Creates the standalone account and authorizes recipient registration and replica membership |
| Store generation | The local event store's cursor generation | Local only; neither a DID nor membership authority |

A vault anchor is not a public contact address. A communication DID is not a
writer ID. An event author is a replica ID, never a replica DID. Portable
history preserves each event's original author, timestamp, CID and references,
even when another replica supplies it.

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
Ed25519 authentication and X25519 key-agreement material. It adds no KDF
or custom encryption algorithm. Implementations MUST use maintained DID,
JOSE and DIDComm libraries for document construction, signature verification
and encryption.

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
authors and former replica documents remain unchanged. Enrollment of the new
incarnation does not remove the old one's membership in this initial profile.

### 3.2 Full-replica trust

All full replicas hold the same seed and can derive the vault's communication,
mediation and replica keys. Distinct replica DIDs separate delivery and
ordinary client behavior; they are not isolation from another seed holder.
This profile provides no revocation of a copied seed or of its holder's ability
to derive another replica identity.

<a id="replica-authorization"></a>

## 4. Vault authorization

A mediator list is discovery information, not sufficient authority for a
client to send vault data to a listed DID. Each member carries a portable
grant signed by the selected replica-mediation account. In the vault every
arrangement is such an account: its `mediation.created` is committed before
the first network request, using a fresh `mediationId` and the existing
`mediation/<mediationId>/me` named-key derivation to create a fresh account
DID, recorded as a `did:peer:4` long form.

That independently verified intent and seed-derived account key bind the
account to the vault; they do not assert that the mediator has accepted it.
Clients MUST NOT accept an unknown account supplied by a mediator.

A grant is compact JWS with these protected headers:

- `alg`: `EdDSA`, using Ed25519 under RFC 8037;
- `typ`: `estoc/replica-grant+jws`;
- `kid`: an authentication key of the known mediation account document.

Each encoded `did:peer:4` long form carried by a grant MUST be no larger than
8192 UTF-8 bytes, including the DID prefix. This applies to
`replica_long_form`, a long-form `mediator`, and the DID portion of `kid`; a
key fragment is not part of the encoded DID. Check this bound before decoding,
resolving or contextualizing material read from the grant. A grant exceeding
this bound fails registration with `invalid-grant` without changing any account
or replica binding, including when that binding already exists. The general
envelope-size limit applies independently.

The mediator applies the same size to every Peer DID it resolves, for every
protocol, during envelope unpacking and before decoding the DID: an envelope
whose authenticated sender is a Peer DID larger than 8192 UTF-8 bytes, or a
short form whose retained long form is, fails to unpack and reaches no handler.
An account whose long form exceeds the bound therefore cannot register under
either spelling.

Its payload is RFC 8785 canonical JSON with exactly these fields:

```json
{
  "account": "did:peer:4...account",
  "mediation_id": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
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
authorizes enrollment; using the inbox or sending as the replica requires its
own key. There is no `iat`, expiry-dependent renewal or automatic removal of
this binding in the initial profile.

Before registering a replica the mediator MUST verify:

1. The authenticated requester is the grant's account DID. An existing account
   belongs to this protocol and has the same mediation ID; an absent account
   is eligible for creation under the mediator's account-creation policy.
2. The JWS uses the permitted algorithm, type and key from that account's
   authenticated document, with no key fetched from a supplied `jku`/`x5u`.
3. Every field has the specified form; `replica_id` is a canonical UUIDv7,
   `mediation_id` a canonical UUIDv5, and `mediator` equals the DID addressed
   by the request.
4. The replica long form is no larger than 8192 UTF-8 bytes, checked before
   decoding it, resolves locally to the stated short form and its
   service names that mediator. The replica DID differs from the account,
   mediator and shared communication recipients.
5. The account and replica documents resolve with verified canonical bindings.
   The account DID is not already a recipient, replica or mediator destination.
   Account authentication and the verified grant authorize the target replica;
   `register` does not require a second request signed or sent by that replica.
6. Neither replica ID nor replica DID is bound to a conflicting identity.
   One account uses one `mediation_id` for this registration domain.

Clients independently verify the grant against their own known
replica-mediation record and its mediator, and compare the replica document's
keys with their seed-derived replica keys. That key comparison establishes the
vault binding; the grant supplies the mediator's account authorization and is
not a substitute for deriving and checking the keys. Clients also reject
conflicting local bindings.
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
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
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
The latest label by canonical event order wins. Labels are portable display
metadata carried by backup/import; the mediator does not need them. Automatic
label synchronization is outside this profile.

<a id="deferred-administration"></a>

### 5.3 Deferred replica administration

Replica retirement is deferred beyond the initial profile. It has no retirement
event schema, removal request, membership tombstone or self-retirement drain.
Membership is append-only: stopping a device, replacing its local incarnation
or observing that it is offline does not remove its registered binding.

A future retirement design is an explicit administration event initiated by a
human during maintenance. It must define how to quiesce the affected operations,
serialize membership changes and resolve or exclude in-flight work before the
administrative change takes effect. A manual trigger alone does not establish
that boundary. Its event schema and enforcement mechanism remain future work;
normal registration and delivery in this profile require no such process.

### 5.4 Ownership of state

| Portable vault data | Local or mediator operational state |
| --- | --- |
| Account intent and first grant observation | Local account-control request progress |
| Replica creation/grant and label | Durable local confirmation of this replica's registration |
| Communication DID and route bindings | Durable local recipient-add confirmations and pending work |
| Communication routes, receipts, admissions and other domain events | Live connections, delivery IDs, pickup ACK progress |
| Event CIDs and currently held raw objects | Local folds, caches and change tokens |

A desired portable state and a remote side effect are reconciled, not committed
in a distributed transaction. Commit account and membership intent before
registration. Each client MUST register only its current local incarnation,
using its own grant and the shared account key. Grants learned through backup,
import or discovery remain peer membership evidence; the client MUST NOT send
`register` on those peers' behalf.
Per-replica registration responses and retries remain operational state and
MUST NOT generate an endless stream of portable registration records.
Successful registration and recipient-add confirmations persist across normal
restart in this runtime's local operational storage. They are not portable
membership evidence or another replica's progress to import. A fresh incarnation
establishes its own confirmations; absent confirmation leaves an operation
pending, so a crash before recording success permits an idempotent retry.
Peer negotiation, sync receipts and staged history transfers belong to the
deferred synchronization design, not this profile's operational requirements.

<a id="replica-lifecycle"></a>

## 6. Registration and discovery

```text
absent -> active
```

In this initial profile, `active` means registered, not currently online.
There is no inactivity lease or membership-removal operation. Being offline
does not change the portable member identity or delivery membership.

### 6.1 `register` / `registered`

The client sends `register` authcrypted from the account DID to the mediator.
The body has exactly `{ "grant": <compact JWS> }`, naming its own local replica.
The same request creates a new account and its first replica or enrolls another
replica in an existing account. No earlier Coordinate Mediation exchange occurs.
Registration starts eligibility for future shared packages; it creates no
deliveries for packages accepted before that registration commits.

For first contact the caller MUST supply the account sender's long-form DID in
the DIDComm envelope sender key identifier. Unconfirmed registration retries
retain that long form until a matching `registered` is verified; subsequent
controls may use the account's verified short form. The mediator resolves and
validates the material to authenticate/decrypt the request, then verifies the
enclosed grant with that account's authorized key. The encrypted grant is not
a prerequisite for decrypting itself. Its replica long form identifies the
enrollment target and supplies verified resolution material for subsequent
replica-authenticated pickup. All authorization checks precede mutation and
account and destination conflicts are rechecked in the transaction.

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
adds deliveries for older packages nor resets ACKs. Clients retry their own
saved grant only while local confirmation is pending, as specified in §7.2.
A conflicting identity fails without mutation.
Shared-recipient and private-replica destinations cannot overlap or steal an
existing destination.

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
Each entry has `grant`, `state: "active"` and `registered_time` (UTC Epoch
Seconds). Repeated pages are stable; an expired snapshot returns `list-expired` and the
client starts a fresh listing. The mediator may shorten a page to fit its wire
limit, but cannot omit an entry from a successfully completed listing.

No other account's identities are disclosed. Clients verify grants and reject
conflicting local bindings before contacting listed peers. A missing row does
not remove portable membership or establish an administrative decision, and
does not authorize registering a peer on its behalf. A discrepancy with locally
confirmed registration is a local operational diagnostic, not a trigger to
clear confirmations, invent a new identity or rebuild remote state.
No response is proof that a peer is online or has complete vault history.

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

In this initial profile, each encoded `did:peer:4` long form supplied as
recipient resolution material MUST be no larger than 8192 UTF-8 bytes, including
the DID prefix. The same bound applies when that material is supplied through a
long-form `recipient_did`, or through a DID value or key identifier in the
recipient proof. Check the encoded input size before decoding, resolving or
contextualizing that input. A request exceeding this bound fails with
`invalid-recipient` and changes no binding, including when the recipient was
already registered. The general envelope-size limit still applies independently.
Implementations MUST NOT decode oversized material in order to determine this
rejection.

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

<a id="append-only-reconciliation"></a>

### 7.2 Append-only reconciliation

Each client sends `register` with its own saved, verified grant until a matching
`registered` response has been verified and durably recorded locally. This
confirmation is bound to the mediator, account and exact local replica binding.
Pickup and recipient adds wait for that initial confirmation. Once confirmed,
startup and reconnection resume pickup without another `register`; pickup need
not wait for recipient adds to complete.

After its own registration is confirmed, the client sends one `recipient-add`
for each locally known validated communication DID whose immutable route binds
this arrangement and whose add has no local success confirmation. Verify the
matching `recipient-added` response and durably record either `added` or
`no_change` as success for that canonical recipient, account and mediator.
First disclosure and unconfirmed retries carry the recipient's long form unless
the mediator is already known to have its verified resolution material under
§7.1. A failed or lost response leaves only that operation pending and does not
undo other completed adds.

Startup, reconnection and newly learned local history resume only unconfirmed
work, including newly validated bindings. Confirmed registrations and adds need
not be replayed. Explicitly clearing a local confirmation during manual
maintenance makes that operation pending again. There is no periodic
remote-state reconciliation or full replay after success. A lost response or
crash before local confirmation can cause an idempotent retry; it does not
change delivery/ACK state. Local confirmation records follow §5.4 and are not
inferred from imported membership intent. Suspected mediator state loss is
reported for manual handling without
automatically clearing these confirmations or replaying completed work.

This includes historical DIDs with later DID or route retirement facts:
validate their original identity/route binding without treating current
application eligibility as a condition for keeping the transport registration.
The protocol does not enumerate remote recipients. Bindings unknown to a
replica remain untouched; their identities and route evidence are recovered
through portable backup/import or future history synchronization, not a
mediator listing.

Recipient bindings remain for the account's lifetime. This protocol has no
recipient remove, replacement, expiry or tombstone operation. DID retirement,
channel blocking, rotation and route withdrawal do not delete them. Rotation
adds a successor DID while the old DID remains routed to the account.
Neither another replica's incomplete history nor an old request can undo an add.

Keeping an address registered permits further transport delivery, not application
admission, new outbound use or automatic effects. Those remain subject to local
domain rules. Ordinary package ACK/expiry still removes mail; permanent recipient
registration is not permanent ciphertext retention. This candidate behavior
replaces phase-1 removal from the mediator when a DID leaves the live desired set;
the owning specifications must adopt that separation before this profile is used.

<a id="routing-and-mailbox-storage-extension"></a>

## 8. Routing and durable fan-out

The accepted-envelope and transport-status rules of
[distributed delivery](../distributed-delivery.md#phase-1-mediator-envelope-and-storage-profile)
apply to this account's opaque packages. Account creation, destination ownership
and delivery selection follow this protocol; the phase-1 account-inbox rule
does not apply. A local event/object CID is not a routing identifier.

Routing classification is determined by the registered `forward.body.next`:

| Destination | Storage and delivery |
| --- | --- |
| Shared communication DID | One immutable shared mailbox package; a fixed set of deliveries for all replicas active at acceptance |
| Active replica DID | One private mailbox package and delivery for that replica only |
| Unknown or unauthorized destination | Refuse without partial storage or fan-out |

For a new shared package, selecting all active replicas, checking account
capacity, inserting the package and creating every target's delivery MUST be
one transaction, serialized against registration. If registration commits first,
the new replica participates in that selection; if package acceptance commits
first, it does not. Transaction order defines the boundary, not a sender timestamp
or a comparison of second-resolution registration times.
There is at most one delivery per `(mailbox package, replica DID)`. The set of
delivery targets is fixed at acceptance. Later registration, reconnection or
queue drainage MUST NOT add targets or reset ACKs. Every accepted forward, a
repeated one included, is a new package with its own selection, so a replica
registered in between is a target of the repeat.

Account retained-byte/message limits may refuse the whole new package. There
is no per-replica queue quota: an accepted shared package creates a delivery
for every active replica, including offline replicas and those with a backlog.
If account capacity is insufficient or any delivery cannot be committed,
refuse the whole package without partial storage, deliveries or an acceptance
record. These failures use the ordinary non-enumerating routing refusal.

A private envelope is opaque to the mediator. It is routed by the replica DID
just like other mail; its encrypted protocol type or contents are not inspected.
It is never copied to a newly enrolled replica. This routing path requires no
particular synchronization protocol or payload format.

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

Before dispatching an attachment to a consumer, classify its enclosed message
by the verified DID owning the exact recipient key-agreement method used to
decrypt it. A key of this local replica DID selects private replica handling;
a key of a locally retained communication DID selects application handling.
Use the DIDComm library's verified recipient evidence; the outer pickup
envelope, request filter and plaintext `to` do not establish this identity.
Inspecting recipient key identifiers may select keys before unpacking but
does not replace envelope validation. For nested envelopes, an anonymous
wrapper's recipient cannot substitute for the authcrypt layer's recipient,
as required by the [adapter boundary](../../../packages/agent-core/README.md#didcomm-api).

`messages-received.message_id_list` affects only this authenticated replica's
deliveries. Repeating an ACK is harmless; unknown, already acknowledged and
other replicas' IDs have no effect. An ACK ends only that replica's delivery
and leaves every other delivery as it was. A package, shared or private, is
deleted when its last delivery ends; no ciphertext is kept once every target
has acknowledged it. No end-to-end application or history-import receipt is
implied by either operation.

For application mail, the client follows the existing
[receive and commit boundaries](../distributed-delivery.md#cross-layer-commit-and-acknowledgment-table):
ACK after durable receipt/evidence storage, or a terminal pre-vault rejection
with no portable message or effect. Recovery of missing local DID/key/history
state and handling of mail that cannot yet be opened belong to a separate
synchronization channel and its receive integration. They impose no additional
pickup scheduling or local staging requirement in this transport profile and
do not change the current receive boundary. Application admission and automatic
effects remain separate from transport ACK.

For private replica traffic, a supported consuming protocol defines the durable
handling or terminal rejection required before pickup ACK. A successfully
unpacked private message whose type belongs to no locally supported
inter-replica protocol MUST be terminally rejected and pickup-ACKed, with a
bounded local diagnostic and no portable event or application receive/effect
work. The initial replica-mediation milestone supports no such payload
protocol, so every successfully unpacked private message takes this rejection
path, including candidate vault-sync messages.

In this initial milestone, a delivery whose enclosed envelope has a non-empty
recipient list naming only key-agreement methods of the retained local replica
document MUST also be terminally rejected and pickup-ACKed if unpacking or
verification fails. This includes unavailable sender resolution material and
invalid ciphertext. Do not wait for history or sender material for this traffic;
retain only a bounded local diagnostic, with no portable event or application
work. These recipient key identifiers select a rejection path, not authenticated
sender or recipient evidence. This rule does not extend to communication,
unknown or mixed recipient keys. Future protocol adoption must define durable
handling, failure, retry and pickup-ACK rules together.

Live-delivery state belongs to the authenticated replica connection. Multiple
connections for the same replica may see the same delivery and share its ACK
domain. Connecting as B never subscribes to A's deliveries. Reconnection also
drains durable queued mail; live push is not a replacement for pickup.

<a id="retention-and-limits"></a>

## 10. Retention, limits and failure

A package expires at the earlier of mediator acceptance time plus its
advertised retention window and the outer forward's explicit expiry, if any.
A past expiry is refused. Until that deadline, pending deliveries remain
available only to their original target replicas; retention never authorizes
new delivery targets. A package remains until its last delivery ends, by ACK
or by its replica's removal, or until its deadline, whichever comes first, and
its deletion frees its share of both quotas. A package accepted with no target
is the exception: it remains until its deadline and counts toward the quotas
until then.

Expiry is independent of slow/offline replicas. This is bounded mail storage,
not a history source for newly enrolled replicas. Earlier history and expired
deliveries require backup/import where that data is still available, or a
future synchronization protocol. Transport acceptance alone is not delivery
to a replica or completion of history catch-up.

`registered.limits` MUST disclose positive bounds for `message_retention_seconds`,
`max_message_bytes`, `max_active_replicas`, `max_membership_page`,
`max_shared_recipients`, `max_retained_bytes`, `max_retained_messages` and
`max_deliveries_per_request`. Byte and message quotas apply to all of the
account's private and shared packages together. A shared package counts once
toward both quotas, regardless of its number of deliveries, until it is
deleted; a private package uses the same account budget and creates one
delivery for its target replica. Exhausting the account budget refuses new
shared and private packages without partial publication. Limits are checked in
the publication transaction.
`max_deliveries_per_request` bounds one pickup response, not a replica's backlog.
Delivery and ACK state remain independent for each replica.

Every registered binding counts toward `max_active_replicas`, including offline
or replaced incarnations. An exact registration retry consumes no additional
slot. At the limit, refuse new bindings without removing existing members;
membership cleanup is deferred administration, not an automatic capacity action.

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
| `replica-required` | Pickup was attempted with the account identity |
| `list-expired` | Membership snapshot is no longer available; start a fresh listing |
| `quota` | An account storage, membership or recipient capacity limit prevents the operation |
| `message-too-large` | Envelope exceeds the transport limit |

Authenticated control failures disclose only the caller's account state.
Replica-mediation account pickup returns `replica-required`; ordinary accounts
keep their existing pickup behavior. Other unregistered pickup senders and
unauthenticated requests receive no protocol response. A failure or missing
response does not clear confirmed registrations or trigger remote-state repair.
Anonymous routing failures retain the existing non-enumerating behavior.

<a id="privacy-and-security"></a>

## 11. Privacy boundary

The mediator may observe account and replica DIDs, their grouping, communication
recipients, ciphertext sizes, transport addresses and delivery timing. It does
not receive the vault seed, plaintext events, content CIDs or human-readable
device labels through this protocol. Private replica payloads are encrypted
end to end between replica DIDs, including any embedded original mail.

The deployment may use the same mediator for both paths. Sender protection is
an independent interoperability/privacy feature, not a prerequisite to this
profile and not a way to hide an explicitly registered replica group.
Default logs MUST NOT contain decrypted control bodies, mail ciphertext,
attachment bytes, vault content or private keys. A mediator must not be given
application content keys. Distinct device identities do not revoke a shared seed.
