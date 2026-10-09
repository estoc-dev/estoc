# Changelog

## Unreleased

- **A fact is keyed by its evidence** (breaking): each fact names the
  record it rests on by `evidence`, and its kind and evidence together,
  a `FactKey`, are its identity. The host-allocated `id`, `FactId`,
  `receipt` and `decision` are gone. An observation's
  `carriedTransition` is `carried: boolean`, naming the transition
  under the same evidence, and a decision's `source` names a receipt,
  resolved to that receipt's observation. Every answer names facts by
  `FactKey`: support, waiting, missing, endings, conflict facts,
  `status(key)`, and the `key` of change records, ending records and
  confirmations.
- **The model accepts facts itself** (breaking): `FactSnapshot`,
  `mergeFacts`, `emptySnapshot`, `normalizeSnapshot`, `sameFacts`,
  `IncompatibleSnapshot` and `canonicalFact` are gone.
  `deriveContinuity` keeps an exact repeat once and refuses a second
  value under one key with `InvalidFact`, so there is no identity
  conflict, in `Conflict` or in `FactStatus`.
- **Contexts are named by the endpoint they keep** (breaking): `History`
  has `samePeer` and `sameLocal` in place of `localContext` and
  `peerContext`.
- **A conflict carries its scope**: every `Conflict` has `scope`, the
  channels it masks directly; a query that depends on them may answer
  `conflict` as well.
- **`bindFromPrior(proof, receipt)` takes no IDs** (breaking): a
  rotation always yields the transition and the observation of the
  receipt that carried it, an ending the transition alone.
- `LocalDecision` is a discriminated union whose ending has a null
  `source`; `Rotation`, `Ending`, `FactKind` and `FactKey` are
  exported. `validateFact` reads only a value's own members.
  `PROFILE_VERSION` is `estoc-continuity/2`.

## 0.1.0 — 2026-09-29

The continuity domain: a pure model of oriented DID pairs under rotation
and ending, and a `from-prior` module for DIDComm v2 proofs.

- `@estoc/continuity`: three fact kinds with exact evidence references,
  RFC 8785 equality, a union merge of snapshots that retains every
  variant of a repeated ID, and deterministic queries for head, changes,
  path, confirmation, history, local decisions, conflicts and fact
  status. Conflicts are reported with their scope and never resolved;
  independent unambiguous support keeps a change usable beside a
  collided claim of it; authority stops at usable links.
- `@estoc/continuity/from-prior`: inspection, precheck, verification,
  binding and creation of `from_prior` under the `estoc-from-prior/1`
  profile: did:peer:4 parties, Ed25519, no validity window, no clock.
  The precheck applies the document-independent rules verification
  applies, and refuses a rotation whose successor is not the
  authenticated sender, before the host has issuer material; its result
  stays unverified. A signature segment that cannot be an Ed25519
  signature and an authorized key that is not one are refused as `form`
  and `document` failures. The signing key comes from the issuer's own long
  form. Endings bind only through a signed audience on an anonymous
  receipt; the basic form verifies and stays unbound.

The package README is the reading entry.
