# Deferred design notes

These drafts are outside the [phase-1 contract](../README.md). They are retained
as design material, not implementation requirements or commitments to a later
interface. They reserve no current event types, payload fields, failure codes,
key names, extension APIs or test cases. Their candidate rules may be incompatible
with the current profile; they must be reconsidered before a feature is adopted.

| Topic | Candidate draft | Decisions still needed before implementation |
| --- | --- | --- |
| Mutable channel DIDs | [Web channel DIDs](did-web-channels.md) | Current-document authorization, lookup/retry limits, proof recovery and any new failure model |
| Multiple receiving replicas — current focus | [Replica mediation](replica-mediation.md) | Standalone-account integration, routing/pickup and mediator conformance |
| Replica-to-replica synchronization — deferred | [Vault sync](vault-sync.md) | Transfer model, transport, reconciliation and catch-up execution policy |

Phase 1 implements immutable `did:peer:4` application channels, one active
writable runtime, ordinary account-scoped pickup and portable SQLite recovery.
Mediator and routing-service DID resolution remains independent of the channel
method restriction. These drafts will be revisited when their features are
adopted, together with the owning specifications and conformance cases.

## Multi-replica design

The next implementation scope is replica mediation. Vault synchronization is
deferred and is not a prerequisite for implementing or testing that transport.
A full replica has its own DID and local event author; communication DIDs and
the vault seed are shared. The mediator fans external mail addressed to shared
communication DIDs out to the replicas active when it first accepts each
package, under account-wide storage limits. Private envelopes address one
replica DID and are delivered only to that replica; their transfer protocol is
independent of mailbox routing.

Later enrollment does not add deliveries for earlier mail. Initial history may
be provisioned through existing portable SQLite backup/restore or import.
Automatic history catch-up is outside the current scope. A replica missing
required history remains pending; successful registration and queued new mail
do not establish readiness to process application traffic.
Recovery of missing replica history and handling of mail that cannot yet be
opened belong to a separate synchronization channel and its receive integration.
That work does not add pickup scheduling or local ciphertext-staging requirements
to this transport milestone.

