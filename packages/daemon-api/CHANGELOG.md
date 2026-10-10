# Changelog

## Unreleased

- Snapshot links: the methods `publishSnapshotLink` (answering a
  `PublishedSnapshotLink`), `revokeSnapshotLink` (`{ hash }`),
  `snapshotLinks` (`{ links: SnapshotLinkRecord[] }`, pending or
  published, a published one saying whether the daemon can still
  revoke it) and `restoreFromLink` (`{ link, passphrase }`). A
  `SnapshotLink` is the sealed snapshot's URL, its name and its key; the
  views' `snapshotLinkUrl` writes one as base64url JSON in the
  `snapshot` parameter of a URL's fragment, and `parseSnapshotLink`
  reads it from such a URL or the parameter alone.

- A message with several valid preparations is the person's to choose
  for: `PendingOutbound` gains `candidates`, the valid preparations by
  event CID, and `selected`, the one this daemon's calls carry or null,
  and the method `selectPreparation` (`{ messageId,
  preparationEventCid }`, the entry of the same name) writes the choice
  and calls nothing, answering `selected` or `none` with why; a `retry`
  carries it. A completion the operation owes the input nothing answers
  `skipped` with the skip code.

- `PendingWork.rotationCandidates` (`RotationCandidate`: the pair, the
  inputs calling for it, `ready`, `waiting` or `blocked` with why, and
  `rotate` as the entry while ready) lists the private addresses a peer's
  first messages call for and no decision records yet.
- `ConnectionRecord.recipients` (`RecipientsRecord`: the DIDs the
  account is to hold, those the connection had confirmed, those refused
  and why) replaces `reconciled` and `unknownRegistrations`: every
  arrangement is a replica-mediation account, whose addresses are added
  and never taken off, so there is no reconciliation to report.
- `setMediator` takes the mediator's DID alone: the one arrangement with
  that mediator is made and enrolled in when none stands.

## 0.1.0 — 2026-09-29

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
- An invitation is a reusable address: `createInvitation` takes
  `{ goal? }` alone, a `LocalDidRecord` disclosure carries `as` alone,
  an `InvitationRecord` has no `uses` or `consumer` and its `state` is
  `available` or `unavailable`, and `DISCLOSURE_USES` and
  `DisclosureUses` are gone.
- `DiagnosticKind` has no `receipt-integrity` member: the vault records
  no receipt ordinal for an author to reuse.
- `@estoc/daemon-api/views`: the pure helpers a view computes with,
  no daemon in reach: the snapshot indexed by ID with every
  conversation's channels, messages and observations assembled from
  what its record names, in the record's order (`indexSnapshot`); a
  conversation followed across snapshots by the trail a view keeps of
  it, the vault and the channel IDs and no record, to the one now
  showing a channel it showed (`trailOf`, `successorOf`); out-of-band
  invitations read from
  a link, its `_oob` parameter or its plaintext, and written as a link
  (`parseInvitation`, `invitationUrl`, `invitationOf`); the contents a
  view sends and the name an introduction claims (`basicMessage`,
  `profileMessage`, `announcedName`); and what a person pasted for a
  mediator read as far as text goes (`mediatorInputOf`,
  `mediatorHost`). The entry point imports the contract alone.
- `@estoc/daemon-api/wire`: one reading of a value as wire data on both
  transports, with its logical size and depth charged against a budget
  as it is read; strict padded base64 for bytes on a text port, and the
  bytes of a view copied out of a larger buffer; bootstrap and
  application frame reading and writing, a request charged whole; a
  port adapter for a message port, closing with its other end, and one
  for a WebSocket, waiting for the socket to drain below 1 MiB before
  it takes the next frame; and `serveApi`, the daemon's side of a
  session: negotiation with a 10 second bootstrap timeout, attachment
  validated like every call, dispatch from the method table with input
  validation before any handler runs, typed refusals, a bounded send
  queue of 64 frames per port that replaces an unsent state or lines
  with a newer one of the same epoch, drops logs first and closes the
  port when what it owes no longer fits, and a `StateUnavailable` fault
  when the baseline or a state cannot be written.
- `@estoc/daemon-api/client`: `connect(port)`, the view's side of a
  session: hello, attachment after the welcome, `connected` once the
  baseline is in and `NotConnected` for a call before that or after the
  connection ends; the daemon's methods typed from the method table
  under `client.daemon`, each checked against the advertised bounds
  before the port takes it; `refresh()` as a barrier on the reply's
  revision or a greater one of its epoch, lost as `StateChanged` when the
  epoch moves; publications applied in order, a state or lines already
  shown ignored; every failure a `CallError` with `isCallError` to
  narrow it, the daemon's errors under `origin: "daemon"` and the SDK's
  under `origin: "client"`, a lost reply `TransportDisconnected` with a
  possible effect and none for a refresh or the attachment; a daemon
  that stops speaking the contract ends the session as a
  `ProtocolError`; and `reconnecting(openPort, { delayMs })`, a client
  that opens another port after a delay when a connection ends,
  attaches afresh and never resends a call the old connection lost.
- Requires Node 26 or later, whose `Uint8Array` has the strict base64
  conversion the text port relies on; browsers and workers without it
  fall back to `atob` and `btoa` under the same acceptance rule.
- `scripts/consumer-check.mjs`: installs the packed package outside the
  workspace, compiles and runs a view against it, and fails when any
  daemon-side package came along.
