import { CompactSign, base64url, decodeProtectedHeader, importJWK, type CompactJWSHeaderParameters } from "jose";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it, test } from "vitest";

import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { canonicalText, type JsonObject } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import {
  KEY_AGREEMENT_METHOD,
  Keys,
  inputDocumentOf,
  mintDid,
  mintReplicaDid,
  peerResolution,
  scanVault,
  signFromPrior,
  signReplicaGrant,
  vaultDraft,
  type Did,
  type DidId,
  type DidUrl,
  type MediationId,
  type PublicKey,
  type ReplicaId,
} from "@estoc/vault";

import { recipientEndOf, seal, type Ends } from "../src/ends.js";
import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { plainMessage } from "../src/protocol/didcomm.js";
import { resolve } from "../src/resolver.js";
import {
  Agent,
  AgentTrace,
  NotAReplica,
  ReceiverClosed,
  SNAPSHOT_LINK,
  UnknownEntity,
  Unusable,
  blobName,
  createMediation,
  readSnapshotLink,
  selectMediation,
  snapshotLinkBody,
  type BlobLink,
  type Inbound,
  type SnapshotLinkReceived,
} from "../src/index.js";
import { Keyring } from "../src/keyring.js";
import { Receiver, deliveryKey, type Delivery } from "../src/receive/receiver.js";
import { replicaReceiptOf } from "../src/replica-channel.js";
import { network, type FakeMediator } from "./fake-mediator.js";
import { copyOf, didcomm, forwarded, newMediator, party, sealed, seedOf, type Fresh } from "./helpers.js";

const MEDIATOR = "https://fake-mediator/";
const PRIOR = "019b0000-0000-7000-8000-0000000000f0" as DidId;
const ADDRESS = "019b0000-0000-7000-8000-0000000000a0" as DidId;
const PROOF_IAT = 1_757_700_000;

type Transport = Pick<FakeMediator, "fetch" | "WebSocket">;

/** A runtime of the vault with its agent open and taking snapshot links, its replica enrolled in an arrangement. */
interface Running extends Fresh {
  agent: Agent;
  trace: AgentTrace;
  mediationId: MediationId;
  replica: { did: Did; longFormDid: Did };
  links: SnapshotLinkReceived[];
  inbounds: Inbound[];
}

const closing: { agent: Agent; runtime: Fresh["runtime"] }[] = [];

afterEach(async () => {
  for (const { agent, runtime } of closing.splice(0)) {
    agent.close();
    await runtime.close();
  }
});

async function opened(fresh: Fresh, transport: Transport, links: SnapshotLinkReceived[] = [], inbounds: Inbound[] = [], trace?: AgentTrace): Promise<Agent> {
  const agent = await Agent.open(fresh, {
    didcomm,
    fetch: transport.fetch,
    WebSocket: transport.WebSocket,
    trace: trace ?? (await AgentTrace.open(fresh.runtime.local)),
    localOptions: fresh.runtime.local.options,
    privateAddresses: false,
    liveDelivery: false,
    onInbound: (inbound) => inbounds.push(inbound),
    onSnapshotLink: (received) => {
      links.push(received);
    },
  });
  closing.push({ agent, runtime: fresh.runtime });
  return agent;
}

async function running(fresh: Fresh, mediationId: MediationId, transport: Transport): Promise<Running> {
  const links: SnapshotLinkReceived[] = [];
  const inbounds: Inbound[] = [];
  const trace = await AgentTrace.open(fresh.runtime.local);
  const agent = await opened(fresh, transport, links, inbounds, trace);
  const { replica } = await agent.enroll(mediationId);
  if (replica.did === null || replica.longFormDid === null) throw new Error("the replica has no DID");
  return { ...fresh, agent, trace, mediationId, replica: { did: replica.did, longFormDid: replica.longFormDid }, links, inbounds };
}

