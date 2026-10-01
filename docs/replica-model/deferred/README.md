# Deferred design notes

These drafts are outside the [phase-1 contract](../README.md). They are retained
as design material, not implementation requirements or commitments to a later
interface. They reserve no current event types, payload fields, failure codes,
key names, extension APIs or test cases. Their candidate rules may be incompatible
with the current profile; they must be reconsidered before a feature is adopted.

| Topic | Candidate draft | Decisions still needed before implementation |
| --- | --- | --- |
| Mutable channel DIDs | [Web channel DIDs](did-web-channels.md) | Current-document authorization, lookup/retry limits, proof recovery and any new failure model |
| Multiple receiving replicas | [Replica mediation](replica-mediation.md) | Vault-authorized replica DIDs, shared-mail fan-out and independent pickup; domain integration and implementation remain |
| Replica-to-replica synchronization | [Vault sync](vault-sync.md) | End-to-end encrypted event/object exchange through the same mediator; domain integration and implementation remain |

Phase 1 implements immutable `did:peer:4` application channels, one active
writable runtime, ordinary account-scoped pickup and portable SQLite recovery.
Mediator and routing-service DID resolution remains independent of the channel
method restriction. These drafts will be revisited when their features are
adopted, together with the owning specifications and conformance cases.

## Multi-replica design

The two replica proposals form one design. A full replica has its own DID and
local event author; communication DIDs and the vault seed are shared. The
mediator fans external mail addressed to shared communication DIDs out to the
registered replicas. Sync messages address one replica DID and are delivered
only to that replica. They carry events and objects encrypted end to end.

[Replica mediation](replica-mediation.md#identity-model) owns the identity model
and account-signed membership grants. [Vault sync](vault-sync.md#roles-and-dependencies)
uses those grants; it does not create another account or membership authority.
Inventory, missing-data requests and sync receipts are answered by replicas,
not a dedicated sync-storage service. The first deployment profile uses one
selected mediation arrangement. The existing encrypted SQLite restore is the
initial device-enrollment path; a simpler pairing UI can be added later.

These documents specify the proposed transport and identity contract. They do
not yet authorize multiple active application executors or claim that the
current folds converge under independently generated automatic effects.

<a id="adoption-work"></a>

## Adoption work

| Stage | Work and completion evidence |
| --- | --- |
| 1. Protocol and identity contract | The two drafts define vault/communication/replica identities, membership authority, shared versus private routing, transferred data and local progress. No runtime API is activated by their presence. |
| 2. Multi-replica domain semantics | Revise owning specifications and prove two independently writable vaults can receive the same external mail, perform supported concurrent operations and merge without manufactured conflicts or unauthorized effects. |
| 3. Replica mediation | Implement registration, terminal retirement, atomic fan-out and independent pickup in the mediator and agent; verify equivalent SQLite and D1 behavior. |
| 4. Vault synchronization | Implement authenticated peer control handling, durable staging/retries, inventory and complete event/object import; verify crash/expiry recovery. |
| 5. Device workflow | Wire encrypted restore, fresh replica identity, enrollment, catch-up and device/sync status into daemon and app. |
| 6. Integration | Exercise multiple Node/browser replicas, offline mail, concurrent writes, restore, missing objects and erasure over a real mediator. |

Before adopting the candidate events/key names, update
[vault events](../vault-events.md#identity-seed-and-key-names),
[SQLite lifecycle](../vault-sqlite.md#ownership-and-lifecycle),
[channels](../channels.md#application-admission) and
[distributed delivery](../distributed-delivery.md) as appropriate. In particular:

- Keep one local writer per runtime database while permitting separate
  replicas to write. Copy/restore must create a fresh author and replica DID;
  transport enrollment must not rewrite historical authors.
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
  against the same event set in different arrival orders. Preserve the atomic
  import boundary; network staging must not become a visible partial vault.
- Define the transition from catch-up to permitted application processing.
  Sync/import and raw shared-mail replay cannot by themselves authorize
  historical replies, pending-outbound takeover or exactly-once side effects.

The domain work must choose these rules explicitly. Neither a mediator's
membership list nor a synchronization receipt substitutes for that decision.
