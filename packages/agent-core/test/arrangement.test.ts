import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { VaultRuntime } from "@estoc/event-store";
import { scanVault, vaultDraft, type Did, type DidId, type Keys, type MediationId } from "@estoc/vault";

import * as core from "../src/index.js";
import { Agent, AgentTrace, LinkClosed, MediatorLink, RECIPIENT_ADD, REPLICA_ADD, REPLICA_LIST, UnknownEntity, Unusable, WrongAccount, WrongMediator, createDid, createMediation, transientOptions, type Arrangement, type DispatchOptions, type Disclosure } from "../src/index.js";
import type { Account } from "../src/arrangement.js";
import { disclose } from "../src/dids.js";
import type { FakeMediator } from "./fake-mediator.js";
import { accountOver, didcomm, freshVault, mediatedRoute, newMediator, party, webFetch, type Party } from "./helpers.js";

const closing: { close(): unknown }[] = [];

afterEach(async () => {
  for (const held of closing.splice(0)) await held.close();
});

const sent = (mediator: FakeMediator, type: string): number => mediator.seenTypes.filter((seen) => seen === type).length;

async function enrolled(mediator: FakeMediator, fill = 1): Promise<Party> {
  const p = await party(mediator, fill);
  closing.push(p.runtime);
  await p.account.enroll();
  return p;
}

async function agentOf(p: Party): Promise<Agent> {
  const agent = await Agent.open(p, { didcomm, fetch: p.linkOptions.fetch as typeof fetch, WebSocket: p.mediator.WebSocket, trace: p.trace, localOptions: p.runtime.local.options, liveDelivery: false });
  closing.unshift(agent);
  return agent;
}

/** A link of the party's account whose every answer, once the mediator gave it, is held back until `release`. */
function held(p: Party): { link: MediatorLink; answered: Promise<void>; release: () => void } {
  let answer = (): void => undefined;
  let release = (): void => undefined;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await (p.linkOptions.fetch as typeof globalThis.fetch)(input, init);
    answer();
    await released;
    return response;
  };
  return { link: new MediatorLink({ ...p.linkOptions, fetch }), answered, release };
}

describe("an arrangement", () => {
  it("refuses a link to another mediator, or speaking as another account, before anything is asked over it", async () => {
    const mediator = await newMediator();
    const elsewhere = await newMediator(201, "http://other-mediator/");
    const p = await party(mediator);
    const there = await party(elsewhere);
    const stranger = await party(mediator, 2);
    closing.push(p.runtime, there.runtime, stranger.runtime);
    await expect(accountOver(p, { link: there.link }).enroll()).rejects.toBeInstanceOf(WrongMediator);
    await expect(accountOver(p, { link: stranger.link }).enroll()).rejects.toBeInstanceOf(WrongAccount);
    expect([...mediator.seenTypes, ...elsewhere.seenTypes]).toEqual([]);
  });

  it("takes one turn at a time for what it writes, whichever binding of the account asks, and lists without waiting for a turn", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    await createDid(p.runtime, p.keys, mediatedRoute(p.mediationId));
    const { link, answered, release } = held(p);
    const done: string[] = [];
    const enrolling = accountOver(p, { link, confirmations: transientOptions() })
      .enroll()
      .then(() => done.push("enroll"));
    await answered;
    const other = accountOver(p);
    const adding = other.addRecipients().then(() => done.push("recipients"));
    const replicas = await other.listReplicas();
    done.push("list");
    expect(replicas.map(({ self }) => self)).toEqual([true]);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(0);
    release();
    await Promise.all([enrolling, adding]);
    expect(done).toEqual(["list", "enroll", "recipients"]);
    expect(sent(mediator, REPLICA_ADD)).toBe(2);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(1);
  });

  it("discloses a mediated address in one turn of its own, the address added and the disclosure committed there, behind the turn already taken", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const { created, minted } = await createDid(p.runtime, p.keys, mediatedRoute(p.mediationId));
    const { link, answered, release } = held(p);
    const done: string[] = [];
    const enrolling = accountOver(p, { link, confirmations: transientOptions() })
      .enroll()
      .then(() => done.push("enroll"));
    await answered;
    const disclosing = disclose(p.account, p.runtime, p.keys, created.data.didId, { as: "oob" }).then(() => done.push("disclose"));
    const adding = accountOver(p)
      .addRecipients()
      .then(() => done.push("recipients"));
    release();
    await Promise.all([enrolling, disclosing, adding]);
    expect(done[0]).toBe("enroll");
    expect(done.slice(1).sort()).toEqual(["disclose", "recipients"]);
    expect(sent(mediator, RECIPIENT_ADD)).toBe(1);
    expect(mediator.sharedRecipients.has(minted.did)).toBe(true);
    expect((await scanVault(p.runtime.vault, p.keys)).dids.entities.get(created.data.didId)?.disclosures).toHaveLength(1);
  });

  it("is unusable once retired, through a binding taken before", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const agent = await agentOf(p);
    const arrangement = await agent.arrangement(p.mediationId);
    await p.runtime.vault.commit([], [vaultDraft("mediation.retired", { mediationId: p.mediationId, because: "gone" })]);
    for (const operation of [() => arrangement.enroll(), () => arrangement.addRecipients(), () => arrangement.listReplicas()]) await expect(operation()).rejects.toBeInstanceOf(Unusable);
    expect(sent(mediator, REPLICA_LIST)).toBe(0);
  });
});