[Replica mediation](replica-mediation.md#identity-model) owns the identity model
and account-signed membership grants. It creates its own accounts and manages
append-only communication recipients, without a Coordinate Mediation exchange
or conversion of an ordinary account. The account DID sends registration and
membership controls; each replica DID authenticates pickup and private traffic.
The first deployment profile uses one selected mediation arrangement.
Additional devices obtain their seed and initial history through authorized
portable recovery and create fresh replica identities before enrollment.
Future synchronization can reuse these identities and grants without creating
another membership authority; its wire format and storage transport remain open.

Replica retirement is deferred to a later human-initiated administration
profile. The initial profile keeps registrations, including offline and replaced
incarnations. [Deferred administration](replica-mediation.md#deferred-administration)
must define an enforced maintenance boundary for concurrent and in-flight work;
a manual trigger alone does not establish one.

The current work specifies transport and identity. Its conformance can be
tested with prepared identities, opaque envelopes and independent queues.
Enabling multiple active application executors still requires the separate
domain work below; mailbox conformance does not establish application convergence.

<a id="adoption-work"></a>

## Adoption work

<a id="replica-mediation-adoption"></a>

### Current scope: replica mediation

| Stage | Work and completion evidence |
| --- | --- |
| 1. Protocol and identity contract | Finalize standalone accounts, account-signed grants, shared recipients, private destinations and pickup boundaries. No sync message family is required. |
| 2. Mediator transport | Implement account creation, registration/listing, append-only recipients, atomic fan-out, account storage limits and independent pickup/ACK; verify equivalent SQLite and D1 behavior. |
| 3. Client integration | Adopt the required account/replica event and key contracts, enrollment, registration-first reconciliation and replica-authenticated pickup. Reject unsupported private protocols. Provision history through existing recovery/import; retain application readiness gates. |
| 4. Transport integration | Exercise concurrent registration, recipient adds, state-loss recovery, offline queues, private delivery/rejection, retries and ACK isolation over a real mediator with no vault-sync worker. |

The mediator transport can be implemented and verified independently of vault
sync and multi-executor application semantics. Before enabling the new profile
in a vault client, adopt the relevant contracts in
[event store](../event-store.md),
[vault events](../vault-events.md#identity-seed-and-key-names),
[SQLite lifecycle](../vault-sqlite.md#ownership-and-lifecycle),
[channels](../channels.md#application-admission) and
[distributed delivery](../distributed-delivery.md). In particular:

- Keep one local writer per runtime database. Copy/restore must create a fresh
  author and replica DID; transport enrollment must not rewrite historical
  authors or enable concurrent application execution by itself.
- Revise the single-seed rule in vault events that key names do not encode a
  replica. Reserve `replica/<replicaId>/me` explicitly for incarnation identity;
  communication DID entity keys keep their existing meanings and names.
- Add the candidate `profile: "replica-mediation/1.0"` discriminator to
  `mediation.created` and require fresh mediation/account identities. Define
  native `registered` as the source of `mediation.granted` for that profile;
  the returned routing DID is the addressed mediator DID. Existing untagged
  records remain ordinary mediation and cannot authorize replica membership.
  The current closed schemas must be revised before the new profile is enabled.
- Implement independent account state and authorization for replica mediation.
  Account-authenticated registration creates the account and first replica
  atomically without a prior mediation grant. Ordinary accounts, their recipient
  bindings, queues and ACK domains remain separate; old addresses/mail are not
  automatically moved into the new account. Replica DIDs remain pickup principals.
- Reconcile local replica registration before recipient adds on startup,
  reconnection, periodic checks and suspected remote-state loss. Each client
  replays only its own saved grant, even when it knows other members' grants.
  Routine periodic checks keep established pickup running; startup, reconnection
  and missing-state recovery wait for verified registration. Exact repeats preserve
  surviving delivery/ACK state and do not backfill old mail. Every account control
  request carries its sender's long form, and recipient replays carry their
  resolution material, so recovery can authenticate after resolver-state loss.
  Authenticated unregistered pickup reports `unknown-replica`; failed authentication
  gets no protocol response. Recovery must work without depending on that report.
- Fix each shared package's delivery targets at first acceptance. Registration
  begins eligibility for later packages and never backfills an earlier one.
  Apply storage quotas to the account's shared and private packages together;
  accept a shared package with deliveries for all active replicas or refuse
  the whole package. Keep independent pickup/ACK state for each replica and
  ordinary redelivery for existing targets. New replicas obtain available
  history through backup/restore or import and wait for the required history
  and domain prerequisites before processing queued application mail;
  enrollment alone is not readiness. No automatic sync worker is required for
  registration, fan-out or pickup conformance.
- Classify private versus application traffic from the enclosed message's verified
  recipient key, independently of the pickup wrapper or plaintext audience.
  A successfully unpacked private message with no supported consuming protocol
  is terminally rejected and pickup-ACKed with only a bounded local diagnostic.
  An envelope naming only the local replica's retained key-agreement methods
  takes the same rejection path on unpacking or verification failure, without
  waiting for history or sender resolution material.
  The current milestone supports no inter-replica payload protocol; it produces
  no portable receipt, application effect or sync receipt for such private mail.
- Replace phase-1 desired-set removal for the new profile with append-only
  single-recipient `recipient-add`. The canonical communication DID binds to
  one account; concurrent same-account adds are idempotent and need no registration
  version. Reuse recipient-signed proofs bound to the recipient, account and
  mediator without an expiry or request-ID binding. After local registration,
  reconciliation re-sends locally validated adds without remote enumeration,
  including historical bindings after remote-state loss. Existing bindings remain
  even when unknown locally or no longer eligible for new application work. DID/route retirement,
  blocking and rotation do not withdraw recipient registrations; application
  admission and outbound selection remain separate. Replica retirement is
  deferred; message ACK/expiry still clears mail without removing membership.

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
existing candidate's detailed rules and conformance cases must be reconsidered
then; they do not gate the replica-mediation milestone.

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
