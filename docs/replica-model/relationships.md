# Estoc channel address and contact policy 1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide)
<!-- suite-navigation:end -->

Status: **phase 1, implemented** — ordinary DIDComm channels, discovery and
early private-address allocation for one active writable vault runtime.
Phase-1 channel endpoints support only `did:peer:4`; mediator DID resolution
is independent of that restriction.

This document uses **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**
and **MAY** as described in BCP 14 when they appear in all capitals.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Understand channels and display | [Model](#what-it-is-for) → [Identifiers](#symmetric-relationship-identity) → [Peer address changes](#peer-address-changes) |
| Implement authentication and receipt | [Receipt gates](#uniform-receipt) → [Receive procedure](distributed-delivery.md#receive-a-message) → [Resolution and retry rules](#did-resolution-requirements) → [Peer DID profile](#peer-did-numalgo-4-profile) |
| Implement address policy | [Discovery](#out-of-band-discovery) → [Select a channel](#ordinary-sending-and-birth-selection) → [Early privacy and notification](#early-private-address-policy-and-notifications) → [Retry and manual resend](#retry-replacement-and-address-rollover) |

<details>
<summary>Contents</summary>

- [1. What it is for](#what-it-is-for)
- [2. Dependencies](#dependencies)
- [3. Terms](#terms)
- [4. Invariants](#invariants)
- [5. Channel pairs and contact identifiers](#symmetric-relationship-identity)
- [6. Out-of-band discovery](#out-of-band-discovery)
- [7. Address lifecycle](#address-lifecycle)
- [8. Ordinary sending and channel selection](#ordinary-sending-and-birth-selection)
- [9. Uniform receipt](#uniform-receipt)
- [10. DID profiles and resolution evidence](#did-profiles-and-resolution-evidence)
- [11. Early private-address policy and notifications](#early-private-address-policy-and-notifications)
- [12. Peer address changes](#peer-address-changes)
- [13. Remote errors and integrity failures](#remote-errors-and-integrity-failures)
- [14. Retry and manual resend](#retry-replacement-and-address-rollover)
- [15. Execution and recovery](#execution-and-recovery)
- [16. Privacy, abuse, interoperability and security](#privacy-abuse-interoperability-and-security)

</details>
<!-- reading-guide:end -->

<a id="what-it-is-for"></a>

## 1. What it is for

A fixed channel records communication between two DIDs. Verified links connect
channels when one endpoint rotates. Each message stays in its actual channel.
[Channels](channels.md#model) owns that model.

Public/rendezvous and pairwise describe disclosure and allocation policy, not
different message schemas or receipt permissions. A shared DID can participate
in several channels; a local continuity decision does not change all of them.
Useful content may be the first message. Trust Ping is the no-content default.
Contacts organize channel histories without protocol authority.

<a id="dependencies"></a>

## 2. Dependencies

A conforming implementation uses:

- DIDComm Messaging 2.1;
- Out-of-Band 2.0 (`https://didcomm.org/out-of-band/2.0`);
- Trust Ping 2.0 (`https://didcomm.org/trust-ping/2.0`);
- Empty Message 1.0 (`https://didcomm.org/empty/1.0`);
- Report Problem 2.0 (`https://didcomm.org/report-problem/2.0`) when a
  remote Report Problem response is received;
- Routing 2.0 (`https://didcomm.org/routing/2.0`);
- Peer DID Method numalgo 4;
- RFC 8785 JSON Canonicalization Scheme;
- `distributed-delivery/1.0`; and
- [vault-events.md](vault-events.md).

Phase 1 uses the mediator's replica-mediation protocol when a mediator is
used: one account per arrangement, each runtime a replica picking up under its
own DID.

Every instruction to append an event in this document means
`Vault.commit(objects, drafts)`, with an empty object list when none are new;
`Vault.events` exposes reads only.

<a id="terms"></a>

## 3. Terms

- **Communication address** — a supported canonical DID with retained keys
  and routing evidence; local DIDs are seed-derived numalgo-4 entities.
- **Channel** — a fixed ordered pair of distinct canonical local and peer DIDs.
- **Continuity link** — a fold-derived, verified replacement of one endpoint in one channel context.
- **Contact** — local names, preferences and direct channel selections for display.
- **Application input** — authenticated input other than control input,
  Empty, Trust Ping ping-response or Report Problem for privacy-trigger purposes.
- **Rotation notification** — a dedicated Empty intent disclosing a selected local rotation.
- **Rotation confirmation** — complete authenticated input proving knowledge of
  the exact successor in its validated channel context; it is not a peer ACK.

<a id="invariants"></a>

## 4. Invariants

Address policy follows [channel identity](channels.md#channel-identity),
[continuity](channels.md#continuity), [operation eligibility](channels.md#operation-eligibility)
and [dispatch authority](channels.md#fixed-outbound-channel). Allocation,
disclosure and contact preferences do not alter those rules. Peers address DIDs;
phase 1 has one active executor.

<a id="10-symmetric-relationship-identity"></a>
<a id="symmetric-relationship-identity"></a>

## 5. Channel pairs and contact identifiers

Channels use [canonical local/peer DID pairs](channels.md#channel-identity);
contacts directly select those pairs.

<a id="101-contact-ids"></a>
<a id="contact-ids"></a>

### 5.1 Contact IDs

Contacts use UUIDv7 and are created or assigned only by explicit product policy.
Creation records a non-empty set of complete channel pairs under
[vault events](vault-events.md#contact-created), possibly before receipt or peer
resolution. A discovered peer DID therefore needs a local-DID choice first.

<a id="102-binding-and-contact-policy"></a>
<a id="binding-and-contact-policy"></a>

### 5.2 Operation and display policy

Opposite first sends can select the same channel without role arbitration.
Each operation retains its own verification evidence. Contact selections affect
display and send choices under [the contact view](../../packages/vault/src/fold/views.ts),
not protocol authority. Deletion that also blocks communication must append
concrete channel denials separately.

<a id="out-of-band-discovery"></a>

## 6. Out-of-band discovery

OOB, QR, directory, file, NFC or manual exchange discloses an ordinary address.
Reusable discovery SHOULD use a public-contact address. Record the disclosed
content as an OOB invitation or direct DID under [did.disclosed](vault-events.md#did-disclosed),
independently of its publication medium. An OOB ID supplies `pthid`, never
channel identity. An invitation is reusable: whoever holds it writes in a
channel of their own, and no receipt takes it from the next under
[channels.md](channels.md#invitations). Availability follows
[the invitation fold](../../packages/vault/src/fold/invitations.ts).

<a id="address-lifecycle"></a>

## 7. Address lifecycle

`did.created`, `did.disclosed` and `did.retired` retain their local key
semantics. Retirement blocks new sending and disclosure. Exact
retained keys may receive while their arrangements remain eligible. Explicit
mediation retirement stops transport; temporary outage remains recoverable.

Rotation is a channel link, not global address retirement. Keep old and new
recipient DIDs through exact-successor confirmation. Existing messages keep
their fixed channels. A verified endpoint replacement prohibits new sends,
preparation, first dispatch and manual retries on that old endpoint within its
rotation context under [channels.md](channels.md#fixed-outbound-channel).
Key or mediation retirement independently prevents sending. Old-peer inputs remain
receivable, but cannot gain new admission or start source-derived work after
supersession becomes known, even if sent or received earlier. Retain prior
admitted history and committed operations without granting another dispatch.

<a id="ordinary-sending-and-birth-selection"></a>

## 8. Ordinary sending and channel selection

Before intent commit, select one exact eligible channel explicitly or through
[the contact's send choices](../../packages/vault/src/fold/views.ts). Defaults follow the
unique verified head under [channel selection](channels.md#fixed-outbound-channel);
an explicit address choice can start a new channel without a handshake.
Existing intents keep their channels.

<a id="ordinary-sending-requirements"></a>

### 8.1 Common requirements

All messages follow DIDComm authentication, exact recipient-method checks and
[ordinary content/header rules](distributed-delivery.md). The [receipt gate](#hard-pre-vault-gate)
applies equally to first and later messages; ACK and Ping-response preferences
do not prevent receipt.

<a id="default-trust-ping"></a>

### 8.2 Default Trust Ping

When no application content is ready, send an ordinary Trust Ping:

```json
{
  "type": "https://didcomm.org/trust-ping/2.0/ping",
  "id": "019b4d12-090a-7c3b-92f7-ac2c51f50db4",
  "from": "did:peer:4zQm...bob-long:z...input",
  "to": ["did:peer:4zQm...alice-short"],
  "body": { "response_requested": true }
}
```

A false `response_requested` prohibits `ping-response`. It does not prohibit
a separate address-change notification under section 11, whose purpose is
disclosing a locally selected rotation. Receipt alone does not request an ACK.

<a id="content-first-communication"></a>

### 8.3 Content-first communication

Any supported application protocol may be the first message, including Basic
Message, with its normal body, thread and attachment semantics. No rendezvous
wrapper, extra wire contact field or preliminary handshake is required.
Content remains application content regardless of whether a rotation is carried.

<a id="select-addresses-and-commit-intent"></a>

### 8.4 Select addresses and commit intent

1. Select a live local DID and canonical peer DID, validating supplied Peer long forms.
2. Derive their fixed channel and direction, then check local send policy.
   Each preparation resolves its own peer evidence.
3. Commit content and `message.out` with this channel, sender and recipient.
   This offline action does no DNS, mediator or socket work.

<a id="prepare-and-send"></a>

### 8.5 Prepare and send

Follow [the send procedure](distributed-delivery.md#send-an-ordinary-message)
and [package preparation](distributed-delivery.md#preparing-a-package) within
the committed channel, under [dispatch authority](channels.md#fixed-outbound-channel).

<a id="uniform-receipt"></a>

## 9. Uniform receipt

<a id="deferred-delivery"></a>

### 9.1 Deferred delivery

Pre-receipt waits concern only the ability to identify the exact local
key-agreement method, recover local key/document/arrangement state, safely open the
envelope, authenticate the current sender, or commit durable channel evidence.
Locked/incomplete recovery is not evidence that a recipient is foreign.
Current-sender authentication uses locally available validated numalgo-4
material under section 10.1; it does not start a network resolution sequence.

The [phase-1 adapter](channels.md#carried-proof-and-library-boundary) authenticates
the current sender without verifying `from_prior`. Missing predecessor material,
failed proof verification or continuity history cannot
defer receipt or pickup ACK. Failed envelope authentication supplies no
authenticated observation: a recoverable prerequisite waits here, while a
definitive rejection follows section 9.2's terminal pickup-ACK path.

After durable `message.in`, each consumer waits only for its required evidence.
These upper-layer waits do not withhold pickup ACK. Recovery uses saved sender
evidence without restarting resolution.

Wait state for missing local receive prerequisites is runtime scheduling state.
Retry when its actual local receive prerequisite changes; unrelated evidence
does not retry it. Redelivery while that wait is retained does not restart
authentication. Loss of that local state re-enters ordinary authentication
against the required local material. Such waits have no client age cap;
network retry budgets do not apply to them. Mediator expiry
may remove that delivery but cannot erase portable channel or continuity
evidence already committed.

<a id="hard-pre-vault-gate"></a>

### 9.2 Hard pre-vault gate

Recipient classification begins before decryption once section 9.1 says local
key state is authoritative. An exact local key-agreement method is eligible
for receipt when its DID/key mapping is valid and conflict-free and, for a
mediated DID, one usable arrangement names its routing DID. DID retirement does not remove a retained
exact key from channel receipt eligibility; invitation state or display membership is not read. Missing
recoverable prerequisites defer under section 9.1. If no recipient `kid`
identifies an eligible or recoverably pending method, the delivery is terminal
wrong-recipient input: a mediated delivery MUST be pickup-ACKed and MUST create
no `message.in`, contact or response effect.

Input to an eligible retired local key MUST pass through ordinary
decryption, authentication and durable receipt. It does not wait for a
`recipient-add`: the DID stays in the desired recipient set under
[the DID fold](../../packages/vault/src/fold/dids.ts), and an addition the
mediator has not confirmed to this runtime is asked for on connection as any is. Channel denials and
the availability of a usable local sender under [distributed-delivery.md section 8.1](distributed-delivery.md#the-ack-target) still govern subsequent work. Its mediation stays in the required
receiving set under [the same fold](../../packages/vault/src/fold/dids.ts) while the
arrangement that routes it is usable.
Explicit channel blocking remains independent of contact display deletion under
[contact deletion](../../packages/vault/src/procedures.ts).

For an exact local recipient that can be decrypted, the receiver then checks
only conditions needed to classify the input safely before writing portable
application state:

- recipient eligibility above, exact key-agreement method and a document naming one route;
- valid DIDComm syntax and authenticated encryption;
- a supported authenticated sender DID under [section 10.1](#did-resolution-requirements), with matching
  `from`/`skid`/`apu` and valid first-disclosure long form for numalgo 4;
- distinct canonical sender and recipient DIDs for an authenticated channel;
- per-source and per-recipient abuse rate limits; and
- emergency raw-ingress/storage exhaustion limits.

Sender authority comes from authenticated encryption. A separate inner signature
does not establish phase-1 channel authority or replace this authentication.

An implementation MUST NOT use this gate for a local preference about message
type, initial-specific size/lifetime limits, message age or expiry,
contact or recipient capacity, absence of current-message `please_ack`,
or Trust Ping `response_requested == false`. Ordinary parser/transport limits
and concrete resource exhaustion still apply, without a separate bootstrap
floor or ceiling.

A safely classified hard rejection received through Message Pickup:

- MUST be pickup-ACKed;
- MUST NOT append `message.in`;
- MUST NOT create a contact or response effect; and
- MAY leave only a bounded local diagnostic, subject to the requirements below.

Direct transport has no pickup ACK. Malformed envelope crypto, wrong recipient,
an unsupported sender method, an unknown sender short form without its long
form and hard abuse/resource limits are examples of this gate. Supersession and channel
policy are checked after receipt when starting new work.
A malformed or invalid string-valued `from_prior` is post-receipt proof evidence,
not malformed envelope crypto. It cannot change the authenticated sender used
for ingress limits or supply predecessor authority.

For an unknown current-sender short form, the receiver MUST expose a bounded
visible local diagnostic stating that sender material is unavailable and the
delivery was discarded. For terminal wrong-recipient input with no known local
recipient key mapping, it MUST likewise expose a bounded visible local
diagnostic stating that local recipient material is unavailable and the
delivery was discarded. These diagnostics MUST NOT present a claimed sender
as authenticated, assign the failure to a contact or assert that missing
history caused the failure. They neither send a response nor append application
state. Snapshot restore can cause these conditions under
[the restore rules](vault-events.md#restore).

<a id="integrity-checks-and-durable-receipt"></a>

### 9.3 Integrity checks and durable receipt

Commit the authenticated observation before source-derived work. Validate each
consumer under [operation eligibility](channels.md#operation-eligibility),
including durable application admission, carried proof and current policy
where required. Raw observation alone cannot update chat/profile/ACK state. Later rotation or
blocking preserves earlier facts; duplicates follow
[the duplicate receipt rules](distributed-delivery.md#duplicate-receipt-handling).

<a id="5-did-profiles-and-resolution-evidence"></a>

<a id="did-profiles-and-resolution-evidence"></a>

## 10. DID profiles and resolution evidence

<a id="51-common-requirements"></a>

<a id="did-resolution-requirements"></a>

### 10.1 Common requirements

<a id="local-methods-and-pinned-peer-documents"></a>

#### Local methods and retained peer documents

A locally controlled communication DID MUST have its fixed key-agreement and
authentication methods, seed-derived keys and validated numalgo-4 document
naming one DIDComm service under [vault-events.md section 5.2](vault-events.md#did-identity-and-keys). That document must
support authenticated messages and signing `from_prior`. Recipient lifecycle
is role-independent under section 9; sending requires a live DID.

Before the first channel package is submitted, its sender MUST durably retain:

- the exact presented peer DID;
- the canonical peer DID;
- the exact RFC 8785 canonical resolved DID document under its raw DASL CID;
- the document's authorized authentication and key-agreement method lists;
- the selected peer key under `peer.resolved.peerPublicKey`; and
- the resolution event CID.

These are immutable operation snapshots, not a permanent channel key set.
The exact envelope identifies the selected recipient `kid`; it must name an
authorized key-agreement method for that selected key in the retained document.
Merely preparing an encrypted
package selects no peer authentication method for a future rotation proof.
Each receipt or package references the exact immutable document it used. Recovery
of a saved operation may retrieve missing bytes only when their canonical raw
CID matches its referenced document CID. Another document cannot substitute
for those bytes. A carried proof instead derives its issuer document locally
under [predecessor resolution](#predecessor-resolution).

<a id="resolver-security-and-supported-senders"></a>

#### Supported channel endpoints

Both local and remote application channel endpoints MUST use `did:peer:4`.
This includes the predecessor and successor of every continuity link. Public
disclosure does not require a different method or force a pairwise address.
An unsupported current sender fails the receive gate; an unsupported recipient
cannot form a phase-1 outbound intent. An unsupported proof issuer makes that
proof invalid for phase-1 continuity without invalidating an otherwise
authenticated carrier or starting a network lookup.

<a id="recipient-resolution-freshness"></a>

#### Recipient resolution

Resolve the recipient locally from its validated long form or a retained
long form matching its canonical short form. Before preparation, commit or
reuse exact `peer.resolved` evidence matching the selected peer key, presented
DID and local key context. A missing long form leaves preparation pending;
it is not evidence of a key change and starts no network lookup. Each new
package retains its own exact evidence reference. Initial dispatch and manual
retry use the committed package unchanged.

<a id="sender-authentication-freshness"></a>

#### Sender authentication

Every new network delivery, including a duplicate, authenticates its sender
against the validated immutable numalgo-4 document, supplied with the long-form
disclosure or retained locally. Commit or reuse matching exact evidence before
`message.in`. An unknown sender short form without its long form cannot
authenticate and follows the terminal receive gate. This differs from a known
local key/document dependency temporarily unavailable during recovery, which
waits under section 9.1. Recovery of an already committed observation uses its
saved authentication evidence without authenticating a new delivery.

<a id="mediator-resolution"></a>

#### Mediator and routing DID resolution

The channel method restriction does not apply to mediator or routing-service
DIDs. A mediator may use `did:web`; resolving it creates no local communication
DID and does not make it an eligible application channel peer. Resolve and
authenticate mediation/control traffic and routing keys under their transport
protocols independently of application channel evidence.

A Web resolver used by a client or mediator MUST be constrained against SSRF,
DNS rebinding, redirects to forbidden networks, unbounded responses and DID
mismatch, with bounded call timeouts. A policy-forbidden fetch is a definitive
failure and MUST NOT fall back to an unrestricted fetch. Preserve the exact
presented Web DID string; its returned document `id` MUST match byte-for-byte.
URL/DNS processing does not authorize case folding, percent-decoding, IDNA
mapping or trailing-dot normalization of DID identity. Use the document's
authorized key IDs rather than local key-name conventions. A mediator lookup
failure grants no application dispatch authority and does not prove that a
channel peer's immutable key changed. Live prerequisite retries follow section 14.

<a id="evidence-change-retries"></a>

#### Evidence-change retries

For an unopened delivery waiting on local receive prerequisites, retry only
when its missing local material changes and then reapply sender authentication.
For a committed observation, newly available exact evidence schedules continuity
verification, admission reconciliation and operation recovery without another
receipt or pickup. Neither kind of evidence recovery grants a new automatic
dispatch action.

<a id="duplicate-authentication-and-historical-recovery"></a>

#### Duplicate authentication and historical recovery

A new delivery authenticates independently before adding an observation.
Recovery of a saved observation verifies its retained references; it never
replaces them with another receipt or document. The fold verifies any original
JWT from the saved carrier and retained immutable issuer material without
replaying the receive operation.

<a id="predecessor-resolution"></a>

#### Predecessor resolution for DID replacement

After durable receipt and without delaying pickup ACK, verify the carrier's
original JWT through [the continuity adapter](channels.md#continuity-integration).
Use the shared package's proof profile and canonical DID binding, including
equivalent issuer/`kid` DID spellings and subject/sender spellings. Preserve
document-independent rejection separately from missing material:
`precheckFromPrior(token, { authenticatedSender })` refuses malformed
claims, unsupported profile headers and time claims, non-canonical or
mismatched DIDs and a `sub` that is not the authenticated sender, all
without an issuer document. Keep that precheck in the package, without a
second parser in the runtime. Decoding supplies no signature or channel
authority.

Resolve a long-form issuer locally from its validated encoded document using
[the fixed document representation](vault-events.md#peer-resolved). For a
short-form issuer, use a retained method-valid `peer.resolved` document whose
validated long form derives that short form. This immutable material may be
used across contexts, but each carrier independently authenticates its current
sender and verifies its own JWT. Do not rewrite signed bytes to change DID spellings.

If the issuer is a valid short form and no matching retained `peer.resolved`
document is available, keep the original carrier and show `pending-proof`.
Do not poll the network, expire the proof into invalidity, or keep the original
receive action waiting for that material. A later matching `peer.resolved`
schedules verification and admission reconciliation under
[channels.md](channels.md#application-admission); it grants no automatic ACK,
reply or notification for that historical carrier. If the material never
arrives, that carrier remains a pending diagnostic without application admission.
A new independently authenticated live carrier is evaluated separately.

`verifyFromPrior` checks the original signature against the authentication
method in the issuer's own long-form DID, and `bindFromPrior` checks the exact
carrier. The vault appends no verification event.
A bad signature or unauthorized key is invalid. Missing source/endpoint/history
references remain pending for their own reason. Invalid or pending proof never
undoes durable receipt or pickup ACK.

Import and recovery recompute the result from the carrier's retained JWT and
the same immutable material under [proof evidence](channels.md#peer-proof-evidence).
Missing referenced object bytes may be repaired only with matching canonical
bytes. Verification may use a disposable cache under
[local projections](vault-sqlite.md#local-state-and-projections); that cache grants no
authority absent its retained inputs and supplies no recovery dispatch action.

<a id="52-peer-did-numalgo-4-profile"></a>

<a id="peer-did-numalgo-4-profile"></a>

### 10.2 Peer DID numalgo-4 profile

Every local and remote phase-1 channel address is a Peer DID numalgo 4.
Both validated long and canonical short forms name one entity. Canonicalization
validates the long form and uses its derived short form. The retained document
follows [vault-events.md section 4.4](vault-events.md#peer-resolved)'s fixed
long-form representation, including when the presented DID is short. The
encoded document is immutable; changing its keys or bound service produces
another DID. Public and private disclosure use this same method.

First disclosure of any local address uses its long form, whether in OOB or
plaintext `from`. Within each exact channel context, a sender MUST use its long
form until an admitted complete authenticated observation confirms knowledge of
that exact address under [channels.md](channels.md#continuity). A successor also includes
its frozen proof until confirmed. Confirmation in an unrelated channel does not
satisfy either condition merely because the address is shared. Later new
messages in the confirmed context may use the short form;
they do not rewrite the retained predecessor spelling. Application `to`,
Routing `forward.next` and mediator registration use the canonical short form
once the peer document is known. Registration is verified before disclosure.

For authcrypt, plaintext `from` and the DID portion of protected `skid` are
byte-identical; decoded `apu` is the exact UTF-8 `skid` string. If the library
represents the sender only through `apu`, its DID portion still equals `from`.
The fragment identifies an authorized key-agreement method in that exact
document. Do not mix long and short forms in one package. A current-sender
short form with no known long-form document fails authentication and cannot
authorize new work.

A local producer MUST use the predecessor's exact first-disclosure long form
for `from_prior.iss` and its protected authentication `kid`; `sub` uses the
successor's long form. A receiver also accepts short-form issuer spelling when
a retained method-valid `peer.resolved` document matches it under section 10.1.
A long form retained only in other event data does not qualify. Without the
matching document, a proof that passes the checks not requiring it stays pending.
A receiver compares predecessor DID spellings and authentication-method IDs
under [vault-events.md section 6.3](vault-events.md#relationship-peertransitioned), using only the method's validated spelling
equivalence and the exact verification document. Exact wire spellings remain retained.
A successor may send through another arrangement or endpoint for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

<a id="early-private-address-policy-and-notifications"></a>

## 11. Early private-address policy and notifications

Public and private addresses use the same channel model. On eligible live
application input, local policy may prefer a fresh private local successor only
when a valid `did.disclosed` names the selected local DID. Use of a DID in
multiple channels, including channels created by a peer's rotation, does not
trigger this policy. Without such a disclosure, separating a reused address
requires manual rotation.
It records `did.rotationSelected` with the fixed `fromDidId`/`peerDid`, a UUIDv7
successor, exact source observation and frozen proof. Reuse an existing
decision from that local predecessor anywhere in its verified peer-only
rotation context under [channels.md](channels.md#did-rotationselected). A newly
verified peer replacement does not authorize another successor or notification;
reuse the original decision, frozen proof and notification selection. Group
membership is not a reason to rotate an unrelated channel.

Create or reuse the dedicated notification under
[the built-in operation rules](distributed-delivery.md#built-in-independent-operations),
preserving the decision's source, successor and proof. Existing replies neither
move to the successor nor suppress the notification; historical work requires
manual completion subject to current source eligibility. A superseded source
peer prevents creation of a missing notification intent. A replaced sender or
peer recipient also prohibits preparation and manual dispatch of an already
committed intent; retaining its history is not permission to send.

<a id="automatic-response-selection"></a>

### 11.1 Independent automatic intents

Eligible live input may independently produce an ACK, Ping response and rotation
notification under [delivery](distributed-delivery.md#built-in-independent-operations).
Optional private allocation or notification failure does not block an otherwise
eligible reply or ACK. Empty, ping-response and Report Problem never trigger
another privacy notification.

<a id="proof-and-ordinary-message-headers"></a>

### 11.2 Proof and ordinary message headers

A newly prepared successor-channel message carries the frozen proof and long
form until exact-successor confirmation. Its `from` equals `from_prior.sub` in
the validated wire spelling. The predecessor authentication method signs the
JWT with fixed rotation `iat`; a message timestamp cannot regenerate it.
A committed package remains byte-identical after confirmation.

<a id="registration-and-submission"></a>

### 11.3 Registration and submission

Verify the new recipient registration before disclosure, then follow
[the send procedure](distributed-delivery.md#send-an-ordinary-message).

<a id="confirmation-and-overlap"></a>

### 11.4 Confirmation and overlap

Use the exact-address, authenticated-peer and local-only/join context checks in
[channels.md](channels.md#continuity). Input at a predecessor confirms no
successor. An ACK's named message IDs alone confirm no address knowledge.
Its admitted complete authenticated carrier, including a pure ACK, can independently
confirm the exact successor address to which it was sent.
Retain both recipient DIDs through confirmation; retire a shared resource
only when no other channel or disclosure still needs it.

<a id="peer-address-changes"></a>

## 12. Peer address changes

Retain an independently authenticated successor receipt even when predecessor
evidence is missing. Derive its issuer document under
[predecessor resolution](#predecessor-resolution), then derive links, joins and
supersession under [continuity](channels.md#continuity). Show the resulting
[verification status](channels.md#verification-status). Superseded peer input
remains receivable but cannot acquire new application admission or start new
application work. Preserve previously admitted history and expose unadmitted
old-peer observations as ignored diagnostics under
[application admission](channels.md#application-admission). Ordinary chat,
profile, received ACK/error state and address confirmation require that
admission. Explicit old-address sending and retry are prohibited in the
affected context, without globally disabling a shared DID or deleting its keys.

<a id="remote-errors-and-integrity-failures"></a>

## 13. Remote errors and integrity failures

A Report Problem is a display diagnostic beside a uniquely correlated outbound
only when its carrier is an admitted complete source witness in the same channel
or a verified role-preserving successor channel, with the required protocol thread
correlation. Keep its body available for display. It does not prove submission
failure, retract a link or authorize replay. Its admitted complete carrier may
separately prove exact-address knowledge.

Missing source/verification evidence defers attribution; inconsistent evidence exposes
conflict. Do not assign an error to a contact by wire ID or name alone.

<a id="retry-replacement-and-address-rollover"></a>

## 14. Retry and manual resend

An initial live action may retry prerequisite resolution/registration before
its first transport call, subject to expiry and these recommended bounds:

```text
minimum prerequisite retry interval = 30 seconds
exponential backoff cap = 21600 seconds
network prerequisite attempt budget per active sequence = 32
```

These network bounds apply to mediation and transport prerequisites, not
phase-1 channel DID or predecessor-proof resolution, which is local. Pickup and
recipient addition may retry normally;
they are not replay of a user message.

Message retries and new sends follow [dispatch authority](channels.md#fixed-outbound-channel):
a manual retry preserves the committed package; selecting a successor channel
requires a new message ID. Neither missing history nor a new send proves that
the original was undelivered. Business idempotency requires a protocol-defined
authenticated operation identity.

<a id="execution-and-recovery"></a>

## 15. Execution and recovery

Phase 1 permits one active executor. Import/restore reconstructs state but
grants no dispatch action for historical intents or automatic responses.

<a id="privacy-abuse-interoperability-and-security"></a>

## 16. Privacy, abuse, interoperability and security

Public/pairwise labels are disclosure policy. Peers receive ordinary DIDComm
messages and no contact or replica ID. Shared addresses can
correlate traffic; fresh pairwise addresses reduce that reuse.

Continuity applies to exact channel contexts and role-preserving paths. It
cannot transfer authority through display membership. Channel receipt never
implies application permission. Resource/parser limits remain in force.
Cross-channel reuse of a peer's wire ID is not deduplicated by this profile;
channel-local processing does not promise exactly-once business execution.
An unconfirmed local successor with a terminal mediation cannot silently branch or
roll back; explicit new communication is a new channel and new message.
