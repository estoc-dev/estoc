# Changelog

## Unreleased

- **Frames are CBOR** (breaking, wire version 2): every frame, the
  bootstrap records included, is one CBOR data item in a `Uint8Array`,
  written and read with `cbor2`. A WebSocket carries binary messages and
  closes on a text one; a message port transfers each frame's buffer and
  closes on a message that is no byte array. Bytes are CBOR byte
  strings, so `Transport`, `Port.transport` and the base64 helpers
  (`ByteWrapper`, `base64Length`, `fromBase64`, `toBase64`,
  `isByteWrapper`, `wrapBytes`) are gone, and `readBootstrap`,
  `writeBootstrap`, `readFrame`, `writeFrame` and `readPayload` take no
  transport. `Limits.maxFrameBytes` is always a number, the byte length
  of one client-to-daemon frame, which every port checks before the
  frame is decoded. `Limits.maxDepth` is gone: nesting is held to the
  decoder's default bound. A string or a key holding a lone surrogate
  is not wire data. A peer of wire version 1 sees the connection
  closed.

- **A call's input is read once** (breaking, `./wire`): `readValue` and
  `readPayload` give a `WireValue`, which only that reading makes, and
  `writeFrame` takes a `WireFrame`, a frame whose payload is one, and
  writes it without reading it again. It no longer takes the byte
  members: a read value holds bytes only at those it was read with.
  `ownFrame(frame, bytesAt)` reads a frame of the sender's own and
  throws on a payload that is not wire data, as `writeFrame` did. The
  client sends the input it read and checked against the method's
  schema as it is.

- **Snapshot parts** (breaking): a snapshot link carries one part of the
  CAR snapshot, `SnapshotPart` `seed` (the sealed seed, with the events
  a new replica enrolls from) or `content` (every event and object, no
  seed), in place of `SnapshotSelection`: `publishSnapshotLink` takes
  `{ part }`, and a `SnapshotLinkRecord` names its `part`. A backup is
  a `.car` carrying both; `restoreIdentity` and `restoreFromLink` need
  the seed, `mergeBackup` and `importFromLink` the content.
  `restoreFromLink` reads no further than the bound a seed link is held
  to, which the daemon sets, rather than `maxBackupBytes`.

- Snapshot links: the methods `publishSnapshotLink` (`{ selection }`,
  answering a `PublishedSnapshotLink`), `revokeSnapshotLink`
  (`{ hash }`), `snapshotLinks` (`{ links: SnapshotLinkRecord[] }`,
  pending or published, each with its `selection`, a published one
  saying whether the daemon can still revoke it), `restoreFromLink`
  (`{ link, passphrase }`) and `importFromLink` (`{ link }`, answering
  a `MergeResult`). A `SnapshotSelection` is `enrollment`, the events a
  new replica enrolls from, which name no object when well formed, or
  `all`, the whole vault. A
  `SnapshotLink` is the sealed snapshot's URL, its name and its key; the
  views' `snapshotLinkUrl` writes one as base64url JSON in the
  `snapshot` parameter of a URL's fragment, and `parseSnapshotLink`
  reads it from such a URL or the parameter alone.

- Replicas: `MediationRecord.replicas` is the mediator's last listing of
  the arrangement's replicas (`ReplicaListing`: when it came, and each
  `ReplicaRecord` with its `ReplicaId`, DID, whether it is the daemon's
  own, `active` or `removed`, when it was added and removed, and the
  last history sent it), null while none was listed; the method
  `refreshReplicas` asks again. `sync` (`{ replicaId? }`, answering
  `{ told }`) sends a copy of the whole vault to that replica, or every
  other, and `Snapshot.historyReceived` says how the last history
  another replica sent is being or was imported.

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
