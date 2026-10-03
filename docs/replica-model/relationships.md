# Estoc channel address and contact policy 1.0

<!-- suite-navigation:start -->
[Suite guide](README.md) · Phase 1 · [Read by task](#reading-guide)
<!-- suite-navigation:end -->

Status: **phase 1, implemented**. Ordinary DIDComm channels, discovery and the
DID profiles for one active writable vault runtime. Phase-1 channel endpoints
support only `did:peer:4`; mediator DID resolution is independent of that
restriction. The receive gate, durable receipt, the early private-address
policy, peer address changes and retry are code, named in
[channels.md section 7](channels.md#folds-and-procedures).

This document uses **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**
and **MAY** as described in BCP 14 when they appear in all capitals.

<!-- reading-guide:start -->
<a id="reading-guide"></a>

**Reading guide**

| Task | Read together |
| --- | --- |
| Understand channels and display | [Model](#what-it-is-for) → [Identifiers](#symmetric-relationship-identity) → [Peer DID profile](#peer-did-numalgo-4-profile) |
| Implement authentication and receipt | [Receive procedure](distributed-delivery.md#receive-a-message) → [Resolution rules](#did-resolution-requirements) → [Peer DID profile](#peer-did-numalgo-4-profile) → [Receive gate](../../packages/agent-core/src/receive/gate.ts) |
| Implement address policy | [Discovery](#out-of-band-discovery) → [Select a channel](#ordinary-sending-and-birth-selection) → [Private-address policy](../../packages/agent-core/src/privacy.ts) → [Retry](../../packages/agent-core/src/dispatcher.ts) |

<details>
<summary>Contents</summary>

- [1. What it is for](#what-it-is-for)
- [2. Dependencies](#dependencies)
- [3. Terms](#terms)
- [4. Invariants](#invariants)
- [5. Channel pairs and contact identifiers](#symmetric-relationship-identity)
- [6. Out-of-band discovery](#out-of-band-discovery)
- [7. Ordinary sending and channel selection](#ordinary-sending-and-birth-selection)
- [8. DID profiles and resolution evidence](#did-profiles-and-resolution-evidence)
- [9. Privacy, abuse, interoperability and security](#privacy-abuse-interoperability-and-security)

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

Address policy follows [channel identity](channels.md#channel-identity) and
[continuity](channels.md#continuity), and the operation eligibility, admission
and dispatch authority their code owns under
[channels.md section 7](channels.md#folds-and-procedures). Allocation,
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

<a id="ordinary-sending-and-birth-selection"></a>

## 7. Ordinary sending and channel selection

Before intent commit, select one exact eligible channel explicitly or through
[the contact's send choices](../../packages/vault/src/fold/views.ts), whose default is the
unique verified head; an explicit address choice can start a new channel
without a handshake.
Existing intents keep their channels.

<a id="ordinary-sending-requirements"></a>

### 7.1 Common requirements

All messages follow DIDComm authentication, exact recipient-method checks and
[ordinary content/header rules](distributed-delivery.md). The [receive gate](../../packages/agent-core/src/receive/gate.ts)
applies equally to first and later messages; ACK and Ping-response preferences
do not prevent receipt.

<a id="default-trust-ping"></a>

### 7.2 Default Trust Ping

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
a separate address-change notification under
[the private-address policy](../../packages/agent-core/src/privacy.ts), whose purpose is
disclosing a locally selected rotation. Receipt alone does not request an ACK.

<a id="content-first-communication"></a>

### 7.3 Content-first communication

Any supported application protocol may be the first message, including Basic
Message, with its normal body, thread and attachment semantics. No rendezvous
wrapper, extra wire contact field or preliminary handshake is required.
Content remains application content regardless of whether a rotation is carried.

<a id="5-did-profiles-and-resolution-evidence"></a>

<a id="did-profiles-and-resolution-evidence"></a>

## 8. DID profiles and resolution evidence

<a id="51-common-requirements"></a>

<a id="did-resolution-requirements"></a>

### 8.1 Common requirements

A locally controlled communication DID MUST have its fixed key-agreement and
authentication methods, seed-derived keys and validated numalgo-4 document
naming one DIDComm service under
[vault-events.md section 5.2](vault-events.md#did-identity-and-keys). That
document must support authenticated messages and signing `from_prior`. Sending
requires a live DID; which retained keys still receive is
[the receive gate](../../packages/agent-core/src/receive/gate.ts)'s to say. Each receipt or package
references the exact immutable peer document it used under
[`peer.resolved`](vault-events.md#peer-resolved); another document cannot
substitute for those bytes.

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
authenticate and is terminal under
[the receiver](../../packages/agent-core/src/receive/receiver.ts), which instead holds a delivery
waiting on a known local key, document or arrangement of this runtime's that
may still be recovered. Recovery of an already committed observation uses its
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
channel peer's immutable key changed. Live prerequisite retries follow
[the dispatcher](../../packages/agent-core/src/dispatcher.ts).

<a id="52-peer-did-numalgo-4-profile"></a>

<a id="peer-did-numalgo-4-profile"></a>

### 8.2 Peer DID numalgo-4 profile

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

A newly prepared successor-channel message carries the frozen proof and the
successor's long form until exact-successor confirmation. Its `from` equals
`from_prior.sub` in the validated wire spelling. The predecessor authentication
method signs the JWT with the rotation's fixed `iat`; a message timestamp
cannot regenerate it, and a committed package remains byte-identical after
confirmation.

A local producer MUST use the predecessor's exact first-disclosure long form
for `from_prior.iss` and its protected authentication `kid`; `sub` uses the
successor's long form. A receiver also accepts short-form issuer spelling when
a retained method-valid `peer.resolved` document matches it under section 8.1.
A long form retained only in other event data does not qualify. Without the
matching document, a proof that passes the checks not requiring it stays pending.
A receiver compares predecessor DID spellings and authentication-method IDs
under [vault-events.md section 6.3](vault-events.md#relationship-peertransitioned), using only the method's validated spelling
equivalence and the exact verification document. Exact wire spellings remain retained.
A successor may send through another arrangement or endpoint for privacy. Neither changing
transport preference nor choosing another service changes an existing DID.

<a id="privacy-abuse-interoperability-and-security"></a>

## 9. Privacy, abuse, interoperability and security

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

Phase 1 permits one active executor. Import and restore reconstruct state but
grant no dispatch action for historical intents or automatic responses.