/** The first runtime of a vault, enrolled at `mediator` and selecting it, so that every runtime of the vault keeps receiving there. */
async function first(mediator: FakeMediator, transport: Transport = mediator): Promise<Running> {
  const p = await party(mediator, 1);
  const r = await running(p, p.mediationId, transport);
  await selectMediation(p.runtime, p.keys, p.mediationId);
  return r;
}

/** Another runtime holding everything `of` holds, enrolled at the same arrangement after the copy: `of` has never heard of it. */
async function another(of: Running, transport: Transport): Promise<Running> {
  return running(await copyOf(1, of), of.mediationId, transport);
}

const addressOf = (r: Pick<Running, "runtime" | "replica">) => ({ replicaId: r.runtime.author, longFormDid: r.replica.longFormDid });

type ReplicaInput = { verificationMethod: JsonObject[]; keyAgreement: string[] };

/**
 * Another runtime holding everything `of` holds, its replica bound to
 * `of`'s arrangement by a grant the seed signs for the document the
 * seed's template gives with `edit` made to it: a document another
 * implementation might have written.
 */
async function boundBy(of: Running, mediatorDid: string, edit: (input: ReplicaInput, keyAgreement: PublicKey) => void): Promise<Fresh> {
  const copy = await copyOf(1, of);
  const replicaId = copy.runtime.author;
  const replicaKeys = await copy.keys.replicaKeys(replicaId);
  const input = inputDocumentOf(replicaKeys, mediatorDid);
  edit(input as unknown as ReplicaInput, replicaKeys.keyAgreement.publicKey);
  const longFormDid = encodeLongForm(input);
  const creation = (await scanVault(copy.runtime.vault, copy.keys)).set.of("mediation.created").find((event) => event.data.mediationId === of.mediationId);
  if (creation === undefined) throw new Error("the arrangement is not recorded");
  const template = await signReplicaGrant(copy.keys, creation.data, replicaId);
  const payload = { ...(JSON.parse(new TextDecoder().decode(base64url.decode(template.split(".")[1] as string))) as JsonObject), replica_did: longToShort(longFormDid), replica_long_form: longFormDid };
  const account = (await copy.keys.mediationKeys(of.mediationId)).authentication;
  const grant = await new CompactSign(new TextEncoder().encode(canonicalText(payload)))
    .setProtectedHeader(decodeProtectedHeader(template) as CompactJWSHeaderParameters)
    .sign(await importJWK(account.privateJwk(), "EdDSA"));
  await copy.runtime.vault.commit([], [vaultDraft("replica.created", { replicaId, mediationId: of.mediationId, grant })]);
  return copy;
}

async function snapshotAt(base: string): Promise<BlobLink> {
  const hash = await blobName(crypto.getRandomValues(new Uint8Array(64)));
  return { url: `${base}b/${hash}`, hash, key: crypto.getRandomValues(new Uint8Array(32)) };
}

async function seedKeys(fill: number): Promise<Keys> {
  const seedKey = await importSeed(seedOf(fill));
  return Keys.open(seedKey, await Keys.anchorOf(seedKey));
}

/** Whoever holds a seed, writing as one replica of it: the ID, and the DID the seed derives for it at `mediatorDid`. */
interface Writer {
  keys: Keys;
  replicaId: ReplicaId;
  did: Did;
  longFormDid: Did;
}

async function writer(keys: Keys, mediatorDid: string, replicaId = uuidv7() as ReplicaId): Promise<Writer> {
  return { keys, replicaId, ...(await mintReplicaDid(keys, replicaId, mediatorDid as Did)) };
}

