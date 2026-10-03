# The Estoc vault events, version 4

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide) · [Conformance cases](#required-conformance-cases)
<!-- suite-navigation:end -->

Status: **phase 1; application-admission and rotation restrictions specified, implementation pending** — event vocabulary and fold rules for
one single-seed vault executed by exactly one active writable full runtime.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**,
**NOT RECOMMENDED**, **MAY**, and **OPTIONAL** as described in BCP 14
when, and only when, they appear in all capitals.

Every example below is the `type`, `roots` and `data` portion of an event
whose complete envelope is defined by [event-store.md](event-store.md). Object CIDs and
retention semantics are defined by [dasl-objects.md](dasl-objects.md). A known event
type has a closed payload schema in version 4. The store itself validates
only the envelope; the vault layer validates the payload before append
and after ingest.

This document defines portable vault state. Socket state, pickup cursors,
retry timers, caches and traces are local state and do not appear here.
[channels.md](channels.md) owns channel identity, invitations and
operation eligibility; receipt precedes source-derived decisions and continuity work.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

Each domain places its event schemas and corresponding folds together.
Use the procedure column for the shared lifecycle and recovery operations.
Shared vocabulary is in [section 3](#identity-seed-and-key-names); cross-document rule ownership is listed in
the [suite guide](README.md#rule-ownership). The table is a navigation aid.

| Domain | Definitions and event schemas | Folds | Procedures |
| --- | --- | --- | --- |
| Identity and naming | [Identity, keys and identifier types](#identity-seed-and-key-names); [Identity label](#identity-label) | [Runtime author](#runtime-author-fold) | [Open runtime](#open-the-writable-full-runtime) |
| Mediation and DIDs | [Key evidence and resolved documents](#message-keys-and-peer-evidence); [Mediation and DID events](#mediation-communication-dids-and-routes) | [Mediation](#mediation-fold); [DIDs and keys](#route-did-and-key-fold) | [Establish mediation](#establish-mediation); [Create DID](#create-a-communication-did); [Disclose address](#disclose-an-address) |
| Channels and continuity | [Source evidence and directed links](#relationships-and-address-changes) | [Channel and continuity projections](#relationship-fold-and-address-index) | [Channel and display policy](relationships.md#symmetric-relationship-identity); [Early privacy policy](relationships.md#early-private-address-policy-and-notifications); [Rotate local address](#rotate-a-local-relationship-address) |
| Contacts and application views | [Contact events](#contacts); [Channel selections](#contact-channelsset) | [Application views](#application-message-views); [Contacts](#contact-fold) | [Delete contact](#delete-a-contact) |
| Messages and delivery | [Stored content](#stored-message-document); [Outbound events](#outbound-message-events); [Inbound events and witnesses](#inbound-message-events) | [Inbound execution](#inbound-message-and-execution-fold); [Outbound delivery](#outbound-message-and-delivery-fold) | [Send](distributed-delivery.md#send-an-ordinary-message); [Receive](distributed-delivery.md#receive-a-message); [Recover receipt](distributed-delivery.md#receive-recovery) |
| Invitations | [Disclosure](#disclosure) | [Invitation availability](#invitation-fold) | [Discovery](relationships.md#out-of-band-discovery); [Receipt integrity](relationships.md#integrity-checks-and-durable-receipt) |
| Erasure and retention | [Erasure and held roots](#erasure-and-collection) | [Held-root rules](#held-roots) | [Erase message](#erase-a-message) |

<details>
<summary>Contents</summary>

- [1. Model](#model)
- [2. Principles](#principles)
- [3. Identity, seed and key names](#identity-seed-and-key-names)
- [4. Message keys and peer evidence](#message-keys-and-peer-evidence)
- [5. Mediation and communication DIDs](#mediation-communication-dids-and-routes)
- [6. Channels, continuity and contact membership](#relationships-and-address-changes)
- [7. Contacts and application views](#contacts)
- [8. Stored message document](#stored-message-document)
- [9. Outbound messages and delivery](#outbound-message-events)
- [10. Inbound messages and execution](#inbound-message-events)
- [11. Automatic effects](#automatic-effects)
- [12. Erasure and collection](#erasure-and-collection)
- [13. Procedures](#procedures)
- [14. Merge and restore](#merge-and-restore)
- [15. Privacy and security boundaries](#privacy-and-security-boundaries)
- [16. Versioning](#versioning)
- [17. Required conformance cases](#required-conformance-cases)

</details>
<!-- reading-guide:end -->

<a id="model"></a>

## 1. Model

A vault is one identity with one seed. Phase 1 permits exactly one active
writable full vault runtime at a time. That runtime may run in a local
application or on a server and can derive every vault-controlled
communication and mediation key.

The local runtime has a `replica_id`, used as its event author. A portable
restore creates a new author so imported history remains distinguishable from
new local events.

The event model distinguishes three kinds of durable statement:

- **intent** — a user or policy decision that must survive offline and process
  failure, such as `message.out` or `contact.petname`;
- **observation** — a fact learned from authenticated bytes or an external
  service, such as `message.in`, `mediation.granted` or
  `delivery.acknowledged`; and
- **materialization** — selected work made durable, such as the exact
  ciphertext named by `message.prepared`.

All current views are folds over immutable events. No portable mutable record
is authoritative.

<a id="principles"></a>

## 2. Principles

1. **Intent precedes effects.** A user-visible action is committed as an event
   and referenced objects before DNS, DID resolution, encryption or network
   submission begins.
2. **Observations carry their evidence boundary.** A peer observation carries
   the local and peer keys directly or through retained evidence references.
   Application views retain their source attribution. A mediator observation
   names the mediation arrangement that produced it.
3. **Portable folds have no current-runtime parameter.** Event `author` is
   provenance, not ownership of communication state.
4. **Mediation and communication keys are vault-scoped.** The active full
   runtime derives them from the vault seed and can reconcile recipient
   registration, receive and expose pending delivery for explicit manual action.
5. **Stable IDs identify exact manual retries.** A logical message, an encrypted package
   and a mediator delivery have different IDs and different lifetimes.
6. **Duplicate work is expected.** Manual retry and mailbox redelivery may repeat work; recovery grants
   no automatic dispatch action. Folds and handlers
   must be idempotent.
7. **Conflicts are visible projections.** Concurrent or contradictory
   decisions remain events. A fold uses set semantics, explicit references or
   canonical latest-wins exactly where this document says so.
8. **Events are permanent; content may be erased.** An erase releases object
   roots. It never deletes a skeleton event.
9. **`replica_id` is not a security boundary.** It does not revoke a copied
   seed or create a second identity.
10. **A mediator is not the vault.** Mailbox ciphertext has bounded retention.
    The readable event/object set is the recovery source.

<a id="14-folds"></a>

<a id="folds"></a>

### 2.1 Fold conventions

All folds accept events in any order and are deterministic over the set.
Canonical order is used only where stated.

<a id="identity-seed-and-key-names"></a>

## 3. Identity, seed and key names

<a id="vault-identity"></a>

### 3.1 Vault identity

The vault identity is the anchor DID in `vault_meta.anchor`. Two vaults are the
same identity exactly when their anchor DIDs are equal.

On unlock, the runtime derives the `anchor` key from the seed and MUST verify
the DID before using the vault. The anchor remains independent of rendezvous
and pairwise communication DIDs. Disclosing a rendezvous DID or running
the full runtime on a server does not replace the anchor.

<a id="single-seed"></a>

### 3.2 Single seed

One seed derives every vault-controlled asymmetric key. The current key
profile uses HKDF-SHA-256 with the `@estoc/keystore` v3 domain separation.
The same seed and same key name always produce the same key material.

Reserved names are:

| name | purpose |
| --- | --- |
| `anchor` | immutable vault identity anchor |
| `mediation/<id>/me` | DIDComm identity for one mediation arrangement |
| `replica/<replicaId>/me` | DIDComm identity of one replica toward the mediator of a replica-mediation arrangement |
| `did/<id>/authentication` | signing/authentication key for one communication DID entity |
| `did/<id>/key-agreement` | DIDComm key-agreement key for one communication DID entity |

In `did/...` names, `<id>` is the DID entity ID. Version 4 defines exactly
one authentication key and one key-agreement key per communication DID
entity. Key names are never renamed or reused. A `did/...` or `mediation/...`
name does not encode a contact, replica, domain owner or process location.

A `replica/...` name is the one name that says which replica holds it: it
derives the DID under which that replica alone picks up mail
([`replica.created`](#replica-created)). No payload field carries it. Every
`localKeyName` is a `did/...` or `mediation/...` name, so what arrives at a
replica's own DID never becomes a portable observation.

Changing a communication DID's keys or embedded service creates another
`did:peer:4` entity. A local `did.rotationSelected` under
[section 6.4](#relationship-localtransitioned) authorizes a successor channel
for new intents; existing intents retain their channel and may become
undispatchable. There is no local
communication-key generation or key-generation selection. Store generations
retain their separate storage meaning.

TLS private keys, DNS credentials, ACME account keys and web deployment
credentials are not vault communication keys and MUST NOT be derived from
these names.

<a id="replica-ids-and-authors"></a>

### 3.3 Replica IDs and authors

Each writable full vault runtime has one canonical UUIDv7 `replica_id`. Every
event it appends has:

```text
event.author = local replica_id
```

Phase 1 has exactly one active writer. The runtime may execute in an end-user
application or on a server; its location does not change event semantics.
Authorship needs no creation event or separate host identity. A
[`replica.created`](#replica-created) records only that a replica is enrolled
in a replica-mediation arrangement.

A portable restore mints a new replica ID unless it is an exact move and the
old writer is permanently stopped. If two writable copies share an author,
[event-store.md](event-store.md) treats their divergent event sets as an author fork when they
meet during import.

A remote client that does not hold the seed is not a full runtime, has no event
author and cannot turn a staged command into portable vault state by itself.

<a id="entity-ids-and-reproducible-uuidv5-namespaces"></a>

### 3.4 Entity IDs and reproducible UUIDv5 namespaces

Unless a rule below says deterministic, locally created entity IDs are
canonical UUIDv7.

No Estoc UUIDv5 namespace is an unexplained random constant. Every namespace
is reproducibly derived from the RFC 4122/9562 URL namespace:

```text
UUID_URL = 6ba7b811-9dad-11d1-80b4-00c04fd430c8

estocNamespace(purpose) = UUIDv5(
  UUID_URL,
  UTF8("https://estoc.dev/uuid/v1/" + purpose)
)
```

The purposes and resulting namespace UUIDs, unchanged from version 3, are:

| purpose | namespace UUID |
| --- | --- |
| `inbound-message` | `4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6` |
| `message-execution` | `6511fc66-4d39-589e-b2c7-7185a807b6c6` |
| `automatic-mid` | `8847bd57-5907-5bcd-9a71-d1e97cee3199` |

A deterministic entity rule then computes:

```text
UUIDv5(estocNamespace(purpose), UTF8(RFC8785(name_array)))
```

`name_array` is the exact JSON array specified by that rule. RFC 8785
canonical UTF-8 gives unambiguous nulls, strings and field boundaries. A
runtime MUST derive and verify the namespace UUID from the URI above rather
than trusting a copied table constant. The table is a test vector, not a
second source of truth.

<a id="identifier-and-reference-vocabulary"></a>

### 3.5 Identifier and reference vocabulary

Vault-event payloads and application interfaces use the following names and
distinct validated types. The suffix describes what the value identifies;
it does not imply that every identifier has the same encoding or scope.
[Sections 3.4](#entity-ids-and-reproducible-uuidv5-namespaces), [4.1](#key-evidence) and the individual schemas own their derivation and validation.
[event-store.md](event-store.md) owns event identity; [dasl-objects.md](dasl-objects.md) owns content identity.

| Value | Type | Field names |
| --- | --- | --- |
| Vault message entity or inbound observation group | `MessageId` | `messageId`, `ackMessageId` |
| Received DIDComm plaintext ID | `WireMessageId` | `wireMessageId`, `ackWireMessageId` |
| One exact event envelope | `EventCid` | derived API/row `cid`, outside the envelope |
| Typed event reference | `EventReference<T>` | payload fields ending in `EventCid` and elements of `*EventCids`, including source, trigger, resolution, disclosure and rotation references |
| Contact | `ContactId` | `contactId`, `fromContactId` |
| Local/peer DID pair | `Channel` | `channels` entries; `localDid` and `peerDid` in selectors |
| Local DID entity | `DidId` | `didId`, `senderDidId`, `fromDidId`, `toDidId` |
| Mediation arrangement | `MediationId` | `mediationId` |
| One prepared package | `PackageId` | `packageId` |
| Scoped mediator delivery | `DeliveryId` | `deliveryId` |
| Sender/recipient-scoped automatic execution | `ExecutionId` | `executionId` |
| Exact content bytes | `Cid` | `bodyCid`, `attachmentCids`, `documentCid`, `envelopeCid`, `dropCids`; generic object APIs use `cid` |
| Vault keystore name | `KeyName` | `localKeyName`, `me.keyName` |
| Complete canonical public-key value | `PublicKey` | `peerPublicKey` |
| DID string / verification-method DID URL | `Did` / `DidUrl` | `did`, `localDid`, `peerDid`, `recipientDid`, `presentedDid`, `longFormDid`, `fromDid`, `toDid` / `authenticationMethodIds`, `keyAgreementMethodIds` |

For every payload `*EventCid`, `T` is the target event type fixed by the
referencing schema. `sourceEventCid` is `EventReference<"message.in">` in
`did.rotationSelected`, `message.admitted` and `message.out`;
`fromDidId` and `toDidId` in `did.rotationSelected` name local DID entities;
`rotationEventCid` in
`message.out` names `did.rotationSelected`. The referencing schema also owns
presence and nullability; a nullable reference has the same typed non-null
value. Generic event-store APIs use `EventCid`. Every event reference is a
canonical raw DASL CID validated against the target's canonical envelope when
available. An event CID identifies an event row; an object CID identifies object
bytes. Using the same hash profile does not add event references to `roots` or
require event envelopes to be stored in `ObjectStore`.

Use the same entity noun for creation and later references: `did.created.didId`
and `did.disclosed.didId`, for example. Add a role prefix when needed, such as
`senderDidId`. Payloads do not abbreviate a contact ID as `cid`, or hide an
entity ID behind a bare `id`, `contact` or `mediation` field.
`cid` and `*Cid` always mean content addresses; `*Did` always means a DID
string, while `*DidId` means a local entity UUID. Arrays of references use the
plural suffix, such as `attachmentCids`; collections of view
records retain their own names and carry typed identifiers in each record.

The type distinction is part of the API contract. One possible TypeScript
representation is below; other languages may use equivalent nominal types.
`EventCid` and `AuthorId` come from [event-store.md section 3](event-store.md#the-event), and `Cid` from
[dasl-objects.md section 6](dasl-objects.md#objectstore).

```ts
type EntityId<Kind extends string> = string & { readonly __entity: Kind };
type MessageId = EntityId<"message">;
type ContactId = EntityId<"contact">;
type Channel = { localDid: Did; peerDid: Did };
type DidId = EntityId<"did">;
type MediationId = EntityId<"mediation">;
type PackageId = EntityId<"package">;
type ExecutionId = EntityId<"execution">;
type WireMessageId = string & { readonly __wireMessageId: unique symbol };
type DeliveryId = string & { readonly __deliveryId: unique symbol };
type KeyName = string & { readonly __keyName: unique symbol };
type PublicKey = string & { readonly __publicKey: unique symbol };
type Did = string & { readonly __did: unique symbol };
type DidUrl = string & { readonly __didUrl: unique symbol };
type EffectKey = string & { readonly __effectKey: unique symbol };
type EventReference<T extends string> = EventCid & { readonly __eventType: T };
```

Identifiers serialize as validated strings without wrapper objects or type
prefixes. `Channel` serializes as a record of two canonical DID strings. Parsers
and derivation functions produce them only after the owning format checks.
A cast is not validation. Resolve an event reference by its exact CID and check
the target's required event type and domain evidence. Do not substitute another
event with equal payload fields or equivalent normalized meaning. Conflicting
domain facts remain separate events and are evaluated by the owning fold.
An event-reference type records its required target type; missing evidence still defers and
incompatible evidence still conflicts under the referencing schema. It is
never proof that the target is available or valid. `effectKey` is the existing
derived idempotency key, not a keystore name or a cryptographic public key.

Message identity has three levels. An event `cid` names one exact envelope;
identical envelopes are one event. Repeated receipt is a new event under its
own time and author, so a distinct event CID with one `messageId`; one writer
recording one envelope twice within a millisecond records one event.
An inbound `messageId` names the exact sender/recipient/wire-ID input; accepted
key variants in that channel share one execution. Different channels never
alias message or execution identities.
An outbound `messageId` is also its plaintext `id`; no duplicate
`wireMessageId` field is stored on `message.out`. Inbound wire IDs have the
sender's scope and are stored separately. `packageId` names a prepared
package; `envelopeCid` addresses its bytes. `localKeyName`, `peerPublicKey`
and a verification-method DID URL are separate kinds of value and cannot be
substituted for one another.

This vocabulary applies to vault payloads. The event envelope's `author` and
`roots`, serialized local-file fields such as `replica_id`, and wire/protocol fields retain their
owner-defined names. In particular, DIDComm `id`, `body`, `attachments`,
`from`, `to`, `thid`, `pthid` and `kid` are unchanged; the stored message
document in [section 8](#stored-message-document) also retains its application-content shape. Producers
map vault fields to those protocol fields explicitly.

Namespace purpose strings, keystore paths, literal hash-transcript tags and
message-content serialization are fixed separately from field spelling.
Implementations MUST construct each specified derivation input, not serialize
an arbitrary renamed payload or API object as its substitute. The sender-and-recipient execution transcript is specified in
[distributed-delivery.md](distributed-delivery.md#execution-id-and-immutable-transcript);
contact IDs are never part of it. Event
canonical bytes do use the current schema; any content hash of an event or
container therefore follows those actual bytes.

<a id="6-identitylabel"></a>

<a id="identity-label"></a>

### 3.6 `identity.label`

```json
{
  "type": "identity.label",
  "roots": [],
  "data": {
    "name": "Alice"
  }
}
```

The latest value by canonical order is the user-visible identity name.
It is ordinary LWW metadata and has no key or protocol effect.

<a id="141-runtime-author-fold"></a>

<a id="runtime-author-fold"></a>

### 3.7 Runtime-author fold

Phase 1 expects exactly one active local `replica_id`. For each author seen in
the event set, the fold reports `firstEventAt` and `lastEventAt`. An author
fork is an event-store integrity condition, not a normal multi-writer merge.

<a id="message-keys-and-peer-evidence"></a>

## 4. Message keys and peer evidence

<a id="key-evidence"></a>

### 4.1 Key evidence

Each message or resolution retains the keys used for that observation or
package, directly or through its exact evidence references:

- `localKeyName` is the vault key name that decrypted or authenticated the
  message, or `null` when no local key participated.
- `peerPublicKey` is the complete authenticated or selected peer public key in the
  canonical encoding below, or `null` for an anonymous sender.

Each event schema defines its required fields and nullability. The keys
provide authentication, decryption and package evidence; they do not assign a
contact. Anonymous input and mediator traffic may retain key
evidence without an application channel.

The canonical public-key value follows the
[did:key identifier syntax and public-key encoding rules](https://w3c-ccg.github.io/did-key-spec/#did-key-identifier-syntax),
using only its base58btc multibase form (leading `z`) and omitting the
`did:key:` prefix. It retains the complete type-tagged public key, without a
fragment, hash or truncation. Equivalent supported JWK and multibase key
representations MUST normalize to the same string; key type, length and
encoding MUST validate. NIST-curve keys use compressed points under
[SEC 1 section 2.3.3](https://www.secg.org/sec1-v2.pdf) (including P-521),
with public-key type codes from the
[multicodec table](https://github.com/multiformats/multicodec/blob/master/table.csv).
Every deterministic ID or authorization check that uses a peer key uses this
exact string.

For an inbound observation it is the key that authenticated the message; for
an outbound package it is the selected recipient key. A peer resolution records
the key-agreement key used for receipt/preparation. Predecessor JWT checks use
the immutable issuer document derived under [section 6.3](#relationship-peertransitioned) and its authentication
methods directly. Selection alone is not evidence
of authenticated inbound traffic or remote receipt.

The executable key fixture used by this specification is X25519, public-key
codec `0xec` (unsigned-varint bytes `ec01`), with these 32 raw public-key bytes:

```text
0900000000000000000000000000000000000000000000000000000000000000
peerPublicKey = z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis
```

`message.in` and `message.prepared` store `localKeyName` and `peerResolutionEventCid`, with
no `peerPublicKey` payload field. Their peer key is derived as
`peer.resolved(peerResolutionEventCid).peerPublicKey`. For an anonymous
inbound only, null `peerResolutionEventCid` yields null `peerPublicKey`; an unavailable or
invalid reference is deferred or conflicted, never treated as anonymous.
In this document and the delivery profile, a message or package's `peerPublicKey`
always means this derived value. `peer.resolved` and ACK observations retain
their explicit keys. Continuity links derive from exact proof evidence and local decisions.

`message.in.presentedDid` preserves the wire spelling, and
`peer.resolved.presentedDid` preserves the spelling used for resolution.
First-disclosure validation and recovery use this retained evidence.
A verified link may justify a new channel without changing earlier message IDs.
Equal key values under different DIDs do not supply channel authority or a
contact assignment. Each observation retains its own key evidence, and each
consumer checks its own prerequisites.

<a id="mediation-key-evidence"></a>

### 4.2 Mediation key evidence

Traffic between the vault and a mediator uses a local key beginning with:

```text
mediation/
```

These observations belong to the mediation fold, not application
channels or contact/application views.

<a id="11-peer-and-profile-observations"></a>

<a id="peer-and-profile-observations"></a>

<a id="43-peer-and-profile-observations"></a>

<a id="resolution-observations"></a>

### 4.3 Resolution observations

Resolution observations retain exact cryptographic evidence. Peer continuity
links follow the same rule in [section 6.3](#relationship-peertransitioned).
These facts remain distinct from contact assignments and local DID entities.

<a id="111-peerresolved"></a>

<a id="peer-resolved"></a>

### 4.4 `peer.resolved`

```json
{
  "type": "peer.resolved",
  "roots": [
    "bafkrei...resolved-did-document"
  ],
  "data": {
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerPublicKey": "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis",
    "presentedDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "did": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "documentCid": "bafkrei...resolved-did-document",
    "authenticationMethodIds": [
      "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP:z...bob-input-document#authentication-0"
    ],
    "keyAgreementMethodIds": [
      "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP:z...bob-input-document#key-agreement-0"
    ],
    "service": "did:web:mediator.example"
  }
}
```

This event is durable resolution evidence for one authenticated or selected
peer key. `localKeyName` identifies the local communication key/context.

- `presentedDid` is the exact numalgo-4 DID string supplied for resolution.
- `did` is its canonical short form under [relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile);
  first disclosure keeps the long form in `presentedDid`.
- `documentCid` names the raw DASL object containing exact RFC 8785 canonical
  resolved DID document JSON. Its CID commits to those bytes.
- the selected or authenticated `peerPublicKey` must be present under the named DID and exact
  document;
- `authenticationMethodIds` and `keyAgreementMethodIds` enumerate all methods authorized
  for those purposes in the exact retained document, with references resolved
  against that document's `id`. They do not prove every listed key controlled the
  observed message. Each consuming message references its
  own exact evidence; method lists from different documents MUST NOT be unioned
  into an authorization set; and
- `service` is the selected DIDComm service URI or null.

Receipts and packages retain exact resolution references for the immutable
peer document. The receipt's `peerResolutionEventCid` authenticates the current
sender only; predecessor JWT verification derives its issuer document under
[section 6.3](#relationship-peertransitioned) using the same canonical representation.
The referenced resolution objects
remain historical evidence; another document cannot replace any reference.
If the event or object is temporarily missing, processing is deferred until
verified recovery material is available; absence is not proof that the
referenced evidence is invalid.

For a `did:peer:4` first disclosure, the implementation decodes and validates
`presentedDid`, derives `did` and the document locally, and stores both forms.
A short form received before corresponding long-form resolution evidence is
known cannot establish authenticated channel receipt.

For numalgo 4, let `L` be the retained validated long form and `S` its derived
short form. `documentCid` MUST store the
[Peer DID Method's long-form resolution result](https://identity.foundation/peer-did-method-spec/#resolving-a-did)
with optional reference expansion disabled. Starting from the decoded input
document, set the root `id` to `L`; preserve its `alsoKnownAs` array (or start
an empty array when absent) and append `S`; fill every omitted verification
method `controller` with `L`, including methods embedded in verification
relationships. Keep relative identifiers/references unchanged. Preserve all
other input members and array order, including any `@context` and explicit
external controllers; add nothing else. Serialize the result as UTF-8 RFC 8785
JSON. This section owns the stored representation; a resolver's optional
expansion, context injection or short-form output is not a storage choice.

Later short-form lookup or receipt MUST reuse or reproduce those same document
bytes and CID from `L`, even though `presentedDid` may now be `S`. New resolution
events may record another presented spelling, selected key or local `localKeyName`;
they do not produce a second document for the same numalgo-4 DID. Import
validates this representation against `L`; it never repairs evidence by rewriting
the retained bytes or CID. Method-ID comparison follows [section 6.3](#relationship-peertransitioned).

Equivalent duplicate observations are harmless. Same document CID with
incompatible contents is an integrity conflict; a different
document under one immutable Peer DID is invalid method evidence.

<a id="mediation-communication-dids-and-routes"></a>

## 5. Mediation and communication DIDs

Mediation arrangements, communication DIDs and their private keys belong to
the vault. Their meaning never depends on the event author or the process
executing the full runtime. DID-document publication is outside vault state.

All communication DIDs have the same send, receive and continuity
semantics. The core stores no public/pairwise role. Disclosure records and
local address-allocation policy describe whether an address is public or was
created for private use with one peer. Where a DID sends is the one
DIDComm service of its own document, a mediator's routing DID or a direct
endpoint. Resolving an external mediator DID, including
`did:web`, does not create a local DID entity or a publication obligation.

<a id="mediation-events"></a>

### 5.1 Mediation events

<a id="mediation-created"></a>

#### `mediation.created`

```json
{
  "type": "mediation.created",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "mediatorDid": "did:web:mediator.example",
    "me": {
      "keyName": "mediation/019b2a51-118f-7e46-b31b-c63cd090c92c/me",
      "did": "did:peer:4zQm..."
    }
  }
}
```

This intent creates the stable vault-controlled identity for one mediation
arrangement. `me.keyName` MUST use the arrangement ID and `me.did` MUST match the
seed-derived key.

`profile` is OPTIONAL. Without it the arrangement is an ordinary Coordinate
Mediation account. Its only value is `"replica-mediation/1.0"`: the arrangement
is an account of the mediator's replica-mediation protocol, whose mail each
replica picks up under its own DID. Such an arrangement records `me.did` as a
`did:peer:4` long form, uses a mediation ID and account no ordinary arrangement
has used, and is never an ordinary arrangement retagged. `null` and every other
value are invalid. A reader that does not know the member refuses the payload
and so has no such arrangement, instead of treating it as an ordinary one.

Repeating the same arrangement ID with different values, `profile` included, is
an integrity conflict. A new attempt against the same mediator uses a new ID.

<a id="mediation-granted"></a>

#### `mediation.granted`

```json
{
  "type": "mediation.granted",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "routingDid": "did:peer:2.Ez..."
  }
}
```

This is the durable observation that the mediator granted the arrangement
and returned `routingDid`. For a replica-mediation arrangement it is the
observation of the mediator's `account-registered` reply, recorded once, and
`routingDid` equals the arrangement's `mediatorDid`; any other value is a
conflict.

More than one distinct routing DID for one arrangement ID is a conflict. The
runtime MUST NOT guess which grant is authoritative; it establishes a new
arrangement or obtains an explicit current answer from the mediator.

<a id="mediation-selected"></a>

#### `mediation.selected`

```json
{
  "type": "mediation.selected",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c"
  }
}
```

This is the user's or policy's preferred mediation for newly minted
mediated DIDs. The latest event by canonical order wins.

Selection does not stop old arrangements from receiving. Any mediation
that routes a retained DID remains required.

<a id="mediation-retired"></a>

#### `mediation.retired`

```json
{
  "type": "mediation.retired",
  "roots": [],
  "data": {
    "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
    "because": "replaced"
  }
}
```

Retirement is terminal for the arrangement ID. A procedure SHOULD give
every DID routed through it a successor first. A DID whose document sends
to the retired arrangement's routing DID waits under
[section 5.7](#route-did-and-key-fold) until another usable arrangement
names that DID; the fold never changes a DID's document.

<a id="replica-created"></a>

#### `replica.created`

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

This intent enrolls one replica in a replica-mediation arrangement. It MUST
be committed before the first `replica-add` request for that binding. Creating
an empty account with `account-register` does not require this intent to be
committed first. Before registering the account, the client validates any
existing local binding and the candidate grant; an invalid or conflicting
candidate MUST NOT cause a network request. A failed account registration
leaves a runtime with no prior replica binding free to choose another
arrangement. The intent records membership, not remote acceptance: what the
mediator confirmed is runtime state, and no event repeats per attempt.

The replica's DID is a `did:peer:4` whose input document carries the two keys
`replica/<replicaId>/me` derives and exactly one DIDComm service, the
arrangement's `mediatorDid`. The same replica at another mediator is therefore
another DID.

`grant` is the compact JWS the mediator's `replica-add` takes. Its protected
header is exactly `alg: "EdDSA"`, `typ: "estoc/replica-grant+jws"` and `kid`,
a DID URL naming an authentication method of the account under either spelling
of the account DID. The method is one a mediator reads an Ed25519 key from:
type `Multikey` or `Ed25519VerificationKey2020` with that key as its
`publicKeyMultibase`, or type `JsonWebKey2020` with it as a public OKP
`publicKeyJwk`. A signer chooses no other method, even one carrying the same
key. Its payload is the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) text of exactly these
string members:

| member | value |
| --- | --- |
| `account` | the short form of the arrangement's `me.did` |
| `mediation_id` | the arrangement ID |
| `mediator` | the arrangement's `mediatorDid` |
| `replica_id` | the replica ID, a canonical UUIDv7 |
| `replica_did` | the short form of the replica's DID, never the account |
| `replica_long_form` | the long form of `replica_did` |

The whole compact JWS is at most 16384 characters, its two separators
included: a mediator refuses a longer one unread. Every DID a grant carries is
also at most 8192 UTF-8 bytes, which alone does not keep the JWS within its
limit. A signer returns no grant over either limit. `replicaId` and
`mediationId` MUST equal the grant's. A payload whose grant is not spelled this
way, a payload that is not I-JSON included, is invalid; whether its `kid`, its
signature and its replica hold is the
[fold's](#mediation-fold).

<a id="did-identity-and-keys"></a>

### 5.2 DID identity and keys

<a id="did-created"></a>

#### `did.created`

A locally controlled communication DID is a Peer DID:

```json
{
  "type": "did.created",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "did": "did:peer:4zQm...rendezvous-short",
    "longFormDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document"
  }
}
```

The entity ID determines exactly
one authentication key name, `did/<id>/authentication`, and one key-agreement
key name, `did/<id>/key-agreement`, under [section 3.2](#single-seed). Both keys are immutable
for that entity; their names are derived, not stored as payload fields.

For every locally controlled communication DID:

- `did` is the canonical `did:peer:4` short form;
- `longFormDid` is the validated self-resolving long form;
- the input document's one DIDComm service is the DID's route under
  [section 5.3](#delivery-routes), a mediator's routing DID or an absolute
  HTTPS or WSS direct endpoint;
- seed-derived public keys MUST match that document; and
- changing keys or route creates another DID entity and an explicit scoped
  transition.

The entity has exactly two validated spellings: `did` and `longFormDid`.
External document claims establish no additional equivalence.

The long form is disclosed before the short form is relied upon by a peer.
The short form is canonical for vault references and mediator recipient
registration after the mapping is known.

Every locally created communication DID entity ID, including a privacy
successor, is a fresh UUIDv7. Same ID with different identity fields is an
integrity conflict.

<a id="delivery-routes"></a>

### 5.3 Where a DID sends

A communication DID's document names exactly one DIDComm service, and
that service is the DID's route: a mediator's routing DID, under which
the DID is routed by the mediation arrangement whose grant names that
DID, or an absolute HTTPS or WSS direct endpoint. The route is part of
the document, so the long form fixes it; nothing beside the document
records it and no event changes it. A transport or mediation change
creates successor DID entities, allowing old and new DIDs to overlap
during cutover. Each affected channel context uses its own
[section-6.5](#relationship-localtransitioned) local decision for new
intents; mediation selection does not migrate existing DIDs.

A direct endpoint routes to a full vault runtime or an ingress service.
It MUST NOT identify one replica as the DIDComm application recipient.
Minting the DID does not itself register a recipient.

One rendezvous DID and many pairwise DIDs may send through the same
arrangement or endpoint, which is how they reuse a mediator or direct
ingress without sharing an application identity.

A mediated DID is routed by the one usable arrangement whose grant names
its routing DID. While no arrangement does, the DID waits. While several
usable arrangements do, which account holds the address is undecidable,
and the DID waits until one of them is retired; a procedure MUST NOT mint
a DID for a routing DID in that state. Once the arrangement routing a DID
is retired, the DID waits again: the arrangements that may name a routing
DID are an open set, a grant not yet replicated here among them, so the
fold MUST NOT end a mediated DID's receipt on their account. Restoring
communication takes a successor DID or a usable arrangement naming the
same routing DID, never a change to the old entity.

<a id="disclosure"></a>

### 5.4 Disclosure

<a id="did-disclosed"></a>

#### `did.disclosed`

```json
{
  "type": "did.disclosed",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "as": "oob",
    "oobId": "019b2a57-a947-7502-8fee-4d80d949dbcb",
    "goal": "Write to Alice"
  }
}
```

`as` is `oob` for an OOB invitation or `direct` for a DID shared without one,
regardless of audience or publication medium. `oobId` is REQUIRED for `oob` and null otherwise;
`goal` is nullable. `didId` names a local DID entity under
[section 3.5](#identifier-and-reference-vocabulary), which retains its spellings.
Any live communication DID may be disclosed. An invitation is reusable: whoever
holds it writes to the disclosed DID in a channel of their own, and no receipt
takes it from the next; [the invitation fold](#invitation-fold) says whether
the DID still takes one.

An `oobId` MUST identify one local disclosure. Republishing an invitation reuses
that disclosure; a new invitation receives a new `oobId`. Distinct disclosures
with the same non-null `oobId` are an entity conflict, and republishing under
that ID is refused.

This permanently records disclosure. A mediated DID MUST have current
verified recipient registration before disclosure. Reusable/public disclosure
SHOULD use a discovery address and SHOULD NOT expose an address allocated for
private communication. These privacy policies grant no cryptographic authority.
First disclosure exposes the validated `did:peer:4` long form.

<a id="did-retired"></a>

### 5.5 `did.retired`

```json
{
  "type": "did.retired",
  "roots": [],
  "data": {
    "didId": "019b2a54-05bd-74ef-b8ac-e8375cb776c2",
    "because": "address-no-longer-needed"
  }
}
```

Retirement is terminal for new sending and disclosure using this DID. Its mediated recipient registration leaves the desired set.
It does not erase keys, documents, received messages or continuity evidence.

A retained exact local key remains eligible for authenticated channel
receipt while a usable arrangement routes it, including after DID
retirement, and waits while none does. This rule applies equally to publicly disclosed and privately
allocated addresses. No renewed registration is required to drain retained
deliveries. An invitation on a retired local DID is unavailable.
[relationships.md section 9](relationships.md#uniform-receipt) owns the receipt gates;
[distributed-delivery.md section 4.3](distributed-delivery.md#receive-a-message) owns the receive procedure.

Retain key/document evidence and usable mediation needed by retained channels.
Channel denials and sender eligibility govern new work. Retained
confirmation may justify an explicitly requested recovery rotation without reviving
the old address. Retirement never erases committed message or delivery evidence;
display contact deletion alone is not a transport or authorization operation.

<a id="142-mediation-fold"></a>

<a id="mediation-fold"></a>

### 5.6 Mediation fold

For each mediation ID:

- exactly one consistent `mediation.created` defines mediator and key;
- one consistent `mediation.granted` makes it usable;
- any `mediation.retired` makes it terminal; and
- conflicting create or grant values make it unusable and visible as a
  conflict, as does a replica-mediation arrangement granted a routing DID
  other than its mediator.

The preferred mediation is the latest `mediation.selected`. If it is missing,
ungranted, retired or conflicted, preferred is null and policy must select
another before minting a new mediated DID.

The **required receiving set** contains every usable mediation that is preferred
or that routes a retained local DID, including a retired DID, under
[section 5.7](#route-did-and-key-fold). Its exact key/document evidence
must be consistent; recoverable missing material leaves that dependency pending
instead of removing it. Allocation/disclosure
policy has no effect on this set. An unpreferred mediation leaves only when no
such dependency remains or it becomes unusable.

This is independent of the desired recipient registration set: draining
retained messages does not re-register a retired DID. A retired mediation
routes nothing and is never required; receipt under a DID it routed waits
for another usable arrangement naming the routing DID. Temporary
unavailability does not erase dependencies.

The active runtime reconciles recipients and drains account-scoped pickup on
every reachable mediation in this set. A hosted runtime receives no special
ownership.

For each replica ID, grants equal in `account`, `mediation_id`, `mediator`,
`replica_id` and `replica_long_form` are one binding, whatever `kid` each was
signed under and whoever authored the events. Different bindings for one
replica ID are a conflict; no canonical-order winner is chosen. A replica with
one binding is a member of its arrangement when all of these hold:

- the arrangement has one consistent creation naming the replica-mediation
  profile;
- the grant's `account` is the short form of that creation's `me.did` and its
  `mediator` equals `mediatorDid`;
- the grant's `kid` spells the account as its short form or as exactly the
  long form that creation records, and its fragment names a method which that
  long form's document authorizes for authentication and which carries the
  authentication key the seed derives for `mediation/<mediationId>/me` under
  one of the [type and encoding pairs a grant's `kid` may name](#replica-created):
  the same key under any other type is a grant no mediator takes;
- the grant's signature verifies under that key; and
- the replica's document carries the keys the seed derives for
  `replica/<replicaId>/me` and names that mediator as its only DIDComm service.

A missing creation or an unavailable seed leaves the replica pending; a failed
condition, disagreeing creations included, makes it a conflict. Membership is
read from the creation and the grant alone: it needs no `mediation.granted`, is
not changed by a missing, contradicting or disallowed routing grant, is not
ended by the arrangement's retirement, and says nothing of what the mediator
holds. Whether the arrangement can carry mail remains the mediation fold's: a
member of a conflicted or retired arrangement receives nothing through it. A writer enrolls only the member whose replica ID is its own.

<a id="143-route-did-and-key-fold"></a>

<a id="route-did-and-key-fold"></a>

### 5.7 DID and key fold

For each DID entity ID:

- exactly one consistent `did.created` defines its spelling set, fixed
  keys and, through its document, its route;
- disclosures are every valid `did.disclosed` in canonical order; and
- any `did.retired` makes the DID entity terminal.

The fold verifies all of the following:

- key names are derived from the DID entity ID and the fixed purpose suffixes
  in [section 3.2](#single-seed);
- the seed-derived public keys match the Peer DID input document;
- the entity stores a valid long form and its derived canonical short form;
- the document names exactly one DIDComm service, a DID or an absolute
  HTTPS or WSS URL, under [section 5.3](#delivery-routes); a document that
  does not is a conflict; and
- a mediated document's routing DID is named by the grant of exactly one
  usable arrangement, which routes the DID.

A DID is **terminal for receipt** only on its own account: no consistent
creation, or a conflict above. A mediated DID whose routing DID no one
usable arrangement names — none yet, none granted, every one known retired
or in conflict, or several usable — is **pending**: the arrangements that
may name a routing DID are an open set, and a grant that has not arrived
MUST NOT be mistaken for one that never will. A temporarily unavailable
endpoint is not a fold state. A direct DID waits only for its key check.

For recipient reconciliation, a live DID is a non-retired, conflict-free
entity satisfying those local identity and route checks. Current recipient
registration is not a prerequisite for entering the desired set; reconciliation
establishes it. Many DIDs may send through one arrangement or endpoint. This
is transport reuse, not DID or contact equivalence.

The desired mediator recipient set contains exactly each
`(canonical DID short form, mediation ID)` pair for a live mediated DID and
the arrangement that routes it. On every connection the phase-1 runtime queries each mediator
and reconciles that desired set with ordinary Coordinate Mediation
`recipient-query` and `recipient-update`. Current registration is runtime state,
not portable vault state. A restore re-queries the mediator before disclosure
or submission.

If the mediator reports a registered recipient with no retained local DID
entity, the runtime MUST expose a bounded visible local diagnostic of the
registration/state mismatch. The observation does not recreate a DID or
establish why its local record is absent. Reconciliation still removes
registrations outside the desired set. Other registration diagnostics MAY be
kept in local trace.

Direct DIDs do not enter that set. They lead to a full vault runtime
or ingress service without naming a replica as the application recipient.

The fold also maintains a reverse map from every local communication key name
to exactly one DID entity. Both validated Peer spellings map to that entity,
but a recipient fragment must still identify its exact key-agreement method.
The map retains retired DIDs and DIDs whose arrangements retired for historical
input and proof joins. Present liveness controls sending and desired
registration; new receipt uses [section 5.5](#did-retired) and [relationships.md section 9.2](relationships.md#hard-pre-vault-gate)'s
eligibility rule for live and retained historical addresses.
Ambiguous or inconsistent mapping is an integrity conflict and prevents
cryptographic use.

<a id="149-invitation-fold"></a>
<a id="invitation-fold"></a>

### 5.8 Invitation fold

Fold each OOB disclosure into one invitation: its `oobId`, its local DID and
whether that DID still takes a first message under it. An invitation is
available while the disclosed DID is live and routed where it may deliver, and
unavailable once the DID is retired or in conflict, its creation is missing,
or while the DID waits to be live, its arrangement retired or ungranted
included. An `oobId` that distinct disclosure events carry, as
two merged histories may each have disclosed it, names no one invitation to
hand out again: every disclosure under it is unavailable with a reason that
says so, none is chosen by event order, and the conflict changes nothing of
the DIDs' liveness, of receipts under them, or of channel identity and
continuity. Receipts under the invitation are ordinary receipts
under [section 6.1](#receipt-and-relationship-evidence): the fold records nothing
of who used it, and nothing a peer sends under it takes it from the next.
[channels.md](channels.md#invitations) owns the rule.

<a id="12-relationships-and-address-changes"></a>
<a id="relationships-and-address-changes"></a>

## 6. Channels, continuity and contact membership

Channel identity, invitations, continuity links, local denial and contact views
are defined in [channels.md](channels.md).

<a id="121-receipt-and-relationship-evidence"></a>
<a id="receipt-and-relationship-evidence"></a>

### 6.1 Receipt and channel evidence

Channel receipt commits independently. Each source-derived operation rechecks
its exact DID pair, evidence and applicable policy under one vault operation
lock.
Every event reference must
name an already committed event; use returned CIDs, not an assumed same-batch
CID. Release the vault lock before network calls. Per-message dispatch is
separately serialized under [delivery](distributed-delivery.md#send-an-ordinary-message).

<a id="123-relationshipcontactassigned"></a>
<a id="relationship-contactassigned"></a>
<a id="contact-peerdidadded"></a>
<a id="contact-peerdidremoved"></a>
<a id="contact-channelsset"></a>

### 6.2 `contact.channelsSet`

```json
{
  "type": "contact.channelsSet",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "channels": [
      {
        "localDid": "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd",
        "peerDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP"
      }
    ]
  }
}
```

The closed data contains exactly `contactId` (UUIDv7) and `channels`, an array
of closed `{localDid, peerDid}` selectors under [channel identity](channels.md#channel-identity);
`roots` is empty. The list is duplicate-free and sorted by the canonical pair
encoding specified there. Latest canonical event per contact replaces its entire
selected set; an empty list clears it. Concurrent sets are not unioned. No set
event means an empty selection. This event neither creates a contact nor
restores a deleted contact; missing contact data affects only presentation.

Selections may be edited offline; missing evidence leaves an unresolved display
selection. One channel MAY be selected by several contacts, each with its own set.
Membership grants no protocol authority. Derived related history follows
[the channel view rules](channels.md#contact-channels) without rewriting the set.

<a id="112-relationshippeertransitioned"></a>
<a id="relationship-peertransitioned"></a>

### 6.3 Peer proof evidence and continuity

Derive the issuer document and verify each committed carrier's original
`fromPrior` under [channels.md](channels.md#peer-proof-evidence). A long-form
issuer supplies its immutable document directly; a short-form issuer requires
the matching retained `peer.resolved` document. The original JWT is event
metadata, and `peer.resolved` independently retains its document root, so
message-content erasure removes neither source of issuer material.
No association, link or trusted verification result is stored as an event.
Verification requires neither handler execution nor a known predecessor channel.

Use the shared proof profile through
[the vault adapter](channels.md#continuity-integration), with
`@estoc/continuity/from-prior` owning parsing, profile checks, signature
verification, creation and receipt binding. The issuer material is its validated
long-form DID: an arbitrary document with the same claimed ID cannot replace
the document encoded in that DID. The retained document/CID must match that
immutable representation.

The proof's `iss` canonicalizes to that issuer and the predecessor peer;
binding requires `sub` to canonicalize to the receipt's authenticated sender.
Long and short spellings of the same DID compare equal, including the DID
portion of `kid`; the method fragment still identifies the authorized
authentication key. Preserve the original JWT, document and presented sender
spellings without rewriting signing input. The package profile accepts optional
`typ` as `JWT` or `application/jwt` without case sensitivity and rejects `exp`
and `nbf`; it evaluates no clock window. These are examples of the shared
profile, not permission for a separate vault parser. `iat` elects no branch.
Local producers additionally use the fixed long-form spellings required by
[local rotation](channels.md#did-rotationselected).

Verification and rebuild follow [predecessor resolution](relationships.md#predecessor-resolution).
Restored issuer material can complete a short-form proof only when its validated
long form derives the exact issuer; referenced document bytes can be repaired
only when their canonical CID matches.
Missing material defers verification; an invalid signature, claim, method or
long form grants no proof authority. Repeated evidence for the same predecessor and
successor is the same DID replacement across validated long/short spellings.
Verify each carrier's own authentication references and original JWT against
the immutable documents; another spelling alone is not a competing successor. Shared
keys, current resolution alone and display assignment cannot replace the
channel context and verified proof.

<a id="124-relationshiplocaltransitioned"></a>
<a id="relationship-localtransitioned"></a>

### 6.4 Local continuity decisions

The [did.rotationSelected schema](channels.md#did-rotationselected) defines the
fixed predecessor pair, successor, proof, nullable source and independent
confirmation requirement. Commit it before disclosure under
[the rotation procedure](#rotate-a-local-relationship-address). Rotation selects
channels for new intents only; existing intents retain their channel and may
become undispatchable under [dispatch authority](channels.md#fixed-outbound-channel).

<a id="144-relationship-fold-and-address-index"></a>
<a id="relationship-fold-and-address-index"></a>

### 6.5 Channel and continuity projections

Index exact ordered pairs by their canonical local and peer DID strings.
Derive directed links, verified opposite-side joins, local-only supersession contexts and
denials under [channels.md](channels.md#continuity). Edges and verification
statuses are derived; each edge exposes its complete source witnesses.
Missing references defer the affected projection; contradictory identities,
proofs or same-end successors conflict. Message and execution identities remain
fixed when graph history changes.

<a id="7-contacts"></a>

<a id="contacts"></a>

## 7. Contacts and application views

A contact uses a `contactId` to organize [selected channels](#contact-channelsset),
names and preferences independently of protocol authority.

<a id="contact-ids"></a>

### 7.1 Contact IDs

See [relationships.md section 5.1](relationships.md#contact-ids).

<a id="contact-event-schemas"></a>

### 7.2 Contact event schemas

Direct channel selections use `contact.channelsSet` in
[section 6.2](#contact-channelsset).

<a id="contact-created"></a>

#### `contact.created`

```json
{
  "type": "contact.created",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "because": "user"
  }
}
```

`because` is `user` or `automatic`.

Commit this event together with an initial non-empty `contact.channelsSet`.
Selection may precede receipt, outbound intent or peer resolution. Imported
creation without its membership remains valid with an empty selection until
that membership arrives; later sets may be empty under [section 6.2](#contact-channelsset).

<a id="contact-petname"></a>

#### `contact.petname`

```json
{
  "type": "contact.petname",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "name": "alice"
  }
}
```

Latest by canonical order wins for that `contactId`.

<a id="contact-flag"></a>

#### `contact.flag`

```json
{
  "type": "contact.flag",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "flag": "pinned",
    "value": true
  }
}
```

Latest per `(contactId, flag)` wins.

<a id="contact-usedid"></a>

#### `contact.useDid`

```json
{
  "type": "contact.useDid",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "didId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "because": "channel"
  }
}
```

This outbound preference associates one of our communication DID entities
with the contact. `data.didId` is that entity's `did.created.data.didId` under
[section 3.5](#identifier-and-reference-vocabulary). `because` is `channel`, `rendezvous`,
`manual` or another documented policy value.

This selects among eligible channels for a new send under [the contact fold](#contact-fold)
without changing `contact.channelsSet`. Publicly disclosed addresses may send;
private allocation follows [the address policy](relationships.md#early-private-address-policy-and-notifications).

<a id="contact-merged"></a>

#### `contact.merged`

```json
{
  "type": "contact.merged",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da",
    "fromContactId": "019b2a66-c794-7b41-bff1-68a4ecdd0b67"
  }
}
```

This is a display-only grouping hint between `contactId` and `fromContactId`.
A UI MAY group their views; each retains its ID, decisions and channel set.
The hint MUST NOT affect attribution, DID selection, protocol identity or
authority, deletion or erasure.

<a id="contact-deleted"></a>

#### `contact.deleted`

```json
{
  "type": "contact.deleted",
  "roots": [],
  "data": {
    "contactId": "019b2a63-48bf-7214-961d-4c3f97cb95da"
  }
}
```

This is a permanent tombstone for exactly the named contact ID.

<a id="113-profilenameclaimed"></a>
<a id="profile-nameclaimed"></a>
<a id="114-profileshared"></a>
<a id="profile-shared"></a>
<a id="145-relationship-profile-fold"></a>
<a id="relationship-profile-fold"></a>
<a id="application-message-views"></a>

### 7.3 Application message views

Applications MAY derive display data from retained messages under a supported
protocol and local display policy. The protocol defines fields, interpretation
and ordering. Every value retains its exact source and channel; inbound claims
require a complete source witness and consistent logical intent under
[operation eligibility](channels.md#operation-eligibility). Missing evidence
defers attribution; conflicting evidence supports no verified claim. Duplicates
and cache rebuilds neither create facts nor advance their ordering.

Ordinary chat, peer-profile fields and incoming ACK/error projections additionally
require effective application admission of their exact source. Unadmitted
observations belong to labelled diagnostics, not accepted application data.

A peer name must come from a protocol-recognized field and remains a peer claim.
It creates no contact, changes no `contact.petname` and grants no sharing
permission. To display a profile as submitted, require a protocol-recognized
`message.out` and complete committed submission evidence; this proves no peer receipt.

Caches must be rebuildable from retained sources. Read content through
[section 12.2](#reading-content).
Erasure invalidates values requiring the erased bytes, even if another message
retains the same object. Retained metadata and delivery records still support
their own facts; explicit petnames remain separate. Missing or erased evidence
does not prove information was never shared. Aggregation retains source-channel
attribution and grants no cryptographic authority or sharing permission.
Rebuilding or losing a view grants no dispatch action.

<a id="146-contact-fold"></a>
<a id="contact-fold"></a>

### 7.4 Contact fold

Fold contacts independently: permanent deletion tombstone, latest
petname/flags, latest local-DID preference under `contact.useDid`, and the
latest `contact.channelsSet`. A tombstone hides the contact even if later
membership events exist; its channels remain independently available. Aggregate
source-labelled application data and channel-local messages without merging their
identities or counting a message twice within one combined view. Missing or
conflicting authentication evidence remains visible in the source channel.

`writeTo[]` contains the distinct eligible head channels for a new user send
from the contact's selected contexts, under
[the head-selection rule](channels.md#fixed-outbound-channel).
Each choice needs its exact pair, usable local key/route, current send policy
and, for a derived continuation, complete link evidence. An empty selection
gives an empty `writeTo[]`.
A newly discovered peer address first needs an explicit local-DID choice to
form a complete channel. Add that pair to the contact's selection or send to
it independently of a contact. Its fixed-channel intent may precede peer
resolution; preparation still validates its own peer resolution.
`contact.useDid` expresses a local-address preference among those heads,
following verified local successors in the same context even when its saved
`didId` names a predecessor. If applying the preference does not leave exactly
one eligible head, the caller must explicitly select an eligible channel before
intent commit. A channel with a replaced local sender or peer recipient is
outside `writeTo[]` and cannot be used by an explicit pre-rotation override.
Names, peer-DID matches and
contact merges cannot resolve ambiguity or supply dispatch authority.

Blocking and cleanup follow [contact deletion](#delete-a-contact), independently
of regrouping. Displayed key changes require exact channel evidence; Report
Problem attribution follows [the error rules](relationships.md#remote-errors-and-integrity-failures).

<a id="stored-message-document"></a>

## 8. Stored message document

Message application content is stored as one whole-resource raw DASL object
containing UTF-8 RFC 8785 canonical JSON. Version 4 uses the following closed
stored representation:

```json
{
  "body": {
    "text": "hello"
  },
  "attachments": [
    {
      "id": "a1",
      "description": null,
      "filename": "photo.png",
      "media_type": "image/png",
      "format": null,
      "lastmod_time": null,
      "byte_count": 48213,
      "data": {
        "kind": "base64",
        "root": "bafkrei...",
        "hash": null,
        "jws": null
      }
    }
  ]
}
```

`body` is the DIDComm application body object. `attachments` preserves wire
order. Every stored descriptor has exactly these members:

```text
id, description, filename, media_type, format,
lastmod_time, byte_count, data
```

Missing optional wire members and explicit JSON null both normalize to null.
A present empty string remains an empty string, except that a non-null
attachment `id` MUST be non-empty and consist only of URI unreserved
characters. This is the DIDComm 2.1 attachment-ID restriction required so the
ID can be safely composed into URI references; it is unrelated to object CIDs
or filenames. For example, `urn:uuid:...` is not valid here because `:` is not
an unreserved character. `lastmod_time` is an Epoch-Seconds integer or null.
`byte_count` is
a non-negative integer or null.

The `data` member has exactly one of these closed structural forms:

```ts
type StoredAttachmentData =
  | {
      kind: "base64";
      root: Cid;
      hash: string | null;
      jws: JsonValue | null;
    }
  | {
      kind: "json";
      root: Cid;
      hash: string | null;
      jws: JsonValue | null;
    }
  | {
      kind: "links";
      links: string[];
      hash: string;
      jws: JsonValue | null;
    };
```

For `base64`, `root` names the raw DASL object containing decoded bytes. For
`json`, it names the raw DASL object containing `UTF8(RFC8785(json value))`.
For `links`, `links` is a non-empty ordered array and `hash` is required.
Exactly one wire content carrier among `data.base64`, `data.json` and
`data.links` is accepted. Multiple carriers are ambiguous and rejected.

Normalization is deterministic:

- inline base64 is decoded once; `byte_count` becomes the exact decoded byte
  length, and a present conflicting wire value is invalid;
- inline JSON is RFC-8785-canonicalized; `byte_count` becomes the exact UTF-8
  length, and a present conflicting wire value is invalid;
- a links descriptor preserves the ordered link strings without fetching
  them; `hash` is required, and `byte_count` is the non-negative wire value or
  null;
- `hash` is the exact wire multihash string or null for inline data;
- `jws` is the exact wire JSON value, normalized as an RFC 8785 JSON value, or
  null;
- inline payload roots appear in the enclosing event's `roots`; link-only
  descriptors have no payload root; and
- unsupported descriptor or data members are excluded from this version's
  portable stored representation. A versioned protocol extension that needs
  another member MUST define its normalization and semantic projection before
  using it.

An implementation MAY retain additional raw-wire diagnostics outside the
portable stored message, but such diagnostics do not affect semantic equality.
There is no implementation choice about which portable attachment fields are
hashed.

Canonical projections and message hashes are defined by [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes).

<a id="9-outbound-message-events"></a>

<a id="outbound-message-events"></a>

## 9. Outbound messages and delivery

<a id="ids"></a>

### 9.1 IDs

- `messageId` is both the outbound vault message entity ID and the innermost
  DIDComm plaintext `id`.
- `packageId` identifies one exact encrypted inner envelope and is Routing
  2.0 `forward.id`.
- mediator `deliveryId` is not stored by outbound events.

A user send mints one UUIDv7 `messageId`. Its package uses it as plaintext `id`.
Outbound events do not store a second `wireMessageId`. Inbound observations keep
their scoped message ID and the received wire ID under [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity); the equality applies only to locally authored outbound messages.

An automatic effect derives:

```text
messageId = UUIDv5(
  8847bd57-5907-5bcd-9a71-d1e97cee3199,
  RFC8785(["v1", effectKey])
)
```

The resulting `messageId` is also the response's wire ID. Preparation and manual
retry preserve this ID and its fixed channel. Equivalent automatic effects
therefore identify one logical response.

<a id="message-out"></a>

### 9.2 `message.out`

```json
{
  "type": "message.out",
  "roots": ["bafkrei...body", "bafkrei...attachment"],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "senderDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "recipientDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "thid": null,
    "pthid": null,
    "createdTime": null,
    "expiresTime": null,
    "pleaseAck": [""],
    "ack": [],
    "headers": {},
    "bodyCid": "bafkrei...body",
    "attachmentCids": ["bafkrei...attachment"],
    "intentHash": "<base64url-sha256>",
    "executionId": null,
    "effectType": null,
    "effectKey": null,
    "sourceEventCid": null,
    "rotationEventCid": null
  }
}
```

`senderDidId` and `recipientDid` are REQUIRED and immutable. Under the operation
lock, select an eligible local DID entity and a peer DID before intent commit.
Their canonical pair fixes the channel under [fixed outbound channels](channels.md#fixed-outbound-channel).
`recipientDid` retains the exact supplied spelling, including a validated Peer
long form for offline preparation; canonicalize it for channel/package comparison.
Selection requires no resolver lookup; preparation retains its own peer evidence.

An automatic output selects the source's channel or a verified role-preserving
successor under [operation eligibility](channels.md#operation-eligibility).
A UI may select through a contact, but its ID is not protocol identity. The
fixed address fields are excluded from the intent hash and included in full
event equality.

Requirements:

- `createdTime` and `expiresTime` are Epoch-Seconds integers or null;
- when both are non-null, `expiresTime` is strictly greater than
  `createdTime`;
- null `createdTime` omits the DIDComm `created_time` header;
- `pleaseAck` is null or the exact ordered wire array; `ack` is `[]`, or,
  for a pure ACK or an explicit ACK another application protocol defines,
  exactly the source carrier's wire ID under
  [distributed-delivery.md section 8.1](distributed-delivery.md#the-ack-target);
- `headers` contains every otherwise-unmodeled supported top-level DIDComm
  header and no reserved field, including `return_route`;
- `bodyCid` names the canonical stored message document;
- `attachmentCids` is the distinct ordered list of object-backed attachment
  payload roots from that document; link-only descriptors add no entry;
- `roots` is the distinct ordered set of `bodyCid` followed by `attachmentCids`;
- `intentHash` is computed under [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes);
- `executionId`, `effectType` and `effectKey` are all
  null for a locally initiated send and all non-null for an inbound-derived
  protocol effect, including explicit completion of pending response work;
- `sourceEventCid` is required and non-null for an inbound-derived effect,
  otherwise null. It names one exact already committed `message.in` forming a
  complete source witness. Its logical input derives `executionId`; its actual
  channel is the output channel or a verified role-preserving predecessor.
  Authentication and required proof evidence must be complete independently
  of the intent;
- `rotationEventCid` is required and non-null exactly for a dedicated rotation
  notification. It names an already committed `did.rotationSelected`; sender,
  recipient and notification fields obey [the built-in operation rules](distributed-delivery.md#built-in-independent-operations).
  If that decision has a trigger, the intent's `sourceEventCid` equals the
  decision's `sourceEventCid`, whose channel matches its `fromDidId`/`peerDid`,
  and its effect tuple uses that source. Without a trigger, the source reference
  and all three effect fields are null; the locally initiated intent still
  names the rotation.
  An ordinary message carrying the selected proof is not a notification and
  keeps `rotationEventCid == null`;
- a locally initiated send has `ack == []`; honoring an inbound ACK request uses
  the deterministic response algorithm;
- `effectType` is the protocol-defined operation URI under
  [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects);
  distinct operations may share a DIDComm `msgType` but have distinct effect types;
- an automatic intent stores the complete `(executionId, effectType)` tuple. Validation checks
  its execution ID against the carrier group, its tuple and intent against the
  producing protocol, recomputes its key under [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects), and requires its `messageId` to equal the [section-9.1](#ids) derivation;
- the three automatic-effect fields and two source/rotation references are portable metadata excluded from
  the wire and intent hash; they still participate in full event equality;
- `thid`, `pthid`, `expiresTime` and all three automatic-effect
  fields are present with null when unused; and
- appending this event requires no network, resolver, mediator or socket.

A preparer emits `created_time`, `expires_time`, `thid` and `pthid` only when
non-null; emits `please_ack` whenever `pleaseAck` is non-null; emits `ack` and
`attachments` when non-empty; and expands `headers` at plaintext top level.

Import validates the exact saved source, fixed endpoints and required proof evidence.
It does not rerun old local policy to erase a previously committed intent;
current policy still gates any new dispatch. A duplicate trigger reuses the
existing intent without replacing its source references with another observation.

More than one `message.out` under one `messageId` is allowed only when every field
is identical. Different channel, sender or recipient values conflict even when
the intent hashes agree. Reuse of one wire ID with a different intent projection
is an intent conflict.

<a id="message-prepared"></a>

### 9.3 `message.prepared`

```json
{
  "type": "message.prepared",
  "roots": [
    "bafkrei...encrypted-envelope"
  ],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c",
    "senderDidId": "019b2a60-c68e-75bf-b6fb-ae1a41f8d715",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "recipientDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "peerResolutionEventCid": "bafkreiefyoi7yed7cmfo7woi5kahpw7zu7uq6pj6avn4lgkbfwalkoxl7a",
    "fromPrior": null,
    "intentHash": "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA",
    "plaintextHash": "WkPpglZREjLGtviZ1L6c-R3EX1cTHtbe0sJrmhl77LQ",
    "envelopeCid": "bafkrei...encrypted-envelope"
  }
}
```

This event makes one exact normalized encrypted envelope recoverable as data.
Importing it grants no dispatch permission to another runtime.

Requirements:

- `senderDidId` equals the fixed sender in `message.out`; retained key/route
  eligibility is checked without replacing it with a later current address;
- the package matches the exact oriented channel in a valid `message.out` and
  has complete local-key and peer-resolution evidence;
- `localKeyName` is that entity's key-agreement key and authorizes the plaintext
  `from` under the exact spelling used by the package;
- the plaintext `id` equals `message.out.messageId`; its other semantic fields
  and immutable control headers equal the committed intent;
- `intentHash` equals the intent value;
- `plaintextHash` hashes the complete plaintext actually encrypted;
- `recipientDid` is the package's exact application `to` DID;
- the canonical sender and recipient must equal the intent's fixed endpoints
  in the same roles under [channel identity](channels.md#channel-identity);
- `peerResolutionEventCid` names the exact `peer.resolved` evidence used to select
  the recipient key; its `peerPublicKey` supplies the package's derived peer key.
  Its `localKeyName` equals the package's local key and its canonical `did` matches
  `recipientDid`. It is non-null for every phase-1 package, including a
  retained numalgo-4 resolution. Local resolution and evidence reuse follow
  [relationships.md section 10.1](relationships.md#did-resolution-requirements);
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization. The `envelopeCid` CID commits to those exact bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

<a id="delivery-attempted"></a>

Committing this event freezes the package for its `messageId`, even before any
transport call. Further `message.prepared` records for that message MUST have
identical payloads and roots, including `packageId` and exact evidence references.
Under the operation lock, reuse an existing preparation and reject a different
one before append. Imported incompatible preparations expose a conflict;
no event order selects a winner. Missing exact evidence or envelope bytes
defers sending and cannot justify another preparation.
A retained package reference whose preparation is missing remains pending;
it is not evidence that no package was selected.

Initial sends and manual retries use this package unchanged under
[dispatch authority](channels.md#fixed-outbound-channel). An uncertain commit
must be resolved before dispatch or further preparation. A package records no
transport invocation; call counts and retry diagnostics are local trace.
Submission or message-scoped termination stops preparation and retry. Recheck
lifecycle and security at dispatch without invalidating historical evidence.
Public and pairwise addresses use the same package rules and name no replica.

<a id="delivery-submitted"></a>

### 9.4 `delivery.submitted`

```json
{
  "type": "delivery.submitted",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "packageId": "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c"
  }
}
```

This says only that one transport endpoint accepted the package. It does not
mean route existence, mediator retention, pickup or ultimate durable receipt.

The closed data contains exactly `messageId` and `packageId`; `roots` is empty.
`packageId` MUST identify the already committed valid `message.prepared` for
this exact `messageId`. Append this event after observing transport acceptance.
Its successful commit completes the logical outbound under
[section 9.7](#outbound-message-and-delivery-fold).
If acceptance happened but this observation did not commit, the outcome remains
unconfirmed and requires explicit manual retry; recovery never resubmits it.

Transport, endpoint and response status are local trace data. They are not
fields of this portable event and do not participate in the delivery fold.

<a id="delivery-failed"></a>

### 9.5 `delivery.failed`

```json
{
  "type": "delivery.failed",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "code": "expired"
  }
}
```

This event terminates an unsubmitted message through expiry or explicit
cancellation. Its closed data contains exactly `messageId` and `code`;
`roots` is empty. `messageId` names the outbound intent.

`code` is exactly one of:

- `expired`: the unsubmitted intent reached its non-null expiry; or
- `cancelled`: an explicit user action cancelled the unsubmitted intent.

An `expired` failure for an intent with null `expiresTime` is invalid and
terminates nothing.

Both codes terminate the entire message, before or after preparation. They
stop all preparation and submission, including manual retry. Termination
requires no package reference or preparation evidence; a preparation imported
later cannot reopen the intent. Further sending requires a new message ID.
A termination never proves nondelivery: an earlier unrecorded call may have
succeeded. Any independently complete submission takes precedence after import.

An explicit cancel action serializes with dispatch for the message, rechecks
submission under the operation lock and appends `code == "cancelled"` only
while unsubmitted. It may cancel before preparation or after an outcome-unknown
call. Cancellation preserves message content.

Resolution and transport failures, the `resolve`/`prepare`/`submit` phase and
retry diagnostics belong only to local trace and retry policy. They MUST NOT append
`delivery.failed`. Losing that local state does not terminate the intent or
change its portable delivery state.

A worker that observes a non-null `expiresTime` with `now >= expiresTime` for an
unsubmitted outbound before prepare or retry appends that expired failure and
submits nothing. It does not
append an expired failure merely because an already-submitted message later
reaches expiry. A later user attempt requires a new `message.out` and wire ID.
Sensitive strings remain in local trace; `code` is a stable non-secret value.

<a id="delivery-acknowledged"></a>

### 9.6 `delivery.acknowledged`

```json
{
  "type": "delivery.acknowledged",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "peerPublicKey": "<alice-pairwise-public-key>",
    "ackMessageId": "27c4471f-8937-501b-9ffb-a7eaeeebc178",
    "ackWireMessageId": "21559fb4-1a9f-54b1-b8fa-1bf82700d365"
  }
}
```

The exact carrier is an admitted complete source witness under
[operation eligibility](channels.md#operation-eligibility). Its explicit `ack`
names this outbound wire ID. Its channel must be the
outbound's fixed channel or a verified role-preserving successor under
[channels.md](channels.md#continuity). Validate the outbound intent and exact
prepared package independently; display membership never supplies that path.
All redundant local-key, sender, wire-ID and message fields match this one
complete witness. Do not assemble a witness from incomplete sibling rows.

This records peer receipt information only. It cannot synthesize submission,
release a package envelope or authorize a retry. Missing references defer;
incompatible evidence conflicts. All five data fields are required:
`messageId` names the outbound; `ackMessageId` and `ackWireMessageId` name
the carrier's vault and wire IDs; `localKeyName` and `peerPublicKey` equal
that complete carrier's local key and derived authenticated peer key.

<a id="148-outbound-message-and-delivery-fold"></a>
<a id="outbound-message-and-delivery-fold"></a>

### 9.7 Outbound message and delivery fold

For each message ID, require one consistent complete `message.out` intent.
Validate preparations under section 9.3. One consistent package is allowed;
incompatible preparations conflict without an event-order winner. Missing exact
references block dispatch and cannot justify another package.

Derive these independent facts:

- `packages[]`: individually valid preparations, including retained skeletons
  and imported competing candidates; dispatch requires one consistent package;
- `submitted`: a complete valid `delivery.submitted` names the exact matching
  intent and package. Validate its own evidence before aggregate eligibility;
  later erasure, termination, policy or a competing package cannot remove this
  historical fact. An incomplete unrelated row cannot erase it;
- `ackWitnesses`: all admitted complete source witnesses satisfying section 9.6;
- `acknowledged`: at least one such witness exists; and
- message terminations and permanent erasures under their schemas.

For an inbound-derived output, verify its `(executionId, effectType)` tuple
against its exact complete source witness in the channel-local
execution and the producing protocol's operation rules. Each tuple permits
at most one compatible intent. ACK, Ping reply and rotation notification have
distinct effect types.
A tuple-local output conflict stops that operation; an authenticated
source-intent conflict stops all affected
source-derived work. Notification selection conflicts are scoped to the exact
rotation decision. None of these conflicts reopens recorded submission.

Portable eligibility requires valid evidence, retained bytes, an unexpired,
unsubmitted, nonterminal, nonerased intent and permitted keys/routes/channel
policy. Dispatch additionally requires a live initial or fresh manual action
under [channels.md](channels.md#fixed-outbound-channel).

Displayed outcome precedence is:

```text
conflict
submitted
terminal
prepared
queued
```

`terminal` covers valid committed expiry or explicit cancellation of the
consistent intent; its code supplies the reason, independently of preparation
evidence. `queued` and `prepared` describe retained intent/package
state, not whether a transport call occurred. Missing submission, including in
a partial snapshot, does not prove nondelivery. Restored pending records require manual action;
the UI may show that requirement separately. A submitted/terminal record
cannot retry; a deliberate new send creates a new ID without altering the old outcome.

Receipt timing uses the earliest parsed RFC 3339 source-observation `at` among
valid ACK witnesses. `late` is true exactly when acknowledged, an immutable
expiry exists, and that instant is at or after expiry. It uses no current
clock or `delivery.acknowledged.at`. Neither ACK timing nor missing ACK changes
submission state, envelope retention or dispatch authority.

<a id="10-inbound-message-events"></a>

<a id="inbound-message-events"></a>

## 10. Inbound messages and execution

<a id="deterministic-inbound-observation-message-id"></a>

### 10.1 Deterministic inbound observation message ID

See [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity).

<a id="message-in"></a>

### 10.2 `message.in`

```json
{
  "type": "message.in",
  "roots": [
    "bafkrei...body",
    "bafkrei...attachment"
  ],
  "data": {
    "messageId": "d2192dcf-cc5c-5f7d-b4f1-46972b7b04de",
    "wireMessageId": "019b2a70-f225-721c-835f-67175be0667e",
    "intentHash": "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
    "plaintextHash": "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
    "localKeyName": "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement",
    "msgType": "https://didcomm.org/basicmessage/2.0/message",
    "peerResolutionEventCid": "bafkreibyv62fswjkyg4ttq2houxa74kghobrly26havhefevacjdud334q",
    "presentedDid": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "did": "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
    "thid": null,
    "pthid": null,
    "createdTime": 1788442800,
    "expiresTime": null,
    "pleaseAck": [
      ""
    ],
    "ack": [],
    "headers": {},
    "fromPrior": null,
    "bodyCid": "bafkrei...body",
    "attachmentCids": [
      "bafkrei...attachment"
    ],
    "bytes": 48213,
    "receivedVia": {
      "mediationId": "019b2a51-118f-7e46-b31b-c63cd090c92c",
      "deliveryId": "01J...opaque"
    }
  }
}
```

Phase 1 records no separate inner-signature evidence. Channel sender authority
requires authenticated encryption under [the receive gate](relationships.md#hard-pre-vault-gate);
an inner signature does not supply an alternative authenticated sender. The
carried `fromPrior` retains its separate continuity-verification role.

Requirements:

- `messageId` is the deterministic observation value above;
- `intentHash` and `plaintextHash` are computed under [distributed-delivery.md section 5](distributed-delivery.md#canonical-projections-and-hashes);
- `localKeyName` is the exact local key that decrypted the message;
- `peerResolutionEventCid` is REQUIRED and names the exact `peer.resolved` used to
  authenticate the sender. It is null exactly for an anonymous observation,
  in which `did`, `presentedDid` and the derived peer key are also null.
  An authenticated sender requires DID resolution evidence; there
  is no DID-less authenticated-key fallback. A non-null reference supplies
  the authenticated peer key under [section 4.1](#key-evidence); its `localKeyName`, `did` and
  `presentedDid` match this observation. Sender authentication and evidence
  reuse MUST satisfy [relationships.md sender freshness](relationships.md#sender-authentication-freshness)
  and [rules for duplicates and recovery](relationships.md#duplicate-authentication-and-historical-recovery).
  Commit/reuse that event and document first, then use its returned event CID
  in the separate inbound commit; later resolutions cannot replace the
  reference. It is local
  evidence metadata, excluded from the message hashes;
- for authenticated input, derive the [channel pair](channels.md#channel-identity)
  from the local DID owning `localKeyName` and the authenticated canonical `did`.
  Validate that local DID/key mapping against the exact local key-agreement
  method that successfully decrypted the authcrypt layer, under the
  [recipient evidence rule](channels.md#carried-proof-and-library-boundary).
  The plaintext `to` header is audience information, not recipient evidence;
  its absence or failure to name that local DID does not by itself invalidate
  receipt or change its channel. Missing exact DID/key evidence defers
  dependent projections. Anonymous input has no channel.
- `presentedDid` is the exact DID spelling disclosed on the wire, including a
  Peer DID long form when first seen;
- `did` is the canonical peer DID, using Peer DID numalgo-4 short form after
  validating the long form, or null when no peer DID is available;
- `createdTime`, `expiresTime`, `pleaseAck`, `ack`, `headers` and `fromPrior`
  preserve normalized wire headers; absent `please_ack` is null, a present
  array is retained exactly, absent `ack` is `[]`, and no additional header is
  `{}`;
- `fromPrior` is null when absent, otherwise the exact original string, even
  when it is not a valid JWT. Parsing, claim and signature failures belong to
  continuity verification and do not invalidate this authenticated observation;
- ACK processing reads from `pleaseAck` only whether this message requests its
  own receipt, by `""` or this `wireMessageId`; stored arrays are not rewritten;
- `headers` contains every otherwise-unmodeled permitted top-level member and
  MUST NOT contain any reserved field, including `return_route`;
- `thid` and `pthid` are present with null when absent;
- event `author` identifies the active receiving runtime;
- mediation and delivery ID are null for direct transport without them;
- `bytes` is the canonical retained document byte length; and
- `attachmentCids` is the distinct ordered list of object-backed attachment
  payload roots in the closed stored document; link-only descriptors add no
  entry; and
- `roots` is the distinct ordered set of `bodyCid` followed by `attachmentCids`.

Every newly committed `message.in` is an event of its own, including a
recorded duplicate of an existing channel-local message ID; re-ingest of an
existing `cid` preserves its event. Inbound commit MUST be serialized across
the active writer. A pickup batch follows the per-delivery receipt/admission
ordering in [the receive procedure](distributed-delivery.md#receive-a-message);
this does not permit committing all live receipts before admission.

The observations of one logical message `M`, including consistent
same-channel key variants, are ordered by
[canonical event order](event-store.md#canonical-order), as are the
candidates admission reconciliation walks under
[channels.md](channels.md#application-admission). Define:

```text
firstWitness(M) = the first admitted complete observation of M in canonical event order
```

It is undefined while no admitted complete observation qualifies, and raw
unadmitted duplicates cannot change it. `firstWitness` names the observation
an operation reads the input's fields from and orders established logical
messages for display; it is no admission prerequisite. A pure ACK names its
carrier alone, so no target array is ordered. For successive events of one
writer whose timestamps strictly increase, canonical order follows commit
order. Events sharing a timestamp are ordered by CID, so their canonical
order may differ from commit order even without clock rollback; a clock
rollback may place later commits before earlier commits. What follows that
order is the choice of witness among consistent duplicates, the order
candidates are judged in and display; a committed admission or intent stands
whatever the order. For independently run histories canonical order is a
deterministic merged order, not a claim about physical receive time between
disconnected writers. This rule permits history union; it does not enable
concurrent phase-1 writers or establish multi-writer effect convergence.

A later observation does not reorder earlier events. Learning an older alias
or importing history may change the first witness for future decisions, but
MUST NOT change a committed `message.out`.

Full import MUST NOT reject an event union for repeated observations of one
input. The generic event store remains payload-opaque. Its [section 5.3](event-store.md#ingest)
`ForkedAuthor` check detects unseen events under the current local author; it
does not prove that every historical author is fork-free.

Commit the observation with its objects after its exact resolution evidence.
Pickup ACK follows [the receive procedure](distributed-delivery.md#receive-a-message),
including its separate hard-rejection path. Subsequent consumers independently
check [operation eligibility](channels.md#operation-eligibility).

<a id="message-admitted"></a>

#### Application admission record

`message.admitted` is the closed, rootless local decision defined by
[channels.md](channels.md#application-admission). Its sole required field is
non-null `sourceEventCid: EventReference<"message.in">`. Receipt commits first;
admission commits before any application projection or input-derived effect.
Preserve both events through export/import and metadata-preserving erasure.
The source retains its own objects; admission introduces no extra roots.
Missing source or verification evidence defers the admission, never completes
it from another observation. Schema validation rejects additional payload
fields, wrong reference types, null references and nonempty roots.

Event order and admission are independent facts. An earlier observation
does not prove acceptance before rotation; use the durable admission record.
Imported historic admissions preserve the originating runtime's decisions,
subject to their exact cryptographic evidence, not today's supersession policy.
New local admissions always check the complete current graph, including when
reconciling restored or imported receipts without admissions.

<a id="duplicate-transition-and-conflict-rules"></a>

### 10.3 Duplicate and conflict rules

Group by `(canonical sender DID, canonical recipient DID, wireMessageId)` and its deterministic
message ID. Each complete observation authenticates independently with its own
method-valid immutable document and derives the same exact sender/recipient pair. Equal intent hashes
represent one logical input. Differences between independently admitted
observations conflict for application use; unadmitted differences remain raw
diagnostics and cannot overwrite admitted content. Transport, author, event time,
authorized key and exact plaintext may
differ without creating a new logical input in this same channel. Incomplete
evidence for a consistent sibling neither supplies another execution nor
withdraws an existing complete witness. Contradictory admitted evidence remains visible and suppresses new affected
application work. Cryptographic continuity conflicts are evaluated independently
of application admission.

Another channel always has another message/execution identity. Verified links,
same bodies and display merges never alias those messages. Local producers
cannot move one outbound wire ID across channels; external peer behavior does
not create a cross-channel exactly-once guarantee.

A pure ACK has Empty type, `{}` body, no attachments, nonempty `ack` and null
`pleaseAck`. This vault produces one whose `ack` names exactly its carrier; a
received one may name several. It is control input; invalid variants are not
treated as pure ACKs.
Receipt/erasure skeletons retain this classification and frozen headers.

<a id="pickup-versus-ultimate-acknowledgment"></a>

### 10.4 Pickup versus ultimate acknowledgment


Message Pickup `messages-received` is mediator queue state, not a vault event.
In phase 1 it acknowledges one account-scoped delivery and follows durable
`message.in`.

An ultimate ACK is an end-to-end application message. It is recorded as
`message.in`; each wire ID in its validated `ack` array selects an exact local
outbound. The admitted complete source witness must be in that outbound's channel or a verified
role-preserving successor channel under [section 9.7](#outbound-message-and-delivery-fold).
A conflict-free match may produce an idempotent `delivery.acknowledged`.
A wire ID alone or shared contact grants no ACK authority. A threaded
or natural response without an explicit `ack` array does not create that
delivery observation.

<a id="complete-observation-witnesses"></a>

### 10.5 Complete observation witnesses

For a claim about received evidence, its **complete observation witnesses** are
all committed `message.in` candidates that each satisfy every per-observation
requirement of the consuming schema or fold. Evaluate the required fields and
their exact referenced evidence against one observation at a time. A check
MUST NOT combine a field from one candidate with a field from another. The
result is the set of all complete matches, independent of enumeration order.

The consumer defines the candidate set and its required comparisons and
validation. `ackMessageId` in [section 9.6](#delivery-acknowledged) restricts
candidates to that observation message ID's group. Any complete matching
duplicate can witness that claim. In contrast, `sourceEventCid` in a
`did.rotationSelected`, `message.out` or `message.admitted`
names one exact observation and cannot replace it with a duplicate. That source
must supply its own complete sender authentication and immutable claims.
If that source carries a JWT, it must independently verify under
[the proof rules](channels.md#peer-proof-evidence). Immutable issuer material may
be shared, but another carrier's authentication or proof result cannot replace
this source's checks. Every exact reference required by a schema must match as specified.

This matching rule does not replace authentication, scope, historical
membership, proof or group-validity checks. A matching candidate cannot clear
a group conflict or bypass a missing-evidence deferral required by the
consuming schema or fold. Incomplete evidence is not a proven mismatch merely
because the candidate cannot yet enter the witness set.

Subject to those checks, an existential claim requires at least one complete
witness. Aggregates use all qualifying witnesses; [section 9.7](#outbound-message-and-delivery-fold)
computes ACK receipt time across all qualifying admitted witnesses, including
duplicates and distinct carriers.

Admission is a prerequisite for producing a new source-derived rotation decision
or outbound intent, and for new address confirmation.
Application projections of chat, profile values, received ACKs and Report Problem
correlation also require effective admission of each exact contributing source;
ACK timing and new ACK-target selection use only admitted witnesses.

Validation of a committed `did.rotationSelected`,
`message.out`, preparation or submission requires its own cryptographic and
reference evidence, not source admission. Their derived links,
frozen intents/packages and submitted facts do not become pending or invalid
merely because an admission is absent. A committed local decision still needs
independent complete predecessor-confirming evidence, without an admission
prerequisite for that witness. Missing exact evidence still defers validation.
For a saved pure ACK, validate its one target under
[distributed-delivery.md section 8.1](distributed-delivery.md#the-ack-target)
on the carrier's complete witness, admitted or not.
These records do not grant admission to their sources or populate accepted
chat/profile/ACK views. A saved `delivery.acknowledged` likewise cannot substitute
for the admitted witnesses required by section 9.7.

Cryptographic carrier verification and continuity/conflict inspection do not
require admission and cannot supply it. Current policy still governs all new
work and dispatch independently of saved-record validity.

<a id="147-inbound-message-and-execution-fold"></a>
<a id="inbound-message-and-execution-fold"></a>

### 10.6 Inbound message and execution fold

For each channel-local logical input, expose complete source witnesses,
receipt order, authenticated intent agreement and its concrete intents/results.
The deterministic execution ID comes from the channel, sender and
wire ID under [delivery](distributed-delivery.md#execution-id-and-immutable-transcript).
An anonymous or mediator-control observation has no application execution.
Mediator-control input is traffic authenticated and correlated within a
mediation, pickup or routing transport session, independently of application
channel evidence. A protocol type string alone does not establish that role
for an observation received on an ordinary communication channel.

Each consumer derives pending/refused/eligible status from its exact evidence
and operation rules. At least one admitted complete source witness and no
conflicting authenticated intent is required for application use. Exact-address
knowledge uses the confirmation-specific checks in
[channels.md section 5.2](channels.md#supersession-confirmation-and-authorization);
conflicting application contents alone do not refute that knowledge. Raw receipt
and cryptographic proof inspection remain independent of admission. Raw payload
discrepancies are diagnostic; only independently admitted claims establish an
application intent conflict.
A stored exact source reference cannot borrow another row's fields. New work
also checks current denial, supersession and policy. Read-only ACK/error
observations follow [operation eligibility](channels.md#operation-eligibility).
Keep current eligibility separate from historical intents and completed facts.

Intent conflict requires independently complete authentication, exact DID-pair
agreement, carried-proof evidence and admission for the disagreeing observations.
Different keys authorized by the same immutable peer document can therefore
still produce an intent conflict in one logical input. Receipt alone, an
unauthorized key or
a still-missing reference cannot establish that conflict or invalidate an
already complete source witness. Retain
those rows with their own pending/refused diagnostics.

Admitted control input, Empty, ping-response and Report Problem can provide complete
ACK witnesses, but never trigger recursive privacy replies.
Erased input creates no new content-derived work. Stable execution tuples
survive ordinary graph extension and display changes. Later links never merge
executions across channels or replay effects.

Recovery may rebuild local projections and show unfinished work. Network or
other external effects require the live initial/manual authority specified by
[dispatch policy](channels.md#fixed-outbound-channel); history is not a queue.

<a id="message-scoped"></a>
<a id="message-accepted"></a>

### 10.7 Operation evidence

[Operation eligibility](channels.md#operation-eligibility) defines the independent
evidence and policy checks for intents, rotation decisions and observations.

<a id="13-automatic-effects"></a>

<a id="automatic-effects"></a>

## 11. Automatic effects

[distributed-delivery.md section 11](distributed-delivery.md#automatic-effects) defines effect identity and commit ordering;
[section 8.2](distributed-delivery.md#deterministic-pure-ack) there owns the pure-ACK vector. [Section 9.1](#ids) of this document defines
outbound ID derivation. [Built-in independent operations](distributed-delivery.md#built-in-independent-operations)
owns rotation-notification selection; [relationships.md section 13](relationships.md#remote-errors-and-integrity-failures)
defines remote error handling.

<a id="15-erasure-and-collection"></a>

<a id="erasure-and-collection"></a>

## 12. Erasure and collection

<a id="151-messageerased"></a>

<a id="message-erased"></a>

### 12.1 `message.erased`

```json
{
  "type": "message.erased",
  "roots": [],
  "data": {
    "messageId": "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    "dropCids": ["bafkrei...body", "bafkrei...attachment"],
    "because": "user"
  }
}
```

`because` is `user`, `contact-deleted` or another stable policy code.
`dropCids` contains roots named by one or more events for the message.
They are names to release and therefore MUST NOT appear in the erase
event's `roots`.

Erasure is global and permanent for that message/root relation. Object
bytes may remain because another message or event retains the same exact CID.
The erased message still reads erased.

<a id="152-reading-content"></a>

<a id="reading-content"></a>

### 12.2 Reading content

For a message root:

1. if any `message.erased` for the message names the root, state is
   **erased** regardless of object presence;
2. otherwise, if every required object is present, content is available;
3. otherwise, if the local view explicitly permits partial object availability,
   state may be **not yet fetched**; and
4. otherwise state is **missing or damaged**.

Missing bytes MUST NOT be displayed as intentional deletion.

<a id="153-held-roots"></a>

<a id="held-roots"></a>

### 12.3 Held roots

Under the operation lock in [event-store.md section 9](event-store.md#vault-interface), the vault runtime computes
the held roots passed to `ObjectStore.collect` in [dasl-objects.md section 8.3](dasl-objects.md#collection).

A root is held when at least one accepted event retains it through `event.roots`,
except where a release rule below applies. Retention is a set fold over the
complete event inventory. Each known event's schema assigns its message/root
contributions. Any valid `message.erased` naming `(messageId, root)` permanently
releases every contribution for that relation, including contributions learned
later. Adding another event cannot revoke that erase or re-hold the same erased
relation. Another message's non-erased contribution can still hold the root.

This section is the sole normative owner of prepared-envelope retention.
For a consistent outbound `M` and valid package `P`, define:

```text
retainEnvelopeForMessage(M, P) =
    !erased(M, P.envelopeCid)
    and !submitted(M)
    and !messageTerminal(M)
```

Terminal means valid committed expiry or cancellation under `delivery.failed`.
It releases this message's envelope contribution independently of preparation
arrival order. Sampling wall time beyond expiry blocks unsubmitted work but
MUST NOT release its envelope until that durable termination is committed.
`submitted(M)` is defined by
[section 9.7](#outbound-message-and-delivery-fold) and remains true after envelope collection or termination.
It releases this message's envelope contribution, including competing imported
packages. Missing evidence for another package or operation of `M`, and an
execution conflict of an automatic `M`, do not withdraw it or require these bytes again. An ACK
does not affect retention, including when an outcome-unknown transport attempt
has no `delivery.submitted`.

Unavailable routes, retryable resolution failures and other reversible
scheduling conditions do not release an unsubmitted, non-terminal package.
There is no separate response-replay retention contribution or closure event.
After submission, even a duplicate inbound request cannot require these bytes
again or authorize a replacement package. The message's body/attachments and
its event skeletons keep their separate retention rules; submission or termination
does not erase conversation content or receipt/scope evidence.

`erased(M, root)` names the permanent message/root relation, not global deletion
of a CID. Another independent non-erased reference may retain the same bytes.
Conflicted evidence is not release authority: disputed package roots remain
held until unambiguous release evidence or explicit erasure exists.

Submission eligibility additionally checks current time, addressing,
proof, route and available bytes. Scheduling eligibility is not a retention
predicate.

Unknown event types retain every exact root in their `roots` because version 4
defines no erase rule for them. A CID embedded in object content is not a
retention edge unless it also appears in an accepted event's `roots`.

<a id="154-no-runtime-local-eviction-event"></a>

<a id="no-runtime-local-eviction-event"></a>

### 12.4 No runtime-local eviction event

Version 4 does not represent local body eviction as a portable event. A local
storage policy that deletes a non-erased retained object makes the phase-1
vault incomplete. It may be repaired from a verified portable SQLite import or backup.
Missing bytes never authorize collection of retained roots.

<a id="16-procedures"></a>

<a id="procedures"></a>

## 13. Procedures

Address selection and binding are defined in [relationships.md sections 8](relationships.md#ordinary-sending-and-birth-selection) and
[5.2](relationships.md#binding-and-contact-policy); all sending and receipt use [distributed-delivery.md sections 4.2](distributed-delivery.md#send-an-ordinary-message) and
[4.3](distributed-delivery.md#receive-a-message). These wire procedures and the runtime procedures below
define required ordering. Implementations may combine steps transactionally
but may not reverse the durability boundaries. Every instruction to append
an event below means `Vault.commit(objects, drafts)`, using an empty object
list when no new objects are needed; `Vault.events` is read-only.

<a id="161-open-the-writable-full-runtime"></a>
<a id="open-the-writable-full-runtime"></a>

### 13.1 Open the writable full runtime

1. Acquire exclusive runtime ownership; open/recover SQLite and validate schema,
   metadata, seed wrapper and derived identity under the SQLite profile.
2. Preserve local IDs on ordinary reopen; use fresh IDs on create/restore.
   Discard only unpublished staging and reconstruct held roots before GC.
3. Rebuild channel receipts, verification statuses, derived links/joins, denials,
   contact channel selections, application admissions and source/intent/result projections from saved evidence.
4. Enumerate incomplete references/content and pending/unconfirmed outbounds for
   local recovery and manual action. Reuse their exact intent, channel, proof,
   package and submission records. Never infer "not sent" from missing history.
5. Rebuild permanent erasure closure, then application display views from their
   remaining source evidence under [section 7.3](#application-message-views).
   This work may recover retained issuer material and recompute a previously
   pending proof, but appends no event for verification and grants no protocol
   dispatch or business effect.
   Reconcile missing admissions in canonical event order under
   [channels.md](channels.md#application-admission), only after the full graph
   and current policy are known. Persist acceptance now for eligible sources,
   never infer a past acceptance. No admission is created for an unadmitted
   superseded peer. Relevant evidence, rotation and denial commits repeat this
   pass during operation; no reopen or redelivery is required.
7. Start recipient reconciliation and pickup. Enable
   new user sends and manual actions only after normal runtime/evidence checks.

Open/import/restore MUST NOT dispatch historical work under
[dispatch authority](channels.md#fixed-outbound-channel). Duplicate delivery of
retained input is historical work. Phase 1 still permits one executor and makes
no exactly-once claim across loss of authoritative history.

<a id="162-establish-mediation"></a>

<a id="establish-mediation"></a>

### 13.2 Establish mediation

1. append `mediation.created` before the network request;
2. derive its vault-scoped account key;
3. perform ordinary Coordinate Mediation;
4. on grant, append `mediation.granted`;
5. reconcile desired recipient DIDs through Coordinate Mediation; and
6. append `mediation.selected` when policy chooses it for new mediated DIDs.

The phase-1 runtime uses ordinary account-scoped Message Pickup. It sends no
`replica_id` to the mediator. A network failure after step 1 leaves a retryable
intent, not a half identity.

<a id="163-create-a-communication-did"></a>

<a id="create-a-communication-did"></a>

### 13.3 Create a communication DID

1. choose the route, a usable arrangement whose routing DID no other usable
   arrangement shares, or a direct endpoint;
2. choose a fresh UUIDv7 entity ID;
3. derive the fixed authentication and key-agreement keys;
4. build and validate a Peer DID numalgo-4 document encoding those keys and
   that route as its one DIDComm service;
5. commit `did.created` with canonical short form and long form.

There is no role field. A committed ID reuses its exact keys, document and route
after a crash; it cannot be recreated for another route. A conflicting or retired
entity cannot be silently replaced. Registration of a mediated recipient must
be verified before disclosure. First disclosure uses the long form under
[relationships.md section 10.2](relationships.md#peer-did-numalgo-4-profile). Address allocation may prefer another mediator to
reduce linkability, but route choice does not establish channel authority.

<a id="164-disclose-an-address"></a>

<a id="disclose-an-address"></a>

### 13.4 Disclose an address

Create or select a live DID under [section 13.3](#create-a-communication-did),
reconcile the arrangement that routes it and verify recipient registration. Commit
[did.disclosed](#did-disclosed), fixing its form before
exposing the long form through the chosen discovery transport.

The address belongs to the vault, not the process displaying it. A runtime
missing authoritative local key or arrangement state leaves incoming delivery pending
until recovery repairs those prerequisites.

<a id="165-erase-a-message"></a>

<a id="erase-a-message"></a>

### 13.5 Erase a message

1. fold every root currently retained by the logical message and its prepared
   packages;
2. process-durably commit the erase event(s), preferably in one `Vault.commit`;
   and
3. run the locked held-root fold and collection under [section 12.3](#held-roots).

Late duplicate observations may introduce another event retaining the same
logical roots. The active runtime that observes an existing erase MUST append
an equivalent erase for newly learned roots of that message before those roots
are considered intentionally released.

<a id="166-delete-a-contact"></a>
<a id="delete-a-contact"></a>

### 13.6 Delete a contact

Append `contact.deleted` for the exact contact ID. This hides the display contact
without changing messages or transport. A product operation
explicitly combining deletion, blocking or erasure additionally records concrete
`channel.blocked` decisions and/or `message.erased` roots selected under the lock.
Keep those decisions independent of future contact membership. Denial can include
verified successors; no shared DID or display name expands its scope.

Late channel receipt may still be saved/pickup-ACKed. Existing channel denial
prevents new admission and automatic work, including new ACK attribution from
a still-unadmitted source. Previously admitted ACK observations retain their
target/path checks and historical attribution. Explicit cleanup follows retained message/root rules.
Shared keys and arrangements are not retired merely because one display contact disappears.

<a id="167-rotate-a-local-relationship-address"></a>
<a id="rotate-a-local-relationship-address"></a>

### 13.7 Rotate a local channel address

1. Select the exact predecessor pair from an existing local DID and canonical
   peer DID, verify exact predecessor confirmation and check current rotation
   policy. Check for an existing decision throughout its verified peer-only
   context before allocating; reuse it, or defer on missing references.
2. For a usable route, the preferred arrangement or the predecessor's own,
   allocate a fresh local DID and sign one frozen predecessor proof without
   committing that new DID yet.
3. Under the lock, fold complete available continuity and recheck lifecycle,
   denial, source-input supersession, conflict and existing decisions from the
   same local predecessor throughout its verified peer-only context under
   [channels.md](channels.md#did-rotationselected). Reuse that decision and its
   successor without a new notification selection; missing references defer.
   Otherwise atomically commit the new successor's `did.created`
   and `did.rotationSelected` with `fromDidId`, `peerDid`, `toDidId`, nullable
   `sourceEventCid` and frozen `fromPrior`. Resolve an uncertain commit before
   allocating again. Do not retire shared resources.
4. Reuse the dedicated Empty notification intent, or create it only while the
   decision's source, when present, remains eligible under
   [channels.md](channels.md#operation-eligibility). The intent names this rotation
   decision under [delivery](distributed-delivery.md#built-in-independent-operations).
   Verify recipient registration before disclosure and use the initial/manual
   dispatch rules. New user sends default to the verified head under
   [channel selection](channels.md#fixed-outbound-channel); automatic replies
   follow their own fixed selection rule. Existing messages keep their channels.
5. Derive exact-successor confirmation; only then retire unneeded resources.

Reuse an existing complete decision after interruption; missing references defer.
Recovery does not dispatch a notification. Manual completion reuses an existing
intent under ordinary dispatch restrictions. It creates the one missing
notification under the same decision only while its source, when present,
remains eligible. A superseded source peer prevents creation; a replaced
sender or peer recipient also prohibits preparation and manual dispatch of
an already committed intent. Completion
never substitutes another source or successor.
Live automatic privacy policy follows
[relationships.md](relationships.md#early-private-address-policy-and-notifications).
Opposite-side rotation uses verified joins, never contact lookup.

<a id="merge-and-restore"></a>

## 14. Merge and restore

<a id="171-event-merge"></a>

<a id="event-merge"></a>

### 14.1 Event merge

Merge is event-store set union by event CID. Equal canonical envelopes occur
once, and every reference continues to name the same exact envelope after
export/restore. Distinct events can still contain conflicting domain facts.
It never:

- rewrites an event;
- removes an imported decision;
- treats another author as read-only history; or
- adopts database pages or physical row order as authoritative state.

After merge, every fold reflects the complete union. A cached projection must
be updated or invalidated in the acceptance transaction and rebuilt before use
if invalid; an incremental result must equal the pure fold of that union.

Application admissions remain distinct from raw observations under
[admission and merge](channels.md#application-admission). A complete imported
admission can restore accepted historical state; merely importing an earlier
receipt cannot manufacture it. A newer rotation blocks new old-peer admission
and dispatch without deleting earlier admitted history or submitted outcomes.

<a id="172-object-merge"></a>

<a id="object-merge"></a>

### 14.2 Object merge

Compute held roots from the prospective event union and copy only verified
source objects that are absent or known damaged in the target and held by that
fold. Full import publishes events and object additions or repairs under
[event-store.md section 10.3](event-store.md#import-into-an-existing-vault)'s atomic
publication boundary; this semantic union is not permission to expose an
intermediate event-only import.
No content traversal is implied. An erased message/root relation does not
revive merely because an older source still has the bytes.

Missing non-erased bytes remain an integrity/availability condition and may
be repaired from a verified portable SQLite import or backup.

<a id="174-restore"></a>

<a id="restore"></a>

### 14.3 Restore

A portable SQLite restore creates a new local `replica_id` and
`store_generation`. An exact local move is a separate operation that may retain
them only with the old writer permanently stopped under
[vault-sqlite.md section 12.3](vault-sqlite.md#exact-local-move). The restored
runtime derives the mediation and communication keys named by retained entity
records, reconciles required recipients using ordinary Coordinate Mediation,
drains the account-scoped mailbox, and exposes pending outbox records for manual
action. Opening never
supplies initial or retry dispatch authority, even after an exact local move.
It also reconciles unfinished committed inbound work under [section 13.1](#open-the-writable-full-runtime),
including observations already pickup-ACKed before the snapshot. Local queue
state is not a recovery source.

A local DID created after the snapshot, including a privacy successor, may be
absent after restore. The seed alone cannot reconstruct the missing UUIDv7
entity IDs in its key names. Once local recipient state is authoritative,
deliveries with no known or recoverably pending recipient mapping follow the
terminal wrong-recipient gate and its bounded visible diagnostic under
[relationships.md](relationships.md#hard-pre-vault-gate). Ordinary recipient
reconciliation removes registrations outside the restored desired set and
reports unknown registered recipients under [section 5.7](#route-did-and-key-fold).

A snapshot can omit a known peer rotation and its admission history. In that
case restore cannot reconstruct the missing restriction or the exact past
acceptance boundary from the seed or timestamps. Import newer
evidence when available; never claim rollback-safe rejection from an old
snapshot alone. Existing old-peer admissions preserve historical state, not
permission to send to a peer whose replacement is now known.

A snapshot can predate a peer's successor long form even though the peer has
already received confirmation and now sends its short form. Such a delivery
cannot authenticate after restore and follows the terminal receive gate:
pickup ACK when mediated, no `message.in`, and the bounded visible diagnostic
under [relationships.md](relationships.md#hard-pre-vault-gate). Waiting alone
does not recover the long form. A new long-form disclosure can enable sender
authentication but does not itself recover missing continuity history or a
discarded delivery. Importing a newer complete snapshot may restore retained
evidence; otherwise the channel may need to be established again.

Traffic at a snapshot-era address is not a guaranteed repair. Supersession
can prevent a reply, and eligible live input, including an already queued
message, can trigger another privacy rotation when the snapshot lacks a later
decision. A manual rotation can also select a different successor. If the peer
already verified the lost decision's successor, it can then retain two valid
replacements of the same endpoint in one context. Phase 1 preserves this fork
as a visible conflict under [channels.md](channels.md#continuity), with no
default send head in the affected context and no authority through conflicted
continuity. Restoring the lost decision does not choose between the branches.
Communication may be established independently from a fresh local DID; doing
so does not resolve the old context. Restore UI MUST explain these limits under
[vault-sqlite.md](vault-sqlite.md#restore).

No previous process must be online. Mediator retention still bounds messages
that were never committed to the vault. The seed recovery credential must be
retained independently of the active runtime; a portable SQLite backup includes
its encrypted wrapper. Recovery verification follows
[vault-sqlite.md section 4.2](vault-sqlite.md#recovery-material-and-product-requirement).

<a id="175-forked-author"></a>

<a id="forked-author"></a>

### 14.4 Forked author

If two writable copies accidentally preserve the same local replica ID,
previously unseen same-author events cause `ForkedAuthor`. One copy mints
a new local replica ID and retries merge. Existing events under the old
author remain unchanged.

<a id="18-privacy-and-security-boundaries"></a>

<a id="privacy-and-security-boundaries"></a>

## 15. Privacy and security boundaries

- Phase 1 has one active full runtime holding the single seed.
- A full runtime may run locally or on a server; process location does not
  confer ownership of a DID.
- `replica_id` and event author are operational provenance, not credentials or
  peer-visible addresses.
- Runtime and portable SQLite databases contain plaintext retained message
  content and attachments unless surrounding storage encrypts them.
- A rendezvous DID is intentionally disclosed and correlatable within its
  audience. Its Peer long form avoids DNS resolution for that DID; resolving
  a mediator may still involve a network resolver.
- Private-address allocation SHOULD disclose its new DID only in encrypted
  interaction and avoid publishing it in reusable discovery. This is policy,
  not a different channel or authentication type.
- A valid `from_prior` is channel-context evidence. It MUST NOT globally
  link or retire addresses used by unrelated channels.
- The phase-1 mediator stores only encrypted inner DIDComm envelopes and
  routing/account-delivery metadata. It does not receive a replica ID.
- The mediator of a replica-mediation arrangement is given each enrolled
  replica's ID and DID in its grant and can group them under the account.
- The mediator may observe its account DID, recipient DID and method,
  ciphertext size, arrival, pickup, ACK, expiry, IP and traffic timing. It is
  not sent a contact ID.
- A direct endpoint sees transport metadata and encrypted DIDComm envelopes;
  it is not an application-level runtime address.
- Ultimate ACKs reveal durable-receipt timing to the peer.
- Event authorship does not authenticate history supplied by another holder
  of the same seed.

<a id="19-versioning"></a>

<a id="versioning"></a>

## 16. Versioning

These event meanings belong to vault version 4. A version-4 reader may
preserve unknown event types but MUST validate every known type according
to this document.

Compatible additions within version 4 may introduce a new event type or
an explicitly optional payload field whose absence has a fixed meaning.
Changing a published field meaning, fold, deterministic ID, erasure rule or key
derivation requires a new vault version.

<a id="20-required-conformance-cases"></a>

<a id="required-conformance-cases"></a>

## 17. Required conformance cases


<a id="runtime-identity-ve-1-ve-2"></a>

### Runtime identity (VE-1–VE-2)

- <a id="ve-1"></a> **VE-1.** Every local event has `author == local replica_id` and phase 1 enforces one
   active writer.
- <a id="ve-2"></a> **VE-2.** A server full runtime has the same event semantics as a local full runtime;
   a thin client without seed is not an author.

<a id="outbound-intent-packages-and-acknowledgment-ve-3-ve-14"></a>

### Outbound intent, packages and acknowledgment (VE-3–VE-14)

- <a id="ve-3"></a> **VE-3.** A send commits body, attachments and `message.out` with networking disabled.
- <a id="ve-4"></a> **VE-4.** Intent freezes channel, sender, recipient, timestamps, exact nullable pleaseAck, ack and supported headers before network work.

- <a id="ve-5"></a> **VE-5.** Null `pleaseAck` omits the wire header; `[]` emits an empty header and
   requests no explicit message ID.
- <a id="ve-6"></a> **VE-6.** `pleaseAck` containing `""` or the current wire ID requests that message's
   receipt; an array naming only older IDs does not. Neither changes submission
   completion or envelope retention.
- <a id="ve-7"></a> **VE-7.** Standard `please_ack` empty-string and current-ID forms are accepted and
   preserved.
- <a id="ve-8"></a> **VE-8.** `return_route` is rejected in vault application headers.
- <a id="ve-9"></a> **VE-9.** Intent hash covers application ID/type/thread/body/ordered attachments and
   immutable control headers; plaintext hash covers one exact DIDComm
   plaintext.
- <a id="ve-10"></a> **VE-10.** A committed preparation fixes one package for the message, including before its first transport call. Identical preparation payloads are idempotent; different package IDs or payloads conflict. Local producers reject a second package, imported conflicts select no winner, and all retries preserve the fixed package.

- <a id="ve-11"></a> **VE-11.** Retrying one package preserves identical plaintext, envelope and package
    ID.
- <a id="ve-12"></a> **VE-12.** Transport acceptance produces delivery.submitted with exactly messageId and packageId and empty roots. The referenced intent/package must already be committed and valid; submission never implies ultimate acknowledgment.

- <a id="ve-13"></a> **VE-13.** A deterministic response acknowledges an outbound only when authenticated
    explicit `ack` names its wire ID.
- <a id="ve-14"></a> **VE-14.** Expiry irreversibly ends unsubmitted work. [Section 9.7](#outbound-message-and-delivery-fold) derives `late`
    from the earliest valid ACK carrier observation `at`, for both submitted
    and expired unsubmitted messages. An observation before expiry is on time;
    equality or later is late. Null expiry is never late. Restart, fold time,
    a later duplicate and delayed `delivery.acknowledged` commit do not change
    an on-time receipt into a late one. No expired failure is needed for a
    submitted message's late receipt.

<a id="inbound-scope-execution-and-receipt-ve-15-ve-25"></a>

### Inbound scope, execution and receipt (VE-15–VE-25)

- <a id="ve-15"></a> **VE-15.** Authenticated key variants in one sender/recipient/wire-ID input agree on one message identity; different channels never alias.

- <a id="ve-16"></a> **VE-16.** Execution ID derives from canonical sender, canonical recipient and wire ID. Each new operation checks its required evidence and current policy; display membership supplies no authority.

- <a id="ve-17"></a> **VE-17.** Missing required source, endpoint or link evidence defers only the affected consumers. Later validation preserves this channel-local identity and grants no automatic recovery dispatch.

- <a id="ve-18"></a> **VE-18.** Contradictory channel identities or authenticated intents conflict; another recipient DID produces another channel and execution identity. Validated long/short spellings alone do neither.

- <a id="ve-19"></a> **VE-19.** Intent conflicts suppress disputed automatic effects and ACK
    processing.
- <a id="ve-20"></a> **VE-20.** Pure ACK, valid Empty rotation notification, protocol-correlated
    Empty/ping-response and no-response errors obey [section 10.6](#inbound-message-and-execution-fold) at every
    address. Their permitted ACK/transition work remains; they create no
    contact or recursive privacy notification. Trust Ping requests remain
    application input.
- <a id="ve-21"></a> **VE-21.** Pure ACK has `pleaseAck == null`; it completes when `delivery.submitted`
    commits under the common rule and creates no ACK loop.
- <a id="ve-22"></a> **VE-22.** Duplicate input creates no new response or dispatch action. A pending response needs explicit manual retry; submission permanently ends its work.

- <a id="ve-23"></a> **VE-23.** Resolution and channel receipt commit before pickup ACK.

- <a id="ve-24"></a> **VE-24.** Local receive prerequisites wait without pickup ACK; continuity waits after authenticated receipt. Retired exact keys may drain through eligible arrangements independently of contacts.

- <a id="ve-25"></a> **VE-25.** Safely classified hard pre-vault rejection is pickup-ACKed before any
    `message.in` and leaves only bounded local diagnostics.

<a id="peer-evidence-and-relationship-formation-ve-26-ve-37"></a>

### Peer evidence and invitation decisions (VE-26–VE-37)

- <a id="ve-26"></a> **VE-26.** `peer.resolved` retains exact canonical numalgo-4 document bytes under their raw CID, presented/canonical DID forms and selected key IDs. Long/short lookup reproduces the same immutable document.

- <a id="ve-27"></a> **VE-27.** Peer DID first disclosure uses one identical long-form spelling in
    plaintext `from`, protected `skid` and decoded `apu`.
- <a id="ve-28"></a> **VE-28.** Public discovery uses a chosen communication address under disclosure
    policy. Private allocation is not a different DID schema or receive path.
    Local Peer discovery needs no DNS. Sharing a bare DID through a profile page,
    directory or address exchange records `as: "direct"` and
    `oobId: null`; sharing an OOB invitation through those surfaces records
    `as: "oob"` with its `oobId`.
- <a id="ve-29"></a> **VE-29.** First and later inputs use common authentication/resource checks regardless of control type or wire age.

- <a id="ve-30"></a> **VE-30.** Unknown application types and absent receipt requests do not prevent channel receipt. Automatic output needs complete source evidence and operation-specific policy checks; received ACK/error observations and application views use their own attribution evidence. None requires invitation state.

- <a id="ve-31"></a> **VE-31.** The first message uses its ordinary application protocol with no custom
    rendezvous wrapper or wire contact ID.
- <a id="ve-32"></a> **VE-32.** message.in records exact channel/authentication evidence and no separate inner-signature evidence. An inner signature does not replace authenticated encryption for channel authority. Automatic intents directly reference their source; application views derive from admitted retained messages in their fixed channels. Carried-proof eligibility derives from the source JWT, immutable issuer material and endpoints independently of invitations.

- <a id="ve-33"></a> **VE-33.** Sending to a peer and receiving from it use the same local/peer pair within a vault. The other vault observes the reversed local/peer roles; message identity preserves sender/recipient direction.

- <a id="ve-34"></a> **VE-34.** Display contact tombstones survive rediscovery; independent channel denials survive regrouping. Receipt in an unassigned channel creates no replacement contact.

- <a id="ve-35"></a> **VE-35.** First channel receipt accepts absent or past wire expiry. Outbound expiry
    independently stops unsubmitted work at equality.

- <a id="ve-36"></a> **VE-36.** Receipt survives crash before display work. Recovery rebuilds saved evidence without redelivery, user action or automatic outgoing effects.


<a id="address-changes-and-default-responses-ve-38-ve-49"></a>

### Address changes and default responses (VE-38–VE-49)

- <a id="ve-38"></a> **VE-38.** Local `from_prior.iss` uses the predecessor's long form and its protected
    `kid` has that exact DID portion. Peer verification matches validated
    predecessor spellings and method IDs under [section 6.3](#relationship-peertransitioned), without changing
    the immutable document or JWT bytes.
- <a id="ve-39"></a> **VE-39.** A local producer's `from_prior.sub` equals plaintext `from` byte-for-byte; before confirmation
    both use the successor's Peer-DID long form.
- <a id="ve-40"></a> **VE-40.** Each carrier's original JWT verifies against the immutable document derived from its long-form issuer or matching retained peer.resolved material for a short-form issuer. Link derivation uses that carrier's exact authentication and endpoint evidence; iat selects no alternative document. Rebuild appends no event for verification and needs no prior verification cache.

- <a id="ve-41"></a> **VE-41.** Successor/local decision and exact package commit before disclosure. Each transport call requires current eligibility and a live initial/manual action; an uncertain preparation commit permits neither dispatch nor a replacement package until resolved. Links themselves have no commit boundary.

- <a id="ve-42"></a> **VE-42.** Trust Ping is the default no-content initial message; an application
    message may be first without wrapping.
- <a id="ve-43"></a> **VE-43.** A live early-privacy notification uses its original source execution and dedicated rotation tuple, independent of pure ACK and Ping reply. Generic pure ACK requests no ACK.

- <a id="ve-44"></a> **VE-44.** A new user message may select an eligible public/private successor channel; existing messages and frozen proof time do not change.

- <a id="ve-45"></a> **VE-45.** New unconfirmed successor packages carry their frozen proof/long form. A committed package never changes after confirmation, even if it has never been sent.

- <a id="ve-46"></a> **VE-46.** Invalid upper-layer evidence refuses dependent decisions/effects while retaining independently authenticated receipt; failed envelope authentication creates no message.in and follows the gate's wait or terminal rules.

- <a id="ve-47"></a> **VE-47.** Public channels can send before a first reply. Every intent fixes its oriented channel, and display preferences never substitute another at preparation.

- <a id="ve-48"></a> **VE-48.** A channel link never globally retires or aliases a public DID used by unrelated channels.

- <a id="ve-49"></a> **VE-49.** Different communication DIDs may send through independent arrangements or endpoints, each fixed by its own document.

<a id="lifecycle-erasure-and-restore-ve-50-ve-55"></a>

### Lifecycle, erasure and restore (VE-50–VE-55)

- <a id="ve-50"></a> **VE-50.** Desired registration includes each live mediated DID with the arrangement that routes it. Retained eligible old DIDs can drain receipt without requiring continuity history.

- <a id="ve-51"></a> **VE-51.** Each local DID derives fixed authentication and key-agreement keys and
    sends where its document says. Rotation creates another entity; the local
    allocator chooses the successor's route when minting it.
- <a id="ve-52"></a> **VE-52.** Erasure is checked before object presence; late roots receive equivalent
    erasure closure. Importing a distinct event CID for an already erased
    message/root relation cannot re-hold that contribution or require its bytes.
    A different message's non-erased contribution can still retain the same root.
- <a id="ve-53"></a> **VE-53.** SQLite restore creates fresh local IDs, restores state and reconciles pickup, but pending outbounds require manual action. Exact moves require a stopped source and also grant no dispatch by opening.

- <a id="ve-54"></a> **VE-54.** Open/restore uses ordinary account-scoped pickup and exposes pending outbounds for manual action without starting another protocol.
- <a id="ve-55"></a> **VE-55.** Shuffling the same event set leaves every phase-1 fold result unchanged.

<a id="commit-ack-and-retention-regressions-ve-56-ve-72"></a>

### Commit, ACK and retention regressions (VE-56–VE-72)

- <a id="ve-56"></a> **VE-56.** Closed attachment normalization makes intent hashes independent of
    implementation-selected presentation or diagnostic metadata.
- <a id="ve-57"></a> **VE-57.** ACK before `delivery.submitted` does not complete submission or release an
    otherwise retained package. Committing `delivery.submitted` releases every
    package's delivery retention contribution for that message ID without waiting for
    ACK; message body and attachment lifetimes remain separate.
- <a id="ve-58"></a> **VE-58.** Commit and collection share the operation lock; GC computes current held roots
    under that lock and cannot delete a retained object or overlap acceptance
    and append within a commit.
- <a id="ve-59"></a> **VE-59.** Committed receipt/content survives immediate restart before pickup ACK even with no contact.

- <a id="ve-60"></a> **VE-60.** ACK lookup validates the exact outbound fixed channel and a role-preserving path from its peer to a carrier with an admitted complete source witness; shared contact/wire ID alone is insufficient.

- <a id="ve-61"></a> **VE-61.** Every committed inbound is an event of its own. `firstWitness` is taken over
    admitted complete observations only, in canonical event order; a clock that went back may order a
    later receipt of one writer first, and the observations of distinct writers order deterministically after a merge.
- <a id="ve-62"></a> **VE-62.** Invitation availability is a projection of the disclosed DID's lifecycle and grants no preparation, automatic output, rotation or ACK/error authority.

- <a id="ve-63"></a> **VE-63.** Within-channel authorized variants share one execution; another channel stays separate after graph discovery. Regrouping and retirement never rewrite existing IDs.

- <a id="ve-64"></a> **VE-64.** Committed submission remains complete after restart, loss of local caches,
    clock rollback, later termination, content erasure and envelope collection.
    Retained event skeletons prevent resubmission or replacement of that message ID.
- <a id="ve-65"></a> **VE-65.** A complete `delivery.submitted` completes its entire message ID and
    suppresses further preparation or submission, including with an imported competing package. Workers
    serialize dispatch per message ID and commit acceptance before further dispatch.
- <a id="ve-66"></a> **VE-66.** The inbound message ID vectors in [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) recompute to
    `d2192dcf-cc5c-5f7d-b4f1-46972b7b04de` and
    `9cfaed56-2cb3-5a84-bc56-f8e882784ac8` from their published inputs.
- <a id="ve-67"></a> **VE-67.** Attachment IDs obey DIDComm 2.1 URI-unreserved syntax independently of
    filename or DASL object identity.
- <a id="ve-68"></a> **VE-68.** An otherwise retained unsubmitted package survives route unavailability
    and GC with its exact bytes. Route recovery cannot reopen a submitted message ID.
- <a id="ve-69"></a> **VE-69.** Explicit cancellation commits message-scoped delivery.failed with code cancelled,
    before or after preparation. It serializes with dispatch and records no cancellation
    once submission is complete. The committed cancellation stops preparation/retry,
    releases envelope retention, preserves message content and does not prove nondelivery.
    A complete submission imported later takes precedence; cancellation never permits a replacement package.
- <a id="ve-70"></a> **VE-70.** Shared envelope bytes remain held by another non-erased message even after
    one message/root relation is erased.
- <a id="ve-71"></a> **VE-71.** Each new duplicate observation is a new event; exact re-ingest is not.
    Admission reconciliation orders candidate observations in canonical event order;
    a later observation changes no committed intent.

<a id="invitation-duplicate-and-recovery-regressions-ve-73-ve-89"></a>

### Invitation, duplicate and recovery regressions (VE-73–VE-89)


- <a id="ve-74"></a> **VE-74.** ACK membership uses fixed outbound channel/direction and exact package/path evidence; wire-ID equality alone cannot acknowledge it.

- <a id="ve-75"></a> **VE-75.** Known DID or wire ID does not bypass missing source authentication, endpoint or required proof evidence; response prerequisites must already be committed. Invitation state grants no source authority.

- <a id="ve-76"></a> **VE-76.** Open discovers retained unfinished input/output for local recovery and manual action without mediator redelivery; it never automatically dispatches effects.

- <a id="ve-77"></a> **VE-77.** A known duplicate can record a new channel observation but cannot recreate
    a tombstoned contact. A conflicting duplicate supplies no new executable
    work; its prior history remains.

- <a id="ve-78"></a> **VE-78.** An admitted authenticated, correlated no-response error produces no reply; its explicit ACK may independently record receipt. Later rotation or blocking does not erase that observation or ACK evidence.

- <a id="ve-79"></a> **VE-79.** Crash recovery rebuilds local receipt/policy/proof state without redelivery or automatic protocol effects. A saved response cannot become a different-channel notification.

- <a id="ve-81"></a> **VE-81.** Every event-set permutation produces the same order of observations; older same-channel duplicates affect future selection only, never a committed intent.


- <a id="ve-84"></a> **VE-84.** contact.merged and contact.channelsSet change display only; operation evidence, executions, ACK authorization, denials and erasure facts remain unchanged.


- <a id="ve-86"></a> **VE-86.** Prepared state records a fixed package, not a transport invocation. Reopen/import of queued or prepared work grants no send; calls and retry diagnostics remain local. Manual retry uses exact bytes, and missing submission cannot establish prior nondelivery.

- <a id="ve-87"></a> **VE-87.** A user send or deterministic response uses its outbound message ID as plaintext
    `id`; its package and every retry preserve it. Inbound observation message IDs remain
    scoped derivations and are not replaced with the received wire ID.
- <a id="ve-88"></a> **VE-88.** A successor freezes its own route at DID creation. Crash before commit may
    choose again; afterward recovery reuses that exact document and route.
    Preference changes do not edit it.
- <a id="ve-89"></a> **VE-89.** Retirement and receipt rechecks serialize. Retained eligible old keys can receive; new sending obeys lifecycle.

<a id="transition-evidence-and-automatic-intent-ve-90-ve-100"></a>

### Transition evidence and automatic intent (VE-90–VE-100)

- <a id="ve-90"></a> **VE-90.** Peer proof verification appends no event. did.rotationSelected contains exactly fromDidId, peerDid, toDidId, nullable sourceEventCid and frozen fromPrior. Channel links derive from authenticated carriers, immutable issuer material and local decisions without stored link IDs.

- <a id="ve-91"></a> **VE-91.** Erasure preserves exact source skeletons, original source JWTs and local decisions. A long-form issuer remains derivable from the JWT; peer.resolved roots retain documents used by short-form issuers independently of message content. Missing required material defers verification; deleting all local verification caches changes no rebuild result.

- <a id="ve-92"></a> **VE-92.** Two automatic intents for the same `(executionId, effectType)`
    have one effect key and message ID. Different intent hashes conflict after any
    permutation of their union; both variants and their packages remain history,
    with preparation and submission suppressed.
- <a id="ve-93"></a> **VE-93.** Equal effect keys and intent hashes with different fixed channels, sender or recipient fields conflict; exact duplicate intents count once.

- <a id="ve-94"></a> **VE-94.** An automatic intent whose execution ID disagrees with its unique carrier
    group's derived ID, whose effect type or intent violates the producing
    protocol's operation rules, whose key disagrees with its tuple, or
    whose message ID disagrees with its key is invalid and cannot execute.
- <a id="ve-95"></a> **VE-95.** Every inbound-derived message.out retains executionId, effectType, effectKey and exact sourceEventCid. Reopen validates the complete source witness and recomputes the key; missing tuple or required evidence cannot authorize work. Locally initiated sends have these four fields null and ack == [].
- <a id="ve-96"></a> **VE-96.** Pure ACK, Ping reply and rotation notification have distinct fixed effect types and may coexist for one input in every import order, including the two outputs with the same Empty message type. Conflicting intents for one `(executionId, effectType)` suppress that operation without suppressing the others; a source intent conflict suppresses all source-derived operations.
- <a id="ve-97"></a> **VE-97.** A supported no-response error is shown only with an admitted complete source witness, exact channel/path and protocol thread correlation. It does not change submission or authorize replay; erasing its body removes that diagnostic.

- <a id="ve-98"></a> **VE-98.** Publicly disclosed numalgo-4 DIDs authenticate senders under the same long/short-form validation as private DIDs; private allocation remains optional policy.

- <a id="ve-99"></a> **VE-99.** A direct input and an input at a rotated channel have different execution IDs even with equal wire IDs. Reopen or graph recovery never merges or repeats their saved effects.

- <a id="ve-100"></a> **VE-100.** Source, local endpoint records, required proof evidence and any rotation decision must commit before a dependent intent. A proposed same-batch prerequisite or intermediate fold row grants no authority or dispatch.

<a id="key-binding-and-resolution-regressions-ve-101-ve-111"></a>

### Key, binding and resolution regressions (VE-101–VE-111)

- <a id="ve-101"></a> **VE-101.** Canonical key encoding governs authentication and method membership. Channel/message IDs use canonical DIDs and channel direction, not selected public-key bytes.

- <a id="ve-102"></a> **VE-102.** Selecting recipient keys or assigning display contacts cannot prove inbound authentication. Anonymous/control/pending inputs retain evidence without application execution.

- <a id="ve-103"></a> **VE-103.** message.out requires immutable senderDidId and recipientDid; their canonical endpoints determine its channel. Different endpoint values conflict even if intentHash agrees; rotation never retargets it.

- <a id="ve-104"></a> **VE-104.** Ordinary user sending and preparation need no first reply. Their fixed intent and exact package evidence retain the channel through rotation, reply, submission, erasure and restore.

- <a id="ve-107"></a> **VE-107.** Channel selectors preserve local/peer roles and compare canonical DID strings; key encoding and display IDs cannot change the pair.

- <a id="ve-109"></a> **VE-109.** Control type alone creates no contact or privacy link. A control input with an admitted complete source witness may supply permitted ACK evidence without recursive notifications.

- <a id="ve-110"></a> **VE-110.** Retained old recipient keys can receive. No usable authorized sender means no automatic response intent; later recovery exposes manual work instead of sending or retargeting it.

- <a id="ve-111"></a> **VE-111.** message.in/prepared derive peer keys from exact peerResolutionEventCid. Sender/recipient/wire-ID message identity does not use key bytes; missing non-null references defer and anonymous input alone has null sender evidence.

<a id="local-rotation-and-relationship-histories-ve-112-ve-124"></a>

### Local rotation and channel history (VE-112–VE-124)

- <a id="ve-112"></a> **VE-112.** A local rotation decision freezes the old local DID, canonical peer, successor, proof and nullable source. A non-null source must match the exact predecessor pair; a manual decision retains that pair with no source. Its derived link changes one endpoint; successors use UUIDv7.

- <a id="ve-113"></a> **VE-113.** A local link needs complete exact-address confirmation against the authenticated peer context. The confirming observation needs no handler decision or output intent and cannot rely on the decision or its descendants to establish its context.

- <a id="ve-114"></a> **VE-114.** New successor preparation uses frozen proof until exact confirmation. Committed packages remain unchanged; overlapping recipient routes stay until no retained channel/disclosure needs them.

- <a id="ve-115"></a> **VE-115.** Local rotation never retargets queued, prepared or submitted messages. A replaced local sender cannot prepare or dispatch in that rotation context; unrelated contexts remain usable. A successor-channel send needs a new ID.

- <a id="ve-116"></a> **VE-116.** Equivalent DID replacements are idempotent across validated long/short spelling; same-side branches, dependency cycles and contradictory identity evidence conflict.

- <a id="ve-117"></a> **VE-117.** Verified role-preserving paths can authorize successor ACKs for fixed old outbounds; they do not merge source executions and display membership supplies no path.

- <a id="ve-118"></a> **VE-118.** A shared DID can belong to unrelated channels. Only evidence-backed opposite-side joins justify new channel combinations; no global Cartesian-product or component identity is assumed.

- <a id="ve-119"></a> **VE-119.** A peer carrier establishes its exact channel link or verified join context. Proof-free input uses its own authentication evidence and exact DID pair; each operation checks any additional evidence it requires.

- <a id="ve-120"></a> **VE-120.** A complete receipt can witness a peer link before any handler runs. Restoring missing issuer material or endpoint evidence permits local validation without inventing a new global identity.

- <a id="ve-121"></a> **VE-121.** Operation eligibility is computed from current policy and evidence. Concrete operation references must form a complete witness; missing exact references defer and contradictory identity/intent conflicts without moving effects.

- <a id="ve-122"></a> **VE-122.** Complete opposite-side links from one exact predecessor pair justify their diagonal join in either import order; same-side competing successors remain conflicts.

- <a id="ve-123"></a> **VE-123.** Direct contact channel selection is independent of invitations, may be edited offline and grants no cryptographic authority.

- <a id="ve-124"></a> **VE-124.** A local privacy rotation decision names the exact eligible source selected while live. Repeated evidence preserves it; its link derives without a new event and recovery never dispatches a missing notification.

<a id="recipient-eligibility-and-evidence-recovery-ve-125-ve-131"></a>

### Recipient eligibility and evidence recovery (VE-125–VE-131)

- <a id="ve-125"></a> **VE-125.** The common DID schema has no role member. Every address pair uses the same channel receipt and operation-evidence rules, and private allocation still avoids reuse.

- <a id="ve-126"></a> **VE-126.** Peer supersession refuses new old-peer admission and source-derived work throughout the verified local-only context, and prevents sending or retrying to that peer. Raw receipts and previously admitted history, decisions and submissions remain; unrelated public-DID channels are unaffected.

- <a id="ve-127"></a> **VE-127.** Resolution and receipt commit in dependent steps before other source-derived work. Evidence decisions serialize under the lock; crash prefixes never authorize automatic recovery dispatch.

- <a id="ve-128"></a> **VE-128.** Confirmation in an unrelated channel does not permit short-form disclosure. Exact predecessor verification evidence and validated DID spelling equivalence govern JWT method comparison.

- <a id="ve-129"></a> **VE-129.** The phase-1 adapter preserves the original proof string and authenticates receipt independently of continuity. Missing proof evidence and invalid JWTs do not block message.in or pickup ACK; restored issuer material updates verification without another receipt. Invalid paths grant no new operation authority; envelope/current-sender authentication failure remains pre-receipt under the gate's wait or terminal rules.

- <a id="ve-130"></a> **VE-130.** Given the same validated numalgo-4 long form L and short form S, every
     stored resolution document uses id=L, preserves input alsoKnownAs entries
     before appending S, fills omitted method controllers with L and leaves
     relative references unchanged. Embedded methods, explicit external
     controllers, array order and input contexts are preserved as in [section 4.4](#peer-resolved). No resolver-added context or absolute-reference variant is stored.
     Long/short receipt, restore and repeated proof processing reproduce one
     RFC 8785 byte string and raw CID, without a spurious document conflict.
<a id="contact-profiles-ve-132-ve-137"></a>

### Application message views (VE-132–VE-137)

- <a id="ve-132"></a> **VE-132.** Contacts aggregate explicitly selected channels and may display verified related history. Shared DIDs/keys do not transfer permission to share information; presentation never changes source channel labels.

- <a id="ve-133"></a> **VE-133.** A displayed peer name requires a supported protocol's recognized name field, readable non-erased content, an admitted complete authenticated source witness and applicable display policy. It is a peer claim derived from the source channel, creates no contact and changes no petname; this schema records no independent name-claim event.

- <a id="ve-134"></a> **VE-134.** A view that a profile was submitted uses a protocol-recognized outbound and valid package/submission evidence in its fixed channel. Intent, preparation or ACK alone is insufficient; the view proves no peer receipt, and later rotation cannot mark another channel as shared.

- <a id="ve-135"></a> **VE-135.** A supported protocol defines display interpretation and ordering from source evidence. Same-channel duplicates represent one logical source, and cache rebuild time never advances a claim; conflicting authenticated intent supplies no verified application fact.

- <a id="ve-136"></a> **VE-136.** Applications derive their own display fields from retained messages; the core defines no profile-specific projection fields. Contact aggregation retains each source channel and grants no send or sharing authority.

- <a id="ve-137"></a> **VE-137.** Erasure invalidates cached values that require the erased bytes even if another message retains the same CID. Metadata and delivery history support only their own facts; contact petnames remain separate. Missing or erased source data is not proof that a profile was never shared, and rebuilding or losing a view never dispatches a message.

<a id="complete-witnesses-and-receipt-timing-ve-138-ve-139"></a>

### Complete witnesses and receipt timing (VE-138–VE-139)

- <a id="ve-138"></a> **VE-138.** ACK and peer-transition claims use complete observation witnesses under
     [section 10.5](#complete-observation-witnesses). If different candidates each match only part of a claim's
     required fields or evidence, they cannot jointly witness it. Adding one
     complete matching duplicate permits the claim once its other gates pass,
     even when another duplicate event is absent. An exact resolution reference
     cannot be replaced merely because another event has the same key or
     document. Matching never clears a group conflict or bypasses a required
     missing-evidence deferral; enumeration and import order select no winner.
- <a id="ve-139"></a> **VE-139.** ACK timing considers every carrier with an admitted complete source witness authorized for the exact outbound, including successor-channel carriers; unrelated/invalid rows donate no timestamps.

### Group waits and transition validity (VE-140–VE-142)

- <a id="ve-140"></a> **VE-140.** A carrier with complete authentication and its own verified JWT can derive a peer link while an equivalent sibling lacks authentication evidence. That sibling cannot borrow authentication or a proof result. Sharing immutable issuer material does not assemble incomplete observations.

- <a id="ve-141"></a> **VE-141.** An admitted complete predecessor observation remains a valid confirmation when another observation later appears at a successor channel. Those messages have distinct identities; missing successor evidence cannot erase the predecessor witness.

- <a id="ve-142"></a> **VE-142.** Conflicting independently admitted intent within one sender/recipient/wire-ID execution suppresses new intents for every effect type without undoing submission or collecting disputed bytes. Unadmitted old-peer duplicates remain diagnostics and cannot poison admitted application history. Different channels never merge into this conflict.

### Completion witnesses and address confirmation (VE-143–VE-144)

- <a id="ve-143"></a> **VE-143.** A complete valid intent/package/submission witness preserves completion despite unrelated incomplete or competing packages and later effect conflict. Invalid/missing own intent, package or authentication evidence completes nothing.

- <a id="ve-144"></a> **VE-144.** Proof-free new successor preparation requires admitted complete exact-address confirmation in the valid channel context. Confirmation needs no handler decision; body erasure and waiting siblings erase no complete witness.

### Direct contact channel selections (VE-145–VE-149)

- <a id="ve-145"></a> **VE-145.** contact.channelsSet contains exactly contactId and a sorted duplicate-free channels array of canonical localDid/peerDid pairs with empty roots. Every import order selects the latest canonical whole set; a later empty set clears it and concurrent sets are not unioned.

- <a id="ve-146"></a> **VE-146.** Two contacts may select the same channel without a conflict or canonical contact election. Editing one set does not change the other; merging their views preserves each contact's decisions and shows each logical message once.

- <a id="ve-147"></a> **VE-147.** A membership event neither creates a missing contact nor restores a tombstoned one. Contact deletion hides that contact even after later set events; channel receipt, messages and explicit denials remain independently available.

- <a id="ve-148"></a> **VE-148.** Contact creation records an initial non-empty contact.channelsSet of complete local/peer pairs in the same commit. Selection before receipt, intent, preparation or peer resolution is valid presentation state. Imported creation without its set and a later cleared set supply no contact send target; missing evidence grants no authentication or dispatch permission.

- <a id="ve-149"></a> **VE-149.** A contact with multiple eligible channels requires a concrete channel choice before intent commit. A contact with no eligible selected channel or verified continuation supplies no send target. A local-DID preference that still matches several options, overlapping contact views and contact merges do not choose one or retarget existing messages; adding a discovered address first requires a complete channel pair.

### Concrete operation evidence (VE-150–VE-153)

- <a id="ve-150"></a> **VE-150.** An automatic intent's missing exact source or required endpoint/proof evidence defers that intent even if another duplicate could independently authorize equivalent work. Importing the missing evidence completes its witness; lookup never replaces saved references. Invitation state alone does not defer it.

- <a id="ve-151"></a> **VE-151.** An admitted complete ACK carrier acknowledges its exact outbound through a valid channel path independently of handler execution. Later blocking or peer supersession preserves prior admitted evidence; a still-unadmitted carrier received after blocking or supersession changes no ACK state or timing. Current endpoint policy separately governs outgoing work.

- <a id="ve-152"></a> **VE-152.** A dedicated notification requires rotationEventCid and uses that decision's successor and peerDid. An inbound-triggered notification uses its exact source in the fromDidId/peerDid pair; a source-free manual notification has null effect/source fields and a UUIDv7 message ID. Different notification IDs for one decision conflict without affecting an independent ACK tuple.

- <a id="ve-153"></a> **VE-153.** A saved intent or rotation decision supplies no generic permission for another operation on the source. New work checks current policy separately; ordinary later policy changes do not erase the saved record or submission.

- <a id="ve-154"></a> **VE-154.** Application views attribute received claims to their exact authenticated inbound channel and submitted information to its exact outbound channel. Missing source endpoint evidence defers attribution. The same peer at another local DID receives no inferred name or sharing fact.

- <a id="ve-155"></a> **VE-155.** contact.channelsSet sorts complete canonical localDid/peerDid tuples by their specified encoding. Duplicate pairs, equal endpoints, noncanonical spellings and extra selector fields are invalid; an empty set clears selection and missing documents grant no processing authority.

### Termination payload and rotation allocation (VE-156–VE-157)

- <a id="ve-156"></a> **VE-156.** delivery.failed has exactly messageId and one of expired or cancelled, with empty roots. Additional fields, including packageId or scope, and unknown codes are invalid. An expired failure for an intent with null expiresTime is invalid and terminates nothing; explicit cancellation remains valid. Either valid code terminates its consistent intent without preparation evidence and blocks preparation/dispatch regardless of preparation import order. Termination releases the message's envelope contribution but preserves content. An independently complete submission still takes precedence.

- <a id="ve-157"></a> **VE-157.** New rotation allocation commits its UUIDv7 did.created and did.rotationSelected atomically. A crash exposes both or neither; recovery of an uncertain commit reuses the committed successor/decision instead of allocating a second DID. Import of the decision without its creation remains pending until exact evidence arrives. No crash prefix alone permits disclosure or dispatch.

### Replica-mediation membership (VE-158–VE-161)

- <a id="ve-158"></a> **VE-158.** mediation.created without profile is an ordinary arrangement. Its only profile value is "replica-mediation/1.0", with me.did a did:peer:4 long form; null and other values are invalid. Creations of one arrangement that differ only in profile disagree. A replica-mediation arrangement granted a routing DID other than its mediatorDid is a conflict.

- <a id="ve-159"></a> **VE-159.** replica/<replicaId>/me derives a replica's DID with its mediator as the only DIDComm service: the same replica ID and mediator give the same DID, another mediator or replica ID another DID. No payload field accepts a replica key name.

- <a id="ve-160"></a> **VE-160.** replica.created has exactly replicaId, mediationId and grant, with empty roots. The grant's protected header is exactly alg EdDSA, the grant typ and a kid naming a method of the account; its payload is its own RFC 8785 text of exactly the six string members, with UUIDv7 IDs equal to the event's, a short-form account, a replica DID other than the account and that DID's long form, no DID over 8192 bytes and no more than 16384 characters in all. Anything else, a payload that is not I-JSON included, is an invalid payload and leaves the events around it readable.

- <a id="ve-161"></a> **VE-161.** A replica is a member of its arrangement by one consistent binding, the arrangement's replica-mediation creation naming the same account and mediator, a kid that names, under the account's short form or its recorded long form, an authentication method of the recorded account document carrying the key the seed derives as a Multikey or Ed25519VerificationKey2020 multibase value or a JsonWebKey2020 JWK, and the seed's verdict on the grant's signature and on the replica's keys and service. The same binding recorded by several authors or under another kid spelling is one member; different bindings for one replica ID conflict without a winner. A missing creation or seed leaves it pending. Neither mediation.granted, whether missing, consistent, contradicting or naming another routing DID, nor retirement changes membership; an arrangement those make unusable still carries no mail.
