import { describe, expect, it, test } from "vitest";

import type { VaultRuntime } from "@estoc/event-store";
import { readReplicaGrant, scanVault, signReplicaGrant, vaultDraft, type Did, type MediationId, type MediationProfile, type VaultFold } from "@estoc/vault";

import {
  ACCOUNT_REGISTER,
  Agent,
  EntityConflict,
  Keyring,
  MediatorLink,
  MediatorRefused,
  REPLICA_ADD,
  STATUS_REQUEST,
  Unusable,
  WrongAccount,
  canonicalDid,
  createMediation,
  createReplica,
  enroll,
  establish,
  reconcile,
  selectMediation,
  transientConfirmations,
  type Confirmations,
} from "../src/index.js";
import { decide } from "../src/procedure.js";
import type { FakeMediator } from "./fake-mediator.js";
import { didcomm, freshVault, newMediator, party, type Party } from "./helpers.js";

const PROFILE: MediationProfile = "replica-mediation/1.0";

const account = (mediator: FakeMediator, fill = 1): Promise<Party> => party(mediator, fill, {}, undefined, PROFILE);
const fold = (p: Pick<Party, "runtime" | "keys">): Promise<VaultFold> => scanVault(p.runtime.vault, p.keys);
const sent = (mediator: FakeMediator, type: string): number => mediator.seenTypes.filter((seen) => seen === type).length;

async function eventsOf(runtime: VaultRuntime): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runtime.vault.events.scan()) events.push(event);
  return events;
}

describe("creating a replica", () => {
  it("records the grant of the runtime's own replica ID before any request, and says the same again", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const created = await createReplica(p.runtime, p.keys, p.mediationId);
    expect(created.data.replicaId).toBe(p.runtime.author);
    expect(readReplicaGrant(created.data.grant)).toMatchObject({ account: canonicalDid(p.created.data.me.did), mediationId: p.mediationId, mediator: mediator.did, replicaId: p.runtime.author });
    expect((await createReplica(p.runtime, p.keys, p.mediationId)).cid).toBe(created.cid);
    expect((await fold(p)).replicas.replicas.get(p.runtime.author)?.status).toBe("member");
    expect(mediator.seenTypes).toEqual([]);
    await p.runtime.close();
  });

  it("refuses an ordinary arrangement, and a second arrangement for the same replica ID", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const ordinary = await createMediation(p.runtime, p.keys, mediator.did as Did);
    await expect(createReplica(p.runtime, p.keys, ordinary.data.mediationId)).rejects.toBeInstanceOf(Unusable);
    await createReplica(p.runtime, p.keys, p.mediationId);
    const second = await createMediation(p.runtime, p.keys, mediator.did as Did, undefined, PROFILE);
    await expect(createReplica(p.runtime, p.keys, second.data.mediationId)).rejects.toBeInstanceOf(EntityConflict);
    await p.runtime.close();
  });

  it("refuses the arrangement whose recorded grant makes the runtime no member, and enrolling asks the mediator nothing", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const elsewhere = canonicalDid((await createMediation(p.runtime, p.keys, mediator.did as Did)).data.me.did) as Did;
    const grant = await signReplicaGrant(p.keys, { mediationId: p.mediationId, mediatorDid: elsewhere, me: p.created.data.me }, p.runtime.author);
    await decide(p.runtime, p.keys, () => [vaultDraft("replica.created", { replicaId: p.runtime.author, mediationId: p.mediationId, grant })]);
    expect((await fold(p)).replicas.replicas.get(p.runtime.author)?.status).toBe("conflict");
    await expect(createReplica(p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    const link = new MediatorLink(p.linkOptions);
    await expect(enroll(link, p.runtime, p.keys, transientConfirmations(), p.mediationId)).rejects.toBeInstanceOf(Unusable);
    expect(mediator.seenTypes).toEqual([]);
    await p.runtime.close();
  });

  test("the same arrangement ID under another profile is a conflict", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    await expect(createMediation(p.runtime, p.keys, mediator.did as Did, p.mediationId)).rejects.toBeInstanceOf(EntityConflict);
    await p.runtime.close();
  });
});

