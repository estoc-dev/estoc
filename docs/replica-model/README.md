# Estoc version 5 specification suite

Status: **version 5**. The folds over the vault's events and the procedures
that append them are specified by the code under
[`packages/`](../../packages/) and its tests, see
[vault events section 11](vault-events.md#folds-and-procedures).
The suite has seven specifications and one vectors appendix. A vault may run
one writable full runtime or several as distinct replicas of one
replica-mediation arrangement. SQLite is the sole persistent vault and portable
interchange format. This guide is informative; linked specification sections
define requirements. The target uses vault version 5 and SQLite schema 2,
retaining the version-3 seed wrapper and existing key/domain-ID derivation;
the inbound transcripts take the canonical wire ID, under which a lower-case
ID derives as before.
Event identity and references use raw CIDs of five-field canonical envelopes;
a message's intent, plaintext and envelope are named by raw CIDs of their own
([message layers](distributed-delivery.md#canonical-projections-and-hashes)).
Identical envelopes are one event. A version-4 vault is refused; no old-vault
migration is required.

<a id="model-overview"></a>

## Model overview

A vault has one seed, immutable events and raw content-addressed objects.
[Channels](channels.md#model) are ordered local/peer DID pairs. Each receipt and
preparation retains its own authentication or encryption evidence. Carried proofs
retain their original JWTs and derive their immutable issuer documents. Phase-1 channel
endpoints use immutable `did:peer:4` documents; mediator DID resolution is
independent. Received proofs and local rotation decisions
derive directed links between pairs. Receipt may precede continuity verification,
whose status remains visible.

Operations use their own evidence and policy. An invitation is a reusable
address: no receipt takes it from the next, and no event records who used it.
Contacts organize
selected channels with local names and preferences. Applications derive ordinary display
data only from durably admitted message history under their protocol rules.
Authenticated receipt and application admission are separate facts; ignored
old-peer observations remain available as explicitly labelled diagnostics.
Admission is required for new source-derived operations and application views.
Existing rotation, outbound and submission records retain their
own validity without it. A saved operation cannot supply missing admission for
its source; see [application admission](channels.md#application-admission).

An outbound fixes its channel at intent commit; rotation never retargets it
and can prohibit its preparation or dispatch, including manual retries. A
preparation commits one fixed envelope, and a message may hold several. Every
transport call carries the envelope of the preparation the runtime selected
in its local state and requires a live initial/manual action. Recovery
exposes pending work for manual action. Retry carries the selected envelope;
different content or another channel requires a new message ID. Peer ACKs
record receipt independently of submission. See
[delivery boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table).

ACK, Trust Ping reply and rotation notification use independent persisted
intents identified by `(executionId, effectType)`. Each stable operation URI
permits at most one compatible intent per execution.

| Layer | Documents | Responsibility |
| --- | --- | --- |
| Storage | [Event store](event-store.md), [DASL objects](dasl-objects.md) | Event API, identity/order, object bytes and retention |
| Persistence | [SQLite vault](vault-sqlite.md) | Schema, exclusive ownership, transactions and portable recovery |
| Domain facts | [Vault events](vault-events.md) | Message, delivery, contact and local policy payloads; the folds over them are code |
| Communication authority | [Channels](channels.md), [Address/contact policy](relationships.md) | Fixed DID pairs, invitations, channel event payloads, DID profiles and address policy; the continuity adapter, admission and dispatch authority are code |
| Runtime | [Delivery](distributed-delivery.md) | Message layers and CIDs, channel-local identity, ACK paths, preparations, runtime-local delivery records and live dispatch actions |
| Vectors | [Message vectors](message-vectors.md) | Fixed inputs with their canonical bytes and CIDs for the message layers |

Ordinary DIDComm messages need no Estoc wire handshake or contact ID.

Two packages hold the shared semantics. The
[`@estoc/from-prior` package](../../packages/from-prior/README.md) implements
`from_prior` proof verification, creation and binding to a receipt, and owns
proof semantics; a bound proof reports the change it establishes. The
[`@estoc/continuity` package](../../packages/continuity/README.md) is a pure
continuity model over facts and owns graph semantics. Each README defines its
package's inputs, answers and host responsibilities.
[Channels](channels.md#continuity) states the application model, and
[`packages/vault/src/fold/channels.ts`](../../packages/vault/src/fold/channels.ts) and
[`fold/continuity.ts`](../../packages/vault/src/fold/continuity.ts) implement its use:
the vault projects bound changes, proof-free receipts and saved decisions into
continuity facts. Keep package semantics in their code, public contracts and
tests; app policy and storage integration belong in this suite and its code.
The packages' illustrated guides, for
[continuity](../../packages/continuity/docs/guide.md) and for
[from_prior](../../packages/from-prior/docs/guide.md), explain their queries,
stages and boundary cases. This app revision supports rotations only, not
endings.

<a id="reading-paths"></a>

## Reading paths

| Task | Suggested path |
| --- | --- |
| Understand the system | [Vault model](vault-events.md#model) → [channels and continuity](channels.md#model) → [address/contact policy](relationships.md#what-it-is-for) → [commit/ACK boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Implement storage | [DASL identity](dasl-objects.md#reading-guide) → [EventStore/Vault](event-store.md#reading-guide) → [SQLite](vault-sqlite.md#reading-guide) |
| Implement application state | [Identifier vocabulary](vault-events.md#identifier-and-reference-vocabulary) → [schemas](vault-events.md#reading-guide) → [folds and procedures](vault-events.md#folds-and-procedures) |
| Integrate continuity | [Event identity](event-store.md#invariants) → [continuity model](channels.md#continuity) → [channel evidence](../../packages/vault/src/fold/channels.ts) → [continuity fold](../../packages/vault/src/fold/continuity.ts) → [admission](channels.md#application-admission) |
| Implement sending | [Send](distributed-delivery.md#send-an-ordinary-message) → [address selection](relationships.md#ordinary-sending-and-birth-selection) → [preparation](distributed-delivery.md#preparing-a-package) → [local delivery records](distributed-delivery.md#runtime-local-delivery-records) → [delivery fold](../../packages/vault/src/fold/outbound.ts) |
| Implement receiving | [Receive](distributed-delivery.md#receive-a-message) → [resolution](relationships.md#did-resolution-requirements) → [receive gate](../../packages/agent-core/src/receive/gate.ts) → [channel evidence](../../packages/vault/src/fold/channels.ts) → [source evidence](distributed-delivery.md#address-chains-and-observation-membership) → [inbound fold](../../packages/vault/src/fold/inbound.ts) |
| Back up or recover | [Recovery material](vault-sqlite.md#recovery-material-and-product-requirement) → [export](vault-sqlite.md#snapshot-and-export) → [restore/import](vault-sqlite.md#restore-and-import) → [unfinished receive work](distributed-delivery.md#receive-recovery) |

<a id="rule-ownership"></a>

## Rule ownership

Change the defining section and align its consumers. ES owns event envelopes,
DO owns raw objects/retention APIs and SQ owns SQLite lifecycle. CH owns channel identity,
invitations and the rotation, admission and denial payloads; the continuity
adapter, operation eligibility, admission and dispatch authority are owned by
their code in `packages/vault` and `packages/agent-core`.
`@estoc/from-prior` owns proof verification and binding, and
`@estoc/continuity` owns graph semantics. VE owns contact selections, display payloads and the remaining
domain payloads, while the folds over them and the procedures that append
them are owned by their code in `packages/vault` and `packages/agent-core`;
DD owns runtime ordering and message/effect identity;
RZ owns the DID profiles, local resolution and address/display policy; the
receive gate, the private-address policy and retry are code.

| Rule | Definition | Consumers |
| --- | --- | --- |
| Event envelope and ordering | [ES](event-store.md#the-event) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary) |
| Commit durability | [ES](event-store.md#commit-and-durability-terminology) | [DD boundaries](distributed-delivery.md#cross-layer-commit-and-acknowledgment-table) |
| Storage ownership and recovery | [SQ](vault-sqlite.md#ownership-and-lifecycle) | [agent open](../../packages/agent-core/src/identity.ts) |
| Object identity and held roots | [DO](dasl-objects.md#accepted-dasl-cids), [VE retention](vault-events.md#held-roots) | [SQ objects](vault-sqlite.md#objects-and-streams) |
| Channel pair and selectors | [CH identity](channels.md#channel-identity) | [VE vocabulary](vault-events.md#identifier-and-reference-vocabulary), [contact selection](vault-events.md#contact-channelsset) |
| Proof verification and binding | [from-prior package](../../packages/from-prior/README.md) | [channel evidence](../../packages/vault/src/fold/channels.ts), [vault proofs](../../packages/vault/src/from-prior.ts) |
| Links, joins and query semantics | [Continuity package](../../packages/continuity/README.md) | [channel evidence](../../packages/vault/src/fold/channels.ts), [continuity fold](../../packages/vault/src/fold/continuity.ts) |
| Source projection, admitted confirmation and query policy | [continuity fold](../../packages/vault/src/fold/continuity.ts) | [rotation](../../packages/agent-core/src/rotate.ts), [DD receive](distributed-delivery.md#receive-a-message) |
| New-send head selection | [contact view](../../packages/vault/src/fold/views.ts) | [DD built-in replies](distributed-delivery.md#built-in-independent-operations), [RZ sending](relationships.md#ordinary-sending-and-birth-selection), [rotation](../../packages/agent-core/src/rotate.ts) |
| Deferred-proof adapter boundary | [DIDComm API](../../packages/agent-core/README.md#didcomm-api) | [receive gate](../../packages/agent-core/src/receive/gate.ts), [DD receipt](distributed-delivery.md#receive-a-message), [VE carrier](vault-events.md#message-in) |
| Receipt verification status | [continuity fold](../../packages/vault/src/fold/continuity.ts) | [DD recovery](distributed-delivery.md#receive-recovery) |
| Durable application admission and operation eligibility | [CH](channels.md#application-admission), [admission model](../../packages/vault/src/admission/model.ts) | [inbound fold](../../packages/vault/src/fold/inbound.ts) |
| Fixed intent, preparation and manual dispatch | [live action](../../packages/agent-core/src/action.ts), [dispatch](../../packages/agent-core/src/dispatch.ts), [DD selected preparation](distributed-delivery.md#the-selected-preparation) | [VE intent](vault-events.md#message-out), [preparation](vault-events.md#message-prepared), [DD send](distributed-delivery.md#send-an-ordinary-message) |
| Inbound/execution IDs | [DD identity](distributed-delivery.md#observation-identity-logical-aliasing-and-execution-identity) | [inbound fold](../../packages/vault/src/fold/inbound.ts) |
| Message layers and their CIDs | [DD layers](distributed-delivery.md#canonical-projections-and-hashes), [VE stored content](vault-events.md#stored-message-document), [vectors](message-vectors.md) | [VE intent](vault-events.md#message-out), [preparation](vault-events.md#message-prepared), [receipt](vault-events.md#message-in) |
| Effect results | [DD automatic effects](distributed-delivery.md#automatic-effects) | [VE skipped effect](vault-events.md#effect-skipped), [effects](../../packages/agent-core/src/effects.ts) |
| Runtime-local delivery records | [DD local records](distributed-delivery.md#runtime-local-delivery-records) | [responder](../../packages/agent-core/src/responder.ts), [prepare](../../packages/agent-core/src/prepare.ts), [dispatch](../../packages/agent-core/src/dispatch.ts) |
| ACK selection and authorization | [DD ACKs](distributed-delivery.md#durable-end-to-end-acknowledgment) | [VE ACK witness](vault-events.md#delivery-acknowledged) |
| Complete witnesses | [continuity fold](../../packages/vault/src/fold/continuity.ts), [inbound fold](../../packages/vault/src/fold/inbound.ts) | [CH links](channels.md#channel-linked), [DD ACKs](distributed-delivery.md#applying-ack) |
| Channel method boundary, local resolution and mediator resolution | [RZ resolution](relationships.md#did-resolution-requirements), [receive gate](../../packages/agent-core/src/receive/gate.ts) | [receipt](../../packages/agent-core/src/receive/receipt.ts), [DD receipt](distributed-delivery.md#receive-a-message) |
| Invitations | [VE disclosure](vault-events.md#did-disclosed), [invitation fold](../../packages/vault/src/fold/invitations.ts) | [CH invitations](channels.md#invitations) |
| Denial and contact views | [CH policy/display](channels.md#effects-and-recovery) | [VE contact selection](vault-events.md#contact-channelsset), [deletion](../../packages/vault/src/contact-commands.ts), [channel and contact views](../../packages/vault/src/fold/views.ts) |
| Submission/receipt state | [outbound fold](../../packages/vault/src/fold/outbound.ts) | [DD completion](distributed-delivery.md#submission-completion-and-expiration) |
| Restore and import | [SQ interchange](vault-sqlite.md#restore-and-import) | [DD recovery](distributed-delivery.md#receive-recovery) |

<a id="evidence-and-references"></a>

## Evidence and references

The seven documents above define the current contract. No document
lists conformance cases: the tests of the package that implements a
document are its evidence, and the folds and procedures over the vault's
events are specified by their code (see
[vault events section 11](vault-events.md#folds-and-procedures)). The
[message vectors](message-vectors.md) are fixed inputs with the bytes and
CIDs the layers must give, and the vault's tests reproduce them.
Mutable channel DIDs have only a [deferred design note](deferred/README.md),
where network vault synchronization is listed as deferred too. Those notes
reserve no current fields, error codes, key names or extension APIs; future
features will define their schemas when adopted.

Named anchors support direct links independently of displayed section numbers.

<a id="editing-conventions"></a>

## Editing conventions

Describe the specified behavior and its constraints directly. Keep a rule with
its owning document, or with its owning module when it is code, and link to
it from consumers. Use stable named anchors for references.
