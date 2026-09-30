# Changelog

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