/** The ends from the writer, spelled by its long form unless told otherwise, to the long form `to`. */
async function endsOf(from: Writer, to: Did, options: { short?: boolean; fromPrior?: Ends["fromPrior"] } = {}): Promise<Ends> {
  const key = (await from.keys.replicaKeys(from.replicaId)).keyAgreement;
  const answer = await resolve(to, () => null);
  if (answer.outcome !== "resolved") throw new Error(answer.reason);
  const recipient = recipientEndOf(to, answer.resolution, key);
  if (recipient === null) throw new Error(`${to} offers no key to seal to`);
  const did = options.short === true ? from.did : from.longFormDid;
  return { sender: { did, resolution: peerResolution(from.longFormDid), methodId: `${from.longFormDid}${KEY_AGREEMENT_METHOD}` as DidUrl, key }, recipient, fromPrior: options.fromPrior ?? null };
}

async function mail(ends: Ends, type: string, body: JsonObject): Promise<string> {
  const plaintext = plainMessage(type, ends.sender.did, ends.recipient.did, body) as unknown as JsonObject;
  return seal(ends, ends.fromPrior === null ? plaintext : { ...plaintext, from_prior: ends.fromPrior.proof }, didcomm);
}

async function eventsOf(r: Pick<Running, "runtime" | "keys">): Promise<number> {
  return [...(await scanVault(r.runtime.vault, r.keys)).set.all()].length;
}

const queued = (mediator: FakeMediator): number => [...mediator.queues.values()].reduce((sum, queue) => sum + queue.length, 0);

describe("a snapshot-link body", () => {
  test("reads back as written, and reads as nothing but the four strings in their shapes", async () => {
    const replicaId = uuidv7() as ReplicaId;
    const link = await snapshotAt(MEDIATOR);
    const body = snapshotLinkBody({ replicaId, link });
    expect(Object.keys(body).sort()).toEqual(["hash", "key", "replica_id", "url"]);
    expect(readSnapshotLink(body)).toEqual({ replicaId, link });
    expect(readSnapshotLink(JSON.parse(JSON.stringify(body)))).toEqual({ replicaId, link });

    const { replica_id: _, ...withoutId } = body;
    const key = body["key"] as string;
    const hash = body["hash"] as string;
    const unreadable: unknown[] = [
      null,
      "a link",
      [body],
      withoutId,
      { ...body, size: "64" },
      { ...body, replica_id: "replica-1" },
      { ...body, replica_id: crypto.randomUUID() },
      { ...body, url: "/b/relative" },
      { ...body, url: 42 },
      { ...body, hash: hash.toUpperCase() },
      { ...body, hash: hash.slice(0, -1) },
      { ...body, key: `${key}=` },
      { ...body, key: key.slice(0, -2) },
      { ...body, key: key.replace(/.$/, key.endsWith("B") ? "C" : "B") },
    ];
    for (const value of unreadable) expect(readSnapshotLink(value), JSON.stringify(value)).toBeNull();
  });
});

