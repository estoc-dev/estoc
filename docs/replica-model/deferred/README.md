# Deferred design notes

These drafts are outside the [phase-1 contract](../README.md). They are retained
as design material, not implementation requirements or commitments to a later
interface. They reserve no current event types, payload fields, failure codes,
key names, extension APIs or test cases. Their candidate rules may be incompatible
with the current profile; they must be reconsidered before a feature is adopted.

| Topic | Candidate draft | Decisions still needed before implementation |
| --- | --- | --- |
| Mutable channel DIDs | [Web channel DIDs](did-web-channels.md) | Current-document authorization, lookup/retry limits, proof recovery and any new failure model |
| Replica-to-replica synchronization | [Vault sync](vault-sync.md) | Transfer model, transport, reconciliation and catch-up execution policy |

Phase 1 implements immutable `did:peer:4` application channels, one active
writable runtime, pickup as a replica of a replica-mediation account and portable SQLite recovery.
Mediator and routing-service DID resolution remains independent of the channel
method restriction. These drafts will be revisited when their features are
adopted, together with the owning specifications.

## Multi-replica design

Phase 1 enrolls every runtime as a replica of its arrangement's
replica-mediation account. The
[mediator README](../../../mediator/README.md#replica-mediation) is that
protocol's wire contract, and
[`replica.created`](../vault-events.md#replica-created) records an enrollment
with its account-signed grant. A full replica has its own DID and event author;
the vault seed and communication DIDs are shared. The mediator delivers mail to
the replicas enrolled when it accepts that mail, so a new replica obtains
earlier history through portable backup/restore or import.

The client only adds: it enrolls its own replica and adds the communication
recipients it holds. What remains outside phase 1:

<a id="replica-administration"></a>

- **Replica administration.** The mediator can list and remove replicas and
  recipients and delete the account; the client uses none of these. Retiring a
  replica is a human-initiated maintenance step. Its design must define how the
  affected operations are quiesced, how membership changes are serialized and
  how in-flight work is resolved or excluded before the change takes effect; a
  manual trigger alone does not establish that boundary.
- **Membership across mediators.** A runtime is a replica of one arrangement.
  Enrollment at one mediator is not enrollment at another, and moving a replica
  to another mediator is not provided.
- **Several active executors.** Transport membership does not choose an
  executor; see [concurrent application runtimes](#application-concurrency-adoption).
- **History synchronization.** See [vault synchronization](#deferred-vault-sync).

<a id="adoption-work"></a>

## Adoption work

<a id="deferred-vault-sync"></a>

### Deferred: vault synchronization

[Vault sync](vault-sync.md) is retained as a candidate design, not a required
companion protocol for replica mediation. Its event inventories, `want`/`events`/
`objects` transfers, peer negotiation, staged imports and `stored` receipts are
outside the current implementation scope. Merkle reconciliation and encrypted
portable SQLite snapshots over [blob-store](../../blob-store.md) are also future
options; no synchronization format or transport has been selected for adoption.

When this work resumes, choose the transfer model and its authorization,
durability, retention, retry and resource bounds together. Reconcile that choice
with the owning import contracts and define automatic device catch-up. The
existing candidate's detailed rules must be reconsidered then.

If the event/object candidate is selected, define bounded staged-input imports
in the owning event store, vault events and SQLite contracts without weakening
complete portable-source validation. Also define a canonical event byte ceiling,
including unknown types, and plaintext/mediator wire floors that can carry a
complete maximum-sized event. Existing larger events need an adoption policy
that preserves their CIDs; incompatible peers must fail negotiation explicitly.

<a id="application-concurrency-adoption"></a>

### Before enabling concurrent application runtimes

The following domain work is separate from transport implementation. Before
claiming support for multiple active application executors, update the owning
specifications and verify their behavior under independently generated facts:

- Define semantic compatibility for independent observations and effects.
  Removing receipt ordinals does not make events from different authors and
  clocks byte-identical. Source-event references must retain their evidence
  meaning when several observations represent the same logical input.
- Decide how multiple replicas produce automatic replies, private addresses,
  rotation choices and prepared packages. The current fixed-package rule
  treats multiple packages for one message as a conflict. This design does not
  resolve that by changing cryptographic randomness or silently electing an
  executor. Stable operation identity, compatible evidence and dispatch/retry
  behavior must be specified and tested together.
- Choose the availability/coordination rule for a replica that has not yet
  learned a rotation or route change. Pull-before-send is useful reconciliation,
  but cannot prove the absence of a concurrent decision on another replica.
- Verify contact-edit merges, admission history and erasure/held-root behavior
  against the same event set in different arrival orders. Preserve atomic
  import with its required objects under whichever transfer model is adopted.
- Define the transition from catch-up to permitted application processing.
  Sync/import and raw shared-mail pickup cannot by themselves authorize
  historical replies, pending-outbound takeover or exactly-once side effects.

The domain work must choose these rules explicitly. Neither a mediator's
membership list nor a synchronization receipt substitutes for that decision.
