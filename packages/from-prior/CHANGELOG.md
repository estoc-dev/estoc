# Changelog

## Unreleased

DIDComm v2 `from_prior` proofs, split from `@estoc/continuity/from-prior`.

- **Its own package**: the module that was the `./from-prior` entry
  point of `@estoc/continuity` keeps its exports and the
  `estoc-from-prior/1` profile, and depends on no continuity model.
  `Did` is the package's own alias of `string`.
- **`bindFromPrior` reports the change it binds** (breaking): a bound
  `Binding` carries `change`, a `BoundChange` in short-form DIDs, either
  `rotate` with the recipient, the issuer and the successor, or `end`
  with the recipient and the issuer. It builds no continuity fact; the
  host projects the change into its own model.
- **The issuer's long form and the receipt** (breaking, since
  `@estoc/continuity` 0.1.0): `verifyFromPrior(jwt, issuerLongForm)` and
  `ProofRequest.issuerLongForm`; `IssuerEvidence` and
  `VerifiedFromPrior.document` are gone. `bindFromPrior(proof, receipt)`
  takes a `Receipt` of token, recipient and sender.
- **Segments and keys as their RFCs write them** (breaking, since
  `@estoc/continuity` 0.1.0): a header or payload segment with padding,
  whitespace or another character outside unpadded base64url is a
  `form` failure even under a valid signature, as the signature segment
  already was. A `publicKeyJwk` reaches the library whole, so one that
  carries the private key, or whose `use`, `key_ops` or `alg` does not
  allow verifying EdDSA, is a `document` failure at verification and at
  creation. So is one whose `x` is not the 32-byte key in base64url
  without padding or whitespace, in every runtime; such a key used to
  verify wherever the runtime's JWK import tolerated it.
- **The profile**: inspection, precheck, verification, binding and
  creation of `from_prior` under `estoc-from-prior/1`: did:peer:4
  parties, Ed25519, no validity window, no clock. The precheck applies
  the document-independent rules verification applies, and refuses a
  rotation whose successor is not the authenticated sender, before the
  host has issuer material; its result stays unverified. A signature
  segment that cannot be an Ed25519 signature and an authorized key that
  is not one are refused as `form` and `document` failures. The signing
  key comes from the issuer's own long form. Endings bind only through a
  signed audience on an anonymous receipt; the basic form verifies and
  stays unbound.

The package README is the reading entry.
