import { describe, expect, expectTypeOf, it, test, vi } from "vitest";

import { scanVault, type DidId, type EventReference, type MessageId } from "@estoc/vault";
import type { VaultRuntime } from "@estoc/event-store";

import { BASIC_MESSAGE } from "../src/protocol/basicmessage.js";
import { LocalRecords, type Content } from "../src/index.js";
import { LiveAction } from "../src/action.js";
import { Keyring } from "../src/keyring.js";
import { localRecordsOf, transientOptions } from "../src/local-records.js";
import { prepare } from "../src/prepare.js";
import { Receiver } from "../src/receive/receiver.js";
import { send } from "../src/send.js";
import { dispatch, selectPreparation } from "../src/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "../src/dispatcher.js";
import { after, didcomm, directParty, handTimers, merged, posting, until, type DirectParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };
const T0 = 1_700_000_000_000;

const accepted = (): Response => new Response(null, { status: 202 });

interface Scene {
  alice: DirectParty;
  bob: DirectParty;
  timers: ReturnType<typeof handTimers>;
  wire: ReturnType<typeof posting>;
  log: string[];
  dispatcher: Dispatcher;
  close(): Promise<void>;
}

async function scene(over: Partial<DispatcherOptions> = {}, answer: () => Response | Promise<Response> = accepted): Promise<Scene> {
  const alice = await directParty(1, "https://alice.example/didcomm", ALICE);
  const bob = await directParty(2, "https://bob.example/didcomm", BOB);
  const timers = handTimers();
  const wire = posting(answer);
  const log: string[] = [];
  const dispatcher = new Dispatcher(alice.session, { didcomm, fetch: wire.fetch, timers, now: () => T0, log: (line) => log.push(line), ...over });
  return {
    alice,
    bob,
    timers,
    wire,
    log,
    dispatcher,
    close: async () => {
      dispatcher.close();
      await alice.runtime.close();
      await bob.runtime.close();
    },
  };
}

/** A message to Bob's short form: its long form is not in evidence, so the preparation waits for it. */
const toShortForm = (s: Scene, messageId: MessageId) => send(s.alice.session, { channel: { localDid: s.alice.did, peerDid: s.bob.did } }, HELLO, { messageId });
/** A message to Bob's long form: it brings the long form into evidence for every message to Bob. */
const toLongForm = (s: Scene, messageId: MessageId) => send(s.alice.session, { channel: { localDid: s.alice.did, peerDid: s.bob.longFormDid } }, HELLO, { messageId });

/** A message to Bob's long form prepared and selected in the runtime's records in memory, and a second valid preparation of it beside that one, as another replica made it. */
async function preparedTwice(s: Scene, messageId: MessageId) {
  const sent = await toLongForm(s, messageId);
  const made = await prepare(s.alice.session, messageId, { didcomm });
  if (made.outcome !== "prepared") throw new Error(`not prepared: ${JSON.stringify(made)}`);
  const elsewhere = await merged(s.alice.runtime, "message.prepared", made.prepared.data, after(made.prepared.at, 1));
  return { action: sent.action, selected: made.prepared.cid as EventReference<"message.prepared">, elsewhere: elsewhere.cid as EventReference<"message.prepared"> };
}

