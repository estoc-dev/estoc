# Changelog

## 0.1.0 — Unreleased

The contract between an Estoc daemon and its views, as one package a
view installs alone.

- `@estoc/daemon-api/contract`: API-owned identifiers, the published
  state value with its phases and holds, the normalized snapshot and its
  records, runtime lines and log lines, the method table with each
  method's named input, result, outcome subset and known error codes,
  the stable error codes, the bootstrap exchange and the application
  frames, protocol constants, and a zod schema for each of these.
  Message bodies pass through with every key kept; display times are
  checked as instants, not spellings only; a channel is referred to by
  its ID and never taken apart.
- `@estoc/daemon-api/wire`: one reading of a value as wire data on both
  transports, with its logical size and depth charged against a budget
  as it is read; strict padded base64 for bytes on a text port, and the
  bytes of a view copied out of a larger buffer; bootstrap and
  application frame reading and writing; port adapters for a message
  port and a WebSocket; and `serveApi`, the daemon's side of a session:
  negotiation with a 10 second bootstrap timeout, attachment, dispatch
  from the method table with input validation before any handler runs,
  typed refusals, and a bounded send queue of 64 frames per port that
  replaces an unsent state or lines with a newer one of the same epoch,
  drops logs first and closes the port when what it owes no longer fits.
- `scripts/consumer-check.mjs`: installs the packed package outside the
  workspace, compiles and runs a view against it, and fails when any
  daemon-side package came along.
