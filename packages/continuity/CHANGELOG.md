# Changelog

## Unreleased

- **A fact is its content** (breaking): a fact names no evidence, and
  facts that say the same thing are one fact however many pieces of
  evidence the host projected them from. The host-allocated `id`,
  `FactId`, `receipt` and `decision` are gone, and so are references
  between facts. `factIdentity` gives the RFC 8785 text the model keys
  and orders facts by, for a host that indexes its own evidence by fact.
  Every answer lists facts: support, waiting, endings, conflict facts,
  `status(fact)`, and the `fact` of change records, ending records and
  confirmations.
- **Three kinds of fact** (breaking): `peer-observation`
  (`PeerObservation`, formerly `address-observed` and
  `AddressObservation`) carries the peer's rotation as `rotatedFrom`, so
  a peer rotation is always the observation of its successor and sits
  at both pairs; `peer-ending` is the peer's ending; a `local-decision`
  names no source, and any usable observation confirms its predecessor
  address. `PeerTransition` is gone. `FactStatus` has no `invalid` or
  `unresolved`, and `HeadResult.unresolved` lists `waiting` only.
- **The model accepts facts itself** (breaking): `FactSnapshot`,
  `mergeFacts`, `emptySnapshot`, `normalizeSnapshot`, `sameFacts`,
  `IncompatibleSnapshot` and `canonicalFact` are gone.
  `deriveContinuity` keeps facts with one identity once, so there is no
  identity conflict, in `Conflict` or in `FactStatus`.
- **Contexts are named by the endpoint they keep** (breaking): `History`
  has `samePeer` and `sameLocal` in place of `localContext` and
  `peerContext`.
- **A conflict carries its scope**: every `Conflict` has `scope`, the
  channels it masks directly; a query that depends on them may answer
  `conflict` as well.
- **from_prior is its own package** (breaking): the
  `@estoc/continuity/from-prior` entry point is gone, and so are the
  `jose`, `@scure/base` and `@estoc/did-peer` dependencies. Proofs are
  `@estoc/from-prior`'s, where `bindFromPrior` reports the change it
  binds rather than a fact, and the host projects that change into the
  fact it establishes.
- `Rotation`, `Ending`, `PeerEnding`, `FactKind` and `FactIdentity` are
  exported; `successorChannel` is not. `validateFact` reads only a
  value's own members. `PROFILE_VERSION` is `estoc-continuity/3`.

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
