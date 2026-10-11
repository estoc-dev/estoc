# @estoc/vault

What the events of an `.estoc` vault mean, as a library over
`@estoc/event-store`: the identifiers, the schema of every event type,
the vault's own keys and DIDs, the evidence it keeps of its peers, the
folds that read an event set into what the vault knows, and the
decisions a writer takes over that fold before it commits. No storage,
no agent, no protocol: `@estoc/event-store` holds the events and
`@estoc/agent-core` runs on them.

The code and its tests are the definition: the payload schemas, the
deterministic identifiers, the stored formats, the folds and the
procedures, each module's leading comment stating what it is
responsible for. The [replica model](../../docs/replica-model/README.md)
keeps the contracts around them:
[vault events](../../docs/replica-model/vault-events.md) for the model
the events are read under, the principles and the boundaries,
[channels](../../docs/replica-model/channels.md) for channel identity
and the channel payloads, and
[distributed delivery](../../docs/replica-model/distributed-delivery.md)
for the hashes and the inbound identities.

## Modules

Each module answers one question. Its leading comment states its
responsibility, its exports are the entry points, and `test/` mirrors
`src/`. Every published identifier, key and document vector of the
specifications is a test, and the DIDs and signatures a fixed seed
derives are pinned there too.

| Question | Module | Entry points |
| --- | --- | --- |
| What kind of value is this? | `types.ts` | the nominal identifier types, `VaultData` |
| Which ID does a rule derive? | `ids.ts` | `inboundMessageId`, `executionId`, `effectKey`, `automaticMessageId`, `forwardId`, `mediationIdOf`, `successorDidId`, `startDidId`, `channelOf`, `canonicalWireId`, the key names |
| How is a public key spelled? | `public-key.ts` | `canonicalPublicKey`, `agreementKey` |
| Does this payload read? | `schema.ts`, `syntax.ts` | `readVaultEvent`, `readVaultDraft`, `vaultDraft` |
| What does a message store, and what identifies it? | `document.ts`, `projection.ts` | `storeMessage`, `wireAttachment`, `envelopeOf`, `readPlaintext`, `wirePlaintext`, `intentOf`, `plaintextCidOf`, `requestsAck`, `replyThread` |
| Which keys and DIDs are ours? | `identity.ts` | `Keys`, `mintDid`, `mintMediationDid`, `mintReplicaDid`, `checkDidCreated`, `documentSendsTo` |
| What does the vault retain of a peer's document? | `peer-document.ts` | `peerResolution`, `canonicalDidOf`, `authorizedMethodIds`, `methodPublicKey` |
| How is a proof signed, and what is it verified against? | `from-prior.ts`, `replica-grant.ts`, `recipient-proof.ts` | `signFromPrior`, `issuerLongFormOf`, `signReplicaGrant`, `verifyReplicaGrant`, `signRecipientProof` |
| Which events are there? | `fold/set.ts` | `VaultEventSet` |
| Who wrote, and what is the vault called? | `fold/author.ts` | `foldAuthors`, `foldLabel` |
| Which arrangements, replicas and DIDs carry mail? | `fold/mediation.ts`, `fold/replicas.ts`, `fold/dids.ts` | `foldMediations`, `foldReplicas`, `foldDids`, `requiredReceivingSet` |
| Is a retained document what its resolution says? | `fold/evidence.ts` | `verifyResolutions` |
| What does each receipt and each rotation establish on its own? | `fold/channels.ts` | `foldChannelEvidence`, `verifyProofs` |
| Which channel stands where, now? | `fold/continuity.ts` | `foldContinuity`: `head`, `witness`, `status`, `confirmedBy`, `blocked`, `decisionsIn` |
| Which events does a continuity fact rest on? | `fold/continuity-index.ts` | `Continuity.index`: `factOf`, `evidenceOf` |
| Which observations speak for the application? | `admission/model.ts` | `foldAdmissions`, `foldDispositions` |
| Which inputs are established, through which witness? | `fold/inbound.ts` | `foldInbound` |
| What has an outbound become, and what does it still need? What did an automatic operation come to? | `fold/outbound.ts` | `foldOutbound`: `outbounds`, `effectResult` |
| What must collection keep? | `fold/held.ts` | `heldRoots`, `retainedRoots`, `readState` |
| May this invitation still be handed out? | `fold/invitations.ts` | `foldInvitations` |
| What did the user decide about a contact? | `fold/contacts.ts` | `foldContacts` |
| What is shown for a channel, or a contact? | `fold/views.ts` | `foldViews` |
| Does this channel take new work? | `channel-policy.ts` | `senderGate`, `channelPolicy` |
| All of it, over one set | `fold/vault.ts` | `foldVault`, `checkVault`, `scanVault` |
| How does a decision commit? | `commit.ts` | `commitDecided`, `commitAndCollect`, for the procedures below |
| What does the event store keep? | `retention.ts` | `vaultRetention`, `vaultHeldRoots`, `collectGarbage` |
| How is a message erased, and kept erased? | `erasure.ts` | `eraseMessage`, `closeErasures` |
| Which admissions are owed? | `admission/record.ts` | `reconcileAdmissions`, `admitReceipts` |
| Where does a reply, or a notification, go? | `response-policy.ts` | `responseChannel`, `notificationChannel`, `automaticIntent` |
| Which records are one rotation intent, and which does a rotation reuse? | `rotation-policy.ts` | `rotationIntent`, `decisionGroups`, `decisionFor` |
| What does blocking or deleting a contact append? | `contact-commands.ts` | `blockChannels`, `deleteContact` |
| What does an open find unfinished? | `pending-work.ts` | `unfinishedWork` |

## Reading order

1. `types.ts` and `ids.ts`: the vocabulary, and the identifiers every rule derives.
2. `schema.ts`: what each event type carries, and the rules between its members.
3. `fold/set.ts`, then `fold/vault.ts`: how an event set is read, and which fold feeds which.
4. The folds, following the arguments `fold/vault.ts` passes from one to the next: a fold's inputs are the folds to read before it.
5. `commit.ts`, which commits one decision over a fold read under the writer lock, then the procedures: each states its own lock and batch boundaries.

## Example

```ts
import { channelOf, reconcileAdmissions, scanVault, senderGate } from "@estoc/vault";

const fold = await scanVault(vault, keys);
const channel = channelOf(ourDid, peerDid);
senderGate(fold, channel);              // { status: "open" }, or why the channel takes no new work
fold.views.channel(channel).inputs;     // the established inputs there, in canonical event order
fold.dispositions.disposition(cid);     // what one observation stands as: admitted, refused, ignored, pending
await reconcileAdmissions(vault, keys); // commit the admissions still owed, dispatching nothing
```

## Development

```
pnpm test       # vitest: identifiers, schemas, keys and proofs, the folds, the procedures
pnpm build      # tsc → dist/
```

## License

Apache-2.0
