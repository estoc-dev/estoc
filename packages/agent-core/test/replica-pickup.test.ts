import { afterEach, describe, expect, it, test } from "vitest";

import { resolveDIDCommDoc } from "@estoc/did-peer";
import { AUTHENTICATION_METHOD, scanVault, type Did, type DidId, type MintedDid, type Replica } from "@estoc/vault";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { PLAIN_TYP, packEncrypted, secretsResolverFor, type IMessage } from "../src/protocol/didcomm.js";
import { FORWARD } from "../src/protocol/spec.js";
import { Agent, DELIVERY_REQUEST, MESSAGES_RECEIVED, STATUS_REQUEST, canonicalDid, classifyRecipients, createDid, selectMediation, type AgentOptions, type Inbound } from "../src/index.js";
import type { FakeMediator } from "./fake-mediator.js";
import { didcomm, kidOf, mediatedParty, newMediator, party, peerSealer, sealed, until, type MediatedParty, type Party, mediatedRoute } from "./helpers.js";

const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const PICKUP = [STATUS_REQUEST, DELIVERY_REQUEST, MESSAGES_RECEIVED];

interface Enrolled extends Party {
  agent: Agent;
  inbounds: Inbound[];
  replica: Replica & { did: Did; longFormDid: Did };
  address: MintedDid;
}

const closing: { close: () => void; runtime: Party["runtime"] }[] = [];

afterEach(async () => {
  for (const { close, runtime } of closing.splice(0)) {
    close();
    await runtime.close();
  }
});

/** A runtime enrolled in an arrangement it selected, with one address its account holds, and its agent connected. */
async function enrolled(mediator: FakeMediator, over: Partial<AgentOptions> = {}): Promise<Enrolled> {
  const p = await party(mediator, 1);
  const inbounds: Inbound[] = [];
  const agent = await Agent.open(p, { didcomm, fetch: p.linkOptions.fetch as typeof fetch, WebSocket: mediator.WebSocket, trace: p.trace, confirmations: p.runtime.local.options, privateAddresses: false, liveDelivery: false, onInbound: (inbound) => inbounds.push(inbound), ...over });
  closing.push({ close: () => agent.close(), runtime: p.runtime });
  const { replica } = await agent.enroll(p.mediationId);
  await selectMediation(p.runtime, p.keys, p.mediationId);
  const address = (await createDid(p.runtime, p.keys, mediatedRoute(p.mediationId))).minted;
  await agent.connect();
  return { ...p, agent, inbounds, replica: replica as Enrolled["replica"], address };
}

/** A peer's agent, to send from. */
async function peer(mediator: FakeMediator): Promise<{ bob: MediatedParty; agent: Agent }> {
  const bob = await mediatedParty(mediator, 2, BOB);
  const agent = await Agent.start(bob, { didcomm, fetch: bob.linkOptions.fetch as typeof fetch, WebSocket: mediator.WebSocket, trace: bob.trace, privateAddresses: false, liveDelivery: false });
  closing.push({ close: () => agent.close(), runtime: bob.runtime });
  return { bob, agent };
}

const hello = (bob: MediatedParty, agent: Agent, to: MintedDid) => agent.send({ channel: { localDid: bob.did, peerDid: to.did }, recipientDid: to.longFormDid }, { type: BASIC_MESSAGE, body: { content: "hello" } });

/** An envelope left at the mediator for `next`, by no one in particular. */
async function forwarded(mediator: FakeMediator, next: string, packed: string): Promise<void> {
  const forward = { id: crypto.randomUUID(), typ: PLAIN_TYP, type: FORWARD, to: [mediator.did], body: { next }, attachments: [{ id: crypto.randomUUID(), data: { json: JSON.parse(packed) as unknown } }] } as IMessage;
  const [outer] = await packEncrypted(didcomm, forward, mediator.did, null, null, { resolve: resolveDIDCommDoc }, secretsResolverFor([]), { forward: false });
  await mediator.handleHttp(outer);
}

/** Who asked the mediator for pickup, by canonical DID, in order and without repeats. */
function pickupSenders(mediator: FakeMediator): string[] {
  const senders: string[] = [];
  mediator.intercept = (msg, from) => {
    if (PICKUP.includes(msg.type) && from !== null && !senders.includes(canonicalDid(from))) senders.push(canonicalDid(from));
    return undefined;
  };
  return senders;
}

async function messagesIn(p: Party): Promise<number> {
  return (await scanVault(p.runtime.vault, p.keys)).set.of("message.in").length;
}

