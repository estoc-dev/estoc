# distributed-delivery/1.0

<!-- suite-navigation:start -->
[Suite guide](README.md)
<!-- suite-navigation:end -->

Status: **version 5**. The delivery profile for the full runtimes of one
vault, run alone or side by side as the replicas of a replica-mediation
arrangement, is code: the derived identities in
[ids.ts](../../packages/vault/src/ids.ts); the message layers in
[projection.ts](../../packages/vault/src/projection.ts) and
[document.ts](../../packages/vault/src/document.ts); the intent, preparation,
submission, receipt and skipped-effect payloads in
[schema.ts](../../packages/vault/src/schema.ts); the folds over them as
[`@estoc/vault`](../../packages/vault/README.md) lists; and the procedures
that send, prepare, dispatch, receive, reconcile, answer and acknowledge as
[`@estoc/agent-core`](../../packages/agent-core/README.md) lists, each
module answering one question, with derivation fixtures and behavioral
checks in the tests beside it. What a forward must be and how the replicas of one
account register under an execution are
[the mediator's README](../../mediator/README.md). This document keeps what
that code cannot state about itself: the message layers and the
derivations every replica must agree on, the commit and acknowledgment
boundaries, what an ACK may name, which replica answers an input, the
failure rules and the privacy budget. Capitalized requirement words have
their BCP 14 meanings. [message-vectors.md](message-vectors.md) lists fixed
inputs with the canonical bytes and CIDs the layers give over them.

<a id="what-it-is-for"></a>

## 1. What it is for

An Estoc message begins as a durable intent in one fixed oriented channel.
Each intent has one executor: the replica that sends, for the user's own
message, and for an input's automatic outputs the replica that answers the
input, the one the mediator registered first under the input's execution
when the input reached several ([section 10](#automatic-effects)).

Every message transport call carries the envelope of one committed
`message.prepared`: the preparation this runtime selected for the message and
keeps in its local state ([section 6.1](#runtime-local-delivery-records)).
Only the live initial action or a new explicit manual retry may make that
call. Transport acceptance commits `delivery.submitted` naming that
preparation, permanently completing the outbound. A failed or unknown call,
a missing ACK, a process reopen or another replica does not automatically
retry it. A manual retry carries the selected preparation's exact envelope;
selecting another channel means a new message ID.

This profile defines the message layers and their identities
([section 5](#canonical-projections-and-hashes)), channel-local
deduplication, explicit ACK authorization, process-durable receipt and effect
ordering. It makes no cross-channel or cross-replica exactly-once
business-execution promise.

<a id="terms"></a>

## 2. Terms

- **Channel** — fixed ordered pair of canonical local and peer DIDs within one vault.
- **Contact** — local names, preferences and selected channel histories with no protocol authority.
- **Full replica** — a writable vault incarnation; one input picked up at a replica-mediation mediator reaches every replica of the account, and one of them answers it.
- **Outbound message ID** — one committed intent's entity ID and plaintext `id`.
- **Canonical wire ID** — a wire ID with its ASCII letters in lower case
  ([section 5](#canonical-projections-and-hashes)); comparisons and ID transcripts use it,
  stored fields keep the spelling received.
- **Inbound message ID** — derived from canonical sender, canonical recipient and canonical wire ID.
- **Execution ID** — stable identity of one channel-local input; identity alone grants no work.
- **Intent CID** — content identity of one fixed application message
  ([section 5](#canonical-projections-and-hashes)); equal content, not one sending.
- **Plaintext CID** — content identity of one complete DIDComm plaintext as
  encrypted or decrypted ([section 5](#canonical-projections-and-hashes)); the vault
  keeps the CID, not the plaintext.
- **Envelope CID** — raw object CID of one normalized encrypted envelope.
- **Preparation** — one committed `message.prepared`, named by its event CID;
  it fixes one envelope and records no transport invocation.
- **Delivery ID** — mediator pickup identity, separate from message and
  preparation identities.
- **Submitted** — recorded transport acceptance of one preparation; it is not
  ultimate receipt.
- **Acknowledged** — accepted explicit peer `ack` naming the exact authorized outbound.

<a id="addressing-layers"></a>

## 3. Addressing

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

All local communication addresses are vault-scoped: the active full runtime
derives their private keys and receives their messages, and a later server
or replica does not own an address merely by executing the vault. The
channel preserves local/peer roles within that vault; each message has a
sender and recipient, and every rotation is directed.

Each local communication DID sends where its document's one DIDComm service
says, a mediator's routing DID or a direct endpoint. Changing its keys or
route creates a successor DID entity, selected by
[local rotation decisions](channels.md#did-rotationselected) in an exact
channel context. An ordinary rotation's successor inherits the
predecessor's route, so the runtime committing it must be one that picks up
there, under
[the successor's standing](../../packages/agent-core/src/successor.ts).
Choosing among a recipient's authorized routes does not change the
application recipient, and a direct endpoint MUST NOT expose a replica ID
as the peer-visible recipient. A valid `from_prior` justifies one endpoint
replacement in its exact channel context; unrelated channels using that
address retain their own endpoint decisions.

The mediator holds one replica-mediation account per arrangement; each
runtime picks up as a replica of its own, under its own DID, and the
mediator applies one recipient profile to all communication DIDs. It looks
at a forward's envelope and never opens it. The sender's local CID for the
normalized envelope is never part of Routing 2.0 and MUST NOT be sent
merely to deliver the package. Every accepted forward is queued as new
mail, a repeated one included; the receiver's channel-local deduplication
absorbs the copies. Mediator or HTTP acceptance means only `submitted`, and
no transport error, timeout or remote Problem Report appends
`delivery.failed`.

Useful content or Trust Ping can be the first ordinary DIDComm message;
address selection and optional early privacy rotation follow
[the address policy](relationships.md).

<a id="4-vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-procedures-and-commit-boundaries"></a>

## 4. Vault-first commits and their boundaries

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only. A successful commit uses the
process-durable boundary of
[event-store.md section 2](event-store.md#commit-and-durability-terminology).
Correctness MUST NOT depend on an uninterrupted process lifetime or
rebuildable cache state. A remote thin client without the seed may stage a
command offline, but the command becomes authoritative only when a full
vault runtime process-durably appends `message.out`.

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before a message's own network work,
resolving its recipient, preparing its envelope and submitting it, commit the
content and [message.out](../../packages/vault/src/schema.ts), freezing its
ID, channel, headers and user or automatic-effect decision. Deciding an
automatic output may wait on the network itself: the replica answering an
input picked up at a replica-mediation mediator is registered for there
before any of the input's automatic intents is committed
([section 10](#automatic-effects)).

`createdTime == null` means the DIDComm `created_time` header is absent. A
preparer MUST NOT invent it: every preparation and retry reads it from the
intent. A user send fixes a non-null `createdTime` when its intent is first
created, the value the caller gives or the clock read once at creation in
whole seconds since the Unix epoch; a send repeated under an existing
message ID agrees with the committed value. An automatic output copies or
derives its time under its operation, null included, and a manual rotation
notification has none. The value is not a transport-freshness proof.

<a id="cross-layer-commit-and-acknowledgment-table"></a>
<a id="91-receive-a-message"></a>
<a id="92-receive-recovery"></a>

### 4.1 Commit and acknowledgment boundaries

| Boundary | Durable prerequisite | Meaning |
| --- | --- | --- |
| Offline send intent | Content and `message.out` with fixed channel/direction | A selected new message, not authority for recovery dispatch |
| Preparation | Valid fixed-channel intent, peer resolution and `message.prepared` | One fixed envelope for this message; the message may hold several |
| Transport invocation | A committed preparation selected in the runtime's local state, plus a live initial/manual action | One call carrying that envelope; no invocation event is stored |
| Submission completion | `delivery.submitted` naming the message and the preparation carried | Stop preparation and sending for this message ID |
| Channel receipt | Current authentication, exact resolution, objects and `message.in` | Normal pickup ACK may follow |
| Proof verification | Exact authenticated carrier with its original JWT and derivable or retained immutable issuer material | Fold computes proof result and continuity status without another event |
| New source-derived work | Admitted complete source/proof evidence, current policy and any additional evidence required by that consumer | Only the specific eligible operation may proceed |
| Peer ACK | Admitted complete source witness and exact channel/path target | Receipt information only |

Every dependency reference names an event committed before the dependent call.
Object storage alone is not event commitment. Contact membership, a thread ID,
peer ACK or a missing submission event never supplies dispatch authority.

<a id="send-an-ordinary-message"></a>

### 4.2 Send

A send commits the content and `message.out`, with its channel and headers
fixed, before the message's own network work; an explicit user send may
select a new channel, and an automatic output goes where
[the response policy](../../packages/vault/src/response-policy.ts) says.
The intent, its preparation, the one transport call of the selected
envelope under the live action and the wait for a prerequisite are
[`send.ts`](../../packages/agent-core/src/send.ts),
[`prepare.ts`](../../packages/agent-core/src/prepare.ts),
[`dispatch.ts`](../../packages/agent-core/src/dispatch.ts) with
[`action.ts`](../../packages/agent-core/src/action.ts), and
[`dispatcher.ts`](../../packages/agent-core/src/dispatcher.ts); no vault
lock is held across network I/O. Transport acceptance is recorded as
`delivery.submitted` naming the message and the preparation whose envelope
was carried. Every other transport outcome stays in the runtime's local
trace and MUST NOT produce `delivery.failed`, which only explicit
cancellation and expiry append; failure or uncertainty grants no next call.
A crash loses the live action, whether or not transport was called; reopen
cannot replay it.

<a id="receive-a-message"></a>
<a id="receive-recovery"></a>

### 4.3 Receive, and recover

Every delivery, picked up or posted directly, goes through one gate, is
recorded as one `message.in` with its exact resolution evidence and content,
and has the admissions the vault owes reconciled under
[application admission](channels.md#application-admission) before the
receipt's lock is released, so that the writer lock is the one runtime-wide
receipt and admission sequence whichever way the delivery came, and a
replacement known by then is known to the decision. A pickup ACK is
authorized by the durable receipt, independently of channel policy and
history, and does not wait for the transport calls of automatic outputs; a
hard terminal rejection may pickup-ACK without `message.in`, and a failed
durable receipt withholds it. Automatic work is earned only by the call that
recorded the first observation the vault holds of an input and had it
admitted under that lock as the witness its input speaks through; a retained
duplicate, an observation admitted later by evidence, an open, an import or
a restore earns none, and what such an input still earns is listed for
manual completion. The rotation such an input selects is decided in the turn
the delivery came in, on every replica it reached, so that each holds the
successor before it opens the next delivery; the input's outputs, the
rotation's notification among them, are made off that turn and only by the
replica answering the input ([section 10](#automatic-effects)). Control
types never trigger recursive privacy notifications.

Receipt-derived state is rebuilt from retained evidence, without
re-resolving a sender or repeating a receipt: proofs are recomputed from
retained JWTs and immutable issuer material, and the pass over what the
vault owes runs at open and whenever evidence arrives, not only after a
restart. Pending and unconfirmed messages are shown for manual action with
their message, execution, preparation and submission identities preserved;
an open, an import or evidence recovered apart mints no action. Erased input
starts no new content-derived effect.

The gate, the receiver, the receipt, the pass over what the vault owes, what
follows a receipt, who answers the input, the automatic effects and what an
open lists are the modules
[`@estoc/agent-core`](../../packages/agent-core/README.md#modules) lists
under those questions. Its
[DIDComm adapter](../../packages/agent-core/README.md#didcomm-api)
preserves any string-valued `from_prior` without verifying it; the vault
judges it from the retained evidence under
[the channel evidence fold](../../packages/vault/src/fold/channels.ts),
showing missing evidence as pending.

<a id="canonical-projections-and-hashes"></a>
<a id="semantic-projection"></a>
<a id="self-references"></a>
<a id="intent-projection"></a>
<a id="exact-plaintext-hash"></a>
<a id="envelope-and-event-cids"></a>
<a id="intent-equality"></a>

## 5. Message layers and their CIDs

A message has four content identities, one per representation. Each is the
raw DASL CID of [dasl-objects.md](dasl-objects.md#accepted-dasl-cids) over
one canonical byte string, each has its own nominal type in
[types.ts](../../packages/vault/src/types.ts) and one constructor, and none
is derived from another.

| Layer | Type | Bytes | Constructor |
| --- | --- | --- | --- |
| Intent | `IntentCid` | `UTF8(RFC8785(["estoc.message.intent", 1, projection]))` | `intentOf` in [projection.ts](../../packages/vault/src/projection.ts) |
| Plaintext | `PlaintextCid` | `UTF8(RFC8785(plaintext))`: the complete DIDComm plaintext as encrypted or decrypted, own `id`, addressing and proof included, nothing omitted or normalized | `plaintextCidOf` in [projection.ts](../../packages/vault/src/projection.ts) |
| Envelope | `EnvelopeCid` | `UTF8(RFC8785(parsedEncryptedEnvelope))`, retained as an object and the preparation's root | `envelopeOf` in [document.ts](../../packages/vault/src/document.ts) |
| Event | `EventCid` | the canonical event envelope | `eventCidOf` in [event.ts](../../packages/event-store/src/event.ts) |

The intent is the fixed application message: the control headers, with a
self reference in `thid` or `please_ack` folded to `""`, and the stored
document by its CID. Other references and application content keep their
spelling. The own `id`, `typ`, `from`, `to`, `from_prior`, the effect tuple,
the source and rotation references and every preparation field are not in
it, so one intent CID may be recorded under any message ID in any channel,
and a use that needs the sender and recipient carries them beside it. Which
top-level headers are reserved, how a self reference is folded and written
back, that `please_ack` absent, `[]` and `[""]` are three intents, and that
an intent put on the wire reads back to the same intent and CID are
`RESERVED_HEADERS`, `SELF`, `intentOf`, `readPlaintext` and `wirePlaintext`
with their tests; [message-vectors.md](message-vectors.md) pins the bytes.
A change to the projection's fields or encoding is a new version.

Wire IDs are compared by canonical wire ID, the spelling with the ASCII
letters `A`–`Z` replaced by `a`–`z` (`canonicalWireId` and `sameWireId` in
[ids.ts](../../packages/vault/src/ids.ts)): the self references, thread
membership, the ACK target of [section 8](#durable-end-to-end-acknowledgment)
and the transcripts of
[section 9](#observation-identity-logical-aliasing-and-execution-identity)
all take it, while a stored field keeps the spelling received. A message
requests its own ACK only through a self reference in its `please_ack`
(`requestsAck`); a reference to another message is kept but asks nothing of
this vault, and the request changes no submission or retry rule.

Content equality is not identity. Two user sends of equal content have
different message IDs and may have one intent CID; one intent prepared
twice has two envelope CIDs; two replicas recording one preparation have
two event CIDs. Records of one message, or of one automatic output, are
one intent when `sameIntent` in
[fold/outbound.ts](../../packages/vault/src/fold/outbound.ts) says so: the
intent CID, the sender, the canonical recipient, the effect tuple with its
key and the rotation announced agree, while `sourceEventCid` is evidence
and may differ. Records that disagree are a conflict for good, whichever
replica wrote them. `delivery.submitted` names its preparation by event CID
and resolves it by that exact CID; an event of equal payload under another
CID is another preparation.

No CID grants admission, dispatch or retry eligibility. The payload reader
([schema.ts](../../packages/vault/src/schema.ts)) checks each layer CID for
its form and recomputes the intent CID of a `message.out` or `message.in`
from the fields beside it; a preparation's intent CID is compared with its
message's by the outbound fold. The vault keeps the plaintext CID and not
the plaintext, so nothing checks it further, and this version makes no
matching, deduplication or admission decision by it. The envelope CID is
the preparation's root: dispatch reads the bytes to carry by it, and the
object store answers for their digest.

<a id="preparing-a-package"></a>

## 6. Preparing a message

A preparation fixes one exact envelope of a message. Its plaintext is
assembled from the intent under [section 5](#canonical-projections-and-hashes),
with the message ID as `id`, and with `from`, `to`,
the exact key methods and any frozen proof following the fixed channel's
evidence; forbidden `return_route`, duplicate JSON members and invalid I-JSON
are rejected. The plaintext is canonicalized with RFC 8785 and encrypted
through maintained DIDComm APIs, and the normalized envelope object, the peer
resolution it used under
[the address profile](relationships.md#recipient-resolution-freshness) and
`message.prepared` are committed in one lock before transport, the event
carrying the intent, plaintext and envelope CIDs with its evidence
references. The commit freezes that envelope: later confirmation, rotation,
resolution or termination cannot replace it, and changing the content or the
channel requires a new message ID.

A message may hold several valid preparations, made by replicas that had not
yet seen each other's and brought together by import or synchronization. A
runtime that holds a preparation of a message makes no second one: envelope
bytes that are missing or damaged are repaired under their exact CID, from a
replica that holds them, or the message is cancelled and the content sent
again under a new ID. Each is checked on its own against the intent and its
own evidence under
[the outbound fold](../../packages/vault/src/fold/outbound.ts); their number
is no conflict, and none is sendable by being recorded. Which spelling and
which keys the two ends take, what defers a preparation, and the pass every
preparation owes are
[`packages/agent-core/src/prepare.ts`](../../packages/agent-core/src/prepare.ts).

The forward around the envelope is sealed per call, so the outer Routing 2.0
`forward.id` is derived from the preparation rather than minted:

```text
forwardId = UUIDv5(
  estocNamespace("forward"),
  UTF8(RFC8785(["v1", preparationEventCid]))
)
```

Every call of one preparation carries one forward ID, and no mediator-visible
ID carries an event CID. The namespace derivation is
[ids.ts](../../packages/vault/src/ids.ts)'s; its vector is pinned in
[ids.test.ts](../../packages/vault/test/ids.test.ts).

<a id="the-selected-preparation"></a>
<a id="runtime-local-delivery-records"></a>

### 6.1 Runtime-local records

Three facts about delivery are this runtime's alone and live in its local
options, never in an event, a snapshot, an export or the trace: the input its
replica left to another replica ([section 10](#automatic-effects)), the
preparation whose envelope its transport calls carry, and a transport
acceptance it observed and has not yet recorded as `delivery.submitted`. The
records are keyed by replica ID: a reopen reads them; a restore or an
identity reset mints another author and reads none, so it starts with no
selection and knows no other runtime's choice. A message with no selection and
several valid preparations waits for the user to choose among them. An
existing selection remains in force, and only the user's explicit choice
replaces it. An acceptance the runtime saw but
could not write leaves the outcome unknown: the message shows as prepared,
and only an explicit manual retry may carry the envelope again. None of
these records, and no trace, decides whether a call may be made: that is
the live action's. The keys, the value shapes and the one adapter that
reads and writes them are
[`packages/agent-core/src/local-records.ts`](../../packages/agent-core/src/local-records.ts).

<a id="submission-completion-and-expiration"></a>

## 7. Submission completion and termination

Any valid committed submission completes the message and prevents further
preparation or retry, regardless of ACK policy; several complete submissions
of one message, of one preparation or of several, are its completion and no
conflict. A submission naming a preparation that is not here is unresolved:
while it may still arrive the message is neither prepared again nor called.
One naming a preparation that is here but pending or in conflict completes
nothing and is judged with that preparation. Missing submission does not
prove nondelivery; pending work follows
[the delivery fold](../../packages/vault/src/fold/outbound.ts). Expiry, at
equality, and explicit cancellation terminate the entire intent without
depending on preparation evidence and without claiming nondelivery; a
complete submission takes precedence, and later ACK evidence reports receipt
without reopening anything. Known endpoint replacement prohibits preparation
and transport on the old channel under
[the continuity fold](../../packages/vault/src/fold/continuity.ts), queued
work and manual retries included; it never rewrites their preparations.
When expiry and cancellation are observed, and what each leaves of the
content and the envelope, is
[`packages/agent-core/src/dispatch.ts`](../../packages/agent-core/src/dispatch.ts).

Prepared-envelope retention is owned solely by
[fold/held.ts](../../packages/vault/src/fold/held.ts): every envelope the
message's preparations name is held until the message is submitted or
terminated under a consistent intent, and released then all at once. A
paused or unconfirmed eligible preparation remains retained for possible
manual action; waiting is not deletion. ACKs have no independent retention
contribution.

<a id="durable-end-to-end-acknowledgment"></a>
<a id="the-ack-target"></a>
<a id="deterministic-pure-ack"></a>
<a id="applying-ack"></a>
<a id="duplicate-receipt-handling"></a>

## 8. Durable end-to-end acknowledgment

Whether to honor a `please_ack` is local policy, not a durable reply
obligation. When the vault does, the one target is the carrier's own
canonical wire ID: the carrier must be the admitted complete witness
establishing its input, and the input's admitted intents must agree
(`ackTarget` in [fold/outbound.ts](../../packages/vault/src/fold/outbound.ts)).
No other message is ever a target, so no receipt order, wire-ID lookup,
predecessor-channel search or ambiguity rule enters the selection, and
later discovery cannot change a saved `ack`; a history rebuilt without the
admission revokes no saved intent, while a new ACK is created only for an
admitted carrier. An ACK uses retained receipt and header evidence, so body
erasure alone does not disqualify its source and restores no permission for
content-derived work; an input with no eligible sender is preserved for
manual action.

A reply's thread is derived from the carrier's intent, so that every
spelling of one input gives one reply intent:

```text
replyThread(carrier) = projection.thid == "" ? canonicalWireId(carrier.wireMessageId) : projection.thid
```

The pure ACK is its own Empty message under the effect type
`https://estoc.dev/distributed-delivery/1.0#pure-ack`, independent of a
natural reply or rotation notification: body `{}`, no attachments or
headers, the carrier's nullable creation time, no expiry, `pleaseAck` null,
`thid = replyThread(carrier)` and `ack` the one target, so that the six
spellings of one self-threaded carrier give one ACK intent
([message-vectors.md](message-vectors.md#reply-thread-and-pure-ack)).
Built-in Ping replies and rotation notifications have `ack == []`; another
protocol may define its own explicit ACKs under the same target checks.
Never request an ACK for a pure ACK, or answer one with another. When the
intent is created, reused or completed by hand is
[`packages/agent-core/src/effects.ts`](../../packages/agent-core/src/effects.ts).

An explicit `ack` whose canonical wire ID is an outbound's message ID,
carried by one admitted complete source witness whose channel is the
outbound's fixed channel or a verified role-preserving successor of it,
records that the peer received the message: peer receipt only, not
transport acceptance and no permission to send again. Undirected
connectivity, group membership, threads and ordinary responses are
insufficient; an ignored old-peer carrier acknowledges nothing, while an
admission recorded before supersession remains historical ACK evidence.
Which witnesses qualify, over which path, is the delivery fold over
[channel authorization](../../packages/vault/src/fold/continuity.ts); each
is recorded once as `delivery.acknowledged` by
[`packages/agent-core/src/acknowledgements.ts`](../../packages/agent-core/src/acknowledgements.ts).

An authenticated duplicate in the same channel is another observation of
the same input under
[the inbound fold](../../packages/vault/src/fold/inbound.ts): it creates no
new effect, output ID, preparation, proof or dispatch action. Another
channel is another input, not a duplicate.

<a id="observation-identity-logical-aliasing-and-execution-identity"></a>
<a id="observation-ids-and-vectors"></a>
<a id="execution-scope-and-commit-prerequisites"></a>
<a id="address-chains-and-observation-membership"></a>
<a id="execution-id-and-immutable-transcript"></a>
<a id="local-rotation-scope-vector"></a>

## 9. Channel-local message and execution identity

For authenticated input, canonicalize the authenticated sender and actual
local recipient, take the canonical wire ID of the plaintext `id`, then
compute:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v3", "authenticated", canonicalSenderDid, canonicalRecipientDid, canonicalWireId])
)

executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v4", {"sender": canonicalSenderDid, "recipient": canonicalRecipientDid}, canonicalWireId])
)
```

The transcript members are the literal tags `sender` and `recipient`, which
RFC 8785 orders; the event schema member names are no substitute. For
inbound work the peer is the sender and the local DID the recipient. For
truly anonymous input, retain the independent observation-only derivation:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "anonymous", localKeyName, canonicalWireId])
)
```

The namespace derivation is [ids.ts](../../packages/vault/src/ids.ts)'s.
The UUID naming fixtures and canonical wire-ID equivalence are tested in
[ids.test.ts](../../packages/vault/test/ids.test.ts), and
[message-vectors.test.ts](../../packages/vault/test/message-vectors.test.ts)
checks that `a1` and `A1` name one input and one execution; the published
values are in [message-vectors.md](message-vectors.md). `message.in` keeps
the `id` as received, the transcript takes its canonical form.

Keys and source event CIDs remain exact authentication evidence; different
authorized keys in one immutable DID document represent the same channel
input, and opposite sender directions cannot collide by choosing the same
wire ID. Equal intent within one input shares one execution, disagreement
is [the inbound fold](../../packages/vault/src/fold/inbound.ts)'s conflict,
and continuity links never merge inputs from different channels. Identity
alone grants no work: automatic work requires
[an admitted witness](../../packages/vault/src/admission/model.ts) and
[a live action](../../packages/agent-core/src/action.ts), and anonymous and
mediator-control input have no application execution.

Changing either endpoint produces another channel and another inbound and
execution ID; the old observation and its effects remain unchanged, and only
a new send can select the new channel. ACK authorization may follow
verified successor paths for an exact outbound message without merging the
ACK carrier and the acknowledged message into one execution.

<a id="automatic-effects"></a>

## 10. Automatic effects

An automatic DIDComm output is identified by `(executionId, effectType)`,
the execution derived from a complete, conflict-free carrier under
[the input fold](../../packages/vault/src/fold/inbound.ts); an intent
conflict between independently admitted observations suppresses all
automatic work for that execution, and making a disagreeing group
ineligible cannot clear it. Each protocol assigns a fixed `effectType` URI
to each operation: a URI with a scheme and no U+0000, identified by its
exact UTF-8 spelling, shared across implementations, unchanged when
handlers are renamed, split or refactored, and distinct per operation even
when two operations produce the same DIDComm message type. Each tuple
permits at most one compatible output intent; retries reuse the tuple and
may not change the effect type to create another output or evade a
conflict.

```text
effectKey = base64url(
  SHA-256(
    UTF8("estoc/effect/3\0") ||
    UTF8(executionId) || 0x00 ||
    UTF8(effectType)
  )
)
```

The unpadded base64url key determines the outbound message and wire ID
(`effectKey` and `automaticMessageId` in
[ids.ts](../../packages/vault/src/ids.ts)); the
[message.out schema](../../packages/vault/src/schema.ts) stores the tuple
and intent.

Each tuple has one result, read from the vault before anything is decided
or frozen, before the input's body is read or its handler asked
(`effectResult` in [fold/outbound.ts](../../packages/vault/src/fold/outbound.ts)):
**produced**, a `message.out` under the tuple, reused as it is after
submission, source erasure, another observation, a handler that would
decide otherwise now or a changed clock; **skipped**, an `effect.skipped`
under the tuple, the operation's own rule applied to the admitted input
owing it no output for good; or **pending**, neither. Only a decision that
is a function of the input and the operation is a skip: a receipt not given
under local policy, a channel that takes no reply now, evidence not here
yet, a paused runtime or a failed write is recorded by nothing. A produced
and a skipped result under one tuple conflict; several produced records are
one intent or a conflict under [section 5](#intent-equality). An input
whose tuples are all produced or skipped owes no output; a produced output
not yet submitted is the message's own unfinished work. Only eligible live
input creates an initial intent on its own, and only on the replica
answering it; historical unfinished work is completed by hand with the same
tuples under [the live action](../../packages/agent-core/src/action.ts).
How each operation is decided, committed and dispatched is
[`packages/agent-core/src/effects.ts`](../../packages/agent-core/src/effects.ts).

An input posted directly to a runtime reached it alone, and that runtime
answers it. An input picked up at a replica-mediation mediator reached every
replica of the account: each replica that the input still owes an output
registers under the input's `executionId` at that mediator, the replica the
registration lists first answers the input, and every other replica creates
no intent and keeps, in its runtime's local state, that it left the input
to that replica. The vault records neither the registration nor the leave,
so a runtime whose current replica keeps no leave lists the input's outputs
as unfinished work, and a missing leave authorizes no registration, intent
or call. The registration gives no process-level exactly-once execution:
the replica listed first may stop before it answers, an explicit completion
on any replica may still make the outputs, and two outputs so made for one
tuple are one intent when they agree under [section 5](#intent-equality).
Who answers an input is
[`packages/agent-core/src/responder.ts`](../../packages/agent-core/src/responder.ts);
the registration the mediator keeps is
[the mediator's README](../../mediator/README.md#executions).

Other external effects MUST commit their protocol-defined portable intent
before execution and use that protocol's idempotency or explicit
at-least-once contract. The message fold does not validate those payloads.

<a id="built-in-independent-operations"></a>

### 10.1 Built-in independent operations

| Operation | `effectType` |
| --- | --- |
| Requested receipt ACK | `https://estoc.dev/distributed-delivery/1.0#pure-ack` |
| Trust Ping reply | `https://didcomm.org/trust-ping/2.0/ping-response` |
| Inbound-triggered rotation notification | `https://estoc.dev/distributed-delivery/1.0#rotation-notification` |

Pure ACK and rotation notification both use DIDComm type
`https://didcomm.org/empty/1.0/empty`; their distinct effect types keep the
two operations independent for one execution, and arrival, dependency
completion and handler order never merge tuples. A built-in reply goes by
the carrier's own channel while its local DID may still send there, else by
the unique verified successor that keeps the carrier's canonical peer, else
not at all ([the response policy](../../packages/vault/src/response-policy.ts));
a later rotation or retirement never reselects a committed intent, it can
only prohibit dispatch. A rotation notification names the exact
`rotationEventCid` of one rotation record in its intent and uses that
record's trigger source for its execution; one record has one notification.
What each reply contains, and how a notification is reused or completed by
hand, are [`effects.ts`](../../packages/agent-core/src/effects.ts) and
[the rotation procedure](../../packages/agent-core/src/rotate.ts).

<a id="required-vault-observations"></a>
<a id="failure-rules"></a>

## 11. Failure rules

- Before intent commit, no message exists. A failed/uncertain commit grants no send.
- A crash between any two later commits leaves the portable state of the last
  one: recovery shows manual work, preserves every preparation and replays nothing,
  so a retry may deliver duplicate bytes, which channel-local dedup absorbs.
- After submission or termination commits, no retry is allowed.
- After rotation, old intents and preparations remain in their fixed channels. If that
  channel becomes unusable, a deliberate new send has a new wire ID.
- After erasure, no new content-derived effect is reconstructed.
- Mediator expiry/outage may lose an already submitted message. This best-effort
  profile does not automatically compensate through another replica or channel.

No failure window changes a message's channel or proves nondelivery merely by
lacking a success record. Manual new sending may produce another visible or
business operation if the first one arrived; protocol-level idempotency is
independent of this transport profile. Continuity links and verification
status are fold results, not events, and contact events are not delivery
observations. Crash and recovery scenarios are exercised in
[`packages/agent-core/test/e2e/crash.test.ts`](../../packages/agent-core/test/e2e/crash.test.ts),
with the admission of an observation a crash left unadmitted in
[`test/after.test.ts`](../../packages/agent-core/test/after.test.ts) and
what an open lists of the work a crash left unfollowed in
[`test/agent.test.ts`](../../packages/agent-core/test/agent.test.ts).

<a id="privacy"></a>

## 12. Privacy

Wire IDs, message types and content are visible only inside end-to-end
encrypted application messages. Forward IDs and recipient routing DIDs are
visible to the mediator; a forward ID is a UUIDv5 over the preparation's event
CID and discloses nothing of the event. Delivery IDs are visible to the
recipient mediator. The mediator stores the accepted encrypted envelope and
the account, recipient, retention, pickup and transport metadata it needs,
and MUST NOT persist or log unpacked application plaintext, content keys,
attachment content or decrypted `forward` bodies; a deployment MAY enable
bounded diagnostic logging only by explicit operator action, visibly
disclosed, access-controlled and time-bounded. An acceptance discloses that
the recipient takes mail at this mediator at that moment; that is the cost
of acceptance meaning `submitted`.

A disclosed rendezvous DID is intentionally correlatable within its audience.
Pairwise DIDs SHOULD be disclosed only in encrypted messages and use
Peer DID long form on first disclosure.

Pure ACKs reveal durable receipt timing to the ultimate peer. Implementations
SHOULD NOT encode contact names, replica labels, event CIDs or content in peer-
or mediator-visible IDs.