describe("enrolling", () => {
  it("registers the account once, records the grant, adds its own replica, and asks for neither again", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const confirmations = p.runtime.local.options;
    const first = await enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId);
    expect(first.steps).toEqual(["replica-created", "account-registered", "replica-added"]);
    expect(first.mediation).toMatchObject({ status: "usable", routingDid: mediator.did });
    expect(mediator.replicaAccounts.has(canonicalDid(p.created.data.me.did))).toBe(true);
    expect(mediator.replicas.get(first.replica.did as Did)).toMatchObject({ replicaDid: first.replica.did, grant: first.replica.grants[0] });
    const asked = mediator.seenTypes.length;
    expect((await enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId)).steps).toEqual([]);
    expect(mediator.seenTypes).toHaveLength(asked);
    expect(mediator.seenTypes).toEqual([ACCOUNT_REGISTER, REPLICA_ADD]);
    expect((await p.trace.read({ stream: "diag" })).map((entry) => entry.type)).toEqual(["diag.enroll", "diag.enroll"]);
    await p.runtime.close();
  });

  test("a mediator out of reach leaves the intents recorded and every step to retry", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    p.offline.reason = "no route to host";
    await expect(enroll(p.link, p.runtime, p.keys, p.runtime.local.options, p.mediationId)).rejects.toThrow(/no route to host/);
    const left = await fold(p);
    expect(left.mediations.mediations.get(p.mediationId)?.status).toBe("pending");
    expect(left.replicas.replicas.get(p.runtime.author)?.status).toBe("member");
    p.offline.reason = null;
    expect((await enroll(p.link, p.runtime, p.keys, p.runtime.local.options, p.mediationId)).steps).toEqual(["account-registered", "replica-added"]);
    await p.runtime.close();
  });

  test("a confirmation that was not kept costs one more replica-add and no other request, and one kept outlives later commits and a clearing of the caches", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const options = p.runtime.local.options;
    let fails = 1;
    const failing: Confirmations = { get: options.get, set: (...args) => (fails-- > 0 ? Promise.reject(new Error("the disk is full")) : options.set(...args)) };
    await expect(enroll(p.link, p.runtime, p.keys, failing, p.mediationId)).rejects.toThrow("the disk is full");
    expect((await enroll(p.link, p.runtime, p.keys, failing, p.mediationId)).steps).toEqual(["replica-added"]);
    await selectMediation(p.runtime, p.keys, p.mediationId);
    await p.runtime.local.clearCaches();
    expect((await enroll(p.link, p.runtime, p.keys, options, p.mediationId)).steps).toEqual([]);
    expect(sent(mediator, ACCOUNT_REGISTER)).toBe(1);
    expect(sent(mediator, REPLICA_ADD)).toBe(2);
    expect(mediator.replicas.size).toBe(1);
    await p.runtime.close();
  });

  it("adds a second replica of the vault under its own grant, registering nothing and adding no one else", async () => {
    const mediator = await newMediator();
    const first = await account(mediator);
    await enroll(first.link, first.runtime, first.keys, first.runtime.local.options, first.mediationId);
    const second = await freshVault(1, "second replica");
    await second.runtime.ingest(await eventsOf(first.runtime));
    const ring = await Keyring.load(second.keys, await fold(second));
    const link = new MediatorLink({ ...first.linkOptions, secrets: () => ring.secrets() });
    const enrolled = await enroll(link, second.runtime, second.keys, second.runtime.local.options, first.mediationId);
    expect(enrolled.steps).toEqual(["replica-created", "replica-added"]);
    expect(enrolled.replica.replicaId).toBe(second.runtime.author);
    expect(sent(mediator, ACCOUNT_REGISTER)).toBe(1);
    expect([...mediator.replicas.keys()].sort()).toEqual((await fold(second)).replicas.members(first.mediationId).map((replica) => replica.did).sort());
    expect((await fold(second)).replicas.members(first.mediationId)).toHaveLength(2);
    await first.runtime.close();
    await second.runtime.close();
  });

  it("records no grant and keeps no confirmation over an answer that names something else, or a refusal", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const confirmations = transientConfirmations();
    mediator.intercept = (msg, from) => (msg.type === ACCOUNT_REGISTER ? mediator.reply(`${ACCOUNT_REGISTER}ed`, from as string, { account: canonicalDid(from as string), routing_did: "did:web:elsewhere.example" }, msg.id) : undefined);
    await expect(enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId)).rejects.toBeInstanceOf(MediatorRefused);
    expect((await fold(p)).mediations.mediations.get(p.mediationId)?.routingDid).toBeNull();

    mediator.intercept = (msg, from) => (msg.type === REPLICA_ADD ? mediator.reply(`${REPLICA_ADD}ed`, from as string, { replica_did: canonicalDid(from as string), state: "active" }, msg.id) : undefined);
    await expect(enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId)).rejects.toBeInstanceOf(MediatorRefused);

    mediator.intercept = null;
    mediator.replicaAccounts.clear();
    await expect(enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId)).rejects.toThrow("replica-add was refused: e.estoc.replica-mediation.unknown-account");
    mediator.replicaAccounts.add(canonicalDid(p.created.data.me.did));
    expect((await enroll(p.link, p.runtime, p.keys, confirmations, p.mediationId)).steps).toEqual(["replica-added"]);
    await p.runtime.close();
  });

  it("refuses an ordinary arrangement, an unknown one, and a link speaking as another account, asking nothing", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const ordinary = await party(mediator, 2);
    await expect(enroll(ordinary.link, ordinary.runtime, ordinary.keys, transientConfirmations(), ordinary.mediationId)).rejects.toBeInstanceOf(Unusable);
    await expect(enroll(p.link, p.runtime, p.keys, transientConfirmations(), "019b0000-0000-7000-8000-000000000000" as MediationId)).rejects.toThrow(/no mediation/);
    const other = await createMediation(p.runtime, p.keys, mediator.did as Did, undefined, PROFILE);
    await expect(enroll(p.link, p.runtime, p.keys, transientConfirmations(), other.data.mediationId)).rejects.toBeInstanceOf(WrongAccount);
    expect((await fold(p)).replicas.replicas.size).toBe(0);
    expect(mediator.seenTypes).toEqual([]);
    await p.runtime.close();
    await ordinary.runtime.close();
  });
});

