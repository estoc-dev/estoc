import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { readReplicaGrant, signReplicaGrant, type Did, type ReplicaId } from "@estoc/vault";

import { Agent, AgentTrace, INVALID_MESSAGE, MediatorRefused, PROBLEM_REPORT, REPLICAS, REPLICA_LIST, Unusable, canonicalDid, type ListedReplica } from "../src/index.js";
import type { FakeMediator } from "./fake-mediator.js";
import { copyOf, didcomm, newMediator, party, type Party } from "./helpers.js";

const closing: { close(): unknown }[] = [];

afterEach(async () => {
  for (const held of closing.splice(0)) await held.close();
});

async function enrolled(mediator: FakeMediator, fill = 1): Promise<Party> {
  const p = await party(mediator, fill);
  closing.push(p.runtime);
  await p.account.enroll();
  return p;
}

/** Another replica of the party's seed in its account, added at the mediator with a grant the seed signs: a device with no runtime here. */
async function added(p: Party, grant?: string): Promise<Did> {
  const jws = grant ?? (await signReplicaGrant(p.keys, p.created.data, uuidv7() as ReplicaId));
  const { replicaDid } = readReplicaGrant(jws);
  p.mediator.replicas.set(replicaDid, { account: canonicalDid(p.created.data.me.did), replicaDid, grant: jws, removedTime: null });
  return replicaDid;
}

/** The grant spelled otherwise: the last character of an Ed25519 signature has low bits that encode nothing, and flipping them changes no byte of it. */
function respelled(jws: string, bits: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return jws.slice(0, -1) + alphabet[alphabet.indexOf(jws.at(-1)!) ^ bits];
}

const active = (grant: string) => ({ grant, state: "active", added_time: 1, removed_time: null });
const listed = (p: Party): Promise<ListedReplica[]> => p.account.listReplicas();
const asked = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === REPLICA_LIST).length;
const roster = (mediator: FakeMediator): Did[] => [...mediator.replicas.keys()] as Did[];

