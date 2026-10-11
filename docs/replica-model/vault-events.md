# The Estoc vault events, version 5

<!-- suite-navigation:start -->
[Suite guide](README.md)
<!-- suite-navigation:end -->

Status: **version 5**. The event vocabulary of one single-seed vault,
executed by its writable full runtimes, one alone or several side by side as
the replicas of a replica-mediation arrangement, is code in
[`@estoc/vault`](../../packages/vault/README.md): the identifier types in
[types.ts](../../packages/vault/src/types.ts); the reproducible namespaces,
every derived ID and the reserved key names in
[ids.ts](../../packages/vault/src/ids.ts); the closed payload of every event
type, the rules between its members and its `roots` in
[schema.ts](../../packages/vault/src/schema.ts); the stored message document
and the normalized envelope in
[document.ts](../../packages/vault/src/document.ts); the canonical public key
in [public-key.ts](../../packages/vault/src/public-key.ts); the vault's own
keys and DIDs in [identity.ts](../../packages/vault/src/identity.ts); what it
retains of a peer's document in
[peer-document.ts](../../packages/vault/src/peer-document.ts); the replica
grant in [replica-grant.ts](../../packages/vault/src/replica-grant.ts); the
held roots in [fold/held.ts](../../packages/vault/src/fold/held.ts); the folds
and the procedures as the package README lists them, one module per question,
with the tests beside each as its evidence and every published vector pinned
there. This document keeps what that code cannot state about itself: the
model its events are read under, the principles a new procedure is written
to, the boundaries the vault promises the layers above, and what this version
deliberately leaves out. Capitalized requirement words have their BCP 14
meanings.

[event-store.md](event-store.md) owns event identity, commit durability and
versioning; [dasl-objects.md](dasl-objects.md) owns object identity;
[vault-sqlite.md](vault-sqlite.md) owns storage, ownership, restore and
import; [channels.md](channels.md) owns channel identity, invitations and the
channel payloads; [distributed-delivery.md](distributed-delivery.md) owns the
message layers, their CIDs, the inbound identities and the commit and
acknowledgment boundaries. Socket state, pickup cursors, retry timers, caches
and traces are local state and appear in no event.

<a id="model"></a>

## 1. Model

