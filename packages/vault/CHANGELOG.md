# Changelog

## Unreleased

- **A source's standing is its type**: `Source` is its common fields with
  one of four members, told apart by `status`: `complete` with
  `localDidId`, `resolution` and `channel` all present, `incomplete` with
  `because`, `conflict` with `because` and no channel, and `anonymous`
  with neither a resolution nor a channel. `status` and `because` replace
  the `standing` object. An anonymous observation, read as complete
  before, has a status of its own, so `complete` alone means placed in a
  channel. `PlacedSource` names that member, and an execution's members,
  the acknowledgement witnesses, a missing response's source and a
  rotation candidate's sources carry it. `Standing` is no longer exported.
- **An input's standing is its type**: `Execution` is its common fields
  with one of three members, told apart by `status`: `complete` with
  `intentHash`, `kind` and `firstWitness` all present, `pending` with
  `because` and the admitted intent once one is admitted, and `conflict`
  with `because` and no intent. `status` is now the string itself and
  `because` sits beside it, in place of the `{ status, because }` object;
  `ExecutionStatus` is no longer exported. Reading `status` tells whether
  the first witness and the intent are there.
- **Every DID says how it was made**: `did.created.generation` is required,
  `{ kind: "entry", profile }`, `{ kind: "start", profile, predecessor,
  binding }` or `{ kind: "next", profile, predecessor }`, and under profile
  `v1`, the one this version makes entities under (`GENERATION_PROFILE`),
  the schema holds the entity ID to it: an entry is a minted UUIDv7, a start
  is `startDidId(predecessor, binding)`, a next `successorDidId(predecessor)`.
  A creation without it is refused; nothing reads the old shape. The DID
  fold reads each entity's `lineage` once: `entry`, `branch` with the anchor
  pair its start was bound to, `pending` while a predecessor's creation is
  not here, `unsupported` under another profile, `invalid` where the
  generations contradict each other.
- **One recipe for a successor**: `successorRecipe(fold, channel)` says what
  a rotation away from the pair makes, from the fold alone: `ready` with a
  `start` of an entry bound to `peerRoot`'s start, or a `next` of a branch
  address once `model.path` leads from the branch's anchor to the pair;
  `waiting` while a predecessor's creation or that path is missing;
  `blocked` where a conflict or an invalid generation stops it.
  `recipeDidId` and `generationOf` turn a recipe into the entity ID and the
  generation it records.
- **Rotations the policy would make**: `unfinishedWork(fold).rotationCandidates`
  lists, per rotation intent, the established application inputs at a
  disclosed entry that no decision answers yet, with the pair current
  policy still rotates, whatever the inputs' clocks say, and the recipe's
  `choice`; a candidate decision takes the group over to its notification,
  a decision waiting or in conflict and a denied or superseded pair are its
  reason.
- **The peer's start**: `Continuity.peerRoot(channel)` walks the usable peer
  replacements back from a pair, its local DID fixed, to the one address of
  the peer no replacement leads to: `found` with that DID and the support
  that re-derives the replacements walked, `conflict` when a conflict
  reaches the pair or a replacement on the way, or the history leads back to
  more than one address. The answer is a start in this snapshot, not the
  first address the relationship ever had: a replacement whose proof is not
  verified adds nothing, and a replacement the peer made toward another
  local DID counts only where a join carries it to this one. A pure read
  over the existing model; no event changes.
- **One rotation intent, several records**: a rotation away from a pair is
  one intent, this predecessor replaced by this successor toward the peer
  anywhere in its verified peer-only context, and several
  `did.rotationSelected` records may support it, each under its own author,
  time, source and proof, when two replicas decide the same rotation apart
  or one decides it again over a restored snapshot. `rotationIntent(fold,
  records)` reads records as the intents they support, `decisionGroups`
  groups them by predecessor, successor and context, keeping a record whose
  predecessor's creation is not here as `unresolved`, and
  `Continuity.peerContext(channel)` is the context a decision's scope is read
  in. `decisionFor` returns that reading in place of `ExistingDecision`:
  `candidate` with the first candidate record in canonical event order and
  its group where it said `reuse`, `pending` where it said `defer`. Two
  records of one intent are no longer a conflict; two successors in one
  context still compete, the same successor from two predecessors is not one
  intent, and a record in conflict beside a verified one still refuses the
  whole. Each record keeps its own notification.
