# Changelog

## 0.1.0 — 2026-10-09

The continuity domain: a pure model of oriented DID pairs under rotation
and ending, under the `estoc-continuity/3` profile. It imports only
`canonicalize`; DIDComm v2 `from_prior` proofs are
`@estoc/from-prior`'s.

- Three kinds of fact, each identified by its content: a
  `peer-observation` is an authenticated receipt from the peer to an
  exact local DID, and with `rotatedFrom` it also carries the peer's
  rotation; a `peer-ending` is the peer's ending; a `local-decision` is
  a saved choice to rotate or end. `factIdentity` gives the RFC 8785
  text the model keys and orders facts by, for a host that indexes its
  own evidence by fact.
- `deriveContinuity` accepts the facts itself, refusing a malformed one
  with `InvalidFact` and keeping facts with one identity once, so the
  answers do not depend on order or repetition.
- Deterministic queries for head, changes, path, confirmation, history,
  local decisions, conflicts and fact status. Every answer lists facts.
  Contexts are named by the endpoint they keep (`samePeer`,
  `sameLocal`). Conflicts carry their scope and are never resolved;
  independent unambiguous support keeps a change usable beside a
  collided claim of it; authority stops at usable links.

The package README is the reading entry.