describe("the mail of a replica-mediation arrangement", () => {
  it("is picked up and acknowledged under the runtime's own replica DID, never the account's", async () => {
    const mediator = await newMediator();
    const senders = pickupSenders(mediator);
    const alice = await enrolled(mediator);
    expect(alice.agent.connections()).toMatchObject([{ unreachable: null, drained: { acked: 0, ended: "empty" }, live: false }]);
    const { bob, agent } = await peer(mediator);
    expect((await hello(bob, agent, alice.address)).dispatched).toMatchObject({ outcome: "submitted" });
    expect(mediator.queues.get(alice.replica.did)).toHaveLength(1);

    const [connection] = await alice.agent.connect();
    expect(connection).toMatchObject({ unreachable: null, drained: { acked: 1, ended: "empty" } });
    await alice.agent.settled();
    expect(alice.inbounds).toMatchObject([{ received: { outcome: "received", live: true } }]);
    expect(mediator.queues.get(alice.replica.did)).toEqual([]);
    expect(senders.filter((sender) => sender !== bob.replica.did)).toEqual([alice.replica.did]);
  });

  it("is pushed down a socket the replica opened, sealed to the replica's short form", async () => {
    const mediator = await newMediator();
    const alice = await enrolled(mediator, { liveDelivery: true });
    await until("live delivery is on for the replica", () => mediator.liveAccounts().includes(alice.replica.did), 10_000);
    expect(mediator.liveAccounts()).toEqual([alice.replica.did]);
    const { bob, agent } = await peer(mediator);
    await hello(bob, agent, alice.address);
    await until("the pushed delivery is followed", () => alice.inbounds.length === 1, 10_000);
    expect(alice.inbounds[0]!.received).toMatchObject({ outcome: "received", live: true });
    await until("the pushed delivery is acknowledged", () => mediator.queues.get(alice.replica.did)?.length === 0, 10_000);
    expect(alice.agent.connections()).toMatchObject([{ live: true }]);
  });

  test("an envelope naming only the replica's own DID is acknowledged unopened, leaving a diagnostic and nothing in the vault", async () => {
    const mediator = await newMediator();
    const alice = await enrolled(mediator);
    const { bob } = await peer(mediator);
    const events = await messagesIn(alice);
    const anonymous = await sealed(null, alice.replica.longFormDid);
    const fromPeer = await sealed({ ...(await peerSealer(bob)), resolver: { resolve: resolveDIDCommDoc } }, alice.replica.longFormDid);
    await forwarded(mediator, alice.replica.did, anonymous);
    await forwarded(mediator, alice.replica.longFormDid, fromPeer);
    expect(mediator.queues.get(alice.replica.did)).toHaveLength(2);

    const [connection] = await alice.agent.connect();
    expect(connection).toMatchObject({ unreachable: null, drained: { acked: 2, ended: "empty" } });
    expect(mediator.queues.get(alice.replica.did)).toEqual([]);
    await alice.agent.settled();
    expect(alice.inbounds.map((inbound) => inbound.received)).toMatchObject([
      { outcome: "terminal", reason: expect.stringMatching(/no protocol addressed to a replica is supported/) },
      { outcome: "terminal", reason: expect.stringMatching(/no protocol addressed to a replica is supported/) },
    ]);
    expect(alice.agent.discardedDeliveries()).toHaveLength(2);
    expect(alice.agent.waitingDeliveries()).toEqual([]);
    expect(await messagesIn(alice)).toBe(events);
    expect((await alice.trace.read({ stream: "envelope" })).filter((entry) => entry.type === "envelope.open" && (entry.data as { type?: string }).type === BASIC_MESSAGE)).toEqual([]);
  });
});

describe("an envelope naming a key of the runtime's replica DID", () => {
  it("is terminal beside keys the vault lacks, and application mail beside a communication DID's key", async () => {
    const mediator = await newMediator();
    const alice = await enrolled(mediator);
    const fold = await scanVault(alice.runtime.vault, alice.keys);
    const replicaKid = kidOf(await sealed(null, alice.replica.longFormDid));
    const shortKid = replicaKid.replace(alice.replica.longFormDid, alice.replica.did);
    const addressKid = kidOf(await sealed(null, alice.address.longFormDid));
    const stranger = "did:example:stranger#key-1";
    const own = alice.runtime.author;

    for (const kids of [[replicaKid], [shortKid], [stranger, replicaKid]]) {
      expect(classifyRecipients(fold, kids, own)).toMatchObject({ verdict: "terminal", reason: expect.stringMatching(/no protocol addressed to a replica is supported/) });
    }
    expect(classifyRecipients(fold, [replicaKid, addressKid], own)).toMatchObject({ verdict: "eligible", kid: addressKid });
    expect(classifyRecipients(fold, [replicaKid])).toMatchObject({ verdict: "terminal", reason: expect.stringMatching(/local recipient material is unavailable/) });
    const authentication = `${alice.replica.did}${AUTHENTICATION_METHOD}`;
    expect(authentication).not.toBe(shortKid);
    expect(classifyRecipients(fold, [authentication], own)).toMatchObject({ verdict: "terminal", reason: expect.stringMatching(/local recipient material is unavailable/) });
  });
});