describe("a replica-mediation arrangement", () => {
  it("takes no coordinate-mediation request", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    await expect(establish(p.link, p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    await enroll(p.link, p.runtime, p.keys, transientConfirmations(), p.mediationId);
    await expect(reconcile(p.link, p.runtime, p.keys, p.mediationId)).rejects.toBeInstanceOf(Unusable);
    expect(mediator.seenTypes).toEqual([ACCOUNT_REGISTER, REPLICA_ADD]);
    await p.runtime.close();
  });

  it("is enrolled in by the agent's connection, which reconciles nothing, and by a later agent only where no confirmation was kept", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const options = { didcomm, fetch: p.linkOptions.fetch as typeof fetch, WebSocket: mediator.WebSocket, trace: p.trace, confirmations: p.runtime.local.options, liveDelivery: false };
    const agent = await Agent.open(p, options);
    expect((await agent.enroll(p.mediationId)).steps).toEqual(["replica-created", "account-registered", "replica-added"]);
    await selectMediation(p.runtime, p.keys, p.mediationId);
    const [connection] = await agent.connect();
    expect(connection).toMatchObject({ mediationId: p.mediationId, unreachable: null, reconciled: null, drained: { acked: 0, ended: "empty" }, live: false });
    expect(connection?.enrolled?.steps).toEqual([]);
    agent.close();

    const later = await Agent.start(p, options);
    expect(later.connections()[0]?.enrolled?.steps).toEqual([]);
    later.close();
    const forgetful = await Agent.start(p, { ...options, confirmations: undefined });
    expect(forgetful.connections()[0]?.enrolled?.steps).toEqual(["replica-added"]);
    forgetful.close();
    expect(mediator.seenTypes.filter((type) => type !== STATUS_REQUEST)).toEqual([ACCOUNT_REGISTER, REPLICA_ADD, REPLICA_ADD]);
    expect(sent(mediator, STATUS_REQUEST)).toBe(3);
    await p.runtime.close();
  });

  it("records the registration answered after the agent closed, and begins no replica-add", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    let answered = (): void => undefined;
    const answeredOnce = new Promise<void>((resolve) => (answered = resolve));
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held: typeof fetch = async (...request) => {
      const response = await (p.linkOptions.fetch as typeof fetch)(...request);
      answered();
      await released;
      return response;
    };
    const agent = await Agent.open(p, { didcomm, fetch: held, WebSocket: mediator.WebSocket, trace: p.trace });
    const enrolling = agent.enroll(p.mediationId);
    await answeredOnce;
    agent.close();
    release();
    await expect(enrolling).rejects.toThrow("the agent is closed");
    expect(mediator.seenTypes).toEqual([ACCOUNT_REGISTER]);
    expect((await fold(p)).mediations.mediations.get(p.mediationId)?.routingDid).toBe(mediator.did);
    await expect(agent.enroll(p.mediationId)).rejects.toThrow("the agent is closed");
    await p.runtime.close();
  });

  it("begins no replica-add for a connection its agent closed while it looked for the confirmation", async () => {
    const mediator = await newMediator();
    const p = await account(mediator);
    const options = { didcomm, fetch: p.linkOptions.fetch as typeof fetch, WebSocket: mediator.WebSocket, trace: p.trace };
    const first = await Agent.open(p, options);
    await first.enroll(p.mediationId);
    first.close();
    await selectMediation(p.runtime, p.keys, p.mediationId);

    let asked = (): void => undefined;
    const askedOnce = new Promise<void>((resolve) => (asked = resolve));
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const slow: Confirmations = {
      get: async () => {
        asked();
        await released;
        return undefined;
      },
      set: async () => {},
    };
    const agent = await Agent.open(p, { ...options, confirmations: slow });
    const connecting = agent.connect();
    await askedOnce;
    agent.close();
    release();
    const [connection] = await connecting;
    expect(connection?.enrolled).toBeNull();
    expect(mediator.seenTypes).toEqual([ACCOUNT_REGISTER, REPLICA_ADD]);
    await p.runtime.close();
  });
});