describe("an arrangement taken from an agent", () => {
  it("is the account's three operations, and not its turn", () => {
    expectTypeOf<Awaited<ReturnType<Agent["arrangement"]>>>().toEqualTypeOf<Arrangement>();
    expectTypeOf<Arrangement>().not.toHaveProperty("turn");
    for (const unbound of ["Account", "enroll", "addRecipients", "addRecipientsNow", "listReplicas", "disclose", "dispatch", "Dispatcher", "manualProcedures"]) expect(core).not.toHaveProperty(unbound);
  });

  it("is taken for an arrangement whose account is not registered, which lists nothing and has its mediator not even resolved", async () => {
    const fresh = await freshVault();
    closing.push(fresh.runtime);
    const { mediationId } = (await createMediation(fresh.runtime, fresh.keys, "did:web:mediator.example" as Did)).data;
    const web = webFetch({});
    const agent = await Agent.open(fresh, { didcomm, fetch: web.fetch, trace: await AgentTrace.open(fresh.runtime.local), liveDelivery: false });
    closing.unshift(agent);
    const arrangement = await agent.arrangement(mediationId);
    const refused = await arrangement.listReplicas().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(Unusable);
    expect((refused as Unusable).faults).toEqual(["its account is not registered"]);
    expect(web.calls).toEqual([]);
  });

  it("is not taken for an arrangement the vault does not record", async () => {
    const p = await party(await newMediator());
    closing.push(p.runtime);
    const agent = await agentOf(p);
    await expect(agent.arrangement("019b0000-0000-5000-8000-000000000000" as MediationId)).rejects.toBeInstanceOf(UnknownEntity);
  });

  it("reaches the mediator no more once the agent closed, and answers what is confirmed already as before", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    closing.push(p.runtime);
    const agent = await agentOf(p);
    await agent.enroll(p.mediationId);
    const arrangement = await agent.arrangement(p.mediationId);
    agent.close();
    const asked = mediator.seenTypes.length;
    expect((await arrangement.enroll()).steps).toEqual([]);
    expect((await arrangement.addRecipients()).added).toEqual([]);
    await expect(arrangement.listReplicas()).rejects.toBeInstanceOf(LinkClosed);
    await createDid(p.runtime, p.keys, mediatedRoute(p.mediationId));
    await expect(arrangement.addRecipients()).rejects.toBeInstanceOf(LinkClosed);
    expect(mediator.seenTypes).toHaveLength(asked);
  });

  it("makes no line once the agent closed, nor resolves the mediator for one", async () => {
    const fresh = await freshVault();
    closing.push(fresh.runtime);
    const { mediationId } = (await createMediation(fresh.runtime, fresh.keys, "did:web:mediator.example" as Did)).data;
    const web = webFetch({});
    const agent = await Agent.open(fresh, { didcomm, fetch: web.fetch, trace: await AgentTrace.open(fresh.runtime.local), liveDelivery: false });
    const arrangement = await agent.arrangement(mediationId);
    agent.close();
    await expect(arrangement.enroll()).rejects.toBeInstanceOf(LinkClosed);
    expect(web.calls).toEqual([]);
  });
});

describe("a dispatch and a disclosure", () => {
  it("take the account bound, and not the confirmations and the link apart", () => {
    expectTypeOf<DispatchOptions>().not.toHaveProperty("confirmations");
    expectTypeOf<DispatchOptions>().not.toHaveProperty("links");
    expectTypeOf<DispatchOptions["accounts"]>().toEqualTypeOf<((mediationId: MediationId) => Account | null) | undefined>();
    expectTypeOf<Parameters<typeof disclose>>().toEqualTypeOf<[account: Account | null, runtime: VaultRuntime, keys: Keys, didId: DidId, disclosure: Disclosure]>();
  });
});
