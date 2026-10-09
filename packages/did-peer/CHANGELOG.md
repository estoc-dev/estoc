# Changelog

## Unreleased

- **Reading what a DID document authorizes**: `authorizedMethodIds`,
  `definedMethod` and `serviceIds` read the verification relationships
  and services of any DID document, with `splitDidUrl`, `isDid`,
  `isDidUrl`, `VERIFICATION_RELATIONSHIPS` and `VerificationRelationship`
  beside them; they throw `DIDDocumentError`. Fragment and query
  references resolve against the document's `id`; a reference into the
  document names a method it defines; two different methods, or two
  services, under one ID are refused. `@estoc/from-prior` verifies with
  them and `@estoc/vault` signs and retains with them, so both name the
  same method for a key. The new `canonicalize` dependency compares two
  definitions under one ID.

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