- **A payload's cross-field rules are its type**: `MessageOut` is its
  common fields with `LocalSend` or `AutomaticEffect`, the producing
  tuple, its key and the source all null or all present, and `MessageIn`
  is its common fields with `AnonymousPeer` or `ResolvedPeer`, the
  resolution evidence and both sender DIDs null together or none of them.
  A payload mixing the two members does not typecheck; reading one field
  of a member tells the rest. The parser refuses the same payloads as
  before and the encoding is unchanged, so no event CID moves.
- **A mediator is one DID however it is spelled**: `canonicalDid` and
  `sameDid` compare a `did:peer:4` by its short form and any other DID as
  it is. The mediation fold reads creations of one arrangement that name
  the same mediator under either spelling, with identical `me`, as one
  creation, grants naming the same routing DID under either spelling as
  one grant, and `through` finds an arrangement under either spelling;
  the replica fold and `sameBinding` compare a grant's `mediator` the
  same way. Events keep the spelling they recorded, and the fold reports
  the spelling of the first in canonical order. `verifyReplicaGrant`
  compares the grant's `mediator` with the replica's service as validated
  identities: a `did:peer:4` long form in either place must be the one
  its hash commits to, resolving the replica's document validating no
  mediator document nested in its service URI, and `InvalidDidDocument`
  refuses one that is not. The DID fold validates the same way the
  `did:peer:4` long form a communication document's service names: one
  that is not the document its hash commits to, or does not read as a
  document, is the entity's conflict, with no route and no arrangement.
- **Derived arrangement and DID entity IDs**: `mediationIdOf(mediatorDid)`
  names the one arrangement with a mediator by the UUIDv5 its canonical
  DID derives, so every replica that arranges with a mediator records the
  same creation; a `mediation.created` whose `mediationId` is any other
  value is an invalid payload, `mediationKeyName` and the
  `mediation/<id>/me` key name take a UUIDv5 alone, and a replica grant's
  `mediation_id` is one too. `successorDidId(predecessor)` and
  `startDidId(publicDid, binding)` derive DID entity IDs; every `didId`
  member, `didKeyName` and the `did/<id>/…` key names take a UUIDv5 or a
  UUIDv7, and the procedures here still mint. `LocalDidEntity.mediation`,
  the one usable arrangement routing the entity or null, replaces
  `mediations`: a usable arrangement is routed through its own mediator and
  a vault has one arrangement per mediator, so no routing DID is routed by
  several. A vault recorded before this change is read anew.
- `DidFold.desiredRecipients` and `DesiredRecipient` are gone. Which DIDs
  an account is to hold at its mediator is the agent's to decide, over
  `receipt`, and it keeps retired DIDs: nothing reads a projection of the
  live ones.
- **Every arrangement is a replica-mediation account**: `mediation.created`
  has no `profile` member, and `MediationProfile` and `Mediation.profile`
  are gone. An arrangement is an account of the mediator's
  replica-mediation protocol and is routed through that mediator itself,
  so a grant naming any other routing DID is a conflict, and the account
  DID is recorded by its did:peer:4 long form. A `mediation.created`
  carrying `profile` is an invalid payload: a vault recorded before this
  change is read anew.