describe("Dispatcher", () => {
  it("waits out a prerequisite for as long as the action lives, doubling the wait, and makes the call once it is there", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    const first = await s.dispatcher.run(sent.action);
    expect(first).toMatchObject({ outcome: "pending", messageId: MESSAGE });
    expect(s.dispatcher.waiting()).toEqual([{ messageId: MESSAGE, kind: "initial", attempts: 1, nextAt: T0 + 30_000, reason: expect.stringMatching(/no long form of/) }]);
    expect(s.timers.waits.map((wait) => wait.ms)).toEqual([30_000]);

    s.timers.waits[0]!.fire();
    await until("the second attempt waited", () => s.timers.waits.length === 2);
    expect(s.dispatcher.waiting()).toMatchObject([{ attempts: 2, nextAt: T0 + 60_000 }]);
    expect(s.timers.waits[1]!.ms).toBe(60_000);
    expect(s.wire.posts).toEqual([]);

    await toLongForm(s, SECOND);
    s.timers.waits[1]!.fire();
    await until("the message was carried", () => s.dispatcher.waiting().length === 0);
    expect(s.wire.posts).toHaveLength(1);
    expect(sent.action.spent).toBe(true);
    const fold = await scanVault(s.alice.runtime.vault, s.alice.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)!.submitted).toBe(true);
    expect(fold.outbound.outbounds.get(SECOND)!.outcome).toEqual({ status: "queued" });
    expect((await s.dispatcher.pending()).map((entry) => [entry.outbound.messageId, entry.waiting])).toEqual([[SECOND, null]]);
    expect(s.log).toEqual([]);
    await s.close();
  });

  it("gives the action up once its attempts are spent, and says so", async () => {
    const s = await scene({ retry: { attempts: 2 } });
    const sent = await toShortForm(s, MESSAGE);
    await s.dispatcher.run(sent.action);
    s.timers.waits[0]!.fire();
    await until("the action was given up on", () => s.dispatcher.waiting().length === 0);
    expect(s.timers.waits).toHaveLength(1);
    expect(s.log).toEqual([expect.stringMatching(/given up on after 2 attempts: no long form of/)]);
    expect(sent.action.spent).toBe(false);
    expect((await s.dispatcher.pending()).map((entry) => [entry.outbound.messageId, entry.waiting])).toEqual([[MESSAGE, null]]);
    await s.close();
  });

  test("a call that was refused is not made again on its own: a retry mints a fresh manual action", async () => {
    const answers: (() => Response)[] = [() => new Response("later", { status: 503 }), accepted];
    const s = await scene({}, () => answers.shift()!());
    const sent = await toLongForm(s, MESSAGE);
    expect(await s.dispatcher.run(sent.action)).toMatchObject({ outcome: "failed", reason: "the endpoint answered 503" });
    expect(s.dispatcher.waiting()).toEqual([]);
    expect(s.timers.waits).toEqual([]);
    expect(await s.dispatcher.retry(MESSAGE)).toMatchObject({ outcome: "submitted", messageId: MESSAGE });
    expect(s.wire.posts).toHaveLength(2);
    expect(s.wire.posts[0]!.body).toBe(s.wire.posts[1]!.body);
    await s.close();
  });

  it("lists what is pending with the wait on it; cancelling drops the wait and terminates the message", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    await toShortForm(s, SECOND);
    await s.dispatcher.run(sent.action);
    expect((await s.dispatcher.pending()).map((entry) => [entry.outbound.messageId, entry.waiting?.attempts ?? null])).toEqual([
      [MESSAGE, 1],
      [SECOND, null],
    ]);
    expect(await s.dispatcher.cancel(MESSAGE)).toMatchObject({ outcome: "cancelled", messageId: MESSAGE });
    expect(s.timers.waits[0]!.cleared).toBe(true);
    expect(s.dispatcher.waiting()).toEqual([]);
    expect((await s.dispatcher.pending()).map((entry) => entry.outbound.messageId)).toEqual([SECOND]);
    expect(sent.action.spent).toBe(false);
    await s.close();
  });

  test("a newer action for the message replaces the one waiting; closing drops every wait and takes no more", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    await s.dispatcher.run(sent.action);
    const manual = LiveAction.manual(MESSAGE);
    expect(await s.dispatcher.run(manual)).toMatchObject({ outcome: "pending" });
    expect(s.timers.waits.map((wait) => wait.cleared)).toEqual([true, false]);
    expect(s.dispatcher.waiting()).toMatchObject([{ messageId: MESSAGE, kind: "manual", attempts: 1 }]);

    s.dispatcher.close();
    expect(s.timers.waits.map((wait) => wait.cleared)).toEqual([true, true]);
    expect(s.dispatcher.waiting()).toEqual([]);
    expect(await s.dispatcher.run(LiveAction.manual(MESSAGE))).toEqual({ outcome: "none", messageId: MESSAGE, because: "the dispatcher is closed" });
    await s.close();
  });

  test("work on a message whose call is in flight waits for that call, from another dispatcher of the runtime or from none: the acceptance is recorded first, so nothing is cancelled and the selection stays, while another message is carried meanwhile", async () => {
    let answer: (response: Response) => void = () => undefined;
    const answers = [() => new Promise<Response>((resolve) => (answer = resolve)), accepted];
    const s = await scene({}, () => answers.shift()!());
    const first = await preparedTwice(s, MESSAGE);
    const second = await toLongForm(s, SECOND);
    const records = localRecordsOf(s.alice.runtime, undefined);
    const settled: string[] = [];
    const running = s.dispatcher.run(first.action).finally(() => settled.push("dispatch"));
    await until("the call is in flight", () => s.wire.posts.length === 1);

    const other = new Dispatcher(s.alice.session, { didcomm, fetch: s.wire.fetch });
    const cancelled = other.cancel(MESSAGE).finally(() => settled.push("cancel"));
    const selected = selectPreparation(s.alice.session, MESSAGE, first.elsewhere).finally(() => settled.push("select"));
    expect(await other.run(second.action)).toMatchObject({ outcome: "submitted", messageId: SECOND });
    expect(settled).toEqual([]);
    let fold = await scanVault(s.alice.runtime.vault, s.alice.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)).toMatchObject({ submitted: false, terminal: null });
    expect(await records.selected(MESSAGE)).toBe(first.selected);

    answer(accepted());
    expect(await running).toMatchObject({ outcome: "submitted", messageId: MESSAGE, preparationEventCid: first.selected });
    expect(await cancelled).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    expect(await selected).toEqual({ outcome: "none", messageId: MESSAGE, because: "submitted" });
    expect(settled).toEqual(["dispatch", "cancel", "select"]);
    fold = await scanVault(s.alice.runtime.vault, s.alice.keys);
    expect(fold.set.of("delivery.submitted").map((event) => event.data.messageId).sort()).toEqual([MESSAGE, SECOND]);
    expect(fold.set.of("delivery.failed")).toEqual([]);
    expect(await records.selected(MESSAGE)).toBe(first.selected);
    expect(s.wire.posts).toHaveLength(2);
    other.close();
    await s.close();
  });

  test("a dispatcher given local records selects and carries by them, while a dispatcher and the procedures given none share the runtime's records in memory", async () => {
    const answers = [() => new Response("later", { status: 503 }), accepted];
    const s = await scene({}, () => answers.shift()!());
    const records = new LocalRecords(transientOptions(), s.alice.runtime.author);
    const own = new Dispatcher(s.alice.session, { didcomm, fetch: s.wire.fetch, local: records });
    const { selected, elsewhere } = await preparedTwice(s, MESSAGE);
    const selections = async () => [await localRecordsOf(s.alice.runtime, undefined).selected(MESSAGE), await records.selected(MESSAGE)];
    expect(await selections()).toEqual([selected, null]);

    expect(await s.dispatcher.retry(MESSAGE)).toMatchObject({ outcome: "failed", preparationEventCid: selected });
    expect(await own.retry(MESSAGE)).toEqual({ outcome: "none", messageId: MESSAGE, because: "2 valid preparations of the message are here, and which one to carry is to be chosen" });
    expect(await own.select(MESSAGE, elsewhere)).toEqual({ outcome: "selected", messageId: MESSAGE, preparationEventCid: elsewhere });
    expect(await selections()).toEqual([selected, elsewhere]);

    expect(await own.retry(MESSAGE)).toMatchObject({ outcome: "submitted", preparationEventCid: elsewhere });
    const fold = await scanVault(s.alice.runtime.vault, s.alice.keys);
    expect(fold.set.of("delivery.submitted").map((event) => event.data.preparationEventCid)).toEqual([elsewhere]);
    expect(s.wire.posts).toHaveLength(2);
    own.close();
    await s.close();
  });

  test("a dispatcher's options do not say when it has closed", () => {
    expectTypeOf<DispatcherOptions>().not.toHaveProperty("closed");
  });

  test("a close while the call is being readied leaves the call unmade, the action live and nothing waiting", async () => {
    const s = await scene();
    const sent = await toLongForm(s, MESSAGE);
    const locked = s.alice.runtime.locked.bind(s.alice.runtime);
    vi.spyOn(s.alice.runtime, "locked").mockImplementation((async (work: Parameters<VaultRuntime["locked"]>[0]) => {
      const value = await locked(work);
      s.dispatcher.close();
      return value;
    }) as VaultRuntime["locked"]);
    expect(await s.dispatcher.run(sent.action)).toEqual({ outcome: "none", messageId: MESSAGE, because: "closed before the call" });
    vi.restoreAllMocks();
    expect(s.wire.posts).toEqual([]);
    expect(sent.action.spent).toBe(false);
    expect(s.dispatcher.waiting()).toEqual([]);
    expect(s.timers.waits).toEqual([]);
    expect(await dispatch(s.alice.session, sent.action, { didcomm, fetch: s.wire.fetch })).toMatchObject({ outcome: "submitted" });
    expect(s.wire.posts).toHaveLength(1);
    await s.close();
  });

  test("closing it closes nothing else of its runtime, nor does closing a receiver beside it close it", async () => {
    const s = await scene();
    const sent = await toShortForm(s, MESSAGE);
    expect(await s.dispatcher.run(sent.action)).toMatchObject({ outcome: "pending" });
    const ring = await Keyring.load(s.alice.keys, await scanVault(s.alice.runtime.vault, s.alice.keys));
    const receipt = async () => ({ outcome: "terminal", reason: "kept for the test" }) as const;
    new Receiver(s.alice.session, ring, { didcomm, receipt }).close();
    expect(s.dispatcher.waiting()).toMatchObject([{ messageId: MESSAGE, attempts: 1, nextAt: T0 + 30_000 }]);
    s.timers.waits[0]!.fire();
    await until("the second attempt waited", () => s.timers.waits.length === 2);

    const receiver = new Receiver(s.alice.session, ring, { didcomm, receipt });
    s.dispatcher.close();
    expect(await receiver.receive({ packed: "not an envelope", source: { kind: "direct" } })).toMatchObject({ outcome: "terminal" });
    receiver.close();
    await s.close();
  });
});
