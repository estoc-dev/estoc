# replica-mediation/1.0

> Proposed multi-replica contract; not implemented and not part of the
> [phase-1 contract](../README.md). The current runtime remains single-writer.
> The [adoption work](README.md#adoption-work) must be completed before enabling
> this profile. Candidate events and key names below are not phase-1 API.

[Suite guide](../README.md) · [Identity model](#identity-model) ·
[Protocol boundary](#protocol-boundary) · [Conformance](#required-conformance-cases)

This document defines vault-authorized replica membership at a mediator,
fan-out of external mail and independently acknowledged pickup. Each replica
has its own DID. Ordinary Message Pickup 3.0 authenticates that DID; a caller
cannot select another replica's queue by supplying a replica ID in a body.
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
| Implement the mediator | [Recipient registration](#coordinate-mediation-profile), [routing](#routing-and-mailbox-storage-extension), [pickup](#message-pickup-3-0-replica-profile) |
| Implement synchronization | [Protocol boundary](#protocol-boundary), [vault-sync](vault-sync.md) |
| Enable multiple active application runtimes | [Adoption work](README.md#adoption-work); transport membership does not choose an executor |

<a id="what-it-is-for"></a>
<a id="protocol-boundary"></a>

## 1. Purpose and protocol boundary

An external sender addresses one of the vault's communication DIDs. The
mediator retains the encrypted application envelope once and creates a delivery
for each active replica. The sender does not need a device list or this
extension. Every replica decrypts the original envelope with the vault's
communication keys and performs its own receive procedure.

A replica sends synchronization traffic to a particular replica DID. That
message gets exactly one destination queue. It MUST NOT be fanned out to the
vault, passed through the ordinary application receive/effect pipeline, or
turned into another portable sent/received-message record.

| Responsibility | Owner |
| --- | --- |
| Authorize replica DID membership; register, list and retire delivery targets | This protocol |
| Bind shared communication addresses to the mediation account | Coordinate Mediation with the control proof below |
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
Routing 2.0, [Coordinate Mediation 3.0](https://didcomm.org/coordinate-mediation/3.0/),
[Message Pickup 3.0](https://didcomm.org/messagepickup/3.0/) and Problem Report 2.0.
Control message types use `https://estoc.dev/replica-mediation/1.0/`.
Each request has a DIDComm `id`, authenticated `from`, and one `to` naming the
mediator. Replies are authcrypted from that mediator to the requesting DID and
use the request ID as `thid`. Body schemas in this profile are closed. Peer DID
comparisons use the verified canonical short form, including an authenticated
sender or key identifier originally carried in long form.

The initial profile uses one selected mediation arrangement for replica
membership and sync delivery. Existing historical communication routes may
still need draining under the vault's route rules. Membership across several
mediators and a live transfer between membership authorities are later work;
a client MUST NOT treat registration at one mediator as registration at another.

The mediator advertises the extension using Discover Features. Successful
registration, rather than discovery alone, establishes support. Accounts that
have not enabled the extension retain ordinary account-scoped pickup.

<a id="terms-and-trust-model"></a>
<a id="identity-model"></a>

## 3. Identities and trust

| Identity | Meaning | Lifetime and visibility |
| --- | --- | --- |
| Vault anchor | `vault_meta.anchor`, derived from the shared seed | Same for every copy; carried inside encrypted sync, not required in mediator control messages |
| Communication DID | An external peer's rendezvous or pairwise address for the vault | Shared across replicas, subject to the existing channel and rotation rules |
| Replica ID | The UUIDv7 in `store_state.replica_id` | One independently writable incarnation; equals the author of its newly committed events |
| Replica DID | The incarnation's DIDComm address and pickup principal | One immutable `did:peer:4` document bound to that replica ID; used for internal synchronization |
| Mediation account DID | The vault-controlled identity of the selected `mediation.created` arrangement | Authorizes shared recipient registration and replica membership at the mediator |
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
grant signed by the selected mediation account. That account is already bound
to this vault through its verified `mediation.created` record and seed-derived
key; sync clients MUST NOT accept an unknown account supplied by a mediator.

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
identity binding, not an expiring bearer token: use requires proof of the
replica key, and retirement is terminal. There is no `iat` or expiry-dependent
renewal that could resurrect a retired ID.

Before granting access the mediator MUST verify:

1. The account has an existing mediation grant at this mediator.
2. The JWS uses the permitted algorithm, type and key from that account's
   authenticated document, with no key fetched from a supplied `jku`/`x5u`.
3. Every field has the specified form; `replica_id` and `mediation_id` are
   canonical UUIDv7s, and `mediator` equals the DID addressed by the request.
4. The replica long form resolves locally to the stated short form and its
   service names that mediator. The replica DID differs from the account,
   mediator and shared communication recipients.
5. The request is authcrypted by the granted replica DID, proving control of
   its key. The UUID in the body is not the authentication principal.
6. Neither replica ID nor replica DID is retired or bound to a conflicting
   identity. One account uses one `mediation_id` for this registration domain.

Sync clients independently verify the grant against their own known mediation
record, its mediator, and their seed-derived replica key. They also check local
retirement facts. They do not need to trust a mediator's account-membership
assertion. The same signed binding can be carried during peer discovery even
when the recipient has not yet received its `replica.created` event.

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
application work, sync publication and pickup under that incarnation. It MAY
preserve/export unsynchronized local history. It MUST NOT silently mint a new
ID to undo retirement; rejoining is an explicit new-enrollment operation.

### 5.4 Ownership of state

| Portable vault data | Local or mediator operational state |
| --- | --- |
| Replica creation/grant, label, retirement | Registration request progress, actual remote membership status |
| Communication routes, receipts, admissions and other domain events | Live connections, delivery IDs, pickup ACK progress |
| Event CIDs and currently held raw objects | Sync retries, peer receipts, inventory sessions, staged transfers, change tokens |

A desired portable state and a remote side effect are reconciled, not committed
in a distributed transaction. Commit membership intent before registration;
commit retirement before requesting removal. Any active full replica may
reconcile known retirements using the shared account key. Responses and retries
remain operational state and MUST NOT generate an endless stream of portable
registration/synchronization records.

<a id="replica-lifecycle"></a>

## 6. Registration and retirement

```text
absent -> active -> retired
             retirement is terminal for both replica ID and DID
```

This profile has explicit retirement and bounded mail retention, not an
inactivity lease. Being offline does not change the portable member identity.

### 6.1 `register` / `registered`

The replica sends `register` authcrypted from its replica DID to the mediator.
The body has exactly `{ "grant": <compact JWS>, "replay": "retained" }`.
The grant's long form may be used to resolve the claimed sender's public key
after opening the request; the encrypted grant cannot bootstrap decryption of
itself. The caller supplies its sender long form in the DIDComm envelope key
identifier when the mediator does not yet know the short form. That document
is resolved and checked locally to authenticate/decrypt the request, then
matched to the signed grant. Neither an unverified document nor a decoded grant
grants access; all checks must succeed before any mutation.

The first valid registration is explicit account opt-in to this extension.
In one transaction the mediator MUST:

1. Enable replica delivery for the shared account if not already enabled,
   preserving every unexpired pending legacy package as shared retained mail.
2. Bind the new replica ID/DID/grant and provision its private destination.
3. Create its missing deliveries for every unexpired shared mailbox message.
4. Disable account-global pickup for the shared account.

An in-flight legacy ACK arriving after activation MUST fail without deleting
shared mail. An ACK committed before activation has the old profile's meaning;
mail already removed before the switch can only be recovered from a replica or
backup. Live pushes occur only after the transaction commits.

An exact repeat for an active member is idempotent and repairs missing
retained deliveries. Existing acknowledged deliveries MUST NOT be reset.
A retired or conflicting identity fails without mutation. Shared-recipient and
private-replica destinations cannot overlap or steal an existing destination.

The `registered` response is authcrypted to the replica DID, uses `thid` equal
to the request ID, and includes `replica_id`, `replica_did`, `state: "active"`,
original `registered_time`, `replayed_count`, and enforced `limits`.

### 6.2 `list` / `replicas`

`list` is authcrypted from the shared mediation account. Its body has
`cursor: null` for a new listing, or a previously returned opaque cursor, plus
a positive `limit` no greater than `max_membership_page`. A new listing captures
a fixed roster; subsequent cursors are bound to that snapshot and account.
`replicas` contains `entries` and `next_cursor` (null for the final page).
Each entry has `grant`, `state` (`active` or `retired`) and `registered_time`
(UTC Epoch Seconds, or null for a tombstone created before registration).
Repeated pages are stable; an expired snapshot returns `list-expired` and the
client starts a fresh listing. The mediator may shorten a page to fit its wire
limit, but cannot omit an entry from a successfully completed listing.

No other account's identities are disclosed. The lifetime membership limit
bounds retained bindings, not just active devices. Reaching that limit is an
explicit failure, never permission to discard tombstones.

Clients verify grants before contacting listed peers and reconcile local
retirements before publishing to them. A missing row is not proof of retirement
or data loss; the mediator may have been restored from an older database.
No response is proof that a peer is online or has complete vault history.

### 6.3 `retire` / `retired`

`retire` is authcrypted from the shared mediation account. Its body is
`{ "replica_id": <UUIDv7>, "grant": <compact JWS> }`; the grant identifies the
exact binding even if registration has not yet reached the mediator.
The account, mediator and replica ID MUST match the request and verified grant.

The mediator atomically records the terminal binding, disables its private
routing and pickup, and removes its pending deliveries. After commit it closes
the replica's live subscriptions; connections do not override durable retirement
state. Bytes already sent over a socket cannot be recalled. It retains shared
ciphertext for other replicas and retained replay. An authorized retirement of
an absent binding records a tombstone, so a
late `register` cannot undo it. Conflicting bindings fail without mutation.
Repeating the same retirement succeeds. `retired` echoes the bound IDs and
`state: "retired"` under the request's `thid`.

Retirement does not withdraw already downloaded data or other replicas'
authored events. The mediator must retain enough terminal state to reject a
replayed grant for its identity lifetime. After remote-state loss, clients
reconcile their known retirements before replaying active registrations.

<a id="coordinate-mediation-profile"></a>

## 7. Shared communication recipients

The shared mediation account continues to own communication recipient
registrations. Replica DIDs are provisioned by `register`, not added as shared
communication recipients. A communication recipient maps to one account at a
mediator; a private replica DID maps to one replica. The namespaces MUST be
disjoint.

The mediator treats rendezvous and pairwise communication addresses alike; it
is not given contact IDs or an address's public/private role. This profile uses
the current immutable Peer channel model. Mutable application DIDs still
require the separate [mutable-channel proposal](did-web-channels.md).

<a id="recipient-control-proof"></a>

### 7.1 Recipient control

A recipient registration MUST prove control of the recipient DID rather than
claiming it first. Each `recipient-update` entry includes `recipient_did`,
`action`, `registration_id`, `resolution_material` and `proof`.
`registration_id` is a UUIDv7; `proof` is compact JWS, protected `alg: EdDSA`,
`typ: estoc/recipient-registration+jws`, and `kid` naming an authentication key
of the recipient. The RFC 8785 payload is exactly:

```json
{
  "account": "did:peer:4...account",
  "action": "add",
  "aud": "did:web:mediator.example",
  "expires_time": 1788443400,
  "registration_id": "019b1b50-42bf-71b7-a8d8-70543a158ffd",
  "request_id": "019b1b50-b403-7940-abaf-f59b92d2231b",
  "recipient": "did:peer:4...communication-address"
}
```

All repeated fields MUST match the outer request. The expiry must be in the
future and at most five minutes ahead of mediator time. Removal uses
`action: "remove"` and the active registration ID. Verification uses the
recipient's authorized key, not the account's key. The complete bounded update
request is atomic: a proof, resolution or quota failure applies none of it.

For Peer DIDs, `resolution_material` supplies the long form if not already
known. The mediator recomputes the short form, contextualizes verification
methods and verifies control locally. Long-form aliases normalize to the
verified short form before comparison. The supplied document is not an
arbitrary URL to fetch. Other DID methods require an explicitly supported,
constrained resolver and control-proof profile; this document does not authorize
unrestricted network resolution or mutable-channel use.

### 7.2 Registration state

An absent recipient may be added with valid proof and available quota. A repeat
of the same account/registration ID is `no_change`; a new valid ID for that
same account replaces it atomically. Another account cannot take it. An
attempt to register a private replica DID, account DID or mediator DID as a
shared address fails.

Removal affects future routing only. A matching active registration is removed;
an absent or stale registration has no effect. Retained shared messages and
already-created deliveries remain until their deadlines. `recipient-query`
returns the account's shared recipients and their current registration IDs.

<a id="routing-and-mailbox-storage-extension"></a>

## 8. Routing and durable fan-out

The accepted-envelope, normalization, package-idempotency and transport-status
rules of [distributed delivery](../distributed-delivery.md#phase-1-mediator-envelope-and-storage-profile)
continue to apply. A local event/object CID is not a routing identifier.

Routing classification is determined by the registered `forward.body.next`:

| Destination | Storage and delivery |
| --- | --- |
| Shared communication DID | One immutable shared mailbox package; one delivery for each active replica |
| Active replica DID | One private mailbox package and delivery for that replica only |
| Retired, unknown or unauthorized destination | Refuse without partial storage or fan-out |

For shared mail, inserting the package and every required delivery MUST be
atomic with registration and retirement. Registration racing a new package
must produce one delivery either through live fan-out or retained replay.
There is at most one delivery per `(mailbox package, replica DID)`.
An accepted shared package is retained even when there are no active replicas.
If quotas prevent complete fan-out, the mediator refuses the whole new package.

A private sync envelope is opaque to the mediator. It is routed by the replica
DID just like other mail; its encrypted protocol type or contents are not
inspected. It is never included in shared replay or copied to a newly enrolled
replica. Requests, replies and sync receipts all use this private path.

Shared package deduplication retains the original recipient and `forward.id`
key within its account. Private deduplication is scoped to its destination
replica DID and `forward.id`. Equal IDs do not combine different recipients'
delivery/ACK state. A repeated package with different normalized bytes is a
conflict. Retransmission of an acknowledged shared package before expiry MUST
NOT recreate that member's delivery.

The mediator never rewrites the inner application envelope's recipients or
re-encrypts its contents. A live push references committed delivery state;
failed sockets or pushes do not consume mail.

<a id="message-pickup-3-0-replica-profile"></a>

## 9. Pickup and acknowledgments

A replica authcrypts standard Message Pickup 3.0 requests to the mediator from
its replica DID. The mediator selects the private inbox plus shared deliveries
belonging to that authenticated principal. The body carries no `replica_id`
selector. Supplying another ID cannot broaden access. Shared-account pickup
is refused after profile activation.

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

<a id="retention-and-replay"></a>

## 10. Retention, limits and failure

Shared mail expires at the earlier of mediator acceptance time plus its
advertised retention window and the outer forward's explicit expiry, if any.
A past expiry is refused. Until that deadline it remains available for replay
to newly registered replicas even if all current replicas acknowledged it.
Private mail remains until its own ACK or deadline and is never shared replay.

Expiry is independent of slow/offline replicas. This is bounded mail storage,
not a permanent archive: after expiry, missing history must come from another
replica or backup. Transport acceptance alone is not delivery to a replica.

`registered.limits` MUST disclose positive bounds for `message_retention_seconds`,
`max_message_bytes`, `max_active_replicas`, `max_membership_records`, `max_membership_page`,
`max_shared_recipients`, `max_retained_bytes`, `max_retained_messages`,
`max_pending_deliveries_per_replica`, `max_deliveries_per_request` and
`max_recipient_updates_per_request`. Membership-record quota counts tombstones.
Byte and message quotas cover private mail as well as shared mail, with shared
ciphertext counted once. Limits are checked before atomic publication.

Protocol failures use Problem Report 2.0 with code prefix
`e.estoc.replica-mediation.` and these suffixes:

| Suffix | Meaning |
| --- | --- |
| `invalid-grant` | Binding, signature, document, sender or destination check failed |
| `unknown-account` | Shared account has no mediation grant |
| `identity-conflict` | ID/DID or destination already has another binding |
| `retired` | This exact incarnation is terminal |
| `replica-required` | Shared-account pickup attempted after activation |
| `list-expired` | Membership-list snapshot is no longer available; start a fresh listing |
| `quota` | No atomic mutation fits the advertised limits |
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
2. A valid account-signed grant plus replica authentication registers; a forged
   list entry, wrong account/mediator, altered document or mismatched sender does not.
3. A first registration preserves pending legacy mail and atomically disables
   shared-account pickup. A late legacy ACK cannot consume replica deliveries.
4. Register and accept a shared package in both transaction orders: exactly one
   delivery exists for the new replica. Repeating registration preserves ACKs.
5. A and B receive identical original shared ciphertext with different delivery
   IDs. A's ACK, including an attempted B ID, cannot consume B's delivery.
6. Sync addressed to B is delivered only to B and never replayed to C when C
   joins. A replica DID cannot be registered as a shared recipient.
7. Recipient filters narrow both status and pickup within the caller's queue;
   they cannot reach another principal. Disconnecting live push loses no mail.
8. Retire before register and register before retire both end retired. A delayed
   grant cannot reactivate the identity; historical authored events remain usable.
9. All replicas ACK shared mail; C joins before expiry and gets replay. After
   expiry it needs peer history. Private mail does not get shared replay.
10. Quota failure publishes neither a partial fan-out nor a partial registration;
    SQLite and D1 implementations satisfy the same atomicity boundary.
11. A restored mediator list cannot authorize a fabricated sync recipient, and
    known local tombstones are reconciled before registration/publication.
12. No delivery or membership operation independently authorizes historical
    application effects or changes a committed application's channel/package.