- **A DID's route is its document's**: `did.created` records only the
  entity ID and the two spellings; where the DID sends is the one
  DIDComm service of its long form, read back by the fold
  (`LocalDidEntity.routeTarget`, via `serviceTargetOf`). A mediated DID
  is routed by the usable arrangement whose grant names its routing DID
  (`LocalDidEntity.mediations`, `MediationFold.through`); it waits while
  no arrangement does, none usable does or several usable ones do, and
  is terminal for receipt only on its own conflict, never on the
  arrangements' account, since the one that routes it may not have
  arrived here yet. `serviceTargetOf` takes a DID, not a DID URL or a
  bare `did:`, which no grant could name. `route.configured`, `route.retired`, `RouteId`, `RouteKind`,
  `Route` and `DesiredRecipient.routeId` are gone, and the fold is the
  DID fold: `foldDids` and `DidFold` at `VaultFold.dids`, its entities
  under `entities`, in place of `foldRoutes`, `RouteFold` and
  `VaultFold.routes`. A `did.created` carrying `boundRouteId` is an
  invalid payload: a vault recorded before this change is read anew.
- **Replica-mediation membership**: the new event `replica.created`
  records one replica's grant, and `foldReplicas` (`VaultFold.replicas`)
  reads which replicas are members of which arrangement, with
  `verifyReplicaGrants` as the seed's check beside it
  (`VaultChecks.replicaGrants`). `replicaKeyName`, `Keys.replicaKeys`,
  `mintReplicaDid` and `checkReplicaKeys` derive a replica's own DID;
  `signReplicaGrant`, `readReplicaGrant`, `verifyReplicaGrant` and
  `sameBinding` are the grant, which is at most `MAX_GRANT_JWS_CHARS`
  long and whose `kid` must name an authentication method of the account
  document the arrangement's creation records, of a type and key
  encoding a mediator reads an Ed25519 key from (`Multikey` or
  `Ed25519VerificationKey2020` with a multibase value, `JsonWebKey2020`
  with a JWK). Membership is read from
  that creation (`mediationCreations`) and does not follow the
  arrangement's routing grants or retirement. Nothing enrolls or picks up yet: this is
  the vault's side of the contract only. A reader older than this
  version keeps a `replica.created` unapplied.
- **Recipient proof**: `signRecipientProof` signs, with a communication
  DID's own authentication key, the compact JWS
  (`RECIPIENT_PROOF_TYP`) that lets a replica-mediation account hold
  that DID at one mediator.

## 0.4.0 — 2026-09-29

- **Receipt ordinals are gone** (behaviour change): `message.in` carries
  no `receiptOrdinal`, and `ReceiptOrdinal`, `ReceiptKey`,
  `ReceiptIntegrity`, `receiptOrderKey`, `compareReceiptKeys`,
  `foldReceipts` and `ChannelEvidence.receipts` are gone with it. An
  observation an older writer stored with the member is an invalid
  payload, so a vault written before this version is not read as it was:
  its observations are kept as events and dropped from the fold. The
  observations of an input — an execution's `members` and `siblings`,
  the anonymous and unplaced observations, the witnesses that
  acknowledge an outbound — are in canonical event order (`at`, then
  event CID), and the inputs of a channel view in the canonical order of
  their first witnesses; `Execution.firstReceiptKey` is gone,
  `firstWitness` being the first admitted complete member in that order.
  A receipt no longer scans every observation for a high-water mark
  before it commits.
- **Admission walks canonical event order** (behaviour change): the
  `candidates` of `foldDispositions`, and so the rounds of
  `admissionDrafts` and `admitReceipts`, are in canonical event order
  (`at`, then event CID), not receipt order. An admission already
  committed is displaced by no later candidate; among the eligible
  unadmitted observations of one input, left waiting for evidence, by
  interrupted processing or by a merge, the order is canonical, not the
  order they were received in. A receipt-integrity conflict withholds
  no admission: an admission of an observation it touches is
  `effective` like any other, the observation is a candidate judged
  like any other and `Eligibility` has no `integrity-conflict` member.
  Nor does the conflict bar a pure ACK any more: `ackTarget` lists the
  carrier's receipt of itself and `builtInOf` validates a saved one
  whatever the ordinals around them; the conflict is a diagnostic,
  read from `receipts.affected` alone.
