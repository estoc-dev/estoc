import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { JsonValue, LocalOptions } from "@estoc/event-store";
import { mintReplicaDid, scanVault, signReplicaGrant, vaultDraft, type Did, type DidId, type ReplicaId } from "@estoc/vault";

import { ACCOUNT_REGISTER, Agent, AgentTrace, BLOB_PUT, EntityConflict, LinkClosed, REPLICA_ADD, UnknownEntity, Unusable, blobName, createMediation, sealBlob, type Arrangement, type BlobLink, type Membership, type ReplicaAddress } from "../src/index.js";
import { createReplica } from "../src/replica-enrollment.js";
import type { FakeMediator } from "./fake-mediator.js";
import { copyOf, didcomm, forwarded, freshVault, mediatedParty, newMediator, party, sealed, webFetch, type Party } from "./helpers.js";

const closing: { close(): unknown }[] = [];

afterEach(async () => {
  for (const held of closing.splice(0)) await held.close();
});

const ADDRESS = "019b0000-0000-7000-8000-0000000000a0" as DidId;

/** The party's agent, open and not connected, and every request it sent; its confirmations the runtime's unless `localOptions` says otherwise. */
async function opened(p: Pick<Party, "runtime" | "keys" | "trace">, mediator: FakeMediator, localOptions: LocalOptions = p.runtime.local.options): Promise<{ agent: Agent; sent: string[] }> {
  const sent: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    sent.push(`${init?.method ?? "GET"} ${String(input)}`);
    return mediator.fetch(input, init);
  };
  const agent = await Agent.open(p, { didcomm, fetch, WebSocket: mediator.WebSocket, trace: p.trace, localOptions, privateAddresses: false, liveDelivery: false });
  closing.unshift(agent);
  return { agent, sent };
}

/** A party enrolled at `mediator`, with its agent and the membership its arrangement hands out. */
async function member(mediator: FakeMediator): Promise<Party & { agent: Agent; sent: string[]; membership: Membership }> {
  const p = await party(mediator);
  closing.push(p.runtime);
  await p.account.enroll();
  const { agent, sent } = await opened(p, mediator);
  return { ...p, agent, sent, membership: await (await agent.arrangement(p.mediationId)).membership() };
}

/** Another replica of the party's seed at `mediator`: one to send a snapshot link to. */
async function sibling(p: Pick<Party, "keys">, mediator: FakeMediator): Promise<ReplicaAddress> {
  const replicaId = uuidv7() as ReplicaId;
  return { replicaId, longFormDid: (await mintReplicaDid(p.keys, replicaId, mediator.did as Did)).longFormDid };
}

/** Local options holding nothing the mediator confirmed: those of a runtime whose vault was copied without them. */
function emptyOptions(): LocalOptions {
  const kept = new Map<string, JsonValue>();
  return {
    get: async (key) => kept.get(key),
    set: async (key, value) => void kept.set(key, value),
    delete: async (key) => void kept.delete(key),
    keys: async () => [...kept.keys()],
  };
}

async function snapshot(mediator: FakeMediator): Promise<BlobLink> {
  const hash = await blobName(crypto.getRandomValues(new Uint8Array(64)));
  return { url: `${mediator.http}b/${hash}`, hash, key: crypto.getRandomValues(new Uint8Array(32)) };
}