A vault is one identity with one seed. Two vaults are the same identity
exactly when their anchor DIDs are equal. It runs one writable full runtime,
or several side by side as the replicas of one replica-mediation arrangement,
each writing as its own author; they share history only through import and
restore, and which of them answers an input that reaches them all is
[distributed-delivery.md](distributed-delivery.md#automatic-effects)'s. A
runtime may run in a local application or on a server and derives every
vault-controlled communication and mediation key from the seed by name;
process location changes no event's meaning and confers no ownership of a
DID. A remote client that does not hold the seed is not a full runtime, has
no event author and cannot turn a staged command into portable vault state by
itself.

The event model distinguishes three kinds of durable statement:

- **intent** — a user or policy decision that must survive offline and process
  failure, such as `message.out` or `contact.petname`;
- **observation** — a fact learned from authenticated bytes or an external
  service, such as `message.in`, `mediation.granted` or
  `delivery.acknowledged`; and
- **materialization** — selected work made durable, such as the exact
  ciphertext named by `message.prepared`.

Which of a message's representations a field names is said by its type: the
intent, plaintext, envelope and event CIDs of
[distributed-delivery.md](distributed-delivery.md#canonical-projections-and-hashes)
are distinct values, and a payload keeps them in distinct fields. A
representation CID is produced only by the constructor or decoder of that
representation, never by a cast; a value loaded under a field is checked
against that representation's own rules.

All current views are folds over immutable events. No portable mutable record
is authoritative. A fold is deterministic over the same event set, the
verdicts handed to it and its options, in whatever order the events arrived;
what needs the seed or the retained objects is checked once beside the fold,
so a repaired or lost object changes the projection without a new event. A
procedure reads the fold under the writer lock, decides over it and commits
each decision in one batch. An event reference names one exact event by its
CID and is never satisfied by another event with equal payload fields; a
missing target defers, an incompatible one conflicts, and neither is resolved
by the reference alone.

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
4. **Mediation and communication keys are vault-scoped.** They are derived
   from the seed by name, and no derived private key material is persisted.
   Key names are never renamed or reused, and a version bump renames none.
5. **Stable IDs identify exact manual retries.** A logical message, a
   preparation and a mediator delivery have different identities and
   different lifetimes.
6. **Duplicate work is expected.** Manual retry and mailbox redelivery may
   repeat work; recovery grants no automatic dispatch action. Folds and
   handlers must be idempotent.
7. **Conflicts are visible projections.** Concurrent or contradictory
   decisions remain events. A fold uses set semantics, explicit references or
   canonical latest-wins exactly where its module says so.
8. **Events are permanent; content may be erased.** An erase releases object
   roots. It never deletes a skeleton event, and nothing re-holds a released
   relation.
9. **`replica_id` is not a security boundary.** It does not revoke a copied
   seed or create a second identity.
10. **A mediator is not the vault.** Mailbox ciphertext has bounded retention.
    The readable event/object set is the recovery source.

<a id="privacy-and-security-boundaries"></a>

## 3. Privacy and security boundaries

- Every full runtime of the vault, alone or one of several replicas, holds the
  single seed. Event authorship does not authenticate history supplied by
  another holder of it.
- A `did/...` or `mediation/...` key name encodes no contact, replica, domain
  owner or process location. A `replica/...` name is the one name that says
  which replica holds it, and no payload field carries it, so what arrives at
  a replica's own DID never becomes a portable observation.
- TLS private keys, DNS credentials, ACME account keys and web deployment
  credentials are not vault communication keys and MUST NOT be derived from
  vault key names.
- Runtime and portable SQLite databases contain plaintext retained message
  content and attachments unless surrounding storage encrypts them.
- A rendezvous DID is intentionally disclosed and correlatable within its
  audience. Its Peer long form avoids DNS resolution for that DID; resolving
  a mediator may still involve a network resolver.
- Private-address allocation SHOULD disclose its new DID only in encrypted
  interaction and avoid publishing it in reusable discovery. This is policy,
  not a different channel or authentication type: every communication DID
  has the same send, receive and continuity semantics, and no payload stores
  a public or pairwise role.
- A valid `from_prior` is channel-context evidence. It MUST NOT globally
  link or retire addresses used by unrelated channels.
- Channel sender authority requires authenticated encryption; an inner
  signature supplies no alternative authenticated sender.
- The mediator stores only encrypted inner DIDComm envelopes and
  routing/account-delivery metadata. It is given each enrolled replica's ID
  and DID in its account-signed grant and can group them under the account;
  it is given no application plaintext, content-decryption key or contact
  ID, and a communication peer learns no local replica ID from that
  enrollment. It may observe its account DID, recipient DID and method,
  ciphertext size, arrival, pickup, ACK, expiry, IP and traffic timing.
- A direct endpoint sees transport metadata and encrypted DIDComm envelopes.
  It routes to a full vault runtime or an ingress service, is not an
  application-level runtime address, and MUST NOT identify one replica as
  the DIDComm application recipient.
- Ultimate ACKs reveal durable-receipt timing to the peer.

<a id="not-in-this-version"></a>

## 4. What this version leaves out

The schema can say what an event carries, not what was decided against.
Version 5 has:

- **no runtime-local eviction event.** A local storage policy that deletes a
  non-erased retained object makes the vault incomplete; it may be repaired
  from a verified portable import or backup, and missing bytes never
  authorize collection of retained roots.
- **no route migration.** Where a DID sends is the one DIDComm service of its
  own document, so the long form fixes it and no event changes it. A
  rotation derives its successor on the predecessor's route. Moving an
  existing relationship to another route or mediation arrangement, off a
  retired arrangement included, is not provided; selecting another
  arrangement affects newly created entries only.
- **no second arrangement with one mediator.** The arrangement ID is the one
  the mediator's DID derives and outlives retirement.
- **no replica-enrollment confirmation event.** `mediation.granted` records
  the account the mediator granted; `replica.created` records membership in
  the arrangement, not the mediator's acceptance of that replica. What a
  replica-add confirmed is runtime state, and no event repeats per attempt.
- **no second `wireMessageId` on an outbound.** An outbound `messageId` is
  its plaintext `id`; inbound wire IDs have the sender's scope and are
  stored apart.
- **no migration from an earlier vault version**, under
  [event-store.md](event-store.md#versioning).