- **A spelling is decoded once** (behaviour change): the retained
  document of a numalgo-4 long form, and the decoding of a public key
  and its standing as a key-agreement key, are kept for the 4096
  inputs each saw last. `peerResolution(did).document` is one
  document for every resolution of that spelling, frozen all the way
  down: a caller that changed it copies it first. Its `bytes`, and
  the `bytes` of `decodePublicKey` and `agreementKey`, are the
  caller's own each time. A refusal is kept with its input and thrown
  again as the same error. `canonicalDidOf` reads the same kept
  document. A scan of a history decodes each spelling it names once
  for as long as the process keeps it, where it decoded each on every
  scan. Needs `@estoc/did-peer` 0.2.0.
- **An invitation is a reusable address** (behaviour change):
  `did.disclosed` has no `uses` member and `invitation.consumed` is
  no event type, so a history holding either is refused by the
  schema. `foldInvitations` takes the set and the routes alone and
  reads each OOB disclosure with whether its DID still takes a first
  message under it, `available` or `unavailable`; `Invitation` has no
  `consumptions`, `consumer` or `candidates`, and `ConsumptionStatus`,
  `Consumption`, `Candidate`, `consumptionDrafts`, `consumeInvitations`
  and `PendingWork.consumptions` are gone. No receipt takes an
  invitation from the next, so nothing about invitations depends on
  the order receipts were recorded in. An `oobId` that distinct
  disclosure events carry, as merged histories may, is `unavailable`
  under every one of them; the DIDs and their receipts are unaffected.
- **A pure ACK names its carrier alone** (behaviour change): the
  receipt a carrier earns is its own wire ID, when its `please_ack`
  names itself by `""` or its ID and it is the admitted complete
  witness establishing an input whose admitted intents agree; a
  request naming other messages earns them nothing. No receipt order,
  wire-ID lookup or predecessor-channel search enters it, so what a
  receipt says never depends on the order inputs were received in.
  `OutboundFold.ackTarget` gives the one target or why there is none,
  in place of `ackTargets`; `expandPleaseAck` is gone, `requestsAck`
  reading the request alone. A saved pure ACK is in conflict unless
  its `ack` is exactly its carrier's wire ID; it stands on the
  carrier's complete witness, admitted or not, so a history rebuilt
  without its admissions keeps the intent's `effect`, its package
  and its submission, and a manual dispatch carries it at the first
  call, while a carrier whose input is under a receipt-integrity or
  intent conflict keeps it in conflict.
- **One send gate at both ends, read by every path to the wire**
  (behaviour change): `senderGate` closes a channel whose local DID
  cannot send, whose pair is denied or in conflicted continuity,
  whose peer has replaced its DID in that context, or whose local DID
  a decision has replaced there — or still waits to, a saved decision
  the fold cannot project yet included — and `channelPolicy` holds
  the pair's part of it: denied, in conflict, or its peer replaced,
  for automatic and user work alike; the `automatic` option is gone.
  An outbound's `work` reads that gate, so a message a replacement of
  either endpoint caught queued or prepared takes no package and no
  call, first or retried, and keeps its intent, its package and
  whatever call was made before; `responseChannel` answers an input
  at a replaced local DID from the unique verified successor keeping
  the peer, retired or not.
- **An address is confirmed for new work by an admitted observation**:
  `Continuity.confirmedBy(localDid, peerDid)` is the first admitted
  observation, in the model's order, by which the peer or a usable
  successor of it wrote to exactly this local DID, or null while the
  model confirms by observations no admission names; it replaces
  `confirmed`. A saved decision is still validated over the model's
  confirmation; `foldContinuity` takes the admissions.
- **A receipt is read as the peer acknowledging, answering or asking
  only once admitted**: `ackWitnesses`, `ackTarget` and `inReplyTo`
  require an admitted complete witness of an input whose admitted
  intents agree, and a `delivery.acknowledged` naming an observation
  no admission names is pending as such; a same-channel witness is
  read under a peer fork ahead of it, one whose path runs through the
  fork is not. `InboundFold.memberOf` gives an observation as a
  member of its input.
