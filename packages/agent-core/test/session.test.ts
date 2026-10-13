import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import { Snapshot, exportSnapshot, restoreSnapshot } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { createSeedKeystore } from "@estoc/keystore";
import { IdentityMismatch, Keys, PING_RESPONSE_EFFECT, PING_TYPE, vaultHeldRoots, type DidId, type MessageId, type VaultFold } from "@estoc/vault";

import { responding } from "../src/action.js";
import { reactTo } from "../src/effects.js";
import { Agent, AgentTrace, openRestoredVault, openVault, type Handler, type VaultSession } from "../src/index.js";
import { Keyring } from "../src/keyring.js";
import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { receiptOf } from "../src/receive/receipt.js";
import { Receiver } from "../src/receive/receiver.js";
import { PASSPHRASE, didcomm, directParty, freshVault, memoryDriver, observed, peerSealer, sealed, seedOf, type DirectParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const ECHO_TYPE = "https://example.org/echo/1.0/echo";
const ECHO_EFFECT = "https://example.org/echo/1.0#echo";
const echo: Handler = {
  types: [BASIC_MESSAGE],
  effectTypes: [ECHO_EFFECT],
  respond: async (input) => [{ effectType: ECHO_EFFECT, content: { type: ECHO_TYPE, body: {}, thid: input.source.event.data.wireMessageId, pleaseAck: null, ack: [] } }],
};
const pong: Handler = { types: [PING_TYPE], effectTypes: [PING_RESPONSE_EFFECT], respond: async () => [] };

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "estoc-session-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fresh = (): string => path.join(dir, `vault-${n++}.sqlite`);
const agentOptions = async (session: VaultSession, handlers: readonly Handler[] = []) => ({ didcomm, fetch: globalThis.fetch, trace: await AgentTrace.open(session.runtime.local), liveDelivery: false, handlers });

/** Bob's chat received by Alice and answered by her echo handler, the echo's intent left queued: an intent of an operation beyond the built-in ones, for the fold to count or not. */
async function echoed(alice: DirectParty): Promise<MessageId> {
  const bob = await directParty(2, "https://bob.example/didcomm", BOB);
  const receiver = new Receiver(alice.session, await Keyring.load(alice.keys, await alice.session.fold()), { didcomm, receipt: receiptOf(alice.session) });
  try {
    const received = await receiver.receive({ packed: await sealed(await peerSealer(bob), alice.longFormDid, { type: BASIC_MESSAGE, body: { content: "hi" } }), source: { kind: "direct" } });
    if (received.outcome !== "received" || received.live === null) throw new Error(`not live: ${JSON.stringify(received)}`);
    const reacted = await reactTo(alice.session, responding(received.live), { handlers: [echo], dispatch: async (action) => ({ outcome: "none", messageId: action.messageId, because: "no transport here" }) });
    const made = reacted.effects.find((effect) => effect.effectType === ECHO_EFFECT);
    if (made?.outcome !== "created") throw new Error(`no echo: ${JSON.stringify(reacted)}`);
    return made.messageId;
  } finally {
    receiver.close();
    await bob.runtime.close();
  }
}

const workOf = (fold: VaultFold, messageId: MessageId) => fold.outbound.outbounds.get(messageId)!.work;
const UNKNOWN = { kind: "none", because: expect.stringContaining(`no operation here produces ${ECHO_EFFECT}`) as string };

describe("the vault session", () => {
  it("keeps the keys inside, and the agent takes only a session this package bound", async () => {
    expectTypeOf<VaultSession>().not.toHaveProperty("keys");
    const alice = await freshVault();
    const { session } = alice;
    const lookalike: VaultSession = {
      runtime: session.runtime,
      fold: () => session.fold(),
      locked: (work) => session.locked(work),
      decide: (choose) => session.decide(choose),
      turn: (key, work) => session.turn(key, work),
      createDid: (route, didId) => session.createDid(route, didId),
      createMediation: (mediatorDid) => session.createMediation(mediatorDid),
      selectMediation: (mediationId) => session.selectMediation(mediationId),
      heldRoots: () => session.heldRoots(),
      retainedRoots: () => session.retainedRoots(),
    };
    await expect(Agent.open(lookalike, await agentOptions(session))).rejects.toThrow("the vault is not one this package opened");
    await expect(Agent.open({ runtime: alice.runtime, keys: alice.keys } as unknown as VaultSession, await agentOptions(session))).rejects.toThrow(TypeError);
    const agent = await Agent.open(session, await agentOptions(session));
    agent.close();
    await alice.runtime.close();
  });

  it("binds a restored runtime under the seed that derives its anchor, and closes one another seed is offered for", async () => {
    const alice = await freshVault(1, "Alice");
    const snapshot = await Snapshot.read(await exportSnapshot(alice.runtime, { parts: "both", heldRoots: alice.session.heldRoots() }), { heldRoots: vaultHeldRoots(null) });
    await alice.runtime.close();
    const other = await createSeedKeystore(PASSPHRASE, { seed: seedOf(2) });
    const restoredInto = async (file: string) => (await restoreSnapshot(snapshot, () => openNodeSqlite(file, { mode: "create" }), { anchor: await Keys.anchorOf(alice.seedKey) })).runtime;

    const refused = fresh();
    await expect(openRestoredVault(await restoredInto(refused), other.seedKey)).rejects.toBeInstanceOf(IdentityMismatch);
    // the file is not held by the refused open: it opens again, under the seed it was restored for
    const reopened = await openVault(openNodeSqlite(refused, { mode: "readwrite" }), alice.seedKey);
    expect((await reopened.fold()).label).toBe("Alice");
    await reopened.runtime.close();

    const bound = await openRestoredVault(await restoredInto(fresh()), alice.seedKey);
    expect(bound.runtime.metadata.anchor).toBe(await Keys.anchorOf(alice.seedKey));
    expect((await bound.fold()).label).toBe("Alice");
    expect(bound.runtime.author).not.toBe(alice.runtime.author);
    await bound.runtime.close();
  });

  it("refuses handlers whose effect types the vault was not opened with, and takes the built-in ones unlisted", async () => {
    const plain = await freshVault();
    await expect(Agent.open(plain.session, await agentOptions(plain.session, [echo]))).rejects.toThrow(`the handlers declare effect types the vault was not opened with: ${ECHO_EFFECT}`);
    const pinged = await Agent.open(plain.session, await agentOptions(plain.session, [pong]));
    pinged.close();
    await plain.runtime.close();

    const declared = await freshVault(1, "party 1", memoryDriver(), { effectTypes: [ECHO_EFFECT] });
    const echoing = await Agent.open(declared.session, await agentOptions(declared.session, [echo, pong]));
    echoing.close();
    await declared.runtime.close();
  });

  it("reads every fold under the effect types it was opened with, which a vault opened without them reads as no work of its own", async () => {
    const alice = await directParty(1, "https://alice.example/didcomm", ALICE, memoryDriver(), { effectTypes: [ECHO_EFFECT] });
    const messageId = await echoed(alice);
    expect(workOf(await alice.session.fold(), messageId)).toEqual({ kind: "prepare" });
    await alice.session.locked(async (locked) => {
      const fold = await locked.fold();
      expect(workOf(fold, messageId)).toEqual({ kind: "prepare" });
      expect(workOf(await locked.foldOf(fold.set), messageId)).toEqual({ kind: "prepare" });
    });

    const unaware = await freshVault(1, "the same seed, told of no operation", memoryDriver());
    await unaware.runtime.ingest([...(await alice.session.fold()).set.all()]);
    expect(workOf(await unaware.session.fold(), messageId)).toEqual(UNKNOWN);
    await unaware.runtime.close();
    await alice.runtime.close();
  });

  it("reads the fold its admissions leave under the same effect types", async () => {
    const alice = await directParty(1, "https://alice.example/didcomm", ALICE, memoryDriver(), { effectTypes: [ECHO_EFFECT] });
    const messageId = await echoed(alice);
    const bob = await directParty(2, "https://bob.example/didcomm", BOB);
    const waiting = await observed(alice, bob, "wire-2", { type: BASIC_MESSAGE, body: { content: "again" } });
    await alice.session.locked(async (locked) => {
      const before = await locked.fold();
      expect(before.admissions.admitted(waiting)).toBe(false);
      const { fold, events } = await locked.admitReceipts(before);
      expect(events.map((event) => event.data.sourceEventCid)).toEqual([waiting]);
      expect(fold.admissions.admitted(waiting)).toBe(true);
      expect(workOf(fold, messageId)).toEqual({ kind: "prepare" });
    });
    await bob.runtime.close();
    await alice.runtime.close();
  });

  it("copies the effect types at open: a generator is read once, and a set changed afterwards changes nothing", async () => {
    const declared = new Set([ECHO_EFFECT]);
    const bySet = await directParty(1, "https://alice.example/didcomm", ALICE, memoryDriver(), { effectTypes: declared });
    const messageId = await echoed(bySet);
    declared.clear();
    expect(workOf(await bySet.session.fold(), messageId)).toEqual({ kind: "prepare" });
    await bySet.runtime.close();

    const byGenerator = await directParty(1, "https://alice.example/didcomm", ALICE, memoryDriver(), { effectTypes: (function* () { yield ECHO_EFFECT; })() });
    const again = await echoed(byGenerator);
    expect(workOf(await byGenerator.session.fold(), again)).toEqual({ kind: "prepare" });
    expect(workOf(await byGenerator.session.fold(), again)).toEqual({ kind: "prepare" });
    await byGenerator.runtime.close();
  });
});