describe("the replicas an account added", () => {
  it("are listed to each replica of the seed alike, each told which one is its own", async () => {
    const mediator = await newMediator();
    const open = async (fresh: Pick<Party, "runtime" | "keys">): Promise<Agent> => {
      const agent = await Agent.open(fresh, { didcomm, fetch: mediator.fetch, WebSocket: mediator.WebSocket, trace: await AgentTrace.open(fresh.runtime.local), localOptions: fresh.runtime.local.options, liveDelivery: false });
      closing.unshift(agent);
      return agent;
    };
    const p = await party(mediator);
    closing.push(p.runtime);
    const first = await open(p);
    const ours = (await first.enroll(p.mediationId)).replica;
    const copy = await copyOf(1, p);
    closing.push(copy.runtime);
    const second = await open(copy);
    const theirs = (await second.enroll(p.mediationId)).replica;

    const fromFirst = await (await first.arrangement(p.mediationId)).listReplicas();
    const fromSecond = await (await second.arrangement(p.mediationId)).listReplicas();
    const as = (replica: typeof ours, self: boolean) => ({ replicaId: replica.replicaId, did: replica.did, longFormDid: replica.longFormDid, state: "active", addedTime: 1, removedTime: null, self });
    expect(fromFirst).toEqual([as(ours, true), as(theirs, false)]);
    expect(fromSecond).toEqual([as(ours, false), as(theirs, true)]);
  });

  it("are listed whole and in the order they were added, across pages", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    for (let i = 0; i < 17; i++) await added(p);
    const replicas = await listed(p);
    expect(replicas.map(({ did }) => did)).toEqual(roster(mediator));
    expect(replicas.filter(({ self }) => self).map(({ replicaId }) => replicaId)).toEqual([p.runtime.author]);
    expect(asked(mediator)).toBe(2);
  });

  it("are asked for one at a time once a mediator refuses the first page as larger than it takes", async () => {
    const mediator = await newMediator();
    mediator.maxMembershipPage = 4;
    const p = await enrolled(mediator);
    await added(p);
    await added(p);
    expect((await listed(p)).map(({ did }) => did)).toEqual(roster(mediator));
    expect(asked(mediator)).toBe(1 + 3);
  });

  it("are listed again from the first page once when a cursor is refused, and not again", async () => {
    const mediator = await newMediator();
    mediator.maxMembershipPage = 1;
    const p = await enrolled(mediator);
    await added(p);
    let refusals = 1;
    mediator.intercept = (msg, from) => (msg.type === REPLICA_LIST && msg.body["cursor"] !== null && refusals-- > 0 ? mediator.reply(PROBLEM_REPORT, from as string, { code: INVALID_MESSAGE }, msg.id) : undefined);
    expect((await listed(p)).map(({ did }) => did)).toEqual(roster(mediator));

    refusals = 2;
    const refused = await listed(p).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(MediatorRefused);
    expect((refused as MediatorRefused).code).toBe(INVALID_MESSAGE);
  });

  it("leave out a grant the seed or the arrangement does not bear out, and trace why", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const stranger = await party(mediator, 2);
    closing.push(stranger.runtime);
    await added(p, await signReplicaGrant(stranger.keys, stranger.created.data, uuidv7() as ReplicaId));
    const elsewhere = (await newMediator(201, "http://other-mediator/")).did as Did;
    await added(p, await signReplicaGrant(p.keys, { ...p.created.data, mediatorDid: elsewhere }, uuidv7() as ReplicaId));
    const kept = await added(p);

    expect((await listed(p)).map(({ did, self }) => ({ did, self }))).toEqual([
      { did: roster(mediator)[0], self: true },
      { did: kept, self: false },
    ]);
    const [traced] = await p.trace.read({ type: "diag.replica-list" });
    expect(traced?.data["listed"]).toEqual([roster(mediator)[0], kept]);
    expect(traced?.data["refused"]).toEqual([expect.stringContaining("account"), expect.stringContaining(elsewhere)]);
  });

  it("include one the mediator removed, as removed and when", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const gone = await added(p);
    mediator.replicas.get(gone)!.removedTime = 7;
    expect((await listed(p)).map(({ did, state, removedTime }) => ({ did, state, removedTime }))).toEqual([
      { did: roster(mediator)[0], state: "active", removedTime: null },
      { did: gone, state: "removed", removedTime: 7 },
    ]);
  });

  it("are not asked for while the arrangement's account is not registered", async () => {
    const mediator = await newMediator();
    const p = await party(mediator);
    closing.push(p.runtime);
    await expect(listed(p)).rejects.toBeInstanceOf(Unusable);
    expect(mediator.seenTypes).toEqual([]);
  });

  it("are each listed once, however many spellings of its grant the mediator lists", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const [own] = mediator.replicas.values();
    const [first, second, third] = [0, 1, 2].map((bits) => respelled(own!.grant, bits));
    mediator.intercept = (msg, from) =>
      msg.type === REPLICA_LIST ? mediator.reply(REPLICAS, from as string, msg.body["cursor"] === null ? { entries: [active(first!), active(second!)], next_cursor: "on" } : { entries: [active(third!)], next_cursor: null }, msg.id) : undefined;
    expect((await listed(p)).map(({ did, self }) => ({ did, self }))).toEqual([{ did: own!.replicaDid, self: true }]);
    expect(asked(mediator)).toBe(2);
  });

  it("are not asked for again by a page that goes on to a cursor given before, whatever else it lists", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    for (const cursors of [["again", "again"], ["one", "two", "one"]]) {
      const before = asked(mediator);
      let page = 0;
      mediator.intercept = (msg, from) => (msg.type === REPLICA_LIST ? mediator.reply(REPLICAS, from as string, { entries: [active(`not a grant ${page}`)], next_cursor: cursors[page++] }, msg.id) : undefined);
      await expect(listed(p)).rejects.toBeInstanceOf(MediatorRefused);
      expect(asked(mediator) - before).toBe(cursors.length);
    }
  });

  it("are not asked for again by a page that lists none not listed before", async () => {
    const mediator = await newMediator();
    const p = await enrolled(mediator);
    const [own] = mediator.replicas.values();
    let page = 0;
    mediator.intercept = (msg, from) => (msg.type === REPLICA_LIST ? mediator.reply(REPLICAS, from as string, { entries: [active(own!.grant)], next_cursor: `page ${++page}` }, msg.id) : undefined);
    await expect(listed(p)).rejects.toBeInstanceOf(MediatorRefused);
    expect(asked(mediator)).toBe(2);
  });
});
