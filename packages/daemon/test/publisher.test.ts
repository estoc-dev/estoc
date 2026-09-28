import { describe, expect, it } from "vitest";

import type { Hold } from "@estoc/daemon-api/contract";
import { Publisher, StateChanged, type BaselineOf, type LinesStateOf, type NonOpenValue, type StateOf } from "../src/publisher.js";

type Snap = { n: number };
type Lines = string[];

const HOLD = "hold-1" as Hold;
const BOOTING: NonOpenValue = { phase: "booting", hold: null, detail: null };
const LOCKED: NonOpenValue = { phase: "locked", hold: HOLD, detail: null };
const NO_LINES: Lines = [];

interface Capture {
  cut(): void;
  resolve(snapshot: Snap): void;
  reject(error: unknown): void;
}

/** A runtime whose reads the test completes by hand, in the order asked. */
function runtime(): { captures: Capture[]; source: { capture(cut: () => void): Promise<Snap> } } {
  const captures: Capture[] = [];
  return {
    captures,
    source: {
      capture: (cut) =>
        new Promise<Snap>((resolve, reject) => {
          captures.push({ cut, resolve, reject });
        }),
    },
  };
}

type Heard = ["state", StateOf<Snap>] | ["lines", LinesStateOf<Lines>] | ["log", { epoch: string; line: string }] | ["unavailable", unknown];

/** A view: what it was handed on attaching, and everything since. */
function view(publisher: Publisher<Snap, Lines>): { baseline: BaselineOf<Snap, Lines>; heard: Heard[]; states(): StateOf<Snap>[] } {
  const heard: Heard[] = [];
  const baseline = publisher.attach({
    state: (state) => heard.push(["state", state]),
    lines: (lines) => heard.push(["lines", lines]),
    log: (line) => heard.push(["log", line]),
    unavailable: (error) => heard.push(["unavailable", error]),
  });
  return { baseline, heard, states: () => heard.filter((said): said is ["state", StateOf<Snap>] => said[0] === "state").map(([, state]) => state) };
}

