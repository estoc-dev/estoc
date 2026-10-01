# Deferred design notes

These drafts are outside the [phase-1 contract](../README.md). They are retained
as design material, not implementation requirements or commitments to a later
interface. They reserve no current event types, payload fields, failure codes,
key names, extension APIs or test cases. Their candidate rules may be incompatible
with the current profile; they must be reconsidered before a feature is adopted.

| Topic | Candidate draft | Decisions still needed before implementation |
| --- | --- | --- |
| Mutable channel DIDs | [Web channel DIDs](did-web-channels.md) | Current-document authorization, lookup/retry limits, proof recovery and any new failure model |
| Multiple receiving replicas | [Replica mediation](replica-mediation.md) | Standalone-account event integration, domain effects and mediator capacity policy |
| Replica-to-replica synchronization | [Vault sync](vault-sync.md) | Bounded atomic imports, maximum event/wire sizes, catch-up execution policy and reconciliation cost |

Phase 1 implements immutable `did:peer:4` application channels, one active
writable runtime, ordinary account-scoped pickup and portable SQLite recovery.
Mediator and routing-service DID resolution remains independent of the channel
method restriction. These drafts will be revisited when their features are
adopted, together with the owning specifications and conformance cases.

## Multi-replica design

The two replica proposals form one design. A full replica has its own DID and
local event author; communication DIDs and the vault seed are shared. The
mediator fans external mail addressed to shared communication DIDs out to the
replicas active when it first accepts each package, under account-wide storage
limits.
Later enrollment does not add deliveries for earlier mail; new replicas recover
history through vault sync or backup. Sync messages address one replica DID
and are delivered only to that replica. They carry events and objects encrypted
end to end.

[Replica mediation](replica-mediation.md#identity-model) owns the identity model
and account-signed membership grants. It creates its own accounts and manages
append-only communication recipients, without a Coordinate Mediation exchange
or conversion of an ordinary account. The account DID sends registration and
membership controls; each replica DID authenticates pickup and synchronization.
[Vault sync](vault-sync.md#roles-and-dependencies)
uses those grants; it does not create another account or membership authority.
Inventory, missing-data requests and sync receipts are answered by replicas,
not a dedicated sync-storage service. The first deployment profile uses one
selected mediation arrangement. Additional devices initially enroll through
encrypted SQLite restore; a simpler pairing UI can be added later.

Replica retirement is deferred to a later human-initiated administration
profile. The initial profile keeps registrations, including offline and replaced
incarnations. [Deferred administration](replica-mediation.md#deferred-administration)
must define an enforced maintenance boundary for concurrent and in-flight work;
a manual trigger alone does not establish one.

These documents specify the proposed transport and identity contract. They do
not yet authorize multiple active application executors or claim that the
current folds converge under independently generated automatic effects.

<a id="adoption-work"></a>

## Adoption work

| Stage | Work and completion evidence |
| --- | --- |
| 1. Protocol and identity contract | The two drafts define vault/communication/replica identities, membership authority, shared versus private routing, transferred data and local progress. No runtime API is activated by their presence. |
| 2. Multi-replica domain semantics | Revise owning specifications and prove two independently writable vaults can receive the same external mail, perform supported concurrent operations and merge without manufactured conflicts or unauthorized effects. |
| 3. Replica mediation | Implement standalone account creation, account-authorized replica registration, append-only membership/recipient bindings and independent pickup; verify equivalent SQLite and D1 atomicity. |
| 4. Vault synchronization | Implement authenticated peer control handling, durable staging/retries, inventory and bounded atomic event/object imports; verify crash/expiry recovery. |
| 5. Device workflow | Wire encrypted restore, fresh replica identity, enrollment, catch-up and device/sync status into daemon and app. |
| 6. Integration | Exercise multiple Node/browser replicas, offline mail, concurrent writes, restore, missing objects and erasure over a real mediator. |

Before adopting the candidate events/key names, update
[event store](../event-store.md),
[vault events](../vault-events.md#identity-seed-and-key-names),
[SQLite lifecycle](../vault-sqlite.md#ownership-and-lifecycle),
[channels](../channels.md#application-admission) and
[distributed delivery](../distributed-delivery.md). In particular:

- Keep one local writer per runtime database while permitting separate
  replicas to write. Copy/restore must create a fresh author and replica DID;
  transport enrollment must not rewrite historical authors.
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
- Fix each shared package's delivery targets at first acceptance. Registration
  begins eligibility for later packages and never backfills an earlier one.
  Apply storage quotas to the account's shared and private packages together;
  accept a shared package with deliveries for all active replicas or refuse
  the whole package. Keep independent pickup/ACK state for each replica and
  ordinary redelivery for existing targets. New replicas use vault
  sync for history and wait for the required catch-up and domain prerequisites
  before processing queued application mail; enrollment alone is not readiness.
- Replace phase-1 desired-set removal for the new profile with append-only
  single-recipient `recipient-add`. The canonical communication DID binds to
  one account; concurrent same-account adds are idempotent and need no registration
  version. Reuse recipient-signed proofs bound to the recipient, account and
  mediator without an expiry or request-ID binding. Reconciliation re-sends
  locally validated adds without remote enumeration, including historical
  bindings after remote-state loss. Existing bindings remain even when unknown
  locally or no longer eligible for new application work. DID/route retirement,
  blocking and rotation do not withdraw recipient registrations; application
  admission and outbound selection remain separate. Replica retirement is
  deferred; message ACK/expiry still clears mail without removing membership.
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
  against the same event set in different arrival orders. Each sync import
  atomically publishes a selected event subset and its required objects.
  Staging stays invisible; already imported subsets are valid partial history,
  not a partly published import. Define the staged-input integration in event
  store, vault events and SQLite specifications: a network cut is not one
  portable SQLite source file, whose existing complete-source checks remain.
- Set a maximum canonical event byte size in the owning event specifications,
  including unknown event types. Require the sync `max_plaintext_bytes` floor
  to fit a maximum event, its CID and the complete single-event batch envelope;
  require mediator wire limits to fit its encrypted and routed representation.
  Define adoption of existing larger events without truncation or rewritten
  CIDs before enabling the profile. Size-incompatible peers fail negotiation,
  rather than accepting work they can never transfer.
- Define the transition from catch-up to permitted application processing.
  Sync/import and raw shared-mail pickup cannot by themselves authorize
  historical replies, pending-outbound takeover or exactly-once side effects.

The domain work must choose these rules explicitly. Neither a mediator's
membership list nor a synchronization receipt substitutes for that decision.