describe("the replica channel", () => {
  it("carries a snapshot link from one replica of the seed to another through their mediator, though the recipient has never heard of the sender", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    const b = await another(a, mediator);
    expect((await scanVault(a.runtime.vault, a.keys)).replicas.replicas.has(b.runtime.author)).toBe(false);
    const events = await eventsOf(a);

    const link = await snapshotAt(MEDIATOR);
    await (await (await b.agent.arrangement(b.mediationId)).membership()).sendSnapshotLink(addressOf(a), link);
    expect(mediator.queues.get(a.replica.did)).toHaveLength(1);
    const [connection] = await a.agent.connect();
    expect(connection).toMatchObject({ unreachable: null, drained: { acked: 1, ended: "empty" } });
    await a.agent.settled();
    expect(a.links).toEqual([{ mediationId: a.mediationId, replicaId: b.runtime.author, link }]);
    expect(a.inbounds.map((inbound) => inbound.received)).toMatchObject([{ outcome: "handed" }]);
    expect(mediator.queues.get(a.replica.did)).toEqual([]);
    expect(await eventsOf(a)).toBe(events);
    expect(a.agent.discardedDeliveries()).toEqual([]);
    const ofType = async (r: Running, what: string) => (await r.trace.read({ stream: "envelope" })).filter((entry) => entry.type === what && (entry.data as { type?: string }).type === SNAPSHOT_LINK);
    expect(await ofType(b, "envelope.seal")).toHaveLength(1);
    expect(await ofType(a, "envelope.open")).toHaveLength(1);

    const back = await snapshotAt(MEDIATOR);
    await (await (await a.agent.arrangement(a.mediationId)).membership()).sendSnapshotLink(addressOf(b), back);
    await b.agent.connect();
    expect(b.links).toEqual([{ mediationId: a.mediationId, replicaId: a.runtime.author, link: back }]);
    expect(mediator.queues.get(b.replica.did)).toEqual([]);
  });

  it("hands the host nothing that does not authenticate as another replica of the seed or is not a snapshot link the mediator serves: each is terminal, acknowledged, and leaves nothing in the vault", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    const events = await eventsOf(a);
    const to = a.replica.longFormDid;
    const sibling = await writer(a.keys, mediator.did);
    const stranger = await writer(await seedKeys(3), mediator.did);
    const elsewhere = await writer(a.keys, "did:web:elsewhere.example", sibling.replicaId);
    const self = { keys: a.keys, replicaId: a.runtime.author, ...a.replica };
    const prior = await mintDid(a.keys, PRIOR, { kind: "mediated", routingDid: mediator.did as Did });
    const proof = await signFromPrior(a.keys, { didId: PRIOR, longFormDid: prior.longFormDid }, sibling.longFormDid, PROOF_IAT);
    const body = async (replicaId: ReplicaId, base = MEDIATOR) => snapshotLinkBody({ replicaId, link: await snapshotAt(base) });

    const cases: [string, Promise<string>, RegExp][] = [
      ["another seed's replica", mail(await endsOf(stranger, to), SNAPSHOT_LINK, await body(stranger.replicaId)), /the sender is not replica .* of this seed/],
      ["a body naming another replica than the sender", mail(await endsOf(sibling, to), SNAPSHOT_LINK, await body(uuidv7() as ReplicaId)), /the sender is not replica/],
      ["a sender at another mediator", mail(await endsOf(elsewhere, to), SNAPSHOT_LINK, await body(sibling.replicaId)), /not the mediator/],
      ["a body naming this runtime's own replica", mail(await endsOf(sibling, to), SNAPSHOT_LINK, await body(a.runtime.author)), /own replica ID/],
      ["this runtime's own replica DID as the sender", mail(await endsOf(self, to), SNAPSHOT_LINK, await body(a.runtime.author)), /is the recipient itself/],
      ["a link elsewhere than the mediator", mail(await endsOf(sibling, to), SNAPSHOT_LINK, await body(sibling.replicaId, "https://elsewhere.example/")), /no https URL the mediator serves/],
      ["a link at the mediator's host over http", mail(await endsOf(sibling, to), SNAPSHOT_LINK, await body(sibling.replicaId, "http://fake-mediator/")), /no https URL the mediator serves/],
      ["a sender spelled by its short form", mail(await endsOf(sibling, to, { short: true }), SNAPSHOT_LINK, await body(sibling.replicaId)), /short form/],
      ["an anonymous envelope", sealed(null, to, { type: SNAPSHOT_LINK, body: await body(sibling.replicaId) }), /anonymous/],
      ["a rotation proof", mail(await endsOf(sibling, to, { fromPrior: { proof, issuer: peerResolution(prior.longFormDid) } }), SNAPSHOT_LINK, await body(sibling.replicaId)), /does not rotate/],
      ["another message type", mail(await endsOf(sibling, to), BASIC_MESSAGE, { content: "hello" }), /is no message of https:\/\/estoc\.dev\/replica-channel\/1\.0/],
      ["a body of another shape", mail(await endsOf(sibling, to), SNAPSHOT_LINK, { ...(await body(sibling.replicaId)), size: "64" }), /not a replica ID, a URL/],
    ];
    for (const [, packed] of cases) await forwarded(mediator, a.replica.did, await packed);
    expect(mediator.queues.get(a.replica.did)).toHaveLength(cases.length);

    const [connection] = await a.agent.connect();
    expect(connection).toMatchObject({ unreachable: null, drained: { acked: cases.length, ended: "empty" } });
    await a.agent.settled();
    expect(a.inbounds.map((inbound) => inbound.received)).toMatchObject(cases.map(([, , reason]) => ({ outcome: "terminal", reason: expect.stringMatching(reason) })));
    expect(a.links).toEqual([]);
    expect(mediator.queues.get(a.replica.did)).toEqual([]);
    expect(await eventsOf(a)).toBe(events);
  });

  test("mail to the replica posted straight to the runtime is terminal, however well it authenticates", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    const sibling = await writer(a.keys, mediator.did);
    const packed = await mail(await endsOf(sibling, a.replica.longFormDid), SNAPSHOT_LINK, snapshotLinkBody({ replicaId: sibling.replicaId, link: await snapshotAt(MEDIATOR) }));
    const inbound = await a.agent.receive(packed);
    expect(inbound.received).toMatchObject({ outcome: "terminal", reason: expect.stringMatching(/taken only from its mailbox/) });
    expect(a.links).toEqual([]);
  });

  test("a send to anyone the seed does not bear out as another replica at the arrangement is refused, and nothing reaches the mediator", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    const link = await snapshotAt(MEDIATOR);
    const stranger = await writer(await seedKeys(3), mediator.did);
    const address = await mintDid(a.keys, ADDRESS, { kind: "mediated", routingDid: mediator.did as Did });
    const sibling = await writer(a.keys, mediator.did);
    const before = queued(mediator);

    const refused: [string, { replicaId: ReplicaId; longFormDid: Did }][] = [
      ["another seed's replica", { replicaId: stranger.replicaId, longFormDid: stranger.longFormDid }],
      ["a communication DID of the vault", { replicaId: sibling.replicaId, longFormDid: address.longFormDid }],
      ["a replica under another ID", { replicaId: uuidv7() as ReplicaId, longFormDid: sibling.longFormDid }],
      ["a replica's short form", { replicaId: sibling.replicaId, longFormDid: sibling.did }],
      ["this runtime's own replica", addressOf(a)],
    ];
    const membership = await (await a.agent.arrangement(a.mediationId)).membership();
    for (const [what, to] of refused) await expect(membership.sendSnapshotLink(to, link), what).rejects.toThrow(NotAReplica);
    expect(queued(mediator)).toBe(before);
  });

  test("a send stays within the arrangement the replica is bound to: a replica of the seed at another usable arrangement is refused, and neither mediator is reached", async () => {
    const m1 = await newMediator(200, "https://m1.example/");
    const m2 = await newMediator(201, "https://m2.example/");
    const both = network(m1, m2);
    const a = await first(m1, both);
    const copy = await copyOf(1, a);
    const m2Id = (await createMediation(copy.runtime, copy.keys, m2.did as Did)).data.mediationId;
    const c = await running(copy, m2Id, both);
    await a.runtime.ingest([...(await scanVault(c.runtime.vault, c.keys)).set.all()]);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.mediations.usable(m2Id)).toBe(true);
    expect(fold.replicas.replicas.get(c.runtime.author)).toMatchObject({ status: "member", mediationId: m2Id });
    const before = [queued(m1), queued(m2)];

    await expect((await (await a.agent.arrangement(a.mediationId)).membership()).sendSnapshotLink(addressOf(c), await snapshotAt("https://m1.example/"))).rejects.toThrow(/not the mediator/);
    expect([queued(m1), queued(m2)]).toEqual(before);
  });

  test("a replica sends from the first key-agreement method of its document that didcomm seals from, and with none it sends nothing", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    const unsealable = (key: PublicKey): JsonObject => ({ id: "#legacy", type: "UnknownKeyType", publicKeyMultibase: key });
    const link = await snapshotAt(MEDIATOR);

    const later = await boundBy(a, mediator.did, (input, key) => {
      input.verificationMethod.push(unsealable(key));
      input.keyAgreement.unshift("#legacy");
    });
    expect((await scanVault(later.runtime.vault, later.keys)).replicas.replicas.get(later.runtime.author)?.status).toBe("member");
    const laterAgent = await opened(later, mediator);
    await laterAgent.enroll(a.mediationId);
    await (await (await laterAgent.arrangement(a.mediationId)).membership()).sendSnapshotLink(addressOf(a), link);
    await a.agent.connect();
    expect(a.links).toEqual([{ mediationId: a.mediationId, replicaId: later.runtime.author, link }]);

    const none = await boundBy(a, mediator.did, (input, key) => {
      input.verificationMethod.push(unsealable(key));
      input.keyAgreement = ["#legacy"];
    });
    expect((await scanVault(none.runtime.vault, none.keys)).replicas.replicas.get(none.runtime.author)?.status).toBe("member");
    const noneAgent = await opened(none, mediator);
    await noneAgent.enroll(a.mediationId);
    const before = queued(mediator);
    await expect((await (await noneAgent.arrangement(a.mediationId)).membership()).sendSnapshotLink(addressOf(a), link)).rejects.toThrow(/no key-agreement method didcomm seals from/);
    expect(queued(mediator)).toBe(before);
  });

  test("a delivery to the replica that the receiver is closed on once it is opened, before the replica receipt is called, is refused and left for the next receiver", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    a.agent.close();
    const ring = await Keyring.load(a.keys, await scanVault(a.runtime.vault, a.keys));
    const replicaReceipt = replicaReceiptOf(a.keys, { mediatorEndpoint: () => MEDIATOR, onSnapshotLink: (received) => void a.links.push(received) });
    const receipt = () => Promise.reject(new Error("only mail to the replica is sent here"));
    const receiver: Receiver = new Receiver(a.runtime, a.keys, ring, {
      didcomm,
      receipt,
      replicaReceipt,
      admit: () => {
        queueMicrotask(() => receiver.close());
        return null;
      },
    });
    const sibling = await writer(a.keys, mediator.did);
    const link = await snapshotAt(MEDIATOR);
    const packed = await mail(await endsOf(sibling, a.replica.longFormDid), SNAPSHOT_LINK, snapshotLinkBody({ replicaId: sibling.replicaId, link }));
    const delivery: Delivery = { packed, source: { kind: "pickup", mediationId: a.mediationId, deliveryId: "d1" } };

    await expect(receiver.receive(delivery)).rejects.toThrow(ReceiverClosed);
    expect(a.links).toEqual([]);
    const next = new Receiver(a.runtime, a.keys, ring, { didcomm, receipt, replicaReceipt });
    expect(await next.receive(delivery)).toEqual({ outcome: "handed", key: deliveryKey(delivery) });
    expect(a.links).toEqual([{ mediationId: a.mediationId, replicaId: sibling.replicaId, link }]);
    next.close();
  });

  test("a runtime whose replica is no member, or whose arrangement carries no mail, sends nothing", async () => {
    const mediator = await newMediator(200, MEDIATOR);
    const a = await first(mediator);
    const sibling = await writer(a.keys, mediator.did);
    const to = { replicaId: sibling.replicaId, longFormDid: sibling.longFormDid };
    const link = await snapshotAt(MEDIATOR);

    const unenrolled = await opened(await copyOf(1, a), mediator);
    await expect((await unenrolled.arrangement(a.mediationId)).membership()).rejects.toThrow(UnknownEntity);

    const membership = await (await a.agent.arrangement(a.mediationId)).membership();
    await a.runtime.vault.commit([], [vaultDraft("mediation.retired", { mediationId: a.mediationId, because: "moved elsewhere" })]);
    await expect(membership.sendSnapshotLink(to, link)).rejects.toThrow(Unusable);
    expect(queued(mediator)).toBe(0);
  });
});