describe("a runtime's membership", () => {
  it("is handed out by an arrangement, and is the replica's blob store and snapshot links, and none of what the agent picks up and registers with", () => {
    expectTypeOf<Awaited<ReturnType<Arrangement["membership"]>>>().toEqualTypeOf<Membership>();
    expectTypeOf<Agent>().not.toHaveProperty("membership");
    expectTypeOf<Membership>().not.toHaveProperty("pickup");
    expectTypeOf<Membership>().not.toHaveProperty("link");
    expectTypeOf<Membership>().not.toHaveProperty("registerExecution");
    expectTypeOf<Agent>().not.toHaveProperty("blobStore");
    expectTypeOf<Agent>().not.toHaveProperty("sendSnapshotLink");
  });

  it("is not bound while the runtime has no replica, and nothing is asked of the mediator, nor is it resolved", async () => {
    const fresh = await freshVault();
    closing.push(fresh.runtime);
    const { mediationId } = (await createMediation(fresh.runtime, fresh.keys, "did:web:mediator.example" as Did)).data;
    const web = webFetch({});
    const agent = await Agent.open(fresh, { didcomm, fetch: web.fetch, trace: await AgentTrace.open(fresh.runtime.local), liveDelivery: false });
    closing.unshift(agent);
    await expect((await agent.arrangement(mediationId)).membership()).rejects.toBeInstanceOf(UnknownEntity);
    expect(web.calls).toEqual([]);
  });

  it("is withheld while the replica is created but the account is not registered, asking nothing; had once the host enrolls, and a blob request then goes alone", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    closing.push(p.runtime);
    await createReplica(p.runtime, p.keys, p.mediationId);
    const fold = await scanVault(p.runtime.vault, p.keys);
    expect(fold.replicas.replicas.get(p.runtime.author)?.status).toBe("member");
    expect(fold.mediations.mediations.get(p.mediationId)?.routingDid).toBeNull();
    const { agent } = await opened(p, mediator);

    const arrangement = await agent.arrangement(p.mediationId);
    await expect(arrangement.membership()).rejects.toBeInstanceOf(Unusable);
    expect(mediator.seenTypes).toEqual([]);
    await agent.enroll(p.mediationId);
    expect(mediator.seenTypes.slice(0, 2)).toEqual([ACCOUNT_REGISTER, REPLICA_ADD]);
    const membership = await arrangement.membership();
    expect(membership).toMatchObject({ replicaId: p.runtime.author, mediationId: p.mediationId });
    const seen = mediator.seenTypes.length;
    const sealed = await sealBlob(new Uint8Array(100));
    await membership.blobs.put(sealed.hash, sealed.bytes.length);
    expect(mediator.seenTypes.slice(seen)).toEqual([BLOB_PUT]);
  });

  it("is withheld while the mediator's adding of the replica is not confirmed to this runtime, though the vault has it a member; had once the host enrolls, which adds it again", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    closing.push(p.runtime);
    await p.account.enroll();
    expect((await scanVault(p.runtime.vault, p.keys)).replicas.replicas.get(p.runtime.author)?.status).toBe("member");
    const { agent, sent } = await opened(p, mediator, emptyOptions());

    const arrangement = await agent.arrangement(p.mediationId);
    await expect(arrangement.membership()).rejects.toThrow(/has not confirmed adding it/);
    expect(sent).toEqual([]);
    const seen = mediator.seenTypes.length;
    await agent.enroll(p.mediationId);
    expect(mediator.seenTypes.slice(seen, seen + 1)).toEqual([REPLICA_ADD]);
    expect(await arrangement.membership()).toMatchObject({ replicaId: p.runtime.author, mediationId: p.mediationId });
  });

  it("is refused at an arrangement its replica is not a member of, which taking it there does not change, and nothing is asked of either mediator; at its own it is the one replica, bound once", async () => {
    const mediator = await newMediator();
    const elsewhere = await newMediator(201, "https://elsewhere.example/");
    const p = await party(mediator);
    closing.push(p.runtime);
    await p.account.enroll();
    const other = (await createMediation(p.runtime, p.keys, elsewhere.did as Did)).data.mediationId;
    const { agent, sent } = await opened(p, mediator);

    const refused = (await agent.arrangement(other)).membership();
    await expect(refused).rejects.toBeInstanceOf(EntityConflict);
    await expect(refused).rejects.toThrow(`a member of the arrangement with ${mediator.did}`);
    expect((await scanVault(p.runtime.vault, p.keys)).replicas.replicas.get(p.runtime.author)).toMatchObject({ status: "member", mediationId: p.mediationId });
    const membership = await (await agent.arrangement(p.mediationId)).membership();
    expect(membership).toMatchObject({ replicaId: p.runtime.author, mediationId: p.mediationId });
    expect(await (await agent.arrangement(p.mediationId)).membership()).toBe(membership);
    await expect((await agent.arrangement(other)).membership()).rejects.toBeInstanceOf(EntityConflict);
    expect(sent).toEqual([]);
    expect(elsewhere.seenTypes).toEqual([]);
  });

  it("refuses every operation once its arrangement is retired, asking nothing", async () => {
    const mediator = await newMediator();
    const m = await member(mediator);
    const to = await sibling(m, mediator);
    const link = await snapshot(mediator);
    await m.runtime.vault.commit([], [vaultDraft("mediation.retired", { mediationId: m.mediationId, because: "gone" })]);
    const sent = m.sent.length;

    await expect((await m.agent.arrangement(m.mediationId)).membership()).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.blobs.limits()).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.blobs.put(link.hash, 64)).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.blobs.delete(link.hash)).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.sendSnapshotLink(to, link)).rejects.toBeInstanceOf(Unusable);
    expect(m.sent).toHaveLength(sent);
  });

  it("refuses every operation once its replica's grants disagree on the arrangement, asking nothing", async () => {
    const mediator = await newMediator();
    const elsewhere = await newMediator(201, "https://elsewhere.example/");
    const m = await member(mediator);
    const to = await sibling(m, mediator);
    const link = await snapshot(mediator);
    const other = await createMediation(m.runtime, m.keys, elsewhere.did as Did);
    const grant = await signReplicaGrant(m.keys, other.data, m.runtime.author);
    await m.runtime.vault.commit([], [vaultDraft("replica.created", { replicaId: m.runtime.author, mediationId: other.data.mediationId, grant })]);
    expect((await scanVault(m.runtime.vault, m.keys)).replicas.replicas.get(m.runtime.author)).toMatchObject({ status: "conflict", mediationId: null });
    const sent = m.sent.length;

    await expect((await m.agent.arrangement(m.mediationId)).membership()).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.blobs.put(link.hash, 64)).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.sendSnapshotLink(to, link)).rejects.toBeInstanceOf(Unusable);
    expect(m.sent).toHaveLength(sent);
  });

  it("refuses every operation once the arrangement's creations disagree, asking nothing", async () => {
    const mediator = await newMediator();
    const m = await member(mediator);
    const stranger = await party(mediator, 2);
    closing.push(stranger.runtime);
    const to = await sibling(m, mediator);
    const link = await snapshot(mediator);
    await m.runtime.vault.commit([], [vaultDraft("mediation.created", { ...m.created.data, me: stranger.created.data.me })]);
    expect((await scanVault(m.runtime.vault, m.keys)).replicas.replicas.get(m.runtime.author)).toMatchObject({ status: "conflict", mediationId: m.mediationId });
    const sent = m.sent.length;

    await expect(m.membership.blobs.put(link.hash, 64)).rejects.toBeInstanceOf(Unusable);
    await expect(m.membership.sendSnapshotLink(to, link)).rejects.toBeInstanceOf(Unusable);
    expect(m.sent).toHaveLength(sent);
  });

  it("reaches the mediator no more once the agent closed, its link made or not", async () => {
    const mediator = await newMediator();
    const m = await member(mediator);
    const to = await sibling(m, mediator);
    const link = await snapshot(mediator);
    const arrangement = await m.agent.arrangement(m.mediationId);
    m.agent.close();
    const sent = m.sent.length;

    await expect(m.membership.blobs.put(link.hash, 64)).rejects.toBeInstanceOf(LinkClosed);
    await expect(m.membership.sendSnapshotLink(to, link)).rejects.toBeInstanceOf(LinkClosed);
    await expect(arrangement.membership()).rejects.toBeInstanceOf(LinkClosed);
    await expect(m.agent.arrangement(m.mediationId)).rejects.toThrow("the agent is closed");
    expect(m.sent).toHaveLength(sent);

    const linked = await member(mediator);
    await linked.membership.blobs.limits();
    linked.agent.close();
    const before = linked.sent.length;
    await expect(linked.membership.blobs.limits()).rejects.toBeInstanceOf(LinkClosed);
    await expect(linked.membership.sendSnapshotLink(await sibling(linked, mediator), link)).rejects.toBeInstanceOf(LinkClosed);
    expect(linked.sent).toHaveLength(before);
  });

  it("acknowledges a delivery picked up and left waiting once the wait ends, for an agent opened before the runtime had a replica", async () => {
    const mediator = await newMediator();
    const elsewhere = await newMediator(201, "https://elsewhere.example/");
    const alice = await mediatedParty(elsewhere, 1, ADDRESS);
    closing.push(alice.runtime);
    const elsewhereOnly = (type: string): boolean => type.startsWith("mediation.") || type.startsWith("replica.");
    const copy = await copyOf(1, alice, (event) => !elsewhereOnly(event.type));
    closing.push(copy.runtime);
    const { mediationId } = (await createMediation(copy.runtime, copy.keys, mediator.did as Did)).data;
    const { agent } = await opened({ ...copy, trace: await AgentTrace.open(copy.runtime.local) }, mediator);
    await expect((await agent.arrangement(mediationId)).membership()).rejects.toBeInstanceOf(UnknownEntity);

    const { replica } = await agent.enroll(mediationId);
    await forwarded(mediator, replica.did!, await sealed(null, alice.longFormDid));
    await agent.enroll(mediationId);
    expect(agent.connections()).toMatchObject([{ mediationId, unreachable: null, drained: { acked: 0, ended: "left" } }]);
    expect(agent.waitingDeliveries()).toHaveLength(1);
    expect(mediator.queues.get(replica.did!)).toHaveLength(1);

    await copy.runtime.ingest([...(await scanVault(alice.runtime.vault, alice.keys)).set.all()].filter((event) => elsewhereOnly(event.type)));
    expect((await agent.localStateChanged()).map(({ received }) => received.outcome)).toEqual(["received"]);
    expect(agent.waitingDeliveries()).toEqual([]);
    expect(mediator.queues.get(replica.did!)).toEqual([]);
  });
});
