import { decodeJwt } from "jose";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, test } from "vitest";

import { longToShort, resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store";
import {
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_EFFECT,
  PING_TYPE,
  PURE_ACK_EFFECT,
  ROTATION_NOTIFICATION_EFFECT,
  automaticMessageId,
  blockChannels,
  channelKey,
  effectKey,
  mintDid,
  reconcileAdmissions,
  scanVault,
  signFromPrior,
  startDidId,
  successorDidId,
  unfinishedWork,
  vaultDraft,
  type Did,
  type DidId,
  type EventReference,
  type MessageId,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault";

import { responding } from "../src/action.js";
import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { secretsResolverFor, type IMessage } from "../src/protocol/didcomm.js";
import {
  AgentTrace,
  EntityConflict,
  Keyring,
  Responding,
  NotificationConflict,
  Receiver,
  UnknownEntity,
  Unusable,
  completeNotification,
  createDid,
  createMediation,
  disclose,
  dispatch,
  enroll,
  manualNotificationDraft,
  pinnedResolver,
  privateAddress,
  reactTo,
  receiptOf,
  retireDid,
  rotate,
  selectMediation,
  unpack,
  type EffectOutcome,
  type Reacted,
  type RotateOptions,
  type Rotated,
  type Source,
  routeOf,
} from "../src/index.js";
import { after, copyOf, didcomm, directParty, mediatedParty, merged, newMediator, party, peerSealer, posting, refuseCommits, sealed, type DirectParty, type Fresh, type Post, mediatedRoute } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const ALICE_NEXT = "019b0000-0000-7000-8000-00000000000b" as DidId;
const ALICE_OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const BOB_FORK = "019b0000-0000-7000-8000-0000000000b2" as DidId;
const BOB_OTHER_FORK = "019b0000-0000-7000-8000-0000000000b3" as DidId;
const CHARLIE = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const DAVE = "019b0000-0000-7000-8000-0000000000d0" as DidId;
const EVE = "019b0000-0000-7000-8000-0000000000e0" as DidId;
const CREATED = 1_757_700_000;
const IAT = 1_757_700_000;

const DIRECT: Source = { kind: "direct" };
const BOB_ENDPOINT = "https://bob.example/didcomm";
const ALICE_ENDPOINT = "https://alice.example/didcomm";

const accepted = (): Response => new Response(null, { status: 202 });

type Holder = Pick<Fresh, "runtime" | "keys">;

const foldOf = (holder: Holder): Promise<VaultFold> => scanVault(holder.runtime.vault, holder.keys);

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, ALICE_ENDPOINT, ALICE), bob: await directParty(2, BOB_ENDPOINT, BOB) };
}

async function closeAll(...holders: Holder[]): Promise<void> {
  for (const holder of holders) await holder.runtime.close();
}

