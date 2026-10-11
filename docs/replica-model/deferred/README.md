# Deferred design notes

These drafts are outside the [current contract](../README.md). They are retained
as design material, not implementation requirements or commitments to a later
interface. They reserve no current event types, payload fields, failure codes,
key names, extension APIs or test cases. Their candidate rules may be incompatible
with the current profile; they must be reconsidered before a feature is adopted.

| Topic | Candidate draft | Decisions still needed before implementation |
| --- | --- | --- |
| Mutable channel DIDs | [Web channel DIDs](did-web-channels.md) | Current-document authorization, lookup/retry limits, proof recovery and any new failure model |

The current profile implements immutable `did:peer:4` application channels,
concurrent writable full runtimes as distinct replicas of one replica-mediation
arrangement, and portable SQLite recovery. Mediator and routing-service DID
resolution remains independent of the channel method restriction. The drafts
above will be revisited when their features are adopted, together with the
owning specifications.

## Multi-replica design

Each runtime enrolls as a replica of its arrangement's replica-mediation
account. The
[mediator README](../../../mediator/README.md#replica-mediation) is that
protocol's wire contract, and
[`replica.created`](../../../packages/vault/src/schema.ts) records an enrollment
with its account-signed grant. A full replica has its own DID and event author;
the vault seed and communication DIDs are shared. The mediator delivers mail to
the replicas enrolled when it accepts that mail, so a new replica obtains
earlier history through portable restore, from a backup file or a snapshot
link, or import.

The client only adds: it enrolls its own replica and adds the communication
recipients it holds. What remains outside the current profile:

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
- **History synchronization.** See [vault synchronization](#deferred-vault-sync).

<a id="adoption-work"></a>

## Adoption work

<a id="deferred-vault-sync"></a>

### Deferred: vault synchronization

History synchronization between replicas remains deferred; a new device
takes the vault's history once, by restoring from a snapshot link. An existing
replica seals its portable SQLite snapshot under a random key and puts it at its
mediator as a [blob](../../blob-store.md) of its own; the link carries the
blob's URL, name and key, not the passphrase. What one replica commits after
that reaches no other.

<a id="application-concurrency-adoption"></a>

### Concurrent application runtimes: current boundaries

Concurrent full runtimes are supported as distinct replicas of one
replica-mediation arrangement. Their current behavior is defined by
[the vault model](../vault-events.md#model),
[admission and merge](../channels.md#application-admission), and
[automatic-output selection](../distributed-delivery.md#automatic-effects).
The current rules are:

- Independent observations retain their exact source-event references and
  evidence. Events from different authors and clocks need not be byte-identical;
  contradictory admitted claims remain visible conflicts.
- For a live input picked up through replica mediation, execution registration
  selects the replica that creates and dispatches its automatic outputs.
  A direct live input is answered by the runtime that receives it. Every
  dispatch still requires its committed fixed package and a live action.
- Each replica may record the local rotation decisions an input selects, the
  early private address among them. Replicas deciding the same rotation apart
  name one successor under [the succession query](../../../packages/vault/src/succession.ts),
  and only the selected replica notifies the peer.
- Each replica admits against the history it holds. Responder selection does
  not synchronize rotation knowledge, and independent processing cannot promise
  immediate knowledge of every concurrent rotation. The owning admission
  contract states the merge and restore limitations.
- Current history exchange uses portable restore and import. A future
  synchronization design must preserve complete-source validation, atomic
  import with required objects, and the merge and retention contracts, under
  which one event set gives contact edits, admission history, erasure and held
  roots one meaning whatever order it arrived in.
- Import and restore reconstruct history without granting automatic dispatch
  authority. Historical unfinished work is completed by explicit manual action;
  responder registration promises neither automatic takeover nor exactly-once
  business execution.

Replica administration, membership across mediators and history synchronization
remain deferred as described above.
