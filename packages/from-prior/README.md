# @estoc/from-prior

The DIDComm v2 `from_prior` proof under a did:peer:4 + Ed25519 profile:
inspecting, prechecking, verifying and creating a proof, and binding a
verified one to the receipt it arrived on. The package knows nothing of
continuity or of any other model a host keeps. A binding answers in the
proof's own terms, a `BoundChange` that says who wrote to whom and from
which DID, and the host projects it into its own model.

The types and JSDoc define the API. This file adds what the API cannot
express: the profile and the host contract, which are binding on an
integrator too. The tests in the repository are the worked examples:
[`from-prior.test.ts`](https://github.com/estoc-dev/estoc/blob/main/packages/from-prior/test/from-prior.test.ts)
for inspecting, prechecking, verifying, binding and creating proofs with
a host-held key. The repository's [illustrated guide](docs/guide.md)
walks through the processing stages and the input boundaries the tests
exercise.

## Usage

```ts
import { bindFromPrior, createFromPrior, verifyFromPrior } from "@estoc/from-prior";

const proof = await verifyFromPrior(jwt, issuerLongForm);
const binding = bindFromPrior(proof, { token: jwt, recipient, sender });
if (binding.status === "bound") {
  const { change } = binding;
  if (change.kind === "rotate") peerRotated({ local: change.recipient, from: change.issuer, to: change.successor });
  else peerEnded({ local: change.recipient, peer: change.issuer });
}

const created = await createFromPrior({ issuer, change: { kind: "rotate", successor }, iat, issuerLongForm }, signer);
```

`peerRotated` and `peerEnded` stand for the host's projection. The Estoc
vault, for one, projects a bound rotation into a continuity
`peer-observation` at the pair of the recipient and the successor, whose
`rotatedFrom` is the issuer.

| Question | This package | The host |
| --- | --- | --- |
| Is this a valid rotation or ending proof? | Parses the JWT, checks the profile, takes the key from the issuer's own document, verifies the signature | Retains the issuer's long-form DID and the original token |
| What does this receipt establish? | Binds the verified proof to the recipient and sender the host established, and reports the change | Decrypts and authenticates the envelope, projects the change into its own model |

## Profile

The supported profile, `FROM_PRIOR_PROFILE`, is did:peer:4 issuers,
subjects and audiences, `EdDSA` over Ed25519 authentication keys, an
integer `iat` and no `exp` or `nbf`: the profile evaluates no validity
window, and verification consults no clock. Creation writes
`typ: JWT`; reception takes `typ` as the optional media type it is,
accepting its absence or `JWT` and `application/jwt` in any case. Each
of the token's three segments is base64url without padding or
whitespace, as RFC 7515 writes a compact JWS. A `b64` header, when
present, is `true` and listed in `crit`, as RFC 7797 requires of a JWT.
DID equivalence is the did:peer:4 short form; presented spellings are
kept beside it. The issuer's material is its long-form DID as the host
retained it: a did:peer:4 is its own document, so the signing key is
taken from the content the DID's hash covers and a document assembled
by a caller cannot substitute one. An authorized key is an Ed25519
Multikey or public JWK. A `publicKeyJwk` carries no private member, its
`x` is the 32-byte key in base64url without padding or whitespace, as
RFC 8037 writes it, and the `use`, `key_ops` and `alg` it may carry
allow verifying `EdDSA`. The package resolves nothing over the network.
`InvalidFromPrior.failure` tells form, profile, binding, document and
signature failures apart.

## Stages

`inspectFromPrior` decodes a token without verifying it, so the host can
find the issuer's material. `precheckFromPrior` applies every rule of
the profile that needs no issuer document, and, given the receipt's
authenticated sender, refuses a rotation whose successor is not that
sender: a token it refuses cannot verify or bind, so the host records
the refusal instead of waiting for material, while a token it passes is
still unverified. Decoding success is not profile validation, and the
precheck grants no verified type. `verifyFromPrior` applies the same
document-independent rules and establishes the issuer's declaration.
`bindFromPrior` checks the declaration against the receipt and reports
the change it binds, in short-form DIDs: a rotation requires the
receipt's own token and an authenticated sender equal to `sub`, and
reports that the successor wrote to the recipient, having rotated from
the issuer `iss`. An ending reports that the issuer ended what it had
with the recipient. A wrong token, sender or recipient is a `mismatch`.

## Endings

A received ending has no sender, and the standard's basic form binds it
to no particular relationship: a valid token could be replayed in a new
anonymous envelope to another recipient, and decryption alone does not
bind the declaration to that second relationship. This profile binds an
ending only when its JWT names the recipient in `aud` and the receipt is
anonymous, which the host asserts by a null sender only when the
plaintext carried no `from`. An ending in the basic form verifies but
reports `unbound`, so endings from agents that do not add `aud` are
retained without binding. The signed audience is this profile's
extension, not a DIDComm requirement.

## Creation

`createFromPrior` builds the token from a request and a signing
capability that names its method and signs the JWS signing input, so a
key behind a hardware wallet can sign, then verifies the result against
the issuer's long form before returning it. Creating a proof saves and
sends nothing.

## Host contract

- **Evidence.** Retain each token exactly as its receipt carried it and
  the issuer's long-form DID: verification takes the key from the
  content of that long form, and binding compares the exact token. The
  receipt's recipient and sender are what the host established by
  decrypting and authenticating the envelope; a null sender asserts an
  anonymous envelope whose plaintext carried no `from`.
- **Projection.** A bound change is a statement about one receipt. What
  it means for a relationship, and whether a host applies an ending at
  all, is the host's projection.
- **Profile.** `FROM_PRIOR_PROFILE` covers accepting and binding a proof.
  A change to what it means is a new profile string rather than the same
  string with new behavior; a host that keeps verified proofs, or what it
  projected from bound changes, verifies and binds them again when the
  string changes.

## Limits

- Endings bind only through this profile's signed audience; a basic
  ending is verified and retained `unbound`.
- The profile refuses `exp` and `nbf`. Supporting them needs an
  explicit evaluation time and a rule for evidence accepted earlier.

## References

- [DIDComm v2.1 DID Rotation](https://identity.foundation/didcomm-messaging/spec/v2.1/#did-rotation) and [Ending a Relationship](https://identity.foundation/didcomm-messaging/spec/v2.1/#ending-a-relationship): the wire proof.
- [Peer DID method 4](https://identity.foundation/peer-did-method-spec/#method-4-short-form-and-long-form): short and long forms.
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515.html#section-2), [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519.html) and [RFC 7797](https://www.rfc-editor.org/rfc/rfc7797.html#section-1): the compact JWS, the JWT and its encoded payload.
- [RFC 7517](https://www.rfc-editor.org/rfc/rfc7517.html#section-4.2) and [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037.html#section-2): the `use`, `key_ops` and `alg` of a JWK, and the `x` of an Ed25519 one.