- **`message.admitted`**, the runtime's durable acceptance of one exact
  observation for application use: `{ sourceEventCid }`, no roots.
  `foldAdmissions` reads each record against its source into
  `effective`, `pending` or `invalid` (`AdmissionFold`), and
  `foldDispositions` gives every observation its `Disposition` —
  `refused`, `admitted`, `ignored-superseded` or `pending-admission`
  with what stands in the way; a verified replacement of the peer
  precedes every pending state, a saved admission still waiting for
  its evidence included — and lists the `candidates` no
  effective or pending admission names, in first-receipt order, each
  `eligible`, `deferred`, `refused` by current policy, `invalid` or in
  an `integrity-conflict`. Both are on `VaultFold` as `admissions` and
  `dispositions`.
- **An input speaks through its admitted observations** (behaviour
  change): `Member.admitted`; the intent of an execution is the one its
  admitted members agree on, a conflict is their disagreement, and an
  input is `complete` only through an admitted complete witness, now
  `Execution.firstWitness`. A positive observation no admission names
  whose intent differs from the admitted one is listed in
  `Execution.contradicting` and raises no conflict. An observation
  caught in a receipt-integrity conflict is admitted by nothing, so
  its input is not established.
- **The ordered admission pass**: `admissionDrafts` is one round — the
  first eligible observation of each input — and `admitReceipts` runs
  round after round under a lock already held, committing each round
  and refolding over the extended set, until none is owed;
  `reconcileAdmissions` takes the lock and runs it. A consistent
  duplicate is admitted the round after the first, a contradicting one
  refused for good.
- An invitation's candidate that is not yet admitted is `deferred`
  until the pass admits it, and one whose admission current policy
  refuses is `refused`; a candidate an admission waits on is deferred
  too. The notification of a source-derived decision and the private
  successor a live input selects require the exact source admitted.
- Gone from the invitations module: `Eligibility`, now the admission
  module's and shared.

- **Continuity is derived by `@estoc/continuity`.** The vault projects
  its evidence into the package's facts (`projectFacts`) under IDs every
  replica derives from the event CIDs — `receipt:<cid>:observation`,
  `receipt:<cid>:transition`, `decision:<cid>`, with the event CIDs as
  evidence references — and `foldContinuity` derives the one model with
  `deriveContinuity`. `Continuity` exposes it as `model` and keeps the
  host queries over it: `status`, `witness`, `conflicted`, `superseded`,
  `head`, `confirmed`, `ackPath`, `blocked`, `decisionsIn`; `conflicts`
  are the package's, each with the channels its scope reaches
  (`ScopedConflict`). Gone: `links`, `unconfirmed`, `ContinuityLink`,
  `Replaced`, `PeerLink`, `LocalLink`, the vault's own `Conflict`,
  `Components`; `Carrier.link` is `Carrier.facts`, the two facts a bound
  proof establishes, and a candidate decision carries its `fact`.
- **`from_prior` is parsed, prechecked, verified, bound and created by
  `@estoc/continuity/from-prior`.** `fromPriorClaims`, `carriedClaims`,
  `verifyFromPrior`, `verifyLocalProof`, `issuerDocumentOf`,
  `FROM_PRIOR_ALG` and the vault's `InvalidFromPrior` are gone;
  `signFromPrior` stays and signs through `createFromPrior` with the
  entity's key (`LocalKey.sign`), `issuerLongFormOf` replaces
  `issuerDocumentOf`, and `ProofCheck` — the verified proof, or why it
  is refused — replaces the yes/no proof check. DID spellings compare
  by validated equivalence wherever the profile does: a short-form
  `sub` for a long-form sender and a short-form `kid` for a long-form
  `iss` verify; `typ` may be absent, `JWT` or `application/jwt` in any
  case; what the profile refuses without a document — the `alg`, the
  `typ`, a `kid` of another DID, a `sub` equal to `iss` or unequal to
  the sender, `exp`/`nbf` — is invalid at once.
- **An ending is `unsupported`**, a new `Proof` and `Status` variant:
  retained, applied to nothing, no fact.
