# @estoc/agent-core

The DIDComm v2 agent behind Estoc's clients, over an `.estoc` vault:
`@estoc/event-store` holds it, `@estoc/vault` says what its events mean,
and this package is what runs on it. A message is decided over the fold
read under the vault's writer lock and committed as an intent, then as
a package, before its one transport call, which goes under a live
action once the lock is released. A delivery passes one gate, is
recorded as one observation under that same lock, and earns automatic
work only in the call that recorded it. On the wire: the mediator's
replica-mediation protocol (each runtime a replica of one account),
messagepickup 3.0 over HTTP and WebSocket, routing 2.0 forwards,
channels of did:peer:4 pairs rotated by `from_prior`, invitations,
trust-ping, basicmessage, user-profile and report-problem.

The identifiers, the hashes, the commit boundaries and the wire
profiles are the [replica model](../../docs/replica-model/README.md)'s:
[distributed delivery](../../docs/replica-model/distributed-delivery.md)
for the inbound and execution identities, the effect keys, the commit
boundaries and the mediator's envelope profile,
[channels](../../docs/replica-model/channels.md) for the channel
payloads, and
[address and contact policy](../../docs/replica-model/relationships.md)
for the DID profiles. The code and its tests define what the procedures
do; each module's leading comment states what it is responsible for.

