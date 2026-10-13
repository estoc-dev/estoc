# @estoc/event-store

The vault as an event store, under the
[replica model](../../docs/replica-model/README.md)'s
[event store contracts](../../docs/replica-model/event-store.md): event
and object identity, commit durability, versioning. What is here
is the model, its reference in memory, the SQLite driver the
persistent stores are written against, the vault's schema and opening
over it, the event store and the object store over that, the SQLite
vault over both, and the snapshot, a CAR of a seed part and a content
part: its export, its read, restore and import — the whole of it run
in a Chromium Worker as it is on Node, one snapshot exchanged between
the two. No event type is known here: what an event means, and the
folds that read it, are `@estoc/vault`'s.

The event model: RFC 8785 canonical JSON and a strict parser; the
five-field envelope `at`/`author`/`type`/`roots`/`data` and its
validation, `roots` being raw DASL CIDs from `@estoc/dasl`; the event's
identity, `cid`, the raw DASL CID of the envelope's canonical bytes —
derived, never among them, so that equal envelopes are one event and a
reference names exact content; canonical order `(at, cid)`, the CID as
text; the `EventStore` interface; and `sampleAt` — `at` from the clock.
`MemoryEventStore` is the reference the others are measured against,
with `ForkedAuthor` and `BadToken`, and `eventStoreSuite` in
`test/suite/` is the conformance suite every store runs.

The object model: raw DASL objects hashed as they stream, whole-resource
identity however large, the `ObjectStore` interface, and
`MemoryObjectStore`, the first store — with `InvalidCid`,
`DigestMismatch`, `ObjectTooLarge` and `DamagedObject`, and
`objectStoreSuite`. A read rehashes on the way out and fails before it
completes when the bytes no longer spell their name; from then on the
object is known damaged — `has`, `stat`, `open` and `read` fail, `list`
fails on reaching it, absence is never how damage shows — until a put of
the same CID replaces it with verified bytes, or collection removes it.
`collect(keep)` deletes exactly the unkept, at once and whatever their
age: no orphan grace, no read latch; a stream open when its object is
collected or replaced completes with the bytes it opened on, or fails,
never truncates.

Over both, the vault: `Vault` — its immutable `metadata` (`VAULT_VERSION`,
5, and the anchor DID), events to read, objects to read, and `commit(objects,
drafts)`, the one way a local event is written, which refuses a supplied
object no draft names as a root before reading a byte and publishes its
objects and events together or not at all — and `VaultRuntime`, what a
host opens: `locked(op)`, the vault-wide writer lock, whose operation
works through `Held`, the same vault sharing the held lock, its
mutations run one at a time in the order issued: once the operation
has returned, the view accepts no further mutation, but what it
accepted still finishes before the lock is released, with reads
through the view good meanwhile, and once the last has finished the
view refuses every call;
`collect(keep)`, the keep set a function called only under the lock,
through a view that reads and refuses to mutate;
`ingest`; and `keystore`, the `KeystoreAccess` to the wrapped seed —
`read` a detached value, `rewrap` a replacement under the lock, the
check that it opens to the same seed being the unlocked host's.
A commit's objects are verified into a `Preparation` no read sees and
published in the transaction that appends its events, so the two land
together or not at all; a root the commit reuses rather than puts is
declared to the preparation with `reuse` and checked once more as it
publishes, since a read outside the lock may have found it damaged
between the root check and the transaction, and the commit then
fails with `DamagedObject` rather than accept an event over bytes
known damaged. `MemoryVault` is the two memory stores under
one runtime; `Runtime` builds the same over any two stores and the
transaction that publishes them, which every backend supplies.