- A carried proof's issuer is compared with the local DID by did:peer:4
  spelling alone, as the profile already validated it; the vault's
  document validator no longer runs on it. A hash-valid issuer whose
  document the vault would refuse to retain used to throw out of the
  fold, and one such receipt, once recorded or imported, stopped every
  later scan.
- **Heads follow the model** (behaviour change): a channel no fact
  mentions is its own head; one a saved rotation leaves has no head
  until the peer confirms the predecessor and never falls back to the
  old pair; a fork or a cycle ahead of a channel makes it `conflicted`,
  so a send or automatic work there is refused rather than left
  headless. A proof-free receipt is a complete witness on its own
  authentication even in a conflicted context.

- **Event references are CIDs.** Every payload field that named an
  event by UUID names it by its event CID and is renamed for it:
  `sourceEventCid`, `rotationEventCid`, `peerResolutionEventCid`,
  `disclosureEventCid`. A reference is a canonical raw DASL CID; the
  schema cannot tell it from an object's. `EventId` is `EventCid`, an
  event's `eventId` is its `cid`, and `Retained` is `{ cid, root }`.
  `SourceKey` is `(at, cid)`. Vault metadata is version 4.

- **A contradicted input acknowledges nothing.** An outbound's
  `ackWitnesses` leave out every observation of an input whose
  admitted observations carry different intents, however complete
  each witness is: which of its `ack` lists the peer meant is not
  known.

## 0.3.0 — 2026-09-20

The version-3 vault, in place of the version-2 one.

- **Version 3 is the package.** What was `@estoc/vault/v3` is now the
  root export, and the `./v3` entry is gone; every entry below describes
  what `@estoc/vault` exports now.
- **The version-2 vault is removed**: its event types and
  `readVaultEvent`, `peerKeyOf` / `fingerprint`, `VaultFold` and
  `EventSet`, `drafts`, the procedures over them, `Keys` over the
  keystore's `keys[]` cache with `MintDid`, and `createFolderVault` /
  `openFolderVault`. `Components`, the union-find the continuity fold
  uses, is kept.

- **Version 3**, under `@estoc/vault/v3`: the code form of the
  replica model's vault events, channels, relationship policy and
  distributed delivery over `@estoc/event-store/v3`. Version 2 is
  untouched beside it.
- **Identifiers and values.** `types.ts` is one nominal type per kind
  of value a payload names, and the channel, an ordered pair of a
  local and a peer DID in canonical did:peer:4 short form (`Channel`,
  `channelOf`, `channelKey`, `compareChannels`, `sameChannel`).
  `ids.ts` derives the three UUIDv5 namespaces from the URL namespace
  and every ID a rule derives rather than mints: `inboundMessageId`
  and `executionId` from the canonical sender, recipient and wire ID,
  `anonymousMessageId` from the decrypting local key, `effectKey`
  over the tagged execution and effect type and `automaticMessageId`
  from it, and the reserved keystore names, each derivation checked
  against the published vectors.
  `canonicalPublicKey` is the did:key encoding a supported key's JWK
  or base58btc multibase form normalizes to, a Weierstrass point
  verified on its curve by `@noble/curves`, base58btc and base64url by
  `@scure/base`, the multicodec prefix by `multiformats`;
  `agreementKey` refuses an X25519 low-order point.
- **Event schemas, stored document and projections.**
  `readVaultEvent`, `readVaultDraft` and `vaultDraft` check the
  payload of each of the 28 event types — closed member set, types,
  spellings, the rules between members and the `roots` the type
  retains — and throw `InvalidPayload`; they never look up a
  referenced event or verify a JWT. `storeMessage`,
  `readStoredDocument` and `wireAttachment` are the stored message
  document and its wire form, meeting at the same bytes.
  `readPlaintext`, `wirePlaintext`, `semanticProjection`,
  `intentProjection`, `intentHash`, `plaintextHash`, `expandPleaseAck`
  and `requestsAck` are the projections and hashes; `from_prior` is
  kept as the original string, JWT or not.
