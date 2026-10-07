# distributed-delivery/1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide)
<!-- suite-navigation:end -->

Status: **phase 1, implemented** — phase-1 delivery profile for one active full vault
runtime.

This document uses the key words **MUST**, **MUST NOT**, **REQUIRED**,
**SHOULD**, **SHOULD NOT**, and **MAY** as described in BCP 14 when they
appear in all capitals.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Implement sending | [Commit boundaries](#cross-layer-commit-and-acknowledgment-table) → [Send](#send-an-ordinary-message) → [Prepare](#preparing-a-package) → [Completion and expiry](#submission-completion-and-expiration) |
| Implement receiving | [Receive](#receive-a-message) → [Recover](#receive-recovery) → [ACK processing](#durable-end-to-end-acknowledgment) |
| Implement identity and effects | [Hash projections](#canonical-projections-and-hashes) → [Observation and execution identity](#observation-identity-logical-aliasing-and-execution-identity) → [Automatic effects](#automatic-effects) |

<details>
<summary>Contents</summary>

- [1. What it is for](#what-it-is-for)
- [2. Terms](#terms)
- [3. Addressing layers](#addressing-layers)
- [4. Vault-first procedures and commit boundaries](#vault-first-procedures-and-commit-boundaries)
- [5. Canonical projections and hashes](#canonical-projections-and-hashes)
- [6. Preparing a package](#preparing-a-package)
- [7. Submission completion and termination](#submission-completion-and-expiration)
- [8. Durable end-to-end acknowledgment](#durable-end-to-end-acknowledgment)
- [9. Channel-local message and execution identity](#observation-identity-logical-aliasing-and-execution-identity)
- [10. First contact and address policy](#first-contact-and-address-policy)
- [11. Automatic effects](#automatic-effects)
- [12. Required vault observations](#required-vault-observations)
- [13. Failure rules](#failure-rules)
- [14. Privacy](#privacy)

</details>
<!-- reading-guide:end -->

<a id="what-it-is-for"></a>

## 1. What it is for

An Estoc message begins as a durable intent in one fixed oriented channel.
Phase 1 has one executor for each intent: the replica that sends, for the
user's own message, and for an input's automatic outputs the replica that
answers the input, the one the mediator registered first under the input's
execution when the input reached several ([section 11](#automatic-effects)).

Every message transport call uses its committed `message.prepared` package.
Only the live initial action or a new explicit manual retry may make that call.
Transport acceptance commits `delivery.submitted`, permanently completing that
outbound. A failed/unknown call, missing ACK, process reopen or another replica
does not automatically retry it. A manual retry preserves the exact committed
package; selecting another channel means a new message ID.

This profile defines intent/package identity, channel-local deduplication,
explicit ACK authorization, process-durable receipt and effect ordering.
It makes no cross-channel or cross-replica exactly-once business-execution promise.

<a id="terms"></a>

## 2. Terms

- **Channel** — fixed ordered pair of canonical local and peer DIDs within one vault.
- **Contact** — local names, preferences and selected channel histories with no protocol authority.
- **Full replica** — a writable vault incarnation; one input picked up at a replica-mediation mediator reaches every replica of the account, and one of them answers it.
- **Outbound message ID** — one committed intent's entity ID and plaintext `id`.
- **Inbound message ID** — derived from canonical sender, canonical recipient and wire ID.
- **Execution ID** — stable identity of one channel-local input; identity alone grants no work.
- **Package ID** — exact encrypted inner envelope identity and Routing `forward.id`.
- **Delivery ID** — mediator pickup identity, separate from message/package IDs.
- **Prepared** — one committed, fixed package; it records no transport invocation.
- **Submitted** — recorded transport acceptance; it is not ultimate receipt.
- **Acknowledged** — accepted explicit peer `ack` naming the exact authorized outbound.
- **Semantic/intent/plaintext hashes** — the projections in section 5; addressing
  is package evidence but the intent's channel is independently immutable.

<a id="addressing-layers"></a>

## 3. Addressing layers

An external peer addresses a DID controlled by the vault. It never addresses
or learns a replica ID.

All local communication addresses are vault-scoped. The active full runtime
derives their private keys and receives their messages. Public/private
allocation does not select a different sender permission or receive
path. A later server or replica does not own an address merely by executing
the vault. The channel preserves local/peer roles within that vault;
each message has a sender and recipient, and every rotation is directed.

Each local communication DID sends where its document's one DIDComm service
says, a mediator's routing DID or a direct endpoint. Changing its keys or
route creates a successor DID entity;
[local rotation decisions](channels.md#did-rotationselected) select continuation
in an exact channel context; their links are derived. An ordinary rotation's
successor inherits the predecessor's route, so the runtime committing it
must be one that picks up there: a mediated predecessor is continued by a
replica of the arrangement that routes it, and a runtime enrolled nowhere
or in another arrangement refuses the rotation before anything is written,
as does every runtime while that arrangement has ended, under
[the successor's standing](../../packages/agent-core/src/successor.ts). A
replica's membership stands for no other runtime's, and what is listed for
a hand to make is read by the same standing.
An external recipient's resolved document may offer transport choices; choosing
among authorized routes does not change the application recipient. A direct
endpoint MUST NOT expose a replica ID as the peer-visible recipient.

The phase-1 mediator holds one replica-mediation account per arrangement; each
runtime picks up as a replica of its own, under its own DID.

A valid `from_prior` justifies one endpoint replacement in its exact channel context.
Unrelated channels using that address retain their own endpoint decisions.

<a id="phase-1-mediator-envelope-and-storage-profile"></a>

### 3.1 Phase-1 mediator envelope and storage profile

Before storing a Routing 2.0 `forward`, the mediator MUST require:

1. an outer DIDComm encrypted message addressed to the mediator;
2. a valid `body.next` that maps to the mediation account itself or a recipient
   currently registered to that account;
3. exactly one attachment;
4. an attachment whose `media_type`, when present and non-null, equals
   `"application/didcomm-encrypted+json"`; an absent or null `media_type` is
   unspecified and does not bypass the checks below;
5. exactly one of `data.json` or `data.base64`, and no `data.links`;
6. after decoding, one DIDComm encrypted-message JSON serialization (General
   JWE JSON): base64url `protected`, `iv`, `ciphertext` and `tag`, and a
   non-empty `recipients` array whose entries each carry `header.kid` and a
   base64url `encrypted_key`. For every recipient, the decoded protected
   header, the shared unprotected header and the per-recipient header MUST
   have pairwise-disjoint member names, and their union MUST give `alg` and
   `enc` as non-empty strings; and
7. stored envelope bytes within the advertised account and message limits.

Senders SHOULD set the attachment `media_type`; stock Routing 2.0 wrappers
leave it out, so receivers apply the same checks either way and reject only a
declared different type.

`data.base64` MUST decode as base64url without ignoring invalid characters
and then as well-formed UTF-8. Unknown members are kept. The mediator MUST NOT
limit the inner `alg` or `enc` to algorithms it implements, and MUST NOT
re-encode `protected`.

Validation is syntactic. The mediator MUST NOT decrypt the inner application
envelope or possess an application content-decryption key. It stores the
accepted encrypted-message JSON, which need not keep the sender's exact text,
plus the minimum account, recipient, package, retention, pickup and transport
metadata required for operation. It MUST NOT persist or log unpacked
application plaintext, content keys, attachment content, decrypted `forward`
bodies or request bodies. A deployment MAY enable bounded diagnostic logging
only by explicit operator action; such logging is outside the no-plaintext
profile and MUST be visibly disclosed, access-controlled and time-bounded.

The sender's local DASL CID for the normalized envelope is never part of
Routing 2.0 and MUST NOT be sent merely to deliver the package.

Every accepted forward is queued as a new package, a repeated one included;
the receiver's channel-local deduplication absorbs the copies.

The mediator applies one recipient profile to all communication DIDs.
Public/private allocation is not sent to it. HTTP or
mediator acceptance means only `submitted`; ultimate acknowledgment still
requires an authenticated application plaintext whose explicit `ack` names the
wire ID. HTTP errors, including 400 and 413, timeouts, disconnects and remote
Problem Reports supply only local failure diagnostics. They MUST NOT append
`delivery.failed`. An unsuccessful or uncertain call leaves manual work and
grants no automatic retry.

The mediator MUST bound stored envelope size, retained ciphertext bytes,
retained message count, registered recipients, recipient-add rate, pickup
batch size and retention time. A quota or validation failure MUST NOT leave a
partially stored package. Anonymous routing responses SHOULD avoid becoming a
precise account- or recipient-existence oracle: an unknown `body.next` and a
full queue share one refusal. An acceptance still discloses that `body.next`
takes mail at this mediator at that moment; that is the cost of acceptance
meaning `submitted`.

<a id="4-vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-sending-and-commit-boundaries"></a>

<a id="vault-first-procedures-and-commit-boundaries"></a>

## 4. Vault-first procedures and commit boundaries

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

A full vault runtime MUST be able to commit a send while DNS, DID resolution
and every mediator are unavailable. Before network work, commit the content and
[message.out](vault-events.md#message-out), freezing its ID, channel, headers
and user or automatic-effect decision.

`createdTime == null` means the DIDComm `created_time` header is absent. A
preparer MUST NOT invent it. A user-authored message normally freezes commit
time, while a deterministic response may copy or derive a timestamp under its
protocol. The value is not a transport-freshness proof.

A successful vault commit uses the process-durable boundary in
[event-store.md section 2.1](event-store.md#commit-and-durability-terminology). Correctness MUST NOT depend on an uninterrupted
process lifetime or rebuildable cache state. A remote thin client without the
seed may stage a command offline, but the command becomes authoritative only
when a full vault runtime process-durably appends `message.out`.

<a id="cross-layer-commit-and-acknowledgment-table"></a>
<a id="91-receive-a-message"></a>
<a id="92-receive-recovery"></a>

### 4.1 Commit and acknowledgment boundaries

| Boundary | Durable prerequisite | Meaning |
| --- | --- | --- |
| Offline send intent | Content and `message.out` with fixed channel/direction | A selected new message, not authority for recovery dispatch |
| Package preparation | Valid fixed-channel intent, operation resolution and `message.prepared` | One fixed package for this message |
| Transport invocation | Committed package plus a live initial/manual action | One call using the fixed package; no invocation event is stored |
| Submission completion | `delivery.submitted` naming that message/package | Stop preparation and sending for this message ID |
| Channel receipt | Current authentication, exact resolution, objects and `message.in` | Normal pickup ACK may follow |
| Proof verification | Exact authenticated carrier with its original JWT and derivable or retained immutable issuer material | Fold computes proof result and continuity status without another event |
| New source-derived work | Admitted complete source/proof evidence, current policy and any additional evidence required by that consumer | Only the specific eligible operation may proceed |
| Peer ACK | Admitted complete source witness and exact channel/path target | Receipt information only |

Every dependency reference names an event committed before the dependent call.
Object storage alone is not event commitment. Contact membership, a thread ID,
peer ACK or a missing submission event never supplies dispatch authority.

<a id="send-an-ordinary-message"></a>

### 4.2 Send an ordinary message

A send commits the content and `message.out`, with its channel and headers
fixed, before any network work; an explicit user send may select a new
channel, and an automatic output goes where
[the response policy](../../packages/vault/src/response-policy.ts) says. What follows is code:
the intent is [`packages/agent-core/src/send.ts`](../../packages/agent-core/src/send.ts), its one
package [`prepare.ts`](../../packages/agent-core/src/prepare.ts), the one transport call of that
package [`dispatch.ts`](../../packages/agent-core/src/dispatch.ts) under
[the live action](../../packages/agent-core/src/action.ts), and the wait for a prerequisite
[`dispatcher.ts`](../../packages/agent-core/src/dispatcher.ts); no vault lock is held across network
I/O. Transport acceptance is recorded as `delivery.submitted` naming the
message and package. Every other transport outcome stays in the runtime's
local trace and MUST NOT produce `delivery.failed`, which only explicit
cancellation and expiry append under
[termination](vault-events.md#delivery-failed); failure or uncertainty
grants no next call. A crash loses the live action, whether or not
transport was called; reopen cannot replay it.

<a id="receive-a-message"></a>

### 4.3 Receive a message

Every delivery, picked up or posted directly, goes through one gate, is
recorded as one `message.in` with its exact resolution evidence and content,
and has the admissions the vault owes reconciled under
[application admission](channels.md#application-admission) before the
receipt's lock is released, so that the writer lock is the one runtime-wide
receipt and admission sequence whichever way the delivery came, and a
replacement known by then is known to the decision. A pickup ACK is
authorized by the durable receipt, independently of channel policy and
history, and does not wait for the transport calls of automatic outputs;
a hard terminal rejection may pickup-ACK without `message.in`, and a
failed durable receipt withholds it. Automatic work is earned only by the call that recorded the first
observation the vault holds of an input and had it admitted under that
lock as the witness its input speaks through; a retained duplicate, an
observation admitted later by evidence, an open, an import or a restore
earns none, and what such an input still earns is listed for manual
completion. The rotation such an input selects is decided in the turn
the delivery came in, on every replica it reached, so that each holds the
successor before it opens the next delivery; the input's outputs, the
rotation's notification among them, are made off that turn and only by
the replica answering the input ([section 11](#automatic-effects)).
Control types never trigger recursive privacy notifications.

The code: the gate [`packages/agent-core/src/receive/gate.ts`](../../packages/agent-core/src/receive/gate.ts),
the receiver [`receive/receiver.ts`](../../packages/agent-core/src/receive/receiver.ts) (what waits
for something recoverable of this runtime's, what is terminal and the
bounded diagnostic it leaves), the receipt
[`receive/receipt.ts`](../../packages/agent-core/src/receive/receipt.ts), the pass over what the
vault owes [`reconcile.ts`](../../packages/agent-core/src/reconcile.ts) (admissions in canonical
event order, then peer acknowledgements), what is reported of the
observation afterwards [`receive/after.ts`](../../packages/agent-core/src/receive/after.ts), who
answers the input [`responder.ts`](../../packages/agent-core/src/responder.ts), and
the automatic effects [`effects.ts`](../../packages/agent-core/src/effects.ts). The
[phase-1 adapter](../../packages/agent-core/README.md#didcomm-api)
preserves any string-valued `from_prior` without verifying it; the vault
judges it from the retained evidence under
[the channel evidence fold](../../packages/vault/src/fold/channels.ts), showing missing
evidence as pending.

<a id="receive-recovery"></a>

### 4.4 Recovery

Receipt-derived state is rebuilt from retained evidence, without re-resolving
a sender or repeating a receipt: proofs are recomputed from retained JWTs and
immutable issuer material under
[the channel evidence fold](../../packages/vault/src/fold/channels.ts), and the pass over what the
vault owes runs at open and whenever evidence arrives, not only after a
restart ([`reconcile.ts`](../../packages/agent-core/src/reconcile.ts)). Pending and unconfirmed messages
are shown for manual action under [the live action](../../packages/agent-core/src/action.ts), with their
message, execution, package and submission identities preserved; an open, an
import or evidence recovered apart mints no action
([`agent.ts`](../../packages/agent-core/src/agent.ts)). A carrier whose predecessor material was missing
at receipt is no longer live when it arrives, under
[the receipt](../../packages/agent-core/src/receive/receipt.ts). Erased input starts no new
content-derived effect.

<a id="canonical-projections-and-hashes"></a>

## 5. Canonical projections and hashes

<a id="semantic-projection"></a>

### 5.1 Semantic projection

For an innermost plaintext `M`, define:

```json
{
  "id": "<M.id>",
  "type": "<M.type>",
  "thid": null,
  "pthid": null,
  "body": {},
  "attachments": []
}
```

Values are copied from `M`. Absent thread values are null. Body and attachments
use the closed normalization in [vault-events.md section 7](vault-events.md#stored-message-document). The semantic
projection contains no implementation-selected attachment metadata.

It excludes:

```text
typ, from, to, created_time, expires_time,
please_ack, ack, from_prior
```

`return_route` is forbidden in an Estoc vault application plaintext.

This projection is the `semantic` member of the intent projection below. It
has no separately stored hash.

<a id="intent-projection"></a>

### 5.2 Intent projection

The intent projection is:

```json
{
  "semantic": {
    "id": "<wire ID>",
    "type": "<message type>",
    "thid": null,
    "pthid": null,
    "body": {},
    "attachments": []
  },
  "created_time": null,
  "expires_time": null,
  "please_ack": [""],
  "ack": [],
  "headers": {}
}
```

`please_ack` is null when the wire header is absent; otherwise it is the exact
ordered wire array. `""` means the current message, and the current wire ID MAY
be used instead.

A message requests its own ACK when the array contains `""` or its own wire
ID. An absent or empty array does not request it, while `[""]` and
`[currentWireId]` do. This profile acknowledges one message at a time: a
receipt is given to the message that asks for it, naming that message alone.
A string naming any other message is preserved but asks nothing of this
vault, so a sender that wants a receipt for a message asks for it in that
message. This request never changes submission completion or retry
eligibility.

Readers preserve the accepted wire array exactly. Absent `please_ack`
normalizes to null; absent `ack` normalizes to `[]`; absent `created_time` or
`expires_time` normalizes to null; absent additional headers normalize to
`{}`. The producer emits `ack` naming exactly one wire ID, the carrier's,
under section 8.1; the ordering MUST in
[DIDComm Messaging v2.1, ACKs](https://identity.foundation/didcomm-messaging/spec/v2.1/#acks)
is therefore met by every emitted array.

`headers` contains every permitted top-level DIDComm field not represented by
a dedicated field. The reserved names `typ`, `id`, `type`, `from`, `to`,
`created_time`, `expires_time`, `thid`, `pthid`, `please_ack`, `ack`,
`from_prior`, `return_route`, `body` and `attachments` are forbidden. A
difference in any such field is an intent difference.
Local effect bookkeeping and package addressing are excluded.

`intentHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON for
this projection.

<a id="exact-plaintext-hash"></a>

### 5.3 Exact plaintext hash

`plaintextHash` is unpadded base64url SHA-256 of RFC 8785 canonical UTF-8 JSON
for the normalized innermost DIDComm plaintext of one package or one
observation. Normalization omits a top-level member whose value is explicitly
null when its name is one of `from`, `to`, `thid`, `pthid`, `created_time`,
`expires_time`, `from_prior` or `attachments`; that set is closed and does not
grow with the headers a library recognizes. Every other present top-level
member stays in the hash input, including `please_ack: null`, `ack: null` and
null values in additional headers. `body` is unchanged, nested nulls included.

Attachments are normalized as containers, not as JSON values. Each
descriptor and its `data` object retain only the members the
[stored attachment profile](vault-events.md#stored-message-document) admits;
an admitted optional member whose value is null is omitted, and any other
member is excluded. The JSON value inside a `json` carrier is unchanged,
nested nulls included, and the ordinary attachment syntax rules still apply,
including the required non-null `hash` of a `links` carrier.

The single-carrier rule of that profile is checked on the decrypted `data`
object as received, before it is projected onto a typed carrier and before
any member is discarded: exactly one of `base64`, `json` and `links` is
present, counted by presence, so `json: null` is a present carrier. A second
recognized carrier is not unsupported metadata and is never dropped to make
the attachment valid. A library that projects attachment data onto one
carrier must therefore reject an ambiguous object itself, or hand the
receiver enough of the original to reject it before acceptance.

The sender hashes the normalized plaintext it encrypts; the receiver
normalizes the accepted plaintext the same way before hashing. A hash helper
that hashes its input unchanged requires that normalization to have happened
before the call.

An outbound `messageId` has one fixed package. Its intent hash matches the
intent; its plaintext hash preserves the exact prepared addressing and proof.

<a id="preparing-a-package"></a>

## 6. Preparing a package

A package is the one exact envelope every transport call of its intent
carries. Its plaintext is constructed from the immutable intent alone:
conditional nullable timestamps and threads, exact `pleaseAck`, frozen `ack`,
supported headers, body and ordered attachments, with `from`, `to`, the exact
key methods and any frozen proof following the fixed channel's evidence; the
wire ID equals the outbound message ID. Forbidden `return_route`, duplicate
JSON members and invalid I-JSON are rejected. The plaintext is canonicalized
with RFC 8785 and encrypted through maintained DIDComm APIs, and the exact
normalized envelope, the peer resolution it used under
[the address profile](relationships.md#recipient-resolution-freshness) and
`message.prepared` are committed in one lock before transport under
[the package schema](vault-events.md#message-prepared). That commit freezes
its plaintext, ciphertext, proof, spelling, package ID and envelope CID for
the initial call and every retry; later confirmation, rotation, resolution or
termination cannot replace it, and changing the package requires a new
message ID. Which spelling and which keys the two ends take, what defers a
package, and the pass every preparation owes are
[`packages/agent-core/src/prepare.ts`](../../packages/agent-core/src/prepare.ts).

<a id="submission-completion-and-expiration"></a>

## 7. Submission completion and termination

Any valid committed submission completes the message and prevents further
preparation or retry, regardless of ACK policy. Missing submission does not prove
nondelivery; pending work follows [the delivery fold](../../packages/vault/src/fold/outbound.ts).
Expiry, at equality, and explicit cancellation terminate the entire intent
under [the termination rules](vault-events.md#delivery-failed), without
depending on preparation evidence and without claiming nondelivery; a
complete submission takes precedence, and later ACK evidence reports receipt
without reopening anything. Known endpoint replacement prohibits preparation
and transport on the old channel under
[the continuity fold](../../packages/vault/src/fold/continuity.ts), queued work and manual retries
included; it never rewrites their packages. When expiry and cancellation are
observed, and what each leaves of the content and the envelope, is
[`packages/agent-core/src/dispatch.ts`](../../packages/agent-core/src/dispatch.ts).

Prepared-envelope retention is owned solely by
[vault-events.md](vault-events.md#held-roots). A paused/unconfirmed eligible
package remains retained for possible manual action; waiting is not deletion.
ACKs have no independent retention contribution. A submitted envelope need not
be recreated for a duplicate input or manual "send again" with a new ID.

<a id="durable-end-to-end-acknowledgment"></a>

## 8. Durable end-to-end acknowledgment

<a id="the-ack-target"></a>

### 8.1 The ACK target

An ACK is created for an admitted complete source witness, in the channel
[the built-in operation rule](#built-in-independent-operations) selects; an
unrelated channel in the same contact is never a substitute, and an input with
no eligible sender is preserved for manual action. An ACK uses retained
receipt and header evidence, so body erasure alone does not disqualify its
source; it restores no permission for content-derived work. When the intent
is created, reused or completed by hand is
[`packages/agent-core/src/effects.ts`](../../packages/agent-core/src/effects.ts).

Whether to honor `pleaseAck` is local policy, not a durable reply obligation.
A carrier that does not request its own receipt under
[section 5.2](#intent-projection) creates no requested-ACK work, whatever
other messages its request names. Otherwise the one target is the carrier's
own wire ID, which names its exact source input: the carrier must be the
admitted complete witness establishing that input, and the input's admitted
intents must agree. No other message is ever a target, so no receipt order,
wire-ID lookup, predecessor-channel search or ambiguity rule enters the
selection, and later discovery cannot change the saved `ack`.

Validation of a saved pure ACK checks that its `ack` is exactly the carrier's
wire ID, that the carrier requests its own receipt, and that the carrier's
input has no independently admitted intent conflict.
The intent stands on the carrier's complete witness, admitted or not: a
history rebuilt without the admission revokes no saved intent, while a
new ACK is created only for an admitted carrier. Generic replies use
`thid = carrier.thid ?? carrier.wireMessageId`, copy nullable `pthid`, and follow
the producing protocol's response rules. No-response errors still do not reply.

The ACK is its own Empty message, under its own tuple, independent of a
natural reply or rotation notification, which may coexist with it. Built-in
Ping replies and rotation notifications have `ack == []`; another application
protocol may define its own explicit ACKs subject to the same target checks.
There is no execution-wide limit of one ACK-bearing output. Control input may
supply ACK observations but cannot trigger recursive privacy notifications.
Never request an ACK for a pure ACK, or answer a pure ACK with another pure
ACK. Every output follows normal preparation/submission boundaries.

<a id="deterministic-pure-ack"></a>

### 8.2 Deterministic pure ACK

```text
effectType = https://estoc.dev/distributed-delivery/1.0#pure-ack
```

Copy the carrier's normalized nullable creation time; expiry is null. Body is
`{}`, attachments empty, `pleaseAck` null and `headers` empty. Threads and the
one ACK target follow section 8.1.

The executable fixture uses recipient
`did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd`,
authenticated sender `did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP` and wire ID
`019b1b61-3444-7190-9db5-1cc9c215eb23`:

```text
executionId = ccee59f0-8c79-5011-8822-dbb14de9cf7d
effectKey = Vyjgpd9idT4bb9ejAEdwT5J8dX-kL6FfSniCkFZDB20
outbound message ID = wire ID = 3543ac01-4ac6-5c14-b160-4f8f4e2e6811
```

These values follow the channel execution transcript and effect-key
algorithm below.

<a id="applying-ack"></a>

### 8.3 Applying `ack`

An explicit `ack` naming an outbound's wire ID, carried by one admitted
complete source witness whose channel is the outbound's fixed channel or a
verified role-preserving successor of it, records that the peer received the
message: peer receipt only, not transport acceptance and no permission to
send again. Undirected graph connectivity, group membership, threads and
ordinary responses are insufficient; an ignored old-peer carrier acknowledges
nothing, while an admission recorded before supersession remains historical
ACK evidence. The carrier's key need not equal the old package's recipient
key. Which witnesses qualify, over which path, is
[the delivery fold](../../packages/vault/src/fold/outbound.ts) over
[channel authorization](../../packages/vault/src/fold/continuity.ts); each is recorded once as
`delivery.acknowledged` by
[`packages/agent-core/src/acknowledgements.ts`](../../packages/agent-core/src/acknowledgements.ts).

<a id="duplicate-receipt-handling"></a>

### 8.4 Duplicate receipt handling

An authenticated duplicate in the same channel is another observation of the
same input under [the inbound fold](../../packages/vault/src/fold/inbound.ts): it creates no new
effect, output ID, package, proof or dispatch action. Another channel has
another input identity and is not a duplicate under this profile.

<a id="observation-identity-logical-aliasing-and-execution-identity"></a>

## 9. Channel-local message and execution identity

<a id="observation-ids-and-vectors"></a>

### Observation IDs and vectors

For authenticated input, canonicalize the authenticated sender and actual local
recipient, then compute:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v3", "authenticated", canonicalSenderDid, canonicalRecipientDid, wireMessageId])
)
```

Keys and source event CIDs remain exact authentication evidence. Different
authorized keys in the same immutable DID document can represent the same
channel input; selected key differences create no new deduplication scope.
Opposite sender directions cannot collide merely by choosing the same wire ID.
For truly anonymous input, retain the independent observation-only derivation:

```text
messageId = UUIDv5(
  estocNamespace("inbound-message"),
  RFC8785(["v1", "anonymous", localKeyName, wireMessageId])
)
```

For recipient `did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd`
and sender `did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP`, the naming vectors are:

| wireMessageId | messageId | executionId |
| --- | --- | --- |
| `019b2a70-f225-721c-835f-67175be0667e` | `d2192dcf-cc5c-5f7d-b4f1-46972b7b04de` | `a03249b8-5e3e-5d10-a2e7-46844b38f5ae` |
| `019b1b61-3444-7190-9db5-1cc9c215eb23` | `9cfaed56-2cb3-5a84-bc56-f8e882784ac8` | `ccee59f0-8c79-5011-8822-dbb14de9cf7d` |

These are identifier fixtures, not authentication/proof fixtures.

<a id="execution-scope-and-commit-prerequisites"></a>

### Execution prerequisites

Automatic work requires [an admitted witness](../../packages/vault/src/admission/model.ts)
and [a live action](../../packages/agent-core/src/action.ts), independently of
ID derivation. Source/endpoint/proof dependencies must already be committed.
Anonymous and mediator-control input have no application execution.

<a id="address-chains-and-observation-membership"></a>

### Source observations

Validate each source with its own recipient/key mapping and immutable
authentication document under [the channel evidence fold](../../packages/vault/src/fold/channels.ts).
Equal intent within one sender/recipient/wire-ID input shares one execution;
disagreement is [the inbound fold](../../packages/vault/src/fold/inbound.ts)'s conflict.
Continuity links never merge inputs from different channels.

<a id="execution-id-and-immutable-transcript"></a>

### Execution ID

```text
executionId = UUIDv5(
  estocNamespace("message-execution"),
  RFC8785(["v4", {"sender": canonicalSenderDid, "recipient": canonicalRecipientDid}, wireMessageId])
)
```

Use the literal transcript members `sender` and `recipient`; RFC 8785 orders
object members canonically. For inbound work, the peer is the sender and the
local DID is the recipient. Namespace derivation
is in [vault-events.md](vault-events.md#entity-ids-and-reproducible-uuidv5-namespaces).
The event schema member names are not substitutes for these transcript tags.

<a id="local-rotation-scope-vector"></a>

### Rotation and message identity

Changing either endpoint produces another channel and another inbound/execution
ID. The old observation and its effects remain unchanged. Retrying an existing
outbound does not make this change; only a new send can select the new channel.
ACK authorization may follow verified successor paths for an exact outbound
message; that path does not merge the ACK carrier and the acknowledged message
into one execution.

<a id="first-contact-and-address-policy"></a>

## 10. First contact and address policy

Useful content or Trust Ping can be the first ordinary DIDComm message.
Address selection and optional early privacy rotation follow
[the address policy](relationships.md).

<a id="automatic-effects"></a>

## 11. Automatic effects

An automatic DIDComm output is identified by `(executionId, effectType)`.
`executionId` MUST derive from a complete, conflict-free logical carrier under
[the input fold](../../packages/vault/src/fold/inbound.ts).
An intent conflict between independently admitted observations suppresses all
automatic work for that execution;
making a disagreeing group ineligible cannot clear the conflict.

Each protocol MUST assign a fixed `effectType` URI to each operation and define
its output intent rules. The URI MUST include a scheme and MUST NOT contain
U+0000. Its exact UTF-8 spelling identifies the operation; implementations MUST
NOT normalize or dereference it to derive the key. The identifier is shared
across implementations and MUST remain unchanged when handlers are renamed,
split or refactored. Distinct operations MUST use different effect types, even
when they produce the same DIDComm message type. An effect type need not itself
be a DIDComm message type URI.

Each tuple permits at most one compatible output intent; different effect types
may independently produce outputs for the same execution. Retries MUST reuse
the tuple and MUST NOT change effect type to create another output or evade a
tuple or execution conflict.

```text
effectKey = base64url(
  SHA-256(
    UTF8("estoc/effect/3\0") ||
    UTF8(executionId) || 0x00 ||
    UTF8(effectType)
  )
)
```

The unpadded base64url key determines the outbound message and wire ID under
[vault events](vault-events.md#ids). The [message.out schema](vault-events.md#message-out)
stores the tuple and intent and defines their validation; conflicts follow
[the delivery fold](../../packages/vault/src/fold/outbound.ts).

An intent is looked up by its tuple before anything is frozen, and an
existing non-conflicted one is reused as it is after submission, source
erasure, another observation or a changed clock; the exact source and any
rotation decision are retained directly in the
[intent](vault-events.md#message-out). Missing evidence or sender leaves that
operation pending without blocking another independently eligible operation.
ACKs and rotation notifications are standalone Empty messages, independent of
natural protocol responses; arrival, dependency completion and handler order
never merge their tuples. Only eligible live input creates an initial intent
on its own, and only on the replica answering it; historical unfinished work is completed by hand with the same
tuples under [the live action](../../packages/agent-core/src/action.ts). How each operation is decided,
committed and dispatched is [`packages/agent-core/src/effects.ts`](../../packages/agent-core/src/effects.ts).

An input posted directly to a runtime reached it alone, and that runtime
answers it. An input picked up at a replica-mediation mediator reached
every replica of the account. Each replica that the input still owes an
output registers under the input's `executionId` at that mediator
(`execution-register`), and the replica the registration lists first
answers the input. Every other replica records
[`execution.yielded`](vault-events.md#execution-yielded), creates no intent
for the execution and lists none of its outputs as unfinished work. A
replica that cannot read the registration as listing itself, because the
mediator refused it, the request was lost twice or the reply lists other
replicas, creates no intent either and records no yield, so the outputs
are listed for manual completion. An input that owes no output is not
registered. Who answers an input is
[`packages/agent-core/src/responder.ts`](../../packages/agent-core/src/responder.ts).

Other external effects MUST commit their protocol-defined portable intent
before execution and use that protocol's idempotency or explicit at-least-once
contract. The message fold does not validate those payloads.

The registration does not provide process-level exactly-once execution: the
replica listed first may stop before it answers, and its outputs are then
listed only for its own manual completion.

<a id="built-in-independent-operations"></a>

### Built-in independent operations

| Operation | `effectType` |
| --- | --- |
| Requested receipt ACK | `https://estoc.dev/distributed-delivery/1.0#pure-ack` |
| Trust Ping reply | `https://didcomm.org/trust-ping/2.0/ping-response` |
| Inbound-triggered rotation notification | `https://estoc.dev/distributed-delivery/1.0#rotation-notification` |

Pure ACK and rotation notification both use DIDComm type
`https://didcomm.org/empty/1.0/empty`. Their distinct effect types keep both
operations independent for one execution.

A built-in ACK or Ping reply goes by the carrier's own channel while its
local DID may still send there, else by the unique verified successor that
keeps the carrier's canonical peer, else not at all:
[the response policy](../../packages/vault/src/response-policy.ts). `recipientDid` is the source's
canonical `did`, never its `presentedDid` spelling. This is a producer
selection rule; import validates the saved intent's evidence, not the
producer's then-visible lifecycle state. A later rotation or retirement never
reselects a committed intent; it can prohibit dispatch, and no second tuple
bypasses the restriction.

A Ping reply requires `response_requested != false` and current protocol/policy
eligibility. It uses type `https://didcomm.org/trust-ping/2.0/ping-response`,
`thid = source.wireMessageId`, source `pthid`, `createdTime` and `expiresTime`,
empty body/attachments/headers, `ack == []` and `pleaseAck == null`. An expired
Ping cannot start a new reply. It is independent of an ACK requested by that Ping.

A rotation notification names the exact `rotationEventCid` of one rotation
record in its intent. It uses that record's trigger source for its execution,
not a later input that discovers unfinished notification work. Its type is
`https://didcomm.org/empty/1.0/empty`, body/attachments/headers are empty,
`ack == []`, `pleaseAck == [""]`, expiry is null, and source `pthid`, nullable
creation time and `thid ?? wireMessageId` are retained. Its sender is the
record's successor DID and recipient is the record's fixed `peerDid`. Its
source, when present, belongs to the record's `fromDidId`/`peerDid` channel.
Until exact-successor confirmation, every successor message, the notification
included, carries a proof selected at preparation time from the first
candidate record in canonical event order within the same rotation intent; it
need not be the proof of the record the notification names. The selected proof
is frozen in each prepared package; notification submission alone is not
confirmation.

A manual rotation with no trigger source uses a locally initiated UUIDv7
notification intent, null thread/parent-thread/creation time, and the same
Empty/ACK-request/expiry rules; its source/effect fields are null, while
`rotationEventCid` remains present. One record has one notification: several
intents naming it conflict for notification work, and no trigger, retry or
completion creates another. Several records of one rotation intent each track
their own notification. Two records over one input derive the same automatic
message ID, so their notification intents collide; a record's notification is
not guaranteed to complete in that case. How a record reuses its notification,
when a missing one may still be completed by hand and that recovery never
allocates another successor are
[the rotation procedure](../../packages/agent-core/src/rotate.ts).

<a id="required-vault-observations"></a>

## 12. Required vault observations

```text
message.out                fixed channel and immutable intent
message.prepared           exact selected envelope
delivery.submitted         observed transport acceptance of the fixed package
delivery.failed            terminal failure or message cancellation
delivery.acknowledged      exact authorized peer receipt observation
message.in                 independent authenticated channel receipt
message.admitted           durable application acceptance of one exact receipt
did.rotationSelected       local successor and frozen proof selected before sending
channel.blocked            local channel/successor denial
```

Continuity links and verification status are fold results, not events.
Contact events are not delivery observations. Schemas are owned by
[vault events](vault-events.md) and [channels](channels.md); the folds over
them are owned by the modules those documents link.

<a id="failure-rules"></a>

## 13. Failure rules

- Before intent commit, no message exists. A failed/uncertain commit grants no send.
- A crash between any two later commits leaves the portable state of the last
  one: recovery shows manual work, preserves the package and replays nothing,
  so a retry may deliver duplicate bytes, which channel-local dedup absorbs.
- After submission or termination commits, no retry is allowed.
- After rotation, old intents/packages remain in their fixed channels. If that
  channel becomes unusable, a deliberate new send has a new wire ID.
- After erasure, no new content-derived effect is reconstructed.
- Mediator expiry/outage may lose an already submitted message. This best-effort
  profile does not automatically compensate through another replica or channel.

No failure window changes a message's channel or proves nondelivery merely by
lacking a success record. Manual new sending may produce another visible or
business operation if the first one arrived; protocol-level idempotency is
independent of this transport profile. Crash and recovery scenarios are
exercised in
[`packages/agent-core/test/e2e/crash.test.ts`](../../packages/agent-core/test/e2e/crash.test.ts),
with the admission of an observation a crash left unadmitted in
[`test/after.test.ts`](../../packages/agent-core/test/after.test.ts) and
what an open lists of the work a crash left unfollowed in
[`test/agent.test.ts`](../../packages/agent-core/test/agent.test.ts).

<a id="privacy"></a>

## 14. Privacy

Wire IDs, message types and content are visible only inside end-to-end
encrypted application messages. Package IDs and recipient routing DIDs are
visible to the mediator. Delivery IDs are visible to the recipient mediator.

A disclosed rendezvous DID is intentionally correlatable within its audience.
Pairwise DIDs SHOULD be disclosed only in encrypted messages and use
Peer DID long form on first disclosure.

Pure ACKs reveal durable receipt timing to the ultimate peer. Implementations
SHOULD NOT encode contact names, replica labels, event CIDs or content in peer-
or mediator-visible IDs.