function publisher(options: { maxRevision?: number } = {}): { publisher: Publisher<Snap, Lines>; failures: unknown[] } {
  const failures: unknown[] = [];
  return { publisher: new Publisher<Snap, Lines>(BOOTING, { noLines: NO_LINES, failed: (error) => failures.push(error), ...options }), failures };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A publisher showing a runtime whose first read is done: one epoch, revision 1. */
async function shown() {
  const made = publisher();
  const { captures, source } = runtime();
  const publishing = made.publisher.open(HOLD, source);
  captures[0]!.cut();
  captures[0]!.resolve({ n: 1 });
  await publishing.ready;
  return { ...made, captures, publishing };
}

const open = (state: StateOf<Snap>): Snap => (state.value.phase === "open" ? state.value.snapshot : (expect.fail(`${state.value.phase} shows no snapshot`) as never));

describe("the publisher", () => {
  it("shows a runtime as the open state of a fresh epoch once its first read is done, then as increasing revisions; a view attached meanwhile starts from what is published and sees what follows", async () => {
    const { publisher: p } = publisher();
    const first = view(p);
    expect(first.baseline.state).toMatchObject({ revision: 1, value: BOOTING });
    expect(first.baseline.lines).toEqual({ epoch: first.baseline.state.epoch, revision: 1, value: NO_LINES });

    const { captures, source } = runtime();
    const publishing = p.open(HOLD, source);
    expect(captures).toHaveLength(1);
    await tick();
    expect(first.heard).toEqual([]);
    p.lines(["too soon"]);
    expect(first.heard).toEqual([]);
    captures[0]!.cut();
    captures[0]!.resolve({ n: 1 });
    await publishing.ready;
    const [opened, lines] = first.heard;
    expect(opened).toEqual(["state", { epoch: expect.any(String), revision: 1, value: { phase: "open", hold: HOLD, snapshot: { n: 1 } } }]);
    const epoch = (opened as ["state", StateOf<Snap>])[1].epoch;
    expect(epoch).not.toBe(first.baseline.state.epoch);
    expect(lines).toEqual(["lines", { epoch, revision: 1, value: NO_LINES }]);
    expect(first.heard).toHaveLength(2);

    p.invalidate();
    await tick();
    expect(captures).toHaveLength(2);
    const second = view(p);
    expect(second.baseline.state).toEqual({ epoch, revision: 1, value: { phase: "open", hold: HOLD, snapshot: { n: 1 } } });
    captures[1]!.cut();
    captures[1]!.resolve({ n: 2 });
    await tick();
    expect(second.states()).toEqual([{ epoch, revision: 2, value: { phase: "open", hold: HOLD, snapshot: { n: 2 } } }]);
    expect(first.states().map(({ revision }) => revision)).toEqual([1, 2]);

    p.lines(["live"]);
    p.log("said");
    expect(second.heard.slice(1)).toEqual([
      ["lines", { epoch, revision: 2, value: ["live"] }],
      ["log", { epoch, line: "said" }],
    ]);
    expect(captures).toHaveLength(2);
  });

  it("does not publish a read begun for an epoch that has since ended, and refuses the refresh that waited on it", async () => {
    const { publisher: p, captures } = await shown();
    const v = view(p);
    p.invalidate();
    const refreshing = p.refresh();
    expect(captures).toHaveLength(2);
    captures[1]!.cut();

    p.set(LOCKED);
    await expect(refreshing).rejects.toThrow(StateChanged);
    expect(v.states()).toMatchObject([{ revision: 1, value: LOCKED }]);
    const locked = v.states()[0]!.epoch;
    expect(locked).not.toBe(v.baseline.state.epoch);
    expect(v.heard.at(-1)).toEqual(["lines", { epoch: locked, revision: 1, value: NO_LINES }]);

    captures[1]!.resolve({ n: 2 });
    await tick();
    expect(v.states()).toHaveLength(1);
    p.lines(["from the agent that was"]);
    expect(v.heard).toHaveLength(2);
    expect(await p.refresh()).toEqual({ epoch: locked, revision: 1 });
    expect(captures).toHaveLength(2);
  });

  it("does not publish a read of a runtime that was closed meanwhile, nor its lines, and refuses the refresh that waited on it", async () => {
    const { publisher: p, captures, publishing } = await shown();
    const v = view(p);
    p.invalidate();
    const refreshing = p.refresh();
    captures[1]!.cut();
    publishing.close();
    await expect(refreshing).rejects.toThrow(StateChanged);
    expect(await p.refresh()).toEqual({ epoch: v.baseline.state.epoch, revision: 1 });
    captures[1]!.resolve({ n: 2 });
    await tick();
    p.lines(["late"]);
    expect(v.heard).toEqual([]);
    p.invalidate();
    expect(captures).toHaveLength(2);
  });

  it("refuses the refresh waiting on a read of a runtime another runtime takes the place of, before the other is read", async () => {
    const { publisher: p, captures } = await shown();
    const v = view(p);
    p.invalidate();
    const refreshing = p.refresh();
    captures[1]!.cut();
    const next = runtime();
    const opening = p.open(HOLD, next.source);
    await expect(refreshing).rejects.toThrow(StateChanged);
    expect(v.heard).toEqual([]);
    captures[1]!.resolve({ n: 2 });
    await tick();
    next.captures[0]!.cut();
    next.captures[0]!.resolve({ n: 10 });
    await opening.ready;
    expect(v.states().map(open)).toEqual([{ n: 10 }]);
  });

  it("keeps publishing while changes keep coming, and the last read covers them all", async () => {
    const { publisher: p, captures } = await shown();
    const v = view(p);
    p.invalidate();
    expect(captures).toHaveLength(2);
    captures[1]!.cut();
    p.invalidate();
    p.invalidate();
    expect(captures).toHaveLength(2);
    captures[1]!.resolve({ n: 2 });
    await tick();
    expect(captures).toHaveLength(3);
    captures[2]!.cut();
    captures[2]!.resolve({ n: 3 });
    await tick();
    expect(captures).toHaveLength(3);
    expect(v.states().map(open)).toEqual([{ n: 2 }, { n: 3 }]);
    expect(await p.refresh()).toEqual({ epoch: v.baseline.state.epoch, revision: 3 });
    expect(captures).toHaveLength(3);
    expect(v.heard).toHaveLength(2);
  });

  it("answers a refresh with the state published when no change is unpublished, without a read or an event", async () => {
    const { publisher: p, captures } = await shown();
    const v = view(p);
    expect(await p.refresh()).toEqual({ epoch: v.baseline.state.epoch, revision: 1 });
    expect(captures).toHaveLength(1);
    expect(v.heard).toEqual([]);
  });

  it("answers a refresh before a runtime's first read stands with the state published now", async () => {
    const { publisher: p } = publisher();
    const v = view(p);
    const { captures, source } = runtime();
    p.open(HOLD, source);
    expect(await p.refresh()).toEqual({ epoch: v.baseline.state.epoch, revision: 1 });
    expect(captures).toHaveLength(1);
  });

  it("shares a read under way with a refresh when its cut began after the change asked about, and reads again for one whose change came after the cut", async () => {
    const { publisher: p, captures } = await shown();
    const v = view(p);
    p.invalidate();
    const early = p.refresh();
    expect(captures).toHaveLength(2);
    captures[1]!.cut();
    p.invalidate();
    const late = p.refresh();
    captures[1]!.resolve({ n: 2 });
    expect(await early).toEqual({ epoch: v.baseline.state.epoch, revision: 2 });
    let answered = false;
    void late.then(() => (answered = true));
    await tick();
    expect(answered).toBe(false);
    expect(captures).toHaveLength(3);
    captures[2]!.cut();
    captures[2]!.resolve({ n: 3 });
    expect(await late).toEqual({ epoch: v.baseline.state.epoch, revision: 3 });
    expect(v.states().map(({ revision }) => revision)).toEqual([2, 3]);
  });

  it("keeps the state as it was when a read fails, tells every view, refuses a view attaching meanwhile, and reads again when a refresh asks or the runtime changes, not on its own", async () => {
    const { publisher: p, captures, failures } = await shown();
    const v = view(p);
    const gone = new Error("the disk went away");
    p.invalidate();
    const refreshing = p.refresh();
    captures[1]!.cut();
    captures[1]!.reject(gone);
    await expect(refreshing).rejects.toThrow(gone);
    expect(failures).toEqual([gone]);
    expect(v.heard).toEqual([["unavailable", gone]]);
    await tick();
    expect(captures).toHaveLength(2);
    expect(p.unavailable).toEqual({ error: gone });
    expect(() => view(p)).toThrow(gone);
    expect(p.current.state).toBe(v.baseline.state);

    const asked = p.refresh();
    expect(captures).toHaveLength(3);
    captures[2]!.cut();
    captures[2]!.reject(gone);
    await expect(asked).rejects.toThrow(gone);
    await tick();
    expect(captures).toHaveLength(3);

    p.invalidate();
    expect(captures).toHaveLength(4);
    captures[3]!.cut();
    captures[3]!.resolve({ n: 2 });
    expect(await p.refresh()).toEqual({ epoch: v.baseline.state.epoch, revision: 2 });
    expect(v.states().map(open)).toEqual([{ n: 2 }]);
    expect(p.unavailable).toBeNull();
    expect(view(p).baseline.state).toMatchObject({ revision: 2 });
    expect(failures).toEqual([gone, gone]);
  });

  it("leaves a failed read behind with the runtime: another phase attaches views again", async () => {
    const { publisher: p, captures } = await shown();
    p.invalidate();
    captures[1]!.cut();
    captures[1]!.reject(new Error("the disk went away"));
    await tick();
    expect(() => view(p)).toThrow("the disk went away");
    p.set(LOCKED);
    expect(view(p).baseline.state).toMatchObject({ revision: 1, value: LOCKED });
    expect(p.unavailable).toBeNull();
  });

  it("shows nothing of a runtime whose first read fails: the state stays, and nothing more is read", async () => {
    const { publisher: p, failures } = publisher();
    const v = view(p);
    const { captures, source } = runtime();
    const publishing = p.open(HOLD, source);
    captures[0]!.reject(new Error("damaged"));
    await expect(publishing.ready).rejects.toThrow("damaged");
    expect(failures).toEqual([]);
    p.lines(["nothing to say"]);
    p.invalidate();
    expect(captures).toHaveLength(1);
    expect(v.heard).toEqual([]);
    expect(p.current.state.value).toEqual(BOOTING);
  });

  it("rejects the runtime being opened when another state takes its place, and one whose runtime closes first", async () => {
    const { publisher: p } = publisher();
    const first = runtime();
    const opening = p.open(HOLD, first.source);
    p.set(LOCKED);
    await expect(opening.ready).rejects.toThrow(/another state/);
    first.captures[0]!.resolve({ n: 1 });
    await tick();
    expect(p.current.state.value).toEqual(LOCKED);

    const second = runtime();
    const closing = p.open(HOLD, second.source);
    closing.close();
    await expect(closing.ready).rejects.toThrow(/closed before/);
    expect(p.current.state.value).toEqual(LOCKED);
  });

  it("publishes a phase with a new detail as the next revision, the same value not at all, and another phase or hold as a fresh epoch with the lines begun again", async () => {
    const { publisher: p } = await shown();
    const v = view(p);
    p.lines(["live"]);
    p.set(LOCKED);
    const [locked] = v.states().slice(-1);
    expect(locked!.epoch).not.toBe(v.baseline.state.epoch);
    expect(v.heard.at(-1)).toEqual(["lines", { epoch: locked!.epoch, revision: 1, value: NO_LINES }]);
    p.set({ ...LOCKED, detail: "the passphrase is wanted" });
    expect(v.states().at(-1)).toEqual({ epoch: locked!.epoch, revision: 2, value: { ...LOCKED, detail: "the passphrase is wanted" } });
    const said = v.heard.length;
    p.set({ ...LOCKED, detail: "the passphrase is wanted" });
    expect(v.heard).toHaveLength(said);
    p.set({ phase: "locked", hold: "hold-2" as Hold, detail: null });
    expect(v.states().at(-1)).toMatchObject({ revision: 1, value: { hold: "hold-2" } });
    expect(v.states().at(-1)!.epoch).not.toBe(locked!.epoch);
    p.log("still here");
    expect(v.heard.at(-1)).toEqual(["log", { epoch: v.states().at(-1)!.epoch, line: "still here" }]);
  });

  it("installs a fresh epoch before the revisions of one run out, for the state and for the lines alike", async () => {
    const { publisher: p } = publisher({ maxRevision: 2 });
    const v = view(p);
    p.set({ ...BOOTING, detail: "one" });
    p.set({ ...BOOTING, detail: "two" });
    const states = v.states();
    expect(states.map(({ revision }) => revision)).toEqual([2, 1]);
    expect(states[1]!.epoch).not.toBe(states[0]!.epoch);

    const { captures, source } = runtime();
    const publishing = p.open(HOLD, source);
    captures[0]!.cut();
    captures[0]!.resolve({ n: 1 });
    await publishing.ready;
    const shownIn = v.states().at(-1)!.epoch;
    p.lines(["a"]);
    p.lines(["b"]);
    const linesHeard = v.heard.filter((said): said is ["lines", LinesStateOf<Lines>] => said[0] === "lines").map(([, lines]) => lines);
    const renewed = linesHeard.at(-1)!.epoch;
    expect(renewed).not.toBe(shownIn);
    expect(linesHeard.slice(-3)).toEqual([
      { epoch: shownIn, revision: 2, value: ["a"] },
      { epoch: renewed, revision: 1, value: NO_LINES },
      { epoch: renewed, revision: 2, value: ["b"] },
    ]);
    expect(v.states().at(-1)).toEqual({ epoch: renewed, revision: 1, value: { phase: "open", hold: HOLD, snapshot: { n: 1 } } });
  });
});