- **Keys, communication DIDs, retained peer documents and proofs.**
  `Keys` derives every key by name from the one seed through
  `@estoc/keystore` and opens only over the seed that derives the
  recorded anchor; `mintDid` and `mintMediationDid` build the
  did:peer:4 input documents, `checkDidCreated` and
  `checkMediationCreated` read a recorded entity's own document back
  against the seed and the bound route. `peerResolution` takes a
  long form to the fixed retained document under its RFC 8785 bytes
  and raw CID, every service URI checked by its RFC 3986 grammar;
  `canonicalDidOf`, `authorizedMethodIds`, `methodPublicKey`,
  `didcommServiceUris` and `splitDidUrl` read DIDs and documents.
  `signFromPrior` issues the compact EdDSA JWT over `jose`;
  `fromPriorClaims`, `carriedClaims` and `verifyFromPrior` read a
  carried proof in three steps, the signature only against the
  issuer's immutable document; `verifyLocalProof` holds a rotation
  decision's frozen proof to its counterpart.
- **The folds**, under `fold/`, every one a pure function of the
  event set, the same over any permutation, with what needs the seed,
  the retained documents or the objects computed beside it and handed
  in as verdicts (`verifyDidKeys`, `verifyMediationKeys`,
  `verifyResolutions`, `verifyProofs`, `checkVault`, `scanVault`):
  `VaultEventSet`; `foldAuthors`, `foldLabel`, `foldMediations`,
  `foldRoutes` and `requiredReceivingSet`, a retired entity receiving
  while its route is not terminal; `heldRoots`, `foldErasures` and
  `readState`, the retention edge by edge; `foldChannelEvidence`, the
  sources, receipts, carriers and rotation decisions and which sources
  are positive; `foldContinuity`, the graph of channels whose edges
  replace one endpoint — the peer's by a carrier's verified proof,
  ours by a decision the peer or a verified successor has confirmed by
  writing to the predecessor — with conflicts found over the whole
  graph and authority granted only through channels free of them,
  answering each carrier's and decision's status, a channel's head,
  supersession, conflict, denials and decisions, and the
  role-preserving path an ACK may follow; `foldInvitations`, each
  one-use disclosure's consumption and candidates; `foldContacts`,
  the latest-wins table under each contact ID; `foldInbound`, one
  execution per input in its channel, complete once one member is a
  complete witness, its kind and first receipt key; `foldOutbound`,
  each message's intent, channel, packages, submission, failures,
  acknowledgments, effect against its source and work left, plus
  `notificationFor`, `ackTargets` and `inReplyTo`; `foldVault`, the
  whole over one set.
- **The views**, `fold/views.ts`, reached as `fold.views`: a channel
  with its inputs in first-receipt order, its outbounds, the problem
  reports peers sent beside the outbound each answers, and its send
  gate (`senderGate`, `channelPolicy`); a contact, or several shown as
  one, as the channels it selected followed by the related history
  verified continuity connects, each message once in its own channel,
  with `writeTo`, a `useDid` preference matched along verified local
  successors and `defaultWriteTo` only when one head is left.
- **The procedures**, `procedures.ts`, over a `VaultRuntime` under its
  lock: `vaultRetention`, `vaultHeldRoots` and `collectGarbage`;
  `eraseMessage` and `closeErasures`; `consumeInvitations`;
  `unfinishedWork`, what an open lists for manual action and
  dispatches nothing of — outbounds to prepare or dispatch, the pure
  ACKs and Ping replies established inputs may still be given under
  `responseChannel`, the notifications verified decisions permit, the
  notification conflicts, the proofs waiting for issuer material and
  the consumptions; `automaticIntent`; `decisionFor`, the decision a
  rotation away from a pair reuses; `blockChannels`; `deleteContact`,
  the tombstone with an optional denial of each selected channel and
  the erasure of every message their views show.
- The version-2 peer-key fingerprint's base32 is `@scure/base`'s
  `base32nopad`, lowercased; the output is unchanged.