/** Alice's receiver over her vault's own receipt, the wire her messages go out on, and the options every rotation takes. */
async function rotating(alice: DirectParty, over: Partial<RotateOptions> = {}, answer: (post: Post) => Response = accepted) {
  const ring = await Keyring.load(alice.keys, await foldOf(alice));
  const receiver = new Receiver(alice.runtime, alice.keys, ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
  const wire = posting(answer);
  const options: RotateOptions = { dispatch: (action) => dispatch(alice.runtime, alice.keys, action, { didcomm, fetch: wire.fetch }), now: () => IAT * 1000, ...over };
  const observed = async (peer: DirectParty, extra: Partial<IMessage>, as?: string, to: string = alice.longFormDid) => {
    const received = await receiver.receive({ packed: await sealed(await peerSealer(peer, as), to, extra), source: DIRECT });
    if (received.outcome !== "received") throw new Error(`not received: ${JSON.stringify(received)}`);
    return received;
  };
  const receive = async (peer: DirectParty, extra: Partial<IMessage>, as?: string, to?: string): Promise<EventReference<"message.in">> => (await observed(peer, extra, as, to)).cid;
  const arrived = async (peer: DirectParty, extra: Partial<IMessage>, as?: string, to?: string): Promise<Responding> => {
    const received = await observed(peer, extra, as, to);
    if (received.live === null) throw new Error(`not live: ${received.cid}`);
    return responding(received.live);
  };
  const live = async (peer: DirectParty, extra: Partial<IMessage>, to?: string): Promise<Reacted> => reactTo(alice.runtime, alice.keys, await arrived(peer, extra, undefined, to), options);
  return { receiver, wire, options, arrived, receive, live };
}

const ping = (wire: string, extra: Partial<IMessage> = {}): Partial<IMessage> => ({ id: wire, type: PING_TYPE, body: { response_requested: true }, please_ack: [""], created_time: CREATED, ...extra });

function created(effect: EffectOutcome | undefined): Extract<EffectOutcome, { outcome: "created" }> {
  if (effect?.outcome !== "created") throw new Error(`not created: ${JSON.stringify(effect)}`);
  return effect;
}

function rotated(privacy: Awaited<ReturnType<typeof privateAddress>>): Rotated {
  if (privacy.outcome !== "rotated") throw new Error(`not rotated: ${JSON.stringify(privacy)}`);
  return privacy.rotation;
}

const successorOf = async (holder: Holder, rotation: Rotated) => (await foldOf(holder)).dids.entities.get(rotation.successor)!.created!;
const successorRoute = async (holder: Holder, rotation: Rotated) => routeOf((await foldOf(holder)).dids.entities.get(rotation.successor)!);

/** The envelope the message's one preparation names, opened as Bob opens it: with his secrets, the documents each vault holds. */
async function openedByBob(bob: DirectParty, alice: DirectParty, messageId: MessageId): Promise<JsonObject> {
  const outbound = (await foldOf(alice)).outbound.outbounds.get(messageId)!;
  const packed = new TextDecoder().decode((await alice.runtime.vault.objects.read(outbound.preparations[0]!.event.data.envelopeCid, 1 << 20)) as Uint8Array);
  const ring = await Keyring.load(bob.keys, await foldOf(bob));
  const his = pinnedResolver(await foldOf(bob));
  const hers = pinnedResolver(await foldOf(alice));
  const resolver = { resolve: async (did: string): Promise<DIDDoc | null> => (await his.resolve(did)) ?? hers.resolve(did) };
  return (await unpack(didcomm, packed, resolver, secretsResolverFor(ring.secrets()))).plaintext as unknown as JsonObject;
}

describe("a local rotation", () => {
  test("a manual rotation mints the successor and freezes the decision in one commit, notifies the peer once under an initial action carrying the proof, and asked again reuses the decision and mints nothing", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    await receive(bob, { type: BASIC_MESSAGE });

    const rotation = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.longFormDid }, options);
    expect([rotation.existed, rotation.channel]).toEqual([false, { localDid: alice.did, peerDid: bob.did }]);
    const successor = await successorOf(alice, rotation);
    expect([rotation.successor, successor.generation]).toEqual([startDidId(alice.did, bob.did), { kind: "start", profile: "v1", predecessor: alice.did, binding: bob.did }]);
    expect(rotation.decision.data).toMatchObject({ fromDidId: ALICE, peerDid: bob.did, toDidId: rotation.successor, sourceEventCid: null });
    expect(decodeJwt(rotation.decision.data.fromPrior)).toMatchObject({ iss: alice.longFormDid, sub: successor.longFormDid, iat: IAT });
    let fold = await foldOf(alice);
    const creation = fold.set.of("did.created").find((event) => event.data.didId === rotation.successor)!;
    expect([creation.at, routeOf(fold.dids.entities.get(rotation.successor)!)]).toEqual([rotation.decision.at, routeOf(fold.dids.entities.get(ALICE)!)]);
    expect(fold.continuity.status(rotation.decision.cid)).toEqual({ status: "verified" });
    expect(fold.continuity.head({ localDid: alice.did, peerDid: bob.did })).toEqual({ localDid: successor.did, peerDid: bob.did });

    const notification = created(rotation.notification);
    expect([notification.action.kind, notification.action.spent, notification.dispatched.outcome, wire.posts.map((post) => post.url)]).toEqual(["initial", true, "submitted", [BOB_ENDPOINT]]);
    expect(notification.intent.data).toMatchObject({
      msgType: EMPTY_MESSAGE_TYPE,
      thid: null,
      pthid: null,
      createdTime: null,
      expiresTime: null,
      pleaseAck: [""],
      ack: [],
      senderDidId: rotation.successor,
      recipientDid: bob.did,
      executionId: null,
      effectType: null,
      effectKey: null,
      sourceEventCid: null,
      rotationEventCid: rotation.decision.cid,
    });
    expect(fold.outbound.notificationFor(rotation.decision.cid)).toEqual({ status: "selected", messageId: notification.messageId });
    expect(fold.outbound.outbounds.get(notification.messageId)!.effect).toEqual({ status: "complete" });
    expect(await openedByBob(bob, alice, notification.messageId)).toMatchObject({ type: EMPTY_MESSAGE_TYPE, from: successor.longFormDid, from_prior: rotation.decision.data.fromPrior, please_ack: [""], body: {} });
    expect(unfinishedWork(fold).notifications).toEqual([]);

    const again = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    expect(again).toMatchObject({ existed: true, decision: { cid: rotation.decision.cid }, successor: rotation.successor, notification: { outcome: "existing", messageId: notification.messageId, action: null, dispatched: null } });
    fold = await foldOf(alice);
    expect([fold.dids.entities.size, fold.set.of("did.rotationSelected").length, wire.posts.length]).toEqual([2, 1, 1]);
    await closeAll(alice, bob);
  });

  test("a record of the same rotation another replica decided under its own proof joins the intent: asked again, the rotation reuses it under the first candidate record, lists both records and mints nothing; the second record's notification is its own, made by a completion, and carries the first record's proof", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    await receive(bob, { type: BASIC_MESSAGE });
    const rotation = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    const successor = await successorOf(alice, rotation);
    expect(rotation.records).toEqual([rotation.decision]);
    const fromPrior = await signFromPrior(alice.keys, { didId: ALICE, longFormDid: alice.longFormDid }, successor.longFormDid, IAT + 1);
    const other = await merged(alice.runtime, "did.rotationSelected", { fromDidId: ALICE, peerDid: bob.did, toDidId: rotation.successor, sourceEventCid: null, fromPrior }, after(rotation.decision.at, 1));
    let fold = await foldOf(alice);
    expect([fold.continuity.status(other.cid), fold.continuity.conflicts]).toEqual([{ status: "verified" }, []]);

    const again = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.longFormDid }, options);
    expect(again).toMatchObject({ existed: true, decision: { cid: rotation.decision.cid }, records: [{ cid: rotation.decision.cid }, { cid: other.cid }], successor: rotation.successor, notification: { outcome: "existing", messageId: created(rotation.notification).messageId } });
    fold = await foldOf(alice);
    expect([fold.dids.entities.size, fold.set.of("did.rotationSelected").length, wire.posts.length]).toEqual([2, 2, 1]);
    expect(unfinishedWork(fold).notifications.map((missing) => missing.decision.event.cid)).toEqual([other.cid]);

    const completed = created(await completeNotification(alice.runtime, alice.keys, other.cid as EventReference<"did.rotationSelected">, options));
    expect([completed.action.kind, completed.dispatched.outcome, wire.posts.length]).toEqual(["manual", "submitted", 2]);
    expect(completed.intent.data).toMatchObject({ senderDidId: rotation.successor, recipientDid: bob.did, rotationEventCid: other.cid });
    expect(await openedByBob(bob, alice, completed.messageId)).toMatchObject({ from: successor.longFormDid, from_prior: rotation.decision.data.fromPrior });
    fold = await foldOf(alice);
    expect(fold.outbound.notificationFor(other.cid)).toEqual({ status: "selected", messageId: completed.messageId });
    expect(unfinishedWork(fold)).toMatchObject({ notifications: [], notificationConflicts: [] });
    await closeAll(alice, bob);
  });

  test("the successor is the start the entry and the peer's start derive, on the predecessor's own route whatever arrangement is preferred; two runtimes of one seed deciding apart arrive at one entity, whose records join one intent when merged", async () => {
    const { alice, bob } = await parties();
    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    const { options, receive } = await rotating(alice);
    for (const peer of [bob, charlie]) await receive(peer, { type: BASIC_MESSAGE });
    const direct = routeOf((await foldOf(alice)).dids.entities.get(ALICE)!)!;
    const mediator = await newMediator();
    const { mediationId } = (await createMediation(alice.runtime, alice.keys, mediator.did as Did)).data;
    await alice.runtime.vault.commit([], [vaultDraft("mediation.granted", { mediationId, routingDid: mediator.did as Did })]);
    await selectMediation(alice.runtime, alice.keys, mediationId);
    expect((await foldOf(alice)).mediations.preferred).toBe(mediationId);
    const copy = await copyOf(1, alice);
    const { options: theirs } = await rotating({ ...copy, didId: ALICE, did: alice.did, longFormDid: alice.longFormDid });

    const hers = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    const his = await rotate(copy.runtime, copy.keys, { localDidId: ALICE, peerDid: bob.longFormDid }, theirs);
    expect([hers.existed, his.existed, hers.successor, his.successor]).toEqual([false, false, startDidId(alice.did, bob.did), startDidId(alice.did, bob.did)]);
    expect(await successorOf(copy, his)).toEqual(await successorOf(alice, hers));
    expect(await successorRoute(alice, hers)).toEqual(direct);
    expect(hers.decision.cid).not.toBe(his.decision.cid);

    await alice.runtime.ingest([...(await foldOf(copy)).set.all()]);
    const fold = await foldOf(alice);
    expect([fold.dids.entities.size, fold.set.of("did.created").length, fold.set.of("did.rotationSelected").length, fold.continuity.conflicts]).toEqual([2, 3, 2, []]);
    expect(fold.dids.entities.get(hers.successor)).toMatchObject({ live: true, conflict: false });
    const again = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    expect(again).toMatchObject({ existed: true, decision: { cid: hers.decision.cid }, records: [{ cid: hers.decision.cid }, { cid: his.decision.cid }] });

    const toCharlie = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: charlie.did }, options);
    expect([toCharlie.successor, (await successorOf(alice, toCharlie)).generation]).toEqual([startDidId(alice.did, charlie.did), { kind: "start", profile: "v1", predecessor: alice.did, binding: charlie.did }]);
    expect(toCharlie.successor).not.toBe(hers.successor);
    await closeAll(alice, bob, charlie, copy);
  });

  test("an entity recorded already under the successor's ID is reused only as exactly what would be made now, generation, route and document alike, and live: another route or another generation under the ID is refused with nothing written, and so is a retired successor", async () => {
    const { alice, bob } = await parties();
    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    const dave = await directParty(4, "https://dave.example/didcomm", DAVE);
    const eve = await directParty(5, "https://eve.example/didcomm", EVE);
    const { wire, options, receive } = await rotating(alice);
    for (const peer of [bob, charlie, dave, eve]) await receive(peer, { type: BASIC_MESSAGE });
    const direct = { kind: "direct", endpoint: ALICE_ENDPOINT } as const;
    const start = (peer: DirectParty) => ({ didId: startDidId(alice.did, peer.did), generation: { kind: "start", profile: "v1", predecessor: alice.did, binding: peer.did } as const });

    const elsewhere = await mintDid(alice.keys, start(bob).didId, { kind: "direct", endpoint: "https://elsewhere.example/didcomm" });
    await alice.runtime.vault.commit([], [vaultDraft("did.created", { didId: elsewhere.didId, did: elsewhere.did, longFormDid: elsewhere.longFormDid, generation: start(bob).generation })]);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options)).rejects.toThrow(new Unusable("DID", ALICE, [`the successor's ID ${elsewhere.didId} is held by an entity on another route`]));

    const foreign = await mintDid(alice.keys, start(charlie).didId, direct);
    await alice.runtime.vault.commit([], [vaultDraft("did.created", { didId: foreign.didId, did: foreign.did, longFormDid: foreign.longFormDid, generation: { kind: "entry", profile: "v9" } })]);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: charlie.did }, options)).rejects.toThrow(new Unusable("DID", ALICE, [`the successor's ID ${foreign.didId} is held by an entity of another generation`]));

    const exact = await mintDid(alice.keys, start(dave).didId, direct);
    const recorded = await merged(alice.runtime, "did.created", { didId: exact.didId, did: exact.did, longFormDid: exact.longFormDid, generation: start(dave).generation }, "2026-09-14T00:00:00.500Z");
    const retiring = await mintDid(alice.keys, start(eve).didId, direct);
    await alice.runtime.vault.commit([], [vaultDraft("did.created", { didId: retiring.didId, did: retiring.did, longFormDid: retiring.longFormDid, generation: start(eve).generation })]);
    await retireDid(alice.runtime, alice.keys, retiring.didId, "gone");
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: eve.did }, options)).rejects.toThrow(new Unusable("DID", ALICE, [`the successor ${retiring.didId} is recorded already and is not live: retired: gone`]));
    let fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected"), fold.set.of("did.created").length, wire.posts.length]).toEqual([[], 5, 0]);

    const reused = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: dave.did }, options);
    expect([reused.existed, reused.successor, reused.notification.outcome]).toEqual([false, exact.didId, "created"]);
    fold = await foldOf(alice);
    expect([fold.set.of("did.created").length, fold.set.of("did.created").filter((event) => event.data.didId === exact.didId).map((event) => event.cid)]).toEqual([5, [recorded.cid]]);
    expect(fold.continuity.status(reused.decision.cid)).toEqual({ status: "verified" });
    await closeAll(alice, bob, charlie, dave, eve);
  });

  test("a mediated predecessor hands its arrangement to the successor, named by the mediator's validated long form whichever spelling the arrangement is recorded under, and is continued only by a replica of that arrangement: a runtime enrolled nowhere or in another arrangement is refused with nothing written", async () => {
    const mediator = await newMediator();
    const alice = await mediatedParty(mediator, 1, ALICE);
    const bob = await directParty(2, BOB_ENDPOINT, BOB);
    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    const { options, receive } = await rotating(alice);
    for (const peer of [bob, charlie]) await receive(peer, { type: BASIC_MESSAGE });
    await alice.runtime.vault.commit([], [vaultDraft("mediation.granted", { mediationId: alice.mediationId, routingDid: longToShort(mediator.did) as Did })]);
    let fold = await foldOf(alice);
    expect(fold.mediations.mediations.get(alice.mediationId)).toMatchObject({ status: "usable", mediatorDid: mediator.did });
    expect(fold.replicas.replicas.get(alice.runtime.author)).toMatchObject({ mediationId: alice.mediationId, status: "member" });

    const nowhere = await copyOf(1, alice);
    const { options: theirs } = await rotating({ ...nowhere, didId: ALICE, did: alice.did, longFormDid: alice.longFormDid });
    await expect(rotate(nowhere.runtime, nowhere.keys, { localDidId: ALICE, peerDid: charlie.did }, theirs)).rejects.toThrow(new Unusable("DID", ALICE, [`this runtime is not enrolled in the arrangement ${alice.mediationId}, which routes the predecessor`]));
    const other = await party(await newMediator(201, "https://other.example/didcomm"), 1);
    await enroll(other.link, other.runtime, other.keys, other.confirmations, other.mediationId);
    await other.runtime.ingest([...fold.set.all()]);
    const { options: hers } = await rotating({ ...other, didId: ALICE, did: alice.did, longFormDid: alice.longFormDid });
    await expect(rotate(other.runtime, other.keys, { localDidId: ALICE, peerDid: charlie.did }, hers)).rejects.toThrow(new Unusable("DID", ALICE, [`this runtime is a replica of the arrangement ${other.mediationId}, not of ${alice.mediationId}, which routes the predecessor`]));
    for (const holder of [nowhere, other]) expect((await foldOf(holder)).set.of("did.rotationSelected")).toEqual([]);

    const rotation = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    const successor = await successorOf(alice, rotation);
    expect([rotation.existed, await successorRoute(alice, rotation)]).toEqual([false, mediatedRoute(alice.mediationId)]);
    expect((await resolveDIDCommDoc(successor.longFormDid))!.service[0]!.serviceEndpoint).toMatchObject({ uri: mediator.did });
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.set.of("mediation.created").length, fold.dids.entities.get(rotation.successor)]).toMatchObject([1, 1, { live: true, mediation: alice.mediationId }]);
    await closeAll(alice, bob, charlie, nowhere, other);
  });

  test("no rotation from an address the peer never wrote to, or wrote to only in an observation not admitted, in a denied channel, toward oneself, from an unknown entity, over a control input, or where decisions already compete", async () => {
    const { alice, bob } = await parties();
    const { options, receive } = await rotating(alice);
    const target = { localDidId: ALICE, peerDid: bob.did };
    const unconfirmed = new Unusable("channel", channelKey({ localDid: alice.did, peerDid: bob.did }), ["no admitted receipt shows the peer writing to exactly this address"]);
    await expect(rotate(alice.runtime, alice.keys, target, options)).rejects.toThrow(unconfirmed);

    const unwitnessed = await parties();
    const { options: over, receive: heard } = await rotating(unwitnessed.alice);
    refuseCommits(unwitnessed.alice.runtime, "message.admitted", 1);
    await expect(heard(unwitnessed.bob, { type: BASIC_MESSAGE })).rejects.toThrow("the disk is full for now");
    let fold = await foldOf(unwitnessed.alice);
    const [observation] = fold.set.of("message.in");
    expect([fold.continuity.model.confirmation(unwitnessed.alice.did, unwitnessed.bob.did).status, fold.dispositions.disposition(observation!.cid)]).toEqual(["confirmed", { status: "pending-admission", because: "the observation is not yet reconciled" }]);
    await expect(rotate(unwitnessed.alice.runtime, unwitnessed.alice.keys, target, over)).rejects.toThrow(new Unusable("channel", channelKey({ localDid: unwitnessed.alice.did, peerDid: unwitnessed.bob.did }), ["no admitted receipt shows the peer writing to exactly this address"]));
    expect((await reconcileAdmissions(unwitnessed.alice.runtime, unwitnessed.alice.keys)).map(({ data }) => data.sourceEventCid)).toEqual([observation!.cid]);
    fold = await foldOf(unwitnessed.alice);
    expect(fold.continuity.confirmedBy(unwitnessed.alice.did, unwitnessed.bob.did)?.event.cid).toBe(observation!.cid);
    expect((await rotate(unwitnessed.alice.runtime, unwitnessed.alice.keys, target, over)).existed).toBe(false);
    await closeAll(unwitnessed.alice, unwitnessed.bob);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: alice.longFormDid }, options)).rejects.toThrow(Unusable);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE_NEXT, peerDid: bob.did }, options)).rejects.toThrow(UnknownEntity);

    const control = await receive(bob, { type: EMPTY_MESSAGE_TYPE, body: {}, ack: [crypto.randomUUID()] });
    await expect(rotate(alice.runtime, alice.keys, { ...target, sourceEventCid: control }, options)).rejects.toThrow("a control input selects no rotation: it is pure-ack");

    await blockChannels(alice.runtime, alice.keys, [{ localDid: alice.did, peerDid: bob.did }], false);
    await expect(rotate(alice.runtime, alice.keys, target, options)).rejects.toThrow("the channel is denied");
    await closeAll(alice, bob);

    const fresh = await parties();
    const { options: fresh0, receive: written } = await rotating(fresh.alice);
    await written(fresh.bob, { type: BASIC_MESSAGE });
    const route = routeOf((await foldOf(fresh.alice)).dids.entities.get(ALICE)!)!;
    for (const didId of [ALICE_NEXT, ALICE_OTHER]) {
      const { minted } = await createDid(fresh.alice.runtime, fresh.alice.keys, route, didId);
      const fromPrior = await signFromPrior(fresh.alice.keys, { didId: ALICE, longFormDid: fresh.alice.longFormDid }, minted.longFormDid, IAT);
      await fresh.alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: fresh.bob.did, toDidId: didId, sourceEventCid: null, fromPrior })]);
    }
    await expect(rotate(fresh.alice.runtime, fresh.alice.keys, target, fresh0)).rejects.toThrow(Unusable);
    expect((await foldOf(fresh.alice)).dids.entities.size).toBe(3);
    await closeAll(fresh.alice, fresh.bob);
  });

  test("a rotation away from a branch address is a next of it, and toward a peer the usable history does not lead to from the branch's anchor it waits and writes nothing; a branch address is neither disclosed nor created as an entry", async () => {
    const { alice, bob } = await parties();
    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    const { wire, options, receive } = await rotating(alice);
    await receive(bob, { type: BASIC_MESSAGE });
    const forward = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    const first = await successorOf(alice, forward);
    await receive(bob, { type: BASIC_MESSAGE }, undefined, first.longFormDid);
    await receive(charlie, { type: BASIC_MESSAGE }, undefined, first.longFormDid);
    let fold = await foldOf(alice);
    expect([fold.continuity.confirmedBy(first.did, bob.did), fold.continuity.confirmedBy(first.did, charlie.did)]).not.toContain(null);
    const toCharlie = { localDid: first.did, peerDid: charlie.did };
    await expect(rotate(alice.runtime, alice.keys, { localDidId: first.didId, peerDid: charlie.did }, options)).rejects.toThrow(new Unusable("channel", channelKey(toCharlie), [`the successor is not decided, waiting: no usable history leads from the branch's anchor, ${alice.did} toward ${bob.did}, to the pair`]));
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.dids.entities.size, wire.posts.length]).toEqual([1, 2, 1]);

    const onward = await rotate(alice.runtime, alice.keys, { localDidId: first.didId, peerDid: bob.did }, options);
    const second = await successorOf(alice, onward);
    expect([onward.existed, second.didId, second.generation, await successorRoute(alice, onward)]).toEqual([false, successorDidId(first.did), { kind: "next", profile: "v1", predecessor: first.did }, routeOf(fold.dids.entities.get(ALICE)!)]);
    fold = await foldOf(alice);
    expect([fold.continuity.status(onward.decision.cid), fold.continuity.conflicts, fold.continuity.head({ localDid: alice.did, peerDid: bob.did })]).toEqual([{ status: "verified" }, [], { localDid: second.did, peerDid: bob.did }]);
    expect(fold.dids.lineage(second.didId)).toEqual({ status: "branch", anchor: { localDid: alice.did, peerDid: bob.did }, start: first.didId });

    await expect(disclose(null, alice.runtime, alice.keys, first.didId, { as: "direct" })).rejects.toThrow(new Unusable("DID", first.didId, ["only an entry is disclosed, and this address is in a private branch: create an entry to disclose"]));
    await expect(createDid(alice.runtime, alice.keys, routeOf(fold.dids.entities.get(ALICE)!)!, first.didId)).rejects.toThrow(new EntityConflict("DID", first.didId, "a start, not an entry"));
    expect((await foldOf(alice)).set.of("did.disclosed")).toEqual([]);
    await closeAll(alice, bob, charlie);
  });

  test("no rotation toward a peer that has replaced its DID, whatever a join at the old pair would make of a waiting decision: nothing is written", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    const bobRoute = routeOf((await foldOf(bob)).dids.entities.get(BOB)!)!;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_PRIOR);
    await receive(bob, { type: BASIC_MESSAGE }, prior.longFormDid);
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    await receive(bob, { type: BASIC_MESSAGE, from_prior: proof });
    const aliceRoute = routeOf((await foldOf(alice)).dids.entities.get(ALICE)!)!;
    const { minted: next } = await createDid(alice.runtime, alice.keys, aliceRoute, ALICE_NEXT);
    await receive(bob, { type: BASIC_MESSAGE }, undefined, next.longFormDid);
    const waiting = await signFromPrior(alice.keys, { didId: ALICE_NEXT, longFormDid: next.longFormDid }, alice.longFormDid, IAT);
    const [pending] = await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE_NEXT, peerDid: prior.did, toDidId: ALICE, sourceEventCid: null, fromPrior: waiting })]);
    const old = { localDid: alice.did, peerDid: prior.did };
    let fold = await foldOf(alice);
    expect([fold.continuity.status(pending!.cid).status, fold.continuity.confirmedBy(alice.did, prior.did) !== null, fold.continuity.head(old)]).toEqual(["pending-history", true, { localDid: alice.did, peerDid: bob.did }]);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: prior.did }, options)).rejects.toThrow(new Unusable("channel", channelKey(old), ["the peer has replaced its DID"]));
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.dids.entities.size, fold.continuity.head(old), fold.continuity.conflicts, wire.posts.length]).toEqual([1, 2, { localDid: alice.did, peerDid: bob.did }, [], 0]);
    await closeAll(alice, bob);
  });

  test("a decision whose joins would carry an existing peer fork into a channel no conflict reached is refused with nothing written, while a rotation the fork does not touch goes through beside it", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    const bobRoute = routeOf((await foldOf(bob)).dids.entities.get(BOB)!)!;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_PRIOR);
    const { minted: fork } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_FORK);
    const { minted: otherFork } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_OTHER_FORK);
    const aliceRoute = routeOf((await foldOf(alice)).dids.entities.get(ALICE)!)!;
    const { minted: next } = await createDid(alice.runtime, alice.keys, aliceRoute, ALICE_NEXT);
    await receive(bob, { type: BASIC_MESSAGE }, prior.longFormDid);
    const proofs: [{ didId: DidId; longFormDid: Did }, Did][] = [
      [{ didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid],
      [{ didId: BOB, longFormDid: bob.longFormDid }, fork.longFormDid],
      [{ didId: BOB, longFormDid: bob.longFormDid }, otherFork.longFormDid],
    ];
    for (const [from, to] of proofs) await receive(bob, { type: BASIC_MESSAGE, from_prior: await signFromPrior(bob.keys, from, to, IAT) }, to);
    await receive(bob, { type: BASIC_MESSAGE }, fork.longFormDid, next.longFormDid);
    const healthy = { localDid: next.did, peerDid: fork.did };
    let fold = await foldOf(alice);
    expect([fold.continuity.conflicts.map(({ conflict }) => conflict.kind), fold.continuity.conflicted(healthy), fold.continuity.head(healthy), fold.continuity.confirmedBy(alice.did, prior.did) !== null]).toEqual([["competing-changes"], false, healthy, true]);

    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: prior.did }, options)).rejects.toThrow(/^channel \[.*\] is not usable: the channel's continuity is in conflict$/);
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.set.of("message.out").length, fold.dids.entities.size, fold.continuity.conflicted(healthy), fold.continuity.head(healthy), wire.posts.length]).toEqual([0, 0, 2, false, healthy, 0]);

    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    await receive(charlie, { type: BASIC_MESSAGE }, undefined, next.longFormDid);
    const beside = await rotate(alice.runtime, alice.keys, { localDidId: ALICE_NEXT, peerDid: charlie.did }, options);
    fold = await foldOf(alice);
    expect([beside.existed, fold.continuity.status(beside.decision.cid), fold.continuity.conflicts.length, beside.notification.outcome, wire.posts.length, fold.dids.entities.size]).toEqual([false, { status: "verified" }, 1, "created", 1, 3]);
    await closeAll(alice, bob, charlie);
  });

  test("the private-address policy: the first live application input at a disclosed address selects a successor over that input and notifies on its thread; a later input reuses the decision; one at the undisclosed successor, a control input or an undisclosed address selects nothing", async () => {
    const { alice, bob } = await parties();
    await disclose(null, alice.runtime, alice.keys, ALICE, { as: "direct" });
    const { wire, options, arrived } = await rotating(alice);
    const wireId = crypto.randomUUID() as WireMessageId;
    const input = await arrived(bob, ping(wireId));
    const reacted = await reactTo(alice.runtime, alice.keys, input, options);
    expect(reacted.effects.map((effect) => [effect.effectType, effect.outcome])).toEqual([
      [PURE_ACK_EFFECT, "created"],
      [PING_RESPONSE_EFFECT, "created"],
    ]);
    const rotation = rotated(await privateAddress(alice.runtime, alice.keys, input, options));
    expect([rotation.existed, rotation.successor, rotation.decision.data.sourceEventCid, rotation.decision.data.peerDid]).toEqual([false, startDidId(alice.did, bob.did), reacted.cid, bob.did]);
    const successor = await successorOf(alice, rotation);
    const notification = created(rotation.notification);
    expect(notification.messageId).toBe(automaticMessageId(effectKey(reacted.executionId!, ROTATION_NOTIFICATION_EFFECT)));
    expect(notification.intent.data).toMatchObject({ msgType: EMPTY_MESSAGE_TYPE, thid: wireId, pthid: null, createdTime: CREATED, pleaseAck: [""], ack: [], senderDidId: rotation.successor, recipientDid: bob.did, executionId: reacted.executionId, effectType: ROTATION_NOTIFICATION_EFFECT, sourceEventCid: reacted.cid, rotationEventCid: rotation.decision.cid });
    expect([notification.action.kind, notification.dispatched.outcome, wire.posts.length]).toEqual(["initial", "submitted", 3]);
    expect(await openedByBob(bob, alice, notification.messageId)).toMatchObject({ type: EMPTY_MESSAGE_TYPE, thid: wireId, from: successor.longFormDid, from_prior: rotation.decision.data.fromPrior });
    let fold = await foldOf(alice);
    expect([fold.outbound.outbounds.get(notification.messageId)!.effect, unfinishedWork(fold).notifications]).toEqual([{ status: "complete" }, []]);

    const later = await arrived(bob, ping(crypto.randomUUID()));
    await reactTo(alice.runtime, alice.keys, later, options);
    expect(await privateAddress(alice.runtime, alice.keys, later, options)).toEqual({ outcome: "reused", decision: rotation.decision });
    fold = await foldOf(alice);
    expect([fold.dids.entities.size, fold.set.of("did.rotationSelected").length, fold.set.of("message.out").length, wire.posts.length]).toEqual([2, 1, 5, 5]);

    const atSuccessor = await arrived(bob, { type: BASIC_MESSAGE }, undefined, successor.longFormDid);
    expect(await privateAddress(alice.runtime, alice.keys, atSuccessor, options)).toEqual({ outcome: "none", because: "the local DID is not disclosed" });
    expect((await foldOf(alice)).continuity.confirmedBy(successor.did, bob.did)).not.toBeNull();
    const control = await arrived(bob, { type: EMPTY_MESSAGE_TYPE, body: {}, ack: [wireId] });
    expect(await privateAddress(alice.runtime, alice.keys, control, options)).toEqual({ outcome: "none", because: "a control input selects no rotation: it is pure-ack" });
    await closeAll(alice, bob);

    const undisclosed = await parties();
    const { options: theirs, arrived: written } = await rotating(undisclosed.alice);
    const chat = await written(undisclosed.bob, { type: BASIC_MESSAGE });
    expect(await privateAddress(undisclosed.alice.runtime, undisclosed.alice.keys, chat, theirs)).toEqual({ outcome: "none", because: "the local DID is not disclosed" });
    expect((await foldOf(undisclosed.alice)).set.of("did.rotationSelected")).toEqual([]);
    await closeAll(undisclosed.alice, undisclosed.bob);
  });

  test("a decision whose notification the disk refused is listed and completed by hand under a manual action; completed again it calls nothing; several intents naming it are a conflict no completion resolves", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const { wire, options, receive } = await rotating(alice, { trace });
    await receive(bob, { type: BASIC_MESSAGE });
    refuseCommits(alice.runtime, "message.out", 1);
    const rotation = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    expect([rotation.existed, rotation.notification.outcome, wire.posts.length]).toEqual([false, "refused", 0]);
    expect((await trace.read({ type: "diag.effect" })).map((entry) => entry.data)).toMatchObject([{ executionId: null, effectType: ROTATION_NOTIFICATION_EFFECT, reason: "the disk is full for now" }]);
    const successor = await successorOf(alice, rotation);
    let fold = await foldOf(alice);
    expect(unfinishedWork(fold).notifications.map((missing) => [missing.decision.event.cid, missing.channel, missing.source])).toEqual([[rotation.decision.cid, { localDid: successor.did, peerDid: bob.did }, null]]);
    const rotationEventCid = rotation.decision.cid as EventReference<"did.rotationSelected">;

    const completed = created(await completeNotification(alice.runtime, alice.keys, rotationEventCid, options));
    expect([completed.action.kind, completed.action.spent, completed.dispatched.outcome, wire.posts.length]).toEqual(["manual", true, "submitted", 1]);
    expect(completed.intent.data).toMatchObject({ senderDidId: rotation.successor, recipientDid: bob.did, rotationEventCid: rotation.decision.cid, sourceEventCid: null, thid: null });
    const again = await completeNotification(alice.runtime, alice.keys, rotationEventCid, options);
    expect(again).toMatchObject({ outcome: "existing", messageId: completed.messageId, action: { kind: "manual", spent: false }, dispatched: { outcome: "none", because: "submitted" } });
    await expect(completeNotification(alice.runtime, alice.keys, crypto.randomUUID() as EventReference<"did.rotationSelected">, options)).rejects.toThrow(UnknownEntity);

    fold = await foldOf(alice);
    const other = manualNotificationDraft(fold, uuidv7() as MessageId, { localDid: successor.did, peerDid: bob.did }, { type: EMPTY_MESSAGE_TYPE, body: {}, pleaseAck: [""], ack: [] }, rotationEventCid);
    await alice.runtime.vault.commit(other.objects, [other.draft]);
    await expect(completeNotification(alice.runtime, alice.keys, rotationEventCid, options)).rejects.toThrow(NotificationConflict);
    fold = await foldOf(alice);
    expect([unfinishedWork(fold).notificationConflicts.length, fold.outbound.outbounds.get(completed.messageId)!.work.kind, wire.posts.length]).toEqual([1, "none", 1]);
    await closeAll(alice, bob);
  });

  test("a selecting input whose peer has since replaced its DID permits no missing notification to be made, while the decision stands and is reused", async () => {
    const { alice, bob } = await parties();
    await disclose(null, alice.runtime, alice.keys, ALICE, { as: "direct" });
    const { wire, options, arrived } = await rotating(alice);
    const route = routeOf((await foldOf(bob)).dids.entities.get(BOB)!)!;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, route, BOB_PRIOR);
    const first = await arrived(bob, ping(crypto.randomUUID()), prior.longFormDid);
    refuseCommits(alice.runtime, "message.out", 1);
    const rotation = rotated(await privateAddress(alice.runtime, alice.keys, first, options));
    expect([rotation.notification.outcome, rotation.decision.data.peerDid]).toEqual(["refused", prior.did]);
    const rotationEventCid = rotation.decision.cid as EventReference<"did.rotationSelected">;
    expect(unfinishedWork(await foldOf(alice)).notifications.map((missing) => missing.decision.event.cid)).toEqual([rotation.decision.cid]);

    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    const moved = await arrived(bob, ping(crypto.randomUUID(), { from_prior: proof }));
    let fold = await foldOf(alice);
    expect([fold.continuity.status(moved.cid), fold.continuity.superseded({ localDid: alice.did, peerDid: prior.did }), unfinishedWork(fold).notifications]).toEqual([{ status: "verified" }, true, []]);
    expect(await completeNotification(alice.runtime, alice.keys, rotationEventCid, options)).toEqual({ effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "none", because: "the successor cannot send to the peer: the peer has replaced its DID" });
    expect(await privateAddress(alice.runtime, alice.keys, moved, options)).toEqual({ outcome: "reused", decision: rotation.decision });
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.dids.entities.size, wire.posts.length]).toEqual([1, 2, 0]);
    expect(fold.continuity.head({ localDid: alice.did, peerDid: prior.did })).toEqual({ localDid: (await successorOf(alice, rotation)).did, peerDid: bob.did });
    await closeAll(alice, bob);
  });
});