Runs wherever didcomm-rust's WASM does: the browser (Vite), workerd, Node.
The WASM itself is *not* loaded here — see [Didcomm API](#didcomm-api).

## Modules

Each module answers one question. Its leading comment states its
responsibility, its exports are the entry points, and `test/` mirrors
`src/`; `test/e2e/` runs two agents against an in-process mediator over
file vaults, one scenario per test: first contact, rotation, admission,
races, crashes, restore, closing and a hostile peer.

| Question | Module | Entry points |
| --- | --- | --- |
| How is the vault opened, and with whose keys? | `identity.ts` | `createVault`, `openVault`, `inspectRuntime`, `inspectSnapshot` |
| What is a vault running? | `agent.ts` | `Agent.open`, `Agent.start`; `connect`, `send`, `receive`, `localStateChanged`, `records`, `pending`, `manual`, `close` |
| What authorizes a transport call? | `action.ts` | `LiveAction.manual`, `LiveInput` |
| How does a procedure write the vault, and talk to a mediator? | `procedure.ts` | `decide`, `serially` |
| How is an arrangement with a mediator recorded? | `mediation.ts` | `createMediation`, `selectMediation`, `mediationOf` |
| How does this runtime enroll at the mediator? | `replica-enrollment.ts` | `enroll`, `createReplica`, `transientConfirmations` |
| Which addresses does the account hold? | `replica-recipients.ts` | `addRecipients`, `holds` |
| What is the line to a mediator? | `link.ts` | `MediatorLink`, `ritual`, `bounded` |
| How is the replica's mail fetched and acknowledged? | `pickup.ts` | `Pickup` |
| Which keys does this runtime hold in hand? | `keyring.ts` | `Keyring`, `secretsOf` |
| How is a communication DID minted, disclosed, retired? | `dids.ts` | `createDid`, `disclose`, `retireDid`, `routeOf` |
| What does a presented DID resolve to? | `resolver.ts` | `resolve`, `knownLongForms`, `webDidUrl`, `WebResolverOptions` |
| What is retained of a peer's document, and how does didcomm read it? | `evidence.ts` | `commitResolution`, `readResolution`, `pinnedResolver` |
| What is a message, before any network work? | `send.ts` | `send`, `automaticDraft`, `manualNotificationDraft` |
| What goes on the wire for an intent? | `prepare.ts` | `prepare`, `prepareAll`, `hasExpired` |
| How is the one call made? | `dispatch.ts` | `dispatch`, `cancel` |
| What waits for a prerequisite, and for how long? | `dispatcher.ts` | `Dispatcher`, `RETRY_POLICY` |
| What does an acceptance the disk has not recorded owe? | `acceptance.ts` | `recordAcceptance` |
| Which key opens a delivery, and whose is it? | `receive/gate.ts` | `classifyRecipients`, `senderEvidence`, `senderProof` |
| How does a delivery reach the vault, wait, or end? | `receive/receiver.ts` | `Receiver`, `deliveryKey` |
| How is a delivery recorded as one observation? | `receive/receipt.ts` | `recordReceipt`, `receiptOf` |
| What does the vault owe on its own? | `reconcile.ts` | `recordOwed`, `recordOwedUnderLock` |
| What does a peer's acknowledgement earn? | `acknowledgements.ts` | `recordAcks` |
| What follows a receipt? | `receive/after.ts` | `afterReceipt` |
| What does an input earn on its own? | `effects.ts` | `reactTo`, `decideEffects`, `callEffects`, `completeResponse` |
| What does a protocol answer? | `handlers/` | `Handler`, `handlerFor`, `BUILT_IN_HANDLERS`, `effectTypesOf` |
| When does a disclosed address give way? | `privacy.ts` | `privateAddress`, `decidePrivateAddress`, `privacyPolicy` |
| How is a local DID replaced toward a peer? | `rotate.ts` | `rotate`, `decideRotation`, `completeNotification` |
| What is an application shown, and which manual steps are there? | `records.ts`, `views.ts` | `readRecords`, `manualProcedures`, `recorder` |
| What did this runtime observe? | `trace.ts` | `AgentTrace`, `tracePolicy` |
| What is on the wire? | `protocol/` | `unpack`, `parseInvitation`, `invitationUrl`, `resolveMediatorInput`, the type URIs |
| Which entity is missing, or in conflict? | `errors.ts` | `UnknownEntity`, `EntityConflict`, `Unusable`, `NoTarget`, … |

## Reading order

1. `action.ts` and `procedure.ts`: what authorizes a transport call, and the shape of every procedure that writes the vault.
2. `send.ts`, `prepare.ts`, `dispatch.ts`: a message as an intent, one package and one call; `dispatcher.ts` for the wait in between.
3. `receive/gate.ts`, `receive/receiver.ts`, `receive/receipt.ts`, then `reconcile.ts` and `effects.ts`: a delivery as one observation, what the vault owes over it, and what a live input earns.
4. `agent.ts`: how open, connect and each delivery put these together; `records.ts` for what the host is shown.
5. `mediation.ts`, `replica-enrollment.ts`, `replica-recipients.ts`, `link.ts`, `pickup.ts`: the mediator side.

## Usage

```ts
import { Agent, AgentTrace, createVault, openVault } from "@estoc/agent-core";
import { openNodeSqlite } from "@estoc/event-store/node";
```

The host opens the SQLite driver — `openNodeSqlite` on Node,
`openSqlitePool` from `@estoc/event-store/browser` in a Worker — and
hands it to `createVault` or `openVault`, which return the runtime and
the seed's `Keys`. `Agent.open(vault, options)` runs the agent with
networking off; `Agent.start` also connects every mediation the vault
must keep receiving on. `@estoc/daemon` is the host most programs want:
it does this wiring and serves records and procedures over RPC.

## Didcomm API

The agent takes `{ Message }` from whichever didcomm-rust build your
runtime loads — `@estoc/didcomm` (browser/workerd WASM, instantiated
your way) or `@estoc/didcomm-node`. Both export the same class. This
package refuses to know how the WASM is instantiated, because every bundler
and runtime does it differently.

The Estoc builds are didcomm-rust with one option added: `unpack` can leave
a `from_prior` header unverified, so that a rotation proof whose issuer is
out of reach does not stop the message it rides from being received. The
agent opens inbound envelopes that way and has the vault judge the proof
from the evidence it records; the upstream builds cannot open them so, and
`unpack` refuses one. `unpack` also holds the layers to one sender:
the plaintext's `from` and any signature inside must be the sealer's, and
an authenticated layer wrapped in an anonymous one is refused, since the
binding reports only the outer layer's recipients. The mediator link still
verifies the proof at unpack.

`@estoc/didcomm` is a peer dependency for its types only; install the build
you inject.

`fetch` and `WebSocket` are injectable too; the tests run two agents
against an in-process fake mediator that way (`test/fake-mediator.ts`).

## Development

```
pnpm test       # vitest: every module against an in-process fake mediator, and test/e2e/ over file vaults
pnpm build      # tsc → dist/
```

## License

Apache-2.0
