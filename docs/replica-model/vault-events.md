# The Estoc vault events, version 4

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide)
<!-- suite-navigation:end -->

Status: **phase 1**. The event vocabulary of one single-seed vault
executed by exactly one active writable full runtime. The folds over the
events and the procedures that append them are code; see
[section 11](#folds-and-procedures).

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
[channels.md](channels.md) owns channel identity, invitations and the channel
event payloads; operation eligibility is the linked modules' code. Receipt
precedes source-derived decisions and continuity work.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

Each domain places its event schemas together; the fold and procedure
columns link the module that owns each rule.
Shared vocabulary is in [section 3](#identity-seed-and-key-names); cross-document rule ownership is listed in
the [suite guide](README.md#rule-ownership). The table is a navigation aid.

| Domain | Definitions and event schemas | Folds | Procedures |
| --- | --- | --- | --- |
| Identity and naming | [Identity, keys and identifier types](#identity-seed-and-key-names); [Identity label](#identity-label) | [Authors and label](../../packages/vault/src/fold/author.ts) | [Open runtime](../../packages/agent-core/src/identity.ts) |
| Mediation and DIDs | [Key evidence and resolved documents](#message-keys-and-peer-evidence); [Mediation and DID events](#mediation-communication-dids-and-routes) | [Mediation](../../packages/vault/src/fold/mediation.ts); [Replicas](../../packages/vault/src/fold/replicas.ts); [DIDs and keys](../../packages/vault/src/fold/dids.ts) | [Establish mediation](../../packages/agent-core/src/mediation.ts); [Enroll a replica](../../packages/agent-core/src/replica-enrollment.ts); [Create and disclose a DID](../../packages/agent-core/src/dids.ts) |
| Channels and continuity | [Channel identity and payloads](channels.md#channel-identity) | [Channel evidence](../../packages/vault/src/fold/channels.ts); [Continuity](../../packages/vault/src/fold/continuity.ts); [Admission](../../packages/vault/src/admission/model.ts) | [Channel and display policy](relationships.md#symmetric-relationship-identity); [Early privacy policy](../../packages/agent-core/src/privacy.ts); [Rotate local address](../../packages/agent-core/src/rotate.ts) |
| Contacts | [Contact events](#contacts); [Channel selections](#contact-channelsset) | [Contacts](../../packages/vault/src/fold/contacts.ts); [Channel and contact views](../../packages/vault/src/fold/views.ts) | [Delete contact](../../packages/vault/src/contact-commands.ts) |
| Messages and delivery | [Stored content](#stored-message-document); [Outbound events](#outbound-message-events); [Inbound events](#inbound-message-events) | [Inbound execution](../../packages/vault/src/fold/inbound.ts); [Outbound delivery](../../packages/vault/src/fold/outbound.ts) | [Send](distributed-delivery.md#send-an-ordinary-message); [Receive](distributed-delivery.md#receive-a-message); [Recover receipt](distributed-delivery.md#receive-recovery) |
| Invitations | [Disclosure](#disclosure) | [Invitation availability](../../packages/vault/src/fold/invitations.ts) | [Discovery](relationships.md#out-of-band-discovery); [Receipt](../../packages/agent-core/src/receive/receipt.ts) |
| Erasure and retention | [Erasure and held roots](#erasure-and-collection) | [Held roots](../../packages/vault/src/fold/held.ts) | [Erase message](../../packages/vault/src/erasure.ts) |

<details>
<summary>Contents</summary>

- [1. Model](#model)
- [2. Principles](#principles)
- [3. Identity, seed and key names](#identity-seed-and-key-names)
- [4. Message keys and peer evidence](#message-keys-and-peer-evidence)
- [5. Mediation and communication DIDs](#mediation-communication-dids-and-routes)
- [6. Contacts](#contacts)
- [7. Stored message document](#stored-message-document)
- [8. Outbound messages and delivery](#outbound-message-events)
- [9. Inbound messages](#inbound-message-events)
- [10. Erasure and collection](#erasure-and-collection)
- [11. Folds and procedures](#folds-and-procedures)
- [12. Merge and restore](#merge-and-restore)
- [13. Privacy and security boundaries](#privacy-and-security-boundaries)
- [14. Versioning](#versioning)

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
   runtime derives them from the vault seed and can have the account hold
   its addresses, receive and expose pending delivery for explicit manual action.
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

In `did/...` names, `<id>` is the DID entity ID: a UUIDv7 minted for a new
address, or a UUIDv5 derived under the DID entity rules of
[section 3.4](#entity-ids-and-reproducible-uuidv5-namespaces). In
`mediation/<id>/me`, `<id>` is the arrangement ID, the UUIDv5 the mediator's
DID derives under the same section. Version 4 defines exactly one
authentication key and one key-agreement key per communication DID entity.
Key names are never renamed or reused. A `did/...` or `mediation/...`
name does not encode a contact, replica, domain owner or process location.

A `replica/...` name is the one name that says which replica holds it: it
derives the DID under which that replica alone picks up mail
([`replica.created`](#replica-created)). No payload field carries it. Every
`localKeyName` is a `did/...` or `mediation/...` name, so what arrives at a
replica's own DID never becomes a portable observation.

Changing a communication DID's keys or embedded service creates another
`did:peer:4` entity. A local [`did.rotationSelected`](channels.md#did-rotationselected)
authorizes a successor channel for new intents; existing intents retain
their channel and may become undispatchable. There is no local
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

The purposes and resulting namespace UUIDs are these; the first three are
unchanged from version 3:

| purpose | namespace UUID |
| --- | --- |
| `inbound-message` | `4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6` |
| `message-execution` | `6511fc66-4d39-589e-b2c7-7185a807b6c6` |
| `automatic-mid` | `8847bd57-5907-5bcd-9a71-d1e97cee3199` |
| `mediation` | `ef3354b7-959d-5de2-a68d-f475ff7a7ab4` |
| `did-entity` | `47c0b363-2cc9-5e29-8898-0cb3cffa2ac2` |

A deterministic entity rule then computes:

```text
UUIDv5(estocNamespace(purpose), UTF8(RFC8785(name_array)))
```

`name_array` is the exact JSON array specified by that rule. RFC 8785
canonical UTF-8 gives unambiguous nulls, strings and field boundaries. A
runtime MUST derive and verify the namespace UUID from the URI above rather
than trusting a copied table constant. The table is a test vector, not a
second source of truth.

Where a rule below takes a DID, `N(did)` is its canonical spelling: the short
form of a `did:peer:4`, whichever spelling arrived, and any other DID as it
is. A value that is no DID, or a `did:peer:4` in neither form, is no input.

<a id="mediation-arrangement-rule"></a>

#### Mediation arrangement rule

```text
mediationId(mediatorDid) = UUIDv5(
  estocNamespace("mediation"),
  UTF8(RFC8785(["v1", N(mediatorDid)]))
)
```

A vault has one arrangement with a mediator, and this is its ID: every
replica that arranges with the mediator derives the same ID, the same
account key name and so the same account, and their `mediation.created`
events are one creation under the
[mediation fold](../../packages/vault/src/fold/mediation.ts). The ID outlives the arrangement: once it
is retired, there is no other ID under which to arrange with that mediator.

The mediator's identity is `N(mediatorDid)`. Wherever a mediator or routing
DID is compared — creations of one arrangement, its grants, the arrangement
a document's routing DID is looked up by, a replica grant's `mediator`
against the arrangement's — the comparison is of `N` of each side: a valid
long and short spelling of one `did:peer:4` are one mediator, never a second
mediator or a disagreeing grant. Each event keeps the spelling it was
written with, and no event or CID is rewritten to canonicalize it: a long
form is the material its short form resolves from. Comparing identities
replaces no check of a document, hash or signature.

Test vector: `did:web:mediator.example` gives
`1922ce3b-533a-5c75-8cb1-10cdd1f80204`.

<a id="did-entity-rules"></a>

#### DID entity rules

```text
successorDidId(predecessor) = UUIDv5(
  estocNamespace("did-entity"),
  UTF8(RFC8785(["v1", "next", N(predecessor)]))
)

startDidId(publicDid, binding) = UUIDv5(
  estocNamespace("did-entity"),
  UTF8(RFC8785(["v1", "start", N(publicDid), N(binding)]))
)
```

`predecessor` is the DID of the local entity a successor follows;
`publicDid` is a public address of this vault and `binding` the peer DID a
relationship under it is bound to. `publicDid` equal to `binding` is no
input.

The successor rule names the predecessor's DID, not its entity ID: the DID
commits to the whole document, keys and route alike, so replicas rotating
from one DID arrive at one successor whose key names and keys agree. Equal
successor documents take more: the allocating procedure must choose the same
document-builder inputs, the route among them, which the ID derivation does
not select. The peer's current DID is no input to the successor rule: replicas
learn of a peer's rotation at different times and would otherwise part.
`"v1"` names the derivation profile: this transcript together with the key
derivation of [section 3.2](#single-seed) and the numalgo-4 document
builder; a change to any of the three is a new version string, and entities
already created keep their IDs.

These rules define the IDs. Which rule made an entity is recorded in its
creation's `generation` under [`did.created`](#did-created): an entry is
minted, a start follows `startDidId` over its predecessor and binding, a
next follows `successorDidId` over its predecessor, and under profile `v1`
the schema checks the entity ID against the rule its generation names. A
generation under another profile is read as recorded and never rebuilt by
these rules.

Test vectors, over the delivery fixture's DIDs
`did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd` (ours) and
`did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP` (the peer's):
`successorDidId(ours)` is `24ae4bcc-e4ee-5111-b600-1674a2300462` and
`startDidId(ours, peer)` is `4cb0f38a-668b-5472-b82c-509b397c8058`.

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
document in [section 7](#stored-message-document) also retains its application-content shape. Producers
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
the key-agreement key used for receipt/preparation. Selection alone is not
evidence of authenticated inbound traffic or remote receipt.

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
Each observation retains its own key evidence; what it establishes is
[the channel evidence fold](../../packages/vault/src/fold/channels.ts)'s to say.

<a id="mediation-key-evidence"></a>

### 4.2 Mediation key evidence

Traffic between the vault and a mediator uses a local key beginning with:

```text
mediation/
```

These observations belong to the mediation fold, not application
channels or contact/application views.

<a id="111-peerresolved"></a>

<a id="peer-resolved"></a>

### 4.3 `peer.resolved`

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
- `did` is its canonical short form under [the peer DID profile](relationships.md#peer-did-numalgo-4-profile);
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
sender only; a predecessor proof is verified against the issuer document
[the channel evidence fold](../../packages/vault/src/fold/channels.ts) finds
under the same canonical representation. The referenced resolution objects
remain historical evidence; another document cannot replace any reference.

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
the retained bytes or CID. Method IDs compare as [the retained peer
document](../../packages/vault/src/peer-document.ts) reads them.

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
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "mediatorDid": "did:web:mediator.example",
    "me": {
      "keyName": "mediation/1922ce3b-533a-5c75-8cb1-10cdd1f80204/me",
      "did": "did:peer:4zQm..."
    }
  }
}
```

This intent creates the stable vault-controlled identity for one mediation
arrangement. `mediationId` is the ID `mediatorDid` derives under the
[mediation arrangement rule](#mediation-arrangement-rule); any other value
is an invalid payload. `me.keyName` MUST use the arrangement ID and `me.did`
MUST match the seed-derived key.

Every arrangement is an account of the mediator's replica-mediation protocol,
whose mail each replica picks up under its own DID. `me.did` is recorded as a
`did:peer:4` long form; a short form is an invalid payload. The payload names
no profile: there is one kind of arrangement.

Replicas that each arrange with one mediator record one creation, whichever
spelling of the mediator each was given: [the mediation
fold](../../packages/vault/src/fold/mediation.ts) reads the creations and the
grants of one arrangement as one when they agree under `N`, and as a conflict
nothing later resolves when they do not. There is no second arrangement with
one mediator.

<a id="mediation-granted"></a>

#### `mediation.granted`

```json
{
  "type": "mediation.granted",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "routingDid": "did:peer:2.Ez..."
  }
}
```

This is the durable observation that the mediator granted the arrangement
and returned `routingDid`. For a replica-mediation arrangement it is the
observation of the mediator's `account-registered` reply, recorded once, and
`N(routingDid)` equals `N(mediatorDid)` of the arrangement; any other value
is a conflict.

<a id="mediation-selected"></a>

#### `mediation.selected`

```json
{
  "type": "mediation.selected",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204"
  }
}
```

This is the user's or policy's preferred mediation for newly minted
mediated DIDs. The latest event by canonical order wins. Selection does not
stop old arrangements from receiving.

<a id="mediation-retired"></a>

#### `mediation.retired`

```json
{
  "type": "mediation.retired",
  "roots": [],
  "data": {
    "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
    "because": "replaced"
  }
}
```

Retirement is terminal for the arrangement ID, and the ID is the one the
mediator's DID derives: the vault does not arrange with that mediator
again. A successor inherits its predecessor's route, so a DID routed
through a retired arrangement takes no successor: an ordinary rotation
away from it is refused, and moving a relationship off a retired
arrangement is a migration this version does not provide. A DID whose
document sends to the retired arrangement's routing DID waits under
[the DID fold](../../packages/vault/src/fold/dids.ts); the fold never changes a DID's
document.

<a id="replica-created"></a>

#### `replica.created`

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
[replica fold's](../../packages/vault/src/fold/replicas.ts).

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
    "longFormDid": "did:peer:4zQm...rendezvous-short:z...rendezvous-input-document",
    "generation": { "kind": "entry", "profile": "v1" }
  }
}
```

`generation` is REQUIRED and records, once and immutably, how the entity
was made and what it is for:

- `{ "kind": "entry", "profile" }`: an address branches are made from, the
  one kind a procedure discloses. Under profile `v1` its ID is a minted
  UUIDv7.
- `{ "kind": "start", "profile", "predecessor", "binding" }`: the first
  address toward one peer under the entry `predecessor`, bound to
  `binding`, the peer's address the usable history led back to when the
  branch was made. Under `v1` its ID is `startDidId(predecessor, binding)`.
- `{ "kind": "next", "profile", "predecessor" }`: the replacement of the
  start or next `predecessor` in the same branch. Under `v1` its ID is
  `successorDidId(predecessor)`.

`predecessor` and `binding` are canonical `did:peer:4` short forms;
`predecessor` is another DID than the entity's own, and `binding` another
than `predecessor`. `profile` names the key derivation, the entity-ID
transcripts and the document builder the entity was made by; this version
makes entities under `v1` alone, reads a non-empty unknown profile as
recorded and continues no branch under it.

The branch an entity belongs to is read back from the generations under
[the DID fold](../../packages/vault/src/fold/dids.ts): an entry; a branch,
anchored at the pair of the start's `predecessor` and `binding`; pending
while a predecessor's creation is not here; invalid where the generations
contradict each other, a start under a branch, a next under an entry, a
profile that changes along the way, a predecessor in conflict or a chain
leading back to itself. The lineage bears on what a successor is made from
and what may be disclosed; it grants no continuity, confirms no receipt and
unmakes no verification of a historical message.

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

A communication DID entity ID is a UUIDv7 minted for an entry, or a UUIDv5
derived under the [DID entity rules](#did-entity-rules) for a start or a
next, as its `generation` says. A creation procedure makes entries alone;
a start or a next is made by [the rotation procedure](../../packages/agent-core/src/rotate.ts)
from the recipe [the succession query](../../packages/vault/src/succession.ts)
names, on the predecessor's own route, and an entity already recorded under
that ID is reused only when its document and generation are exactly what
would be made. Same ID with different identity fields, the generation
included, is an integrity conflict; a retry of a creation never writes a
second creation to change an entity's use.

<a id="delivery-routes"></a>

### 5.3 Where a DID sends

A communication DID's document names exactly one DIDComm service, and
that service is the DID's route: a mediator's routing DID, under which
the DID is routed by the mediation arrangement whose grant names that
DID, or an absolute HTTPS or WSS direct endpoint. The route is part of
the document, so the long form fixes it; nothing beside the document
records it and no event changes it. A transport or mediation change
creates successor DID entities, allowing old and new DIDs to overlap
during cutover. Each affected channel takes its own
[`did.rotationSelected`](channels.md#did-rotationselected) for new intents;
mediation selection does not migrate existing DIDs.

A direct endpoint routes to a full vault runtime or an ingress service.
It MUST NOT identify one replica as the DIDComm application recipient.
Minting the DID does not itself register a recipient.

One rendezvous DID and many pairwise DIDs may send through the same
arrangement or endpoint, which is how they reuse a mediator or direct
ingress without sharing an application identity.

Which arrangement routes a mediated DID now, and whether the DID is live,
waits or has ended, is [the DID fold](../../packages/vault/src/fold/dids.ts)'s.
Restoring communication takes a successor DID, never a change to the old
entity.

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
Any live entry may be disclosed, and no address of a private branch: a
start or a next is the one peer's, and a disclosure of it is refused with
the reason that an entry is to be created instead. An invitation is reusable: whoever
holds it writes to the disclosed DID in a channel of their own, and no receipt
takes it from the next; [the invitation fold](../../packages/vault/src/fold/invitations.ts) says whether
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

Retirement is terminal for new sending and disclosure using this DID.
It does not erase keys, documents, received messages or continuity evidence,
and it takes the DID off no mediator: the DID stays in the desired recipient
set of [the DID fold](../../packages/vault/src/fold/dids.ts), held by its account.
A retired DID's key still receives; whether it may now is that fold's, and
[the receiver](../../packages/agent-core/src/receive/receiver.ts) owns the
receipt gates. An invitation on a retired local DID is unavailable.

<a id="7-contacts"></a>

<a id="contacts"></a>

## 6. Contacts

A contact uses a `contactId` to organize [selected channels](#contact-channelsset),
names and preferences independently of protocol authority.

<a id="contact-ids"></a>

### 6.1 Contact IDs

See [relationships.md section 5.1](relationships.md#contact-ids).

<a id="contact-event-schemas"></a>

### 6.2 Contact event schemas

<a id="123-relationshipcontactassigned"></a>
<a id="relationship-contactassigned"></a>
<a id="contact-peerdidadded"></a>
<a id="contact-peerdidremoved"></a>
<a id="contact-channelsset"></a>

#### `contact.channelsSet`

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
that membership arrives; later sets may be empty under [`contact.channelsSet`](#contact-channelsset).

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

This selects among eligible channels for a new send under [the contact view](../../packages/vault/src/fold/views.ts)
without changing `contact.channelsSet`. Publicly disclosed addresses may send;
private allocation follows [the private-address policy](../../packages/agent-core/src/privacy.ts).

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

<a id="stored-message-document"></a>

## 7. Stored message document

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

## 8. Outbound messages and delivery

<a id="ids"></a>

### 8.1 IDs

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

### 8.2 `message.out`

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

`senderDidId` and `recipientDid` are REQUIRED and immutable; their canonical
pair fixes the channel under [channel identity](channels.md#channel-identity).
`recipientDid` retains the exact supplied spelling, including a validated Peer
long form for offline preparation; canonicalize it for channel/package comparison.
Which channel an automatic output goes to is
[the response policy](../../packages/vault/src/response-policy.ts)'s; a contact
ID is not protocol identity. The fixed address fields are excluded from the
intent hash and included in full event equality.

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
  producing protocol, recomputes its key under [distributed-delivery.md section 11](distributed-delivery.md#automatic-effects), and requires its `messageId` to equal the [section 8.1](#ids) derivation;
- the three automatic-effect fields and two source/rotation references are portable metadata excluded from
  the wire and intent hash; they still participate in full event equality;
- `thid`, `pthid`, `expiresTime` and all three automatic-effect
  fields are present with null when unused; and
- appending this event requires no network, resolver, mediator or socket.

A preparer emits `created_time`, `expires_time`, `thid` and `pthid` only when
non-null; emits `please_ack` whenever `pleaseAck` is non-null; emits `ack` and
`attachments` when non-empty; and expands `headers` at plaintext top level.

More than one `message.out` under one `messageId` is one intent only when
every field is identical; what [the outbound
fold](../../packages/vault/src/fold/outbound.ts) makes of a difference, or of
an automatic intent's source, is its own.

<a id="message-prepared"></a>

### 8.3 `message.prepared`

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
  [the DID resolution requirements](relationships.md#did-resolution-requirements);
- `fromPrior` is the exact compact JWT included in the package or null;
- the envelope object contains `UTF8(RFC8785(parsedEncryptedEnvelope))` under
  a raw DASL CID; duplicate members or invalid I-JSON are rejected before
  canonicalization. The `envelopeCid` CID commits to those exact bytes;
- `packageId` is a UUIDv7 and equals outer `forward.id`; and
- every retry of this package uses identical envelope bytes.

<a id="delivery-attempted"></a>

Committing this event freezes the package for its `messageId`, even before any
transport call: further `message.prepared` records for that message MUST have
identical payloads and roots, including `packageId` and exact evidence
references, and every transport call of the message carries these envelope
bytes. A package records no transport invocation; call counts and retry
diagnostics are local trace. What a differing or missing preparation means is
[the outbound fold](../../packages/vault/src/fold/outbound.ts)'s; when the
package is sent is [dispatch](../../packages/agent-core/src/dispatch.ts)'s.

<a id="delivery-submitted"></a>

### 8.4 `delivery.submitted`

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
[the outbound fold](../../packages/vault/src/fold/outbound.ts).
If acceptance happened but this observation did not commit, the outcome remains
unconfirmed and requires explicit manual retry; recovery never resubmits it.

Transport, endpoint and response status are local trace data. They are not
fields of this portable event and do not participate in the delivery fold.

<a id="delivery-failed"></a>

### 8.5 `delivery.failed`

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

Resolution and transport failures, the `resolve`/`prepare`/`submit` phase and
retry diagnostics belong only to local trace and retry policy. They MUST NOT append
`delivery.failed`. Losing that local state does not terminate the intent or
change its portable delivery state.

When each code is appended is [preparation](../../packages/agent-core/src/prepare.ts)'s
and [dispatch](../../packages/agent-core/src/dispatch.ts)'s. A later user
attempt requires a new `message.out` and wire ID. Sensitive strings remain in
local trace; `code` is a stable non-secret value.

<a id="delivery-acknowledged"></a>

### 8.6 `delivery.acknowledged`

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

This records peer receipt information only: it cannot synthesize submission,
release a package envelope or authorize a retry. All five data fields are
required: `messageId` names the outbound; `ackMessageId` and
`ackWireMessageId` name the carrier's vault and wire IDs; `localKeyName` and
`peerPublicKey` equal that carrier's local key and derived authenticated peer
key, every field matched against one complete witness. Which carriers
acknowledge an outbound, and over which path, is
[the outbound fold](../../packages/vault/src/fold/outbound.ts)'s.

<a id="10-inbound-message-events"></a>

<a id="inbound-message-events"></a>

## 9. Inbound messages

<a id="deterministic-inbound-observation-message-id"></a>

### 9.1 Deterministic inbound observation message ID

See [distributed-delivery.md section 9](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity).

<a id="message-in"></a>

### 9.2 `message.in`

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
      "mediationId": "1922ce3b-533a-5c75-8cb1-10cdd1f80204",
      "deliveryId": "01J...opaque"
    }
  }
}
```

Phase 1 records no separate inner-signature evidence. Channel sender authority
requires authenticated encryption under [the receive gate](../../packages/agent-core/src/receive/gate.ts);
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
  and [the receipt](../../packages/agent-core/src/receive/receipt.ts).
  Commit/reuse that event and document first, then use its returned event CID
  in the separate inbound commit; later resolutions cannot replace the
  reference. It is local
  evidence metadata, excluded from the message hashes;
- for authenticated input, derive the [channel pair](channels.md#channel-identity)
  from the local DID owning `localKeyName` and the authenticated canonical `did`.
  Validate that local DID/key mapping against the exact local key-agreement
  method that successfully decrypted the authcrypt layer, under the
  [recipient evidence rule](../../packages/agent-core/src/receive/gate.ts).
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
existing `cid` preserves its event, and a full import never rejects an event
union for repeated observations of one input. How the observations of one
input are grouped, ordered and witnessed is
[the inbound fold](../../packages/vault/src/fold/inbound.ts)'s; how a delivery
becomes one is [the receipt](../../packages/agent-core/src/receive/receipt.ts)'s.

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
fields, wrong reference types, null references and nonempty roots. What an
admission is worth, and which observation may be admitted now, is
[the admission model](../../packages/vault/src/admission/model.ts)'s.

<a id="15-erasure-and-collection"></a>

<a id="erasure-and-collection"></a>

## 10. Erasure and collection

<a id="151-messageerased"></a>

<a id="message-erased"></a>

### 10.1 `message.erased`

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

<a id="153-held-roots"></a>

<a id="held-roots"></a>

### 10.2 Held roots

Under the operation lock in [event-store.md section 9](event-store.md#vault-interface), the vault runtime computes
the held roots passed to `ObjectStore.collect` in [dasl-objects.md section 8.3](dasl-objects.md#collection);
[the held-roots fold](../../packages/vault/src/fold/held.ts) is that
computation. Collection may rely on this much:

- a root is held while an accepted event retains it through `event.roots`;
  an event of a type this version does not name, or whose payload does not
  read, retains every root it names;
- a valid `message.erased` naming `(messageId, root)` permanently releases
  every contribution of that message to that root, those learned later
  included, and no later event re-holds that relation; another message's
  contribution still holds the bytes;
- a prepared envelope is released once its message is submitted or
  terminated under a consistent intent, and by nothing else: not a peer's
  acknowledgement, a competing package, a conflict or missing evidence;
- a CID embedded in object content is not a retention edge unless it also
  appears in an accepted event's `roots`.

<a id="154-no-runtime-local-eviction-event"></a>

<a id="no-runtime-local-eviction-event"></a>

### 10.3 No runtime-local eviction event

Version 4 does not represent local body eviction as a portable event. A local
storage policy that deletes a non-erased retained object makes the phase-1
vault incomplete. It may be repaired from a verified portable SQLite import or backup.
Missing bytes never authorize collection of retained roots.

<a id="16-procedures"></a>

<a id="procedures"></a>
<a id="folds-and-procedures"></a>

## 11. Folds and procedures

The folds over these events, and the procedures that decide what to
append, are specified by their code and its tests, not by this document.
[`packages/vault/README.md`](../../packages/vault/README.md) lists them,
one module per question, with each module's entry points; a module's
leading comment states the rule it implements, and the tests beside it
are the evidence. A fold is deterministic over the same event set, the
verdicts handed to it and its options, in whatever order the events
arrived; what needs the seed or the retained objects is checked once
beside the fold, in
[`packages/vault/src/fold/vault.ts`](../../packages/vault/src/fold/vault.ts),
so a repaired or lost object changes the projection without a new event.
A procedure reads the fold under the writer lock, decides over it and
commits each decision in one batch, as
[`commit.ts`](../../packages/vault/src/commit.ts) states; the runtime's
own procedures are the modules of
[`packages/agent-core/src/`](../../packages/agent-core/src/). This
document keeps the event schemas, the identifiers and the retention
contract the folds obey; where a section above refers to a fold or a
procedure, it links the module that owns it.

<a id="merge-and-restore"></a>

## 12. Merge and restore

<a id="171-event-merge"></a>

<a id="event-merge"></a>

### 12.1 Event merge

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

<a id="172-object-merge"></a>

<a id="object-merge"></a>

### 12.2 Object merge

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

### 12.3 Restore

A portable SQLite restore creates a new local `replica_id` and
`store_generation`. An exact local move is a separate operation that may retain
them only with the old writer permanently stopped under
[vault-sqlite.md section 12.3](vault-sqlite.md#exact-local-move). The restored
runtime is another replica of the vault: it derives the keys its retained
entity records name, enrolls at each arrangement it must keep receiving on,
has the account hold every address the arrangement routes, and picks up its
own mailbox; mail the mediator fanned out to the earlier replica before the
restore stays with that replica. Opening records what the vault owes on its
own, observations already pickup-ACKed before the snapshot included, mints no
initial or retry dispatch authority, even after an exact local move, and
shows what it finds unfinished for manual action. The open is
[`packages/agent-core/src/agent.ts`](../../packages/agent-core/src/agent.ts) over
[`identity.ts`](../../packages/agent-core/src/identity.ts); local queue state is not a recovery source.

A local DID created after the snapshot may be absent after restore. The
seed alone cannot reconstruct a missing entry, whose UUIDv7 entity ID is
minted; a missing start or next is made again from the same recipe, the same
entity under the same keys and document, once the rotation that made it is
decided again. Once local recipient state is authoritative,
deliveries with no known or recoverably pending recipient mapping follow the
terminal wrong-recipient gate and its bounded visible diagnostic under
[the receiver](../../packages/agent-core/src/receive/receiver.ts). Such an address stays
held by the account under [the DID fold](../../packages/vault/src/fold/dids.ts); nothing is
taken off the mediator.

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
under [the receiver](../../packages/agent-core/src/receive/receiver.ts). Waiting alone
does not recover the long form. A new long-form disclosure can enable sender
authentication but does not itself recover missing continuity history or a
discarded delivery. Importing a newer complete snapshot may restore retained
evidence; otherwise the channel may need to be established again.

Traffic at a snapshot-era address is not a guaranteed repair. Supersession
can prevent a reply, and eligible live input, including an already queued
message, can trigger another privacy rotation when the snapshot lacks a later
decision. The successor it selects is the one the recipe derives, so where
the restored vault leads back to the same start of the peer it is the lost
decision's own successor, and the new record joins the lost intent once the
histories merge; the peer verifies one replacement under two proofs. Where
the restored vault sees another start of the peer, the recipe differs and
so does the successor: if the peer already verified the lost decision's
successor, it then retains two valid replacements of the same endpoint in
one context. Phase 1 preserves that fork as a visible conflict under
[channels.md](channels.md#continuity), with no default send head in the
affected context and no authority through conflicted continuity. Restoring
the lost decision does not choose between the branches. Communication may
be established independently from a fresh entry; doing so does not resolve
the old context. Restore UI MUST explain these limits under
[vault-sqlite.md](vault-sqlite.md#restore).

No previous process must be online. Mediator retention still bounds messages
that were never committed to the vault. The seed recovery credential must be
retained independently of the active runtime; a portable SQLite backup includes
its encrypted wrapper. Recovery verification follows
[vault-sqlite.md section 4.2](vault-sqlite.md#recovery-material-and-product-requirement).

<a id="175-forked-author"></a>

<a id="forked-author"></a>

### 12.4 Forked author

If two writable copies accidentally preserve the same local replica ID,
previously unseen same-author events cause `ForkedAuthor`. One copy mints
a new local replica ID and retries merge. Existing events under the old
author remain unchanged.

<a id="18-privacy-and-security-boundaries"></a>

<a id="privacy-and-security-boundaries"></a>

## 13. Privacy and security boundaries

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
  routing/account-delivery metadata. The mediator of a replica-mediation
  arrangement is given each enrolled replica's ID and DID in its
  account-signed grant and can group them under the account; it is given
  no application plaintext or content-decryption key, and a communication
  peer learns no local replica ID from that enrollment.
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

## 14. Versioning

These event meanings belong to vault version 4. A version-4 reader may
preserve unknown event types but MUST validate every known type according
to this document.

Compatible additions within version 4 may introduce a new event type or
an explicitly optional payload field whose absence has a fixed meaning.
Changing a published field meaning, fold, deterministic ID, erasure rule or key
derivation requires a new vault version.
