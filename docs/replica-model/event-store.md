# The Estoc event store, version 5

<!-- suite-navigation:start -->
[Suite guide](README.md)
<!-- suite-navigation:end -->

Status: **version 5** — content-addressed events. SQLite is the sole
persistent vault; a snapshot, a DASL CAR of a seed part and a content part,
is the interchange format. The event model, the `EventStore`, `ObjectStore`
and `Vault` interfaces, the SQLite vault and the snapshot are code in
[`@estoc/event-store`](../../packages/event-store/README.md):
the envelope, its validation, its identity and its order in
[event.ts](../../packages/event-store/src/event.ts); the object store and its
streaming hash in [objects.ts](../../packages/event-store/src/objects.ts); the
vault, its writer lock and the held view in
[vault.ts](../../packages/event-store/src/vault.ts); the snapshot's format,
export and read in [snapshot.ts](../../packages/event-store/src/snapshot.ts)
and its import in [import.ts](../../packages/event-store/src/import.ts); the
SQLite schema, the opening of a runtime and a restore under
[src/sqlite/](../../packages/event-store/src/sqlite/); the conformance
suites under `test/suite/` as the evidence every store must give.
This document keeps the contracts the code cannot state about itself: what
event identity promises to the layers above, what a successful commit
guarantees, and what a change to any of it costs. Capitalized requirement words
have their BCP 14 meanings.

Object CIDs are the raw DASL CIDs of
[`@estoc/dasl`](../../packages/dasl/README.md);
[vault-events.md](vault-events.md) owns the vault model and its
boundaries; payloads, held roots and the folds over them are
[`@estoc/vault`](../../packages/vault/README.md)'s.
[Delivery](distributed-delivery.md) and [channels](channels.md)
use these primitives.

<a id="invariants"></a>

## 1. Event and object identity

Events are immutable and identified by the raw DASL CID of their canonical
envelope bytes. Merge is set union by event CID: identical bytes are one event,
and different bytes are different events under the hash profile. An event
reference names exact content; it cannot be retargeted to another event with
similar fields. An **accepted event** is durably retained, not thereby a
trusted domain fact or an application-admitted message. Folds depend on the
accepted event set, never on arrival or physical row order.

Content addressing does not authenticate the author or the supplied history.
`author` is provenance, not a credential: it names one writable incarnation of
the vault, not hardware, a person or an execution-host key, and it is the
runtime's replica ID. Creation and a restore from a snapshot mint a fresh
author. Only
an exact move keeps it and the store generation: the complete current runtime,
moved once the old writer is permanently stopped and the database is cleanly
closed or recovered into one standalone file. A runtime copy taken before later
writes of its source is not an exact move: opening it to write MUST renew both
IDs, which invalidates every change token of the old generation and every
record keyed by the old replica ID (`resetIdentity` in
[`@estoc/event-store`](../../packages/event-store/README.md)). Two writable
copies never share an author. A store that meets, under its own author, an
event it does not hold refuses the whole input as a fork; the recovery is an
identity reset, and the historical events are never rewritten.

Equal envelopes are one event, however many times they are drafted. A domain
that must distinguish occurrences records that distinction in its payload, such
as a message ID. Decisions needing causality use explicit references, immutable
IDs, tombstones or set semantics. The wall-clock `at` and the canonical order
`(at, cid)` are presentation order and the order of explicitly latest-wins
fields, not causality and not arrival order. An ambiguous commit outcome is
not a safe instruction to resubmit drafts: a new commit samples a new `at` and
can produce different CIDs for the same drafts.

An object is named by the raw DASL CID of its complete bytes, whatever its
size: storage chunks and transport segments have no CID of their own, and
moving their boundaries changes no object's CID. The vault accepts raw objects
only. Content addressing checks integrity, not authorization, confidentiality,
provenance or safety: bytes are hashed where they are accepted, whatever a
stored column, a server or an HTTP digest claims, and object content is not
executed.

Only explicit event roots retain objects; a CID merely mentioned in a payload
or inside an object retains nothing and is not fetched. Change tokens and
caches never travel in a snapshot. A content part is labelled with the range
it was exported as: the exporting replica, its store generation and the
positions it accepted the events at. The label stays the exporter's: no
restore or import takes it for a replica ID, a generation, a position or a
token of its own, and losing it cannot lose a committed decision or message
body.

<a id="commit-and-durability-terminology"></a>

## 2. Commit and durability

Successful promise resolution confirms acceptance. A transaction may commit
before the caller receives confirmation; an unresolved or rejected promise is
not proof of rollback. Before resolution, a process crash may leave the complete
operation or none, never a partial accepted operation. After success, restarting
over the same intact storage generation MUST observe the complete committed
value, unless subsequently removed by an authorized operation such as object GC.

This is the suite's **process-durable** boundary. Sudden power loss, device
failure and loss of operating-system caches are separate platform guarantees.
A product claiming stronger durability must document and test that boundary;
this minimum alone is not a power-loss-safe receipt claim. The configuration
each platform runs with is reported by the driver tests of
[`@estoc/event-store`](../../packages/event-store/README.md).

<a id="versioning"></a>

## 3. Versioning

Vault version 5 covers the envelope, the object profile, key derivation and
the domain folds. SQLite schema versioning is separate, and the keystore
wrapper version is independent and remains 3. For a published vault version,
compatible additions are new event types, optional payload fields with a fixed
absent meaning, or negotiated capabilities. Changing existing meaning, the
envelope, ID or CID formats, derivation or a required fold needs a new vault
version. Changing the runtime's schema needs a new SQLite schema version, and
changing the snapshot's header or block rules a new snapshot format. An
earlier vault version is refused before any payload is read and is not
rewritten; no migration or import/restore compatibility with earlier vaults is
required, and a version bump renames no key-derivation purpose string.
