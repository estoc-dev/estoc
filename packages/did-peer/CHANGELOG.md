# Changelog

## Unreleased

- **Reading what a DID document authorizes**: `authorizedMethodIds`,
  `definedMethod` and `serviceIds` read the verification relationships
  and services of any DID document, with `splitDidUrl`, `isDid`,
  `isDidUrl`, `VERIFICATION_RELATIONSHIPS` and `VerificationRelationship`
  beside them; they throw `DIDDocumentError`. Fragment and query
  references resolve against the document's `id`; a reference into the
  document names a method it defines; two different methods, or two
  services, under one ID are refused. Two definitions of one method are
  compared as RFC 8785 text once their IDs are resolved, so a relative
  and an absolute spelling of one ID agree, and a value with no RFC 8785
  form defined twice is refused. `definedMethod` gives the entry with its
  ID resolved. A service ID is an absolute URI as it stands, or a
  fragment or query reference resolved against `id`; whether it is a
  well-formed URI is the application's to check. `@estoc/from-prior`
  verifies with them and `@estoc/vault` signs and retains with them, so
  both name the same method for a key. The new `canonicalize` dependency
  does the comparing.
- **Node 22 or later** (breaking): `canonicalize` needs
  `String.prototype.isWellFormed`, so the package declares `engines.node`
  `>=22`; a browser or worker runtime needs that method too. It was Node
  18.
- **`toDIDCommDIDDoc` reads a document as `authorizedMethodIds` and
  `definedMethod` do** (behaviour change): a method embedded in one
  relationship and referenced from another, such as an `assertionMethod`
  key that `authentication` names, is hoisted into `verificationMethod`,
  so didcomm-rust finds it. A document the reader refuses, with two
  different methods under one ID or a reference that names no method, is
  a `DIDDocConversionError`; it used to convert with one of the two
  methods, or the dangling reference, in it.
- **`toDIDCommDIDDoc` types `Other` a method didcomm-rust reads no key
  from** (behaviour change): a method keeps its suite only when
  didcomm-rust reads its key under that suite from the first of
  `publicKeyJwk`, `publicKeyMultibase` and `publicKeyBase58` it carries:
  a JWK under `JsonWebKey2020` on P-256, secp256k1, Ed25519 or X25519, a
  multibase key under the 2020 suite of its own curve, a base58 key
  under `X25519KeyAgreementKey2019` or `Ed25519VerificationKey2018`. A
  known suite over other material, such as `JsonWebKey2020` with a
  multibase key or a multibase key on another curve, used to keep its
  suite and fail whichever operation picked it.
  `EcdsaSecp256k1VerificationKey2019`, which didcomm-rust reads no key
  under, is `Other` too. A caller that passes over `Other` methods now
  passes over every method didcomm-rust cannot use.
- **`toDIDCommDIDDoc` passes a JWK on as the key it holds** (behaviour
  change): the `publicKeyJwk` of a `JsonWebKey2020` method keeps `kty`,
  `crv` and the members holding the key, `x` and on EC `y`, and nothing
  else. didcomm-rust imports the key through askar, whose JWK parser
  fails on a member it has no case for, such as `alg`, so a JWK naming
  its algorithm used to keep its suite and fail whichever operation
  picked it; the key imported is the one the JWK holds. A JWK without
  one of those members as a string is `Other`.

## 0.2.0 — 2026-09-29

- **A long form is decoded once** (behaviour change): `decodeLongForm`
  keeps the document of each of the 4096 long forms it saw last, by
  the spelling, and hands every caller of one spelling the same
  document, frozen all the way down. A caller that changed the
  document it was handed copies it first:
  `{ ...decodeLongForm(did), keyAgreement: [...] }`. `resolveLongForm`
  and `resolveShortForm` still build a document of the caller's own
  around it, whose nested members are the frozen ones. A spelling
  refused for its hash or its JSON is refused with the same error
  again. Base58 costs the square of the length decoded, and a vault
  reads the same long forms on every scan of its history.
- **`@estoc/did-peer/remembered`**: `remembered`, which keeps what a
  pure function of a string made of the inputs it saw last, and
  `frozen`, for the results it hands to every caller.