Under the stores, the SQLite driver: `SqliteDriver` — one
synchronous connection, `prepare`d statements with positional
parameters (`run`, `get`, `all`, `iterate`), `exec`, and `transaction`,
which does not nest and never spans an `await` — and what a value must
be to cross it, decided once in `checkParams` for both adapters: text
without a NUL or an unpaired surrogate, an integer in the safe range,
any other finite number as a double, bytes (copied at both boundaries,
so neither side holds the other's buffer), or null; anything else, a
bigint or a boolean included, is `InvalidSqlValue` before the statement
runs, and a stored integer outside the safe range is `InvalidSqlValue`
on the read that meets it, never rounded. Stored text that is not text
— a NUL inside, invalid UTF-8, which only a foreign file or a cast in
SQL puts in a TEXT column — is `InvalidSqlValue` where the adapter can
see the bytes (wasm); `node:sqlite` hands text over already cut at a
NUL and repaired, so text a reader checks is read as
`CAST(column AS BLOB)` and decoded with `decodeText`, which refuses
exactly that, on either platform. What SQLite itself refuses is
`SqliteError` with its result code on either platform. An open is
`create`, `readwrite` or `readonly`: a create needs a target nothing is
at (`DatabaseExists`), the others one that exists (`DatabaseMissing`),
and a writable open takes ownership — a second open of the same target,
in this process or another, is `DatabaseBusy` until the first closes;
a read-only open hardens the connection for a file another party wrote
(no writes, no extension loading, `trusted_schema` off) and excludes
writers for as long as it is open. After `close` every call is
`DatabaseClosed`.

Two adapters. `openNodeSqlite(path, { mode, journal? })` under
`@estoc/event-store/node` is `node:sqlite` (Node 22.13 or later; it
prints an ExperimentalWarning on first use): ownership is SQLite's
exclusive locking mode, taken by an empty immediate transaction so no
page is written before the vault is validated, and met by any other
connection as `SQLITE_BUSY` at its first statement; a create leaves the
file in WAL with `synchronous=NORMAL`, the runtime's configuration, or
with `journal: "delete"` in a rollback journal with `synchronous=FULL`,
for a file that keeps nothing beside it between transactions; a
read-only open forbids writes through
`query_only` and keeps the lock its first read leaves it with — on a
rollback-journal file the shared lock, so writers are excluded while
other readers are not; on a WAL file the exclusive lock, since a WAL
reader keeps no lock a writer would meet — letting SQLite recover the
WAL on open and checkpoint it on close. Every handle is SQLite's own:
a descriptor opened beside SQLite's and closed would take the
process's locks on the file with it.
`openSqlitePool({ directory })` under `@estoc/event-store/browser` is
`@sqlite.org/sqlite-wasm` over its OPFS access-handle pool, in a Worker
only: the pool owns one OPFS directory, `open(name, mode)` a database
in it (each stored as `<name>.sqlite`, so no name can spell the journal
SQLite keeps beside another; the pool grows as databases and their
journals need handles), and ownership of the directory is a
Web Lock taken before the pool is installed and held until `close`, so
a second Worker of the origin is refused before it touches the
directory; the directory's one normalized spelling names both the lock
and the VFS, so two spellings contend and two directories never share
a pool, and a closed pool refuses every call. The driver cases in
`test/sqlite/driver-cases.ts` run over both, Node on a file and in
memory and Chromium in a Worker; the pool's own cases are in
`test/browser/pool-cases.ts`. In Chromium the page spawns the Workers
all at once, each over a directory of its own: a case marked `large`
— one moving tens of mebibytes — gets a Worker to itself and the rest
of its list share one, so the run takes as long as its slowest
Worker rather than the sum of every case (`test/browser/sqlite-page.ts`);
on Node the large cases alone get the long time limit. The browser runs a profile
on disk, whose storage quota follows the disk; an ephemeral context's
follows memory and runs out under the large cases' databases at once.

Over the driver, the vault's schema and its opening. `createTables`
makes the runtime's seven tables, all `STRICT` — `vault_meta`,
`keystore`, `events`, `objects`, `object_chunks` and the two control
tables `store_state` and `event_positions`; `checkSchema`
checks a database holds exactly that, structurally, through SQLite's
own pragmas — names, columns, types, primary and unique keys with their
collation and direction, references with both their actions, no table
`WITHOUT ROWID` — and,
since no pragma reports a column's collation, by comparing through
each text column that it collates byte for byte; the SQL the tables
were spelled with is not what is checked, and the schema's names are
read as their stored bytes and decoded. A runtime may add indexes,
`local_*` tables and `ANALYZE` statistics beside them; a view or a
trigger is refused, and a table named like an inherited property of
an object is an extra table like any other.
`createRuntime(driver, { metadata, wrapped })` fills the empty database
a `create` opened — application ID `ESTC`, schema version 2, the
tables, the metadata, the wrapped seed as the UTF-8 of its compact JWE,
fresh `replica_id` and `store_generation` — in one transaction,
published ready, and hands the runtime back open. `openRuntime(driver,
{ anchor })` checks a `readwrite` driver's database in order — the
file's application ID and schema version; the metadata, so an unready
file is told apart before its tables are;
the schema; the wrapped seed; then the anchor, given outright or
derived by a function that unlocks the wrapper the vault holds,
against the vault's (`AnchorMismatch`); then the control, whose row is
the one keyed 1, whose replica ID and generation are canonical
UUIDv7s, and whose `last_seq` and positions, all positive, account for
every event (`DamagedControl` otherwise, and nothing is made up in
their place) — and writes nothing. The metadata and keystore rows are likewise the one keyed 1
each: the file's own constraints are not trusted to have kept it so.
`openInspector(driver)` applies the same checks without the seed on a
connection set to refuse every write; it takes only a `readwrite`
driver, the one mode that owns the file outright on every platform,
since a `readonly` driver may share a rollback-journal file with other
readers and a runtime's inspector must not. The wrapped seed is checked against
the keystore package's profile as far as it can be without the
passphrase — `PBES2-HS512+A256KW` over `A256GCM`, an iteration count
the package would accept, a salt of at least 8 bytes, nothing else in
the protected header, and segments of the lengths a wrapped 256-bit key,
a 96-bit nonce, a 32-byte seed and a 128-bit tag have — not just the
shape of a compact JWE. Each open returns a handle with the driver,
the metadata, for a runtime the local IDs and `keystore(locked)` —
`read` any time, `rewrap` one transaction under the lock the caller
runs it in, no statement held past either — and `close`, after which
every call is `VaultClosed`; a create or open that fails, for any
reason, closes the driver it was given, so ownership never stays with
a handle nobody can use. Everything a file must show is a `NotAVault`
naming what it did not. The open cases in
`test/sqlite/open-cases.ts` run over both platforms, Node on files
and Chromium in a Worker.

Over an open runtime, the event store: `SqliteEventStore(db, { now })`
over the connection, author, generation and writability an open handed
back. An append is one `BEGIN IMMEDIATE` transaction on the runtime's
own connection — the events as their canonical bytes beside the four
columns that index them, a position each above `last_seq`, `last_seq`
advanced by as many — so a batch lands whole or not at all and two
writes never interleave; `appendAll(drafts, publish)` runs `publish`
inside that transaction, before the events, which is how the SQLite
vault publishes a commit's objects with its events, a throw from it
rolling back what it wrote. A batch is validated index by index, so a
hole in a sparse array is refused like any value that is not a draft.
`ingest` reads its whole input first,
outside any transaction — each value validated with its `cid`, a CID
for other bytes refused before any lookup — then classifies each input
against what is held, by CID: duplicate or new; checks for a fork and
accepts, in one transaction. `appendAll` hashes each draft's envelope
the same way and answers a CID already held, or repeated in the batch,
with the event held, adding no row and no position. `scan` orders in
SQL by `(at, cid)` and reads every row before the first yield, one cut;
`cid`, `author` and `type` narrow the rows in SQL, bound as bytes cast to text so that
a NUL in a type is stored and compared as itself, and the whole filter
is then applied in code to the parsed event, exact primitive equality,
so a match is exactly what the filter says. `changes` joins the
positions: a token is `{ generation, seq }`, the store generation and
the position accepted last, valid across reopens for as long as the
generation stands, and a malformed token, another generation's or a
position past the last is `BadToken`. Every row read is decoded the
same way — parsed strictly, validated, re-canonicalized and compared
byte for byte, its four columns compared with the event's fields, the
text columns read as stored bytes — and one that fails is damage: left
out of every scan and delta, listed by `damaged()` as
`events/<cid>` (or the rowid, when the CID column itself does not decode)
with its bytes and what was wrong. Damage makes the history
incomplete, and the store then accepts no write: every read remembers
the damage it meets, a store surveys every row once before its first
write, and from either `append`, `appendAll` — its `publish` never
run — and `ingest` refuse with `DamagedHistory` until a validated
snapshot is restored into a new runtime. Over an inspector's handle
the store reads and refuses every write with `ReadOnlyVault` before it
reads a source. `eventStoreSuite` runs over it in memory and on files;
`test/sqlite/events.test.ts` adds what only a database shows — the
rows, the positions, a reopen, damage, the inspector, a process dying
inside its transaction — and `test/sqlite/event-cases.ts` what the
two platforms' SQLite must agree on, run on `node:sqlite` and in a
Chromium Worker: a NUL in a type, damage stopping writes across a
reopen, a sparse batch.

Over the same runtime, the object store: `SqliteObjectStore(db, {
maxObjectBytes, maxStagedBytes })` over the connection and writability
of an open handle. A put is hashed as it streams and cut into the
format's chunks — 1 MiB each, the last holding what remains — staged
as they arrive in a table of the connection's temporary database,
never the vault's file and where no read of the store looks. That
database is a file: both adapters set `temp_store` to `FILE` on a
writable connection — the wasm build would otherwise keep it in
memory, and the pool reserves handles for it — and the store gives it
a 2 MiB page cache, so what is held in memory is the chunk in hand
and that cache, whatever the object's size. What may be staged at
once across every preparation in flight is bounded too:
`maxStagedBytes`, 1 GiB unless given, and the put that would pass it
is refused with `StagingFull` before the chunk that would, nothing of
it staged, the others untouched. The CID is known at the end, checked
against the one `putObject` was given, and the chunks then move under
it in one `BEGIN IMMEDIATE` transaction with the `objects` row, so an
object is visible whole or not at all and a source that fails, one
over either bound or a digest that does not match leaves nothing
staged. An object already held and sound is one object still, its
bytes untouched; one known damaged is replaced whole.
`preparing(commit)` splits the two for the vault's commit: `commit`
is handed a `SqlitePreparation`, which stages what is put through it,
counts it present to its own `has`, notes what the commit declares
`reuse`d, and is accepted by `publish()` inside the transaction the
commit lands in — the `publish` callback of
`SqliteEventStore.appendAll` — which first checks every reused
object against the damage known by then, refusing the transaction
with `DamagedObject`, unless the object is staged as well, which
repairs it. The preparation publishes once, refusing while a put
through it is still reading its source, that source calling back
included, takes no put or `reuse` once it has, and refuses every call
once `commit` has ended. `commit`
resolving means that transaction committed, and only then is the
damage of what it repaired cleared, a rollback keeping the old bytes
and their damage; however `commit` ends, the puts still reading are
waited for and nothing staged stays staged. `open` streams one chunk a
pull, rehashing on the way out, each chunk checked against the
layout the size gives the object — numbered from zero, the chunk
size each but the last, which holds what remains — and the read
after the last checks that no other chunk is stored under the CID
and that the bytes hash to it; `read` is the same walk into one
buffer, refused before allocation when the object is over
`maxBytes`. The size is read as its decimal text, so a stored
integer the platform cannot hand over exactly is the object's damage
rather than a failure of the read. What a read finds wrong — bytes
that do not hash to the CID, a chunk missing, short or surplus, a
chunk under an empty object, a size that is no count, a key that is
no CID — is damage known for the rest of the session: `has`,
`stat`, `open` and `read` of that CID fail with `DamagedObject`,
`list` fails on reaching it, `damaged()` lists it as `objects/<cid>`
(or by rowid, when the key is no CID) with what was wrong; nothing
is persisted, and a reopen finds it again by the read that meets it.
A write never waits for a reader: a repair or a collection pass
moves the CID's epoch, and a stream open on the old bytes fails at
its next chunk with `InterruptedRead` — not damage, not absence —
rather than read on into bytes of two generations. `collect(keep)`
checks every keep CID, then deletes every other object and its
chunks in one transaction, a damaged one among them, and reports the
CIDs removed in binary-CID order; a kept damaged object stays, its
damage still known. Over an inspector's handle every write is
refused with `ReadOnlyVault` before a source is read. The chunk size
is the format's and not a setting: a test that wants a chunk
boundary inside an object puts one of more than a mebibyte.
`objectStoreSuite` runs over it in memory and on files;
`test/sqlite/objects.test.ts` adds what only a database shows —
the staging beside a read, the staging bound, a stream across a
repair, a key that is no CID, a process dying inside its acceptance
— and `test/sqlite/object-cases.ts` what the two platforms'
SQLite must agree on, run on `node:sqlite` and in a Chromium Worker:
the chunk rows, a reopen, a preparation rolled back, damage of each
kind and its repair, collection under an open stream, the inspector,
and staging on the file under a cache that does not grow with the
object, measured where the platform reports what SQLite holds.

Over both, the vault: `SqliteVault(db, { now, maxObjectBytes,
maxStagedBytes })`, a `Runtime` — the writer lock, the `Vault` facade
application code gets, the held view, `locked`, `collect` and
`ingest` as the runtime in memory has them — whose commit publishes
as one transaction: the objects prepared under the lock while the
sources stream, the transaction opened only once every draft is
minted, the prepared objects and their repairs published inside it
ahead of the events and their positions, and the preparation settled
after the commit, so a throw anywhere before the `COMMIT` leaves no
object, no repair and no event. The keystore is the handle's over the
runtime's lock, and the runtime's local state is `vault.local`:
`options`, JSON by key, kept through every reopen and clearing;
`cache`, bytes by namespace and key, dropped whole in the transaction
of every commit or import that lands an event, an object or a repair
— what it was built from has changed under it — and when the identity
is reset; and `trace`, one entry a row in the order written, scanned
by type and position and pruned by age and count, sequence numbers
never reused, so retained entries appended later remain after an
earlier cursor — each in a `local_*` table made on its first write, so
a runtime that uses none writes none, and `clearCaches()` empties the
cache and the trace, the sequence continuing, and nothing else. An inspector's vault reads all of it and refuses every
write. The vault stops two ways, and `stopped` says which. Damage to
the history — found by a read, or by the survey the event store makes
before its first write and `stopped` asks for — refuses commit,
ingest and collection with `DamagedHistory`, collection because its
keep set is folded from that history, while reads, local state and
rewrap go on; the history is recovered by restoring a validated
snapshot into a new runtime. A `COMMIT` SQLite could not complete is
`UncertainCommit`, thrown by the driver's shared `Connection`, which
does no further work — every call after it fails the same way — until
it is closed: whether the transaction landed is unknown to it, and
only the recovery a reopen runs can tell, so the vault refuses
everything, reads included, and drafts it minted are not resubmitted
blindly. `close()` admits nothing more, waits for the operations
already admitted, then closes the database and with it ownership; a
stream still open fails at its next chunk. `openRuntime(driver, {
anchor, resetIdentity: true })` is the recovery from `ForkedAuthor`,
and the open of a runtime copy taken before later writes of its
source: once every check has passed, one transaction gives the runtime a
fresh replica ID and generation and drops the cache, the events,
positions, objects, options and keystore staying and every token of
the old generation refused. `vaultSuite` in `test/suite/` is what
any runtime must show through `Vault`, `VaultRuntime` and `Held` — a
commit whole or not at all, damage and its repair, collection under
open streams, the held view's ordering, rewrap under the lock, ingest
as yielded — run over the runtime in memory and over the SQLite vault
in memory and on files; `test/sqlite/vault-cases.ts` is what the
two platforms' SQLite must agree on, run on `node:sqlite` and in a
Chromium Worker: the rows one commit leaves and a reopen finds, a
refused commit leaving nothing, the identity reset, the history
stopping writes, the local tables, a `COMMIT` that fails, ownership
across close; and `test/sqlite/vault.test.ts` bundles a process
that commits through the vault and kills itself right after each of
the commit's statements in turn, reopening the file after each to
find the batch whole or not at all.

The snapshot, a DASL CAR (`src/snapshot.ts`) of two parts a snapshot
carries one or both of. The seed part is the wrapper; alone, it brings
only the events of the types its exporter selects and the objects they
hold on their own. The content part is every event and every object
they hold, with its range: `{ replica, generation, after, through }`,
the positions the exporting replica accepted them at, what `changes`
from a token at `after` gives. A whole export starts at 0 and ends at
`EventTally.lastSeq`, read in the lock that fixes the cut; the range is
a label of the exporter's, which no importer takes for a position or a
token of its own, and a range that does not start at 0 is refused for
now. The header is `{ version: 1, roots, estoc }`, `estoc` being `{
snapshot: 1, vault_version: 5, anchor, seed?, content? }`; the roots
are the events, each the CID of its envelope's canonical bytes; every
other block is an object the events hold, written once whatever holds
it, a block that is an event too included.

`exportSnapshot(runtime, { parts, types, heldRoots, maxBytes })` builds
one from any runtime — the SQLite vault, an inspector's, the vault in
memory — through the interfaces every runtime presents, and hands back
its bytes. `parts` is `"seed"` with `types`, `"content"` or `"both"`;
the objects a part carries are exactly those its own events hold, so a
seed alone leaves out an object only other events hold. Everything is
done under the writer lock: with content, the tally weighed against
`maxBytes` before an event is read; then the events' bytes before the
fold runs; then `heldRoots`, the caller's fold of the roots the events
hold — through the held view, or for a seed alone through a vault in
memory of the selected events alone that reads objects through the
held view and refuses a commit — each root's presence and size
checked; then the CAR's whole length, `carLength` of the header and the
block sizes, before an object is read. Past `maxBytes` at any of these
is `SnapshotTooLarge`; history damage or a held root absent or known
damaged is `IncompleteSnapshot`. A conflict on record is a local
diagnostic, not damage: the accepted value is exported and the
diagnostic is not. Then one buffer of that length is filled through
`CarWriter`, the events in canonical order and the objects in CID
order, each streamed through the vault's own read, which rehashes it,
and not checked again; a source that fails while its bytes are written
is `IncompleteSnapshot` too. What the runtime keeps for itself — the
control, the positions, local state, an object no event holds — is in
no part.

`Snapshot.read(bytes, { heldRoots })` validates the whole CAR before
anything is handed out: a CAR that does not decode is
`InvalidSnapshot`; a header that is not this format's — a member beside
`estoc`, a member of it missing or unknown, another format or vault
version, an anchor that is no DID, a seed outside the keystore's
profile, a range that is no range or does not start at 0, neither part
— is `NotAVault`; then a block that does not hash to its CID, at any of
its occurrences, a root named twice, not raw, without a block or whose
block is not an envelope's canonical bytes, a block that is not raw, a
held root without a block and a block neither an event nor held are
`InvalidSnapshot`, every one found named. Whether the events' known
payloads are valid is the fold's to decide, in the layer that knows
them: what `heldRoots` throws is what the export or the read fails
with. The `Snapshot` is the only thing a restore or an import takes:
its `seed` and `content`, `undefined` for a part it lacks, its counts,
and `vault`, a read-only `Vault` that refuses `commit` and `changes`.
It owns its bytes: a view spanning its whole buffer has the buffer
transferred (`ArrayBuffer.prototype.transferToFixedLength`), the
caller's view detached, and any other input — part of a larger buffer,
a shared buffer, one that cannot be detached — is copied once; every
block is a view of that buffer, and what the snapshot hands out — a
`read`, a stream's pieces — is a copy.

`restoreSnapshot(snapshot, create, { anchor })` builds a new runtime
from a snapshot with the seed part — `MissingPart` before the
credential is asked otherwise. The credential's anchor — given
outright, or as the function that unlocks the snapshot's wrapper and
derives it — is compared with the snapshot's own, nothing made when it
differs; then `create()`, a function of the platform's, `() =>
openNodeSqlite(path, { mode: "create" })` or `() => pool.open(name,
"create")`, makes the destination, laid in one transaction as a
runtime with `ready = 0` — the schema, the metadata, the wrapper
adopted, a fresh replica ID and store generation, every event under a
fresh position in canonical order — and filled object by object, a
batch of 8 MiB of chunks to a transaction, from the bytes the read
already checked; checked against what the snapshot counted and set
ready in one transaction; and handed back open, `{ runtime, events,
eventBytes, objects, objectBytes }`, for the host to build a
`SqliteVault` over and reconstruct what the events say is unfinished
before it runs. A failure once the destination is made closes it and
leaves it unready, opening as nothing, for the caller to remove; no
seed is minted. Restoring both parts holds what restoring the seed and
importing the content holds.

`importSnapshot(target, snapshot, { retainedRoots })` merges the
content part of a snapshot of the same vault into any open runtime —
the SQLite vault, or the vault in memory, since it works through
`VaultRuntime` and `Held` — and returns `{ added, duplicates, objects,
repaired, range }`. Its fold is a `RetainedRoots`, the retention edge
by edge — each event, each root of its own it still retains — rather
than the `HeldRoots` an export takes, because the roots an import
requires bytes for are those the *new* events retain in the union, and
a root one event released may be held by another under the same CID:
only the edge tells which event holds it; `heldRootsOf(retainedRoots)`
is the same fold as a `HeldRoots`, for the export, the read and the
collection pass. Before the lock: an inspector is refused with
`ReadOnlyVault`, a snapshot without the content part with
`MissingPart` and another vault's with `AnchorMismatch`. Under the
lock: a damaged target history is `DamagedHistory`; each source event
is classified against what the target holds, by CID — a duplicate or
new — and a new event under the target's own author is `ForkedAuthor`,
the whole import refused with nothing written, the recovery being an
identity reset, after which the same snapshot imports again; the fold
runs on the target as it is and on the prospective union, held as a
vault in memory that refuses a commit; every root a new event retains
in the union, and every root the union holds that the target did not,
must have bytes in the snapshot or bytes the target holds sound as far
as it knows — nothing is rehashed — else `IncompleteImport` names each
and nothing is written; every union-held object the target lacks or
knows damaged, whose bytes the snapshot has, is staged through the
target's preparation, verified as it streams — the snapshot's bytes
awaited under the lock, but outside any transaction — even when no
event is new; a union-held root outside those requirements that the
snapshot lacks stays as it is, absent or damaged. Then `Held.ingest(
events, stage)` — with `Stores.ingestion`, the ingest counterpart of
`transaction` — publishes the staged objects and repairs with every new
event and its position in one transaction, dropping `local_cache` when
anything landed. Every target object the import reuses that the
snapshot could replace or the union requires is declared `reuse`d to
the preparation, so the transaction checks it once more: a read
outside the lock may have found it damaged while the snapshot
streamed, and the publication then refuses, the staging dropped, and
the import plans again with that damage known — the repair among the
staged when the snapshot has the bytes, `IncompleteImport` when the
root is required and it does not — rather than accept an event over
bytes known damaged. The target's identity, wrapper, options and trace
stay. The same snapshot again adds nothing and, with nothing to repair
and no conflict to record, writes nothing.

`test/snapshot.test.ts` runs the three exports over vaults in memory,
their headers, roots and block order, every header and block a read
refuses, and an import into a vault in memory.
`test/sqlite/snapshot-cases.ts` runs on `node:sqlite` and in a
Chromium Worker: the range read in the export's lock, an inspector's
export, the three restores and the import agreeing, the restored
replica's own positions and the import's placing of what it adds, a
block both an event and an object, a part missing, a restore failing
at each statement, an export over damage, the bound met before an
object is read, a SQLite file refused as no CAR, and the snapshot
owning its bytes. `test/sqlite/export-cases.ts`, on both too: what
the runtime keeps for itself in no part, a commit, a collection pass
and a rewrap waiting on the export's lock and landing after without
changing what it wrote, a seed part restored and exported again byte
for byte, and the 64 MiB object below. `test/sqlite/import-cases.ts`,
on both: a restore's runtime checked row by row and run on; its
refusals before and after the destination is made; an import's union,
what it reports and keeps, the repeat that writes nothing, and the
vault in memory as a target; a fork from a copy of the runtime, and
the import after the identity reset; the roots the union requires
bytes for, crossed in both directions by a fold with a contestable
release, the root held before and after that needs none, and the root
a new event names but the fold released beside the target's own
reference to it, absent or damaged; what an import fills and repairs,
damage forgotten by a reopen and found again, and the released root it
does not revive; a reused object found damaged while the snapshot
streams, repaired by the import planned again or refusing it with
nothing written; another vault's snapshot, a snapshot without content
and an inspector refused before the lock; and an import interrupted at
every statement of its transaction, or at its `COMMIT`, leaving the
whole old union or the whole new. `test/sqlite/import.test.ts` adds a
restore into a destination of either journal.

The two platforms, side by side. The three conformance suites —
`eventStoreSuite`, `objectStoreSuite`, `vaultSuite` — run over the
wasm pool in the Chromium Worker as they run over `node:sqlite` in
memory and on files, through the same openers
(`test/sqlite/suite-openers.ts`); the Worker's bundle gets the
`vitest` the suites import from `test/browser/vitest-stand-in.ts`,
whose `describe` and `it` collect the tests for the Worker to run one
at a time and whose `expect` is vitest's own matchers over chai, so a
suite asserts in the Worker exactly what it asserts under vitest, and
`test/sqlite/browser-driver.test.ts` reports each collected test
as a case of its own. One snapshot crosses between them
(`test/sqlite/exchange.ts`): a sample vault — text with control
characters and numbers of every JSON kind in the events' data, a
type outside ASCII, a second author's event, the empty object, one
across a chunk boundary and one of bytes that are no text — is
exported on Node, inspected there, sent to the Worker, and inspected
there to the same values: the metadata, the seed, the range, what the
read counted, every event as scanned and every object's key, codec,
size and bytes as read; the Worker restores it, commits one more event
over one more object and exports again, and that CAR, sent back,
inspects on Node as it did in the Worker and imports into the sample
vault as exactly the one event and the one object. An object of 64
MiB streams through a commit, a read, an export and a restore on
both platforms under a source that reuses one buffer, with what the
platform holds sampled on the way, in two measures. What JavaScript
holds once garbage is collected — the heap and the backing stores of
its array buffers — on Node from `process.memoryUsage`, the collector
taken from V8 at run time (`test/sqlite/node-memory.ts`); in the Worker from
outside it, over the DevTools protocol the test exposes to the page
before it loads (`Target.exposeDevToolsProtocol`), which attaches to
the Worker's target by name, collects its garbage and reads
`Runtime.getHeapUsage` (`test/browser/sqlite-page.ts`); both collect
twice, since the backing stores a collection frees are swept after
it. And what SQLite's allocator holds, which is outside those backing
stores: `sqlite3_status` on the wasm build, where the Worker reads
it; `node:sqlite` exposes no such count, so on Node only the first
measure is taken. The resident set is not measured, since glibc
keeps what the transient mebibyte buffers were freed into. While
the export and the restore copy, their source is watched from the
test's side and what is held sampled every mebibyte read, the most of
those the copy's sample: the CAR an export fills as it reads, and the
batch a restore gathers before a transaction, seen while they are
held. The bounds are on growth, one table for each measure
(`test/sqlite/export-cases.ts`). For JavaScript: none across the
second half of the commit or of the read; the CAR and a chunk at most
while the export copies, the snapshot and a batch of chunks while the
restore does; none from the commit to the end of the restore, once the
snapshot is let go; and less than half the object in all. For SQLite:
none across the second half of the commit, whose staging spills to the
temporary file, or of the read, nor while the export reads the object;
a connection's page cache — 16 MiB, the wasm build's default — while
the restore writes its destination, freed when it closes; and in all
the vault's own cache the commit fills, its staging cache, and little
else. Two cases turn the measures on themselves: with a copy of
every chunk kept as it passes through, every JavaScript bound breaks
on both platforms and no SQLite bound, and once the copies are let
go what is held falls back; with every connection's cache enlarged
to the object, the restore's and the vault's own SQLite bounds break
and no JavaScript bound, and closing frees it.
The staging case does the same for the temporary cache: told to
cache the staging, SQLite is seen to hold it.

The durability configuration on each platform, reported by the
driver case that checks it. On `node:sqlite`, foreign keys are
enforced by the binding's default, a created runtime runs in WAL
with `synchronous=NORMAL` — durable against a crash of the process,
consistent after a loss of power, the last transactions possibly
lost — and a file created with `journal: "delete"` in a rollback
journal (`journal_mode=DELETE`) with `synchronous=FULL`, so it stands
alone; a restore's destination is a created runtime and runs as one.
In the Worker, foreign keys are enabled on every connection, and the
pool's databases run in a rollback journal with `synchronous=FULL`,
the wasm build's defaults over the access-handle pool, whose sync is
the handle's flush.
On both, the temporary database is on a file (`temp_store=FILE`),
and `journal_mode=OFF` or `MEMORY` and `synchronous=OFF` are never
set.