## 0.2.0 — 2026-09-01

The version-2 vault is the package. What was `@estoc/vault/v2` is now
the root entry, and the version-1 format — `VaultBackend` and its
backends, the layout constants, `SegmentedLog`, the contact and
invitation stores, the message and delivery logs, `BlobStore`, the
trace log, `snapshotVault` / `importVault`, `Vault` — is deleted with
its tests and `docs/vault-format.md` retired. The folder, its backends
(`MemoryBackend`, `OpfsBackend`, `FsBackend` in
`@estoc/event-store/node`), blobs, local state, the trace and
interchange live in `@estoc/event-store` (`docs/event-store.md`,
`docs/vault-folder.md`); this package is what the events mean
(`docs/vault-events.md`).

- `exports` is `"."` only: `./node` is gone with `FsBackend` (import it
  from `@estoc/event-store/node`), `./v2` is the root.
- Everything `@estoc/vault/v2` exported is exported here unchanged: the
  event types and `readVaultEvent`, `peerKeyOf` / `fingerprint`,
  `EventSet`, `VaultFold`, `drafts`, the procedures (`record`,
  `recordMessage`, `eraseMessage`, `deleteContact`, `holdImported`,
  `importPolicy`, `collectBlobs`, `readRoot`, `sweepDeleted`, …),
  `Keys` with `MintDid`, `createFolderVault` / `openFolderVault`.
- A version-1 folder is refused on open (`NotAVault`), as it was by
  `@estoc/vault/v2`; there is nothing to migrate.

## 0.1.0 — 2026-08-29

The `.estoc` format on its own. Everything here moved out of
`@estoc/agent-core` 0.16 unchanged in behaviour — `VaultBackend` with
`MemoryBackend` and `OpfsBackend`, the layout constants, `SegmentedLog`,
the contact and invitation stores, the message and delivery logs,
`BlobStore`, `snapshotVault` / `importVault`, and `Vault` — with two
changes at the edges:

- `Vault` no longer knows did:peer:4. `Vault.open(backend, { mint })` and
  `Vault.create(backend, { …, mint })` take a `MintDid`:
  `(identity, serviceUri) => { did, … }`, deterministic. `setMediator`,
  `mintPairwise`, `createInvitation` and `peerIdentity` call it and
  record what it returns; the type of what it returns is the vault's
  type parameter (`Vault<M>`). `@estoc/agent-core` binds it to
  `mintPeerDid` (`openVault`, `createVault`, `PeerVault` there).
- `FsBackend`, a folder on disk, moved here from `@estoc/daemon` as
  `@estoc/vault/node`, and now keeps the mode of a file it replaces (a
  keystore made 0600 stays 0600).
- `TraceLog.setPolicy(policy)`: keep by another policy from now on (a device
  preference changing while the vault is open); `policy` is a getter.
- **`trace/`, the trace log** (`docs/vault-format.md` §6.10): what this
  device observed, apart from what was said — `TraceLog` with five
  streams (`envelope`, `wire`, `wire.bytes`, `mediation`, `diag`), each
  line `{ stream, tid, at, event, parent?, mid?, … }`. The one log that
  is deleted from: a `TracePolicy` gives every stream a `keepMs` and a
  `capBytes`, segments rotate at a mebibyte or a day, and `prune()`
  unlinks whole segments by name — never a line — and leaves a `prune`
  line in `diag` when it was the cap that did it. `traceOf(mid)` follows
  `parent` both ways to hand back the whole onion of one message.
  `TRACE_OFF` / `TRACE_NORMAL` / `TRACE_VERBOSE` and `tracePolicy(level)`
  are the presets; `Vault` takes `{ trace?: TracePolicy }` (default
  normal) and exposes `vault.trace`. Scheduling `prune()` is the
  caller's. Never in a snapshot, never laid down by an import.
- `VaultBackend.size(path)`: a file's size without reading it, or null.
  Prune reads names and sizes, never contents. Every backend here has it;
  a backend elsewhere must add it.
