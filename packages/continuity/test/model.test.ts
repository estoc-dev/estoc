import { describe, expect, it } from "vitest";

import { deriveContinuity, InvalidFact, type Channel, type Continuity, type ContinuityFact } from "../src/index.js";
import { C, decide, localEnd, observe, ordered, peerEnd, permutations, rotated } from "./facts.js";

const A0B0 = C("A0", "B0");
const A0B1 = C("A0", "B1");
const A0B2 = C("A0", "B2");
const A1B0 = C("A1", "B0");
const A1B1 = C("A1", "B1");

/** Every query result that has a fixed shape, so two derivations can be compared whole. */
function view(model: Continuity, channels: readonly Channel[], facts: readonly ContinuityFact[]) {
  return {
    facts: model.facts,
    conflicts: model.conflicts(),
    heads: channels.map((channel) => model.head(channel)),
    histories: channels.map((channel) => model.history(channel)),
    confirmations: channels.map((channel) => model.confirmation(channel.localDid, channel.peerDid)),
    statuses: facts.map((fact) => model.status(fact)),
  };
}

/** Every order of a short list; a longer one in each rotation of it and of its reverse. */
function* ordersOf(facts: readonly ContinuityFact[]): Generator<ContinuityFact[]> {
  if (facts.length <= 6) {
    yield* permutations(facts);
    return;
  }
  for (const list of [facts, [...facts].reverse()]) for (let i = 0; i < list.length; i++) yield [...list.slice(i), ...list.slice(0, i)];
}

function sameWhateverTheOrder(facts: readonly ContinuityFact[], channels: readonly Channel[]) {
  const expected = view(deriveContinuity(facts), channels, facts);
  for (const order of ordersOf(facts)) expect(view(deriveContinuity(order), channels, facts)).toEqual(expected);
  return expected;
}

describe("receiving a peer rotation", () => {
  const p1 = rotated(A0B1, "B0");

  it("moves the head of the old pair to the successor pair, supported by the observation that carried the rotation", () => {
    const model = deriveContinuity([p1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: [p1] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
    expect(model.status(p1)).toEqual({ status: "usable", support: [p1] });
  });

  it("confirms A0 in the B0 context through the successor's observation", () => {
    const model = deriveContinuity([p1]);
    const observations = [{ fact: p1, support: [p1] }];
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "confirmed", observations });
  });

  it("does not touch another relationship sharing the peer DID", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([p1, observe(X0B0)]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: X0B0, support: [] });
    expect(model.changes(X0B0, "peer")).toEqual([]);
    expect(model.head(C("Y0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("lists the change at the pair the peer left, for supersession checks across the same-peer context", () => {
    const model = deriveContinuity([p1]);
    expect(model.changes(A0B0, "peer")).toEqual([{ fact: p1, at: A0B0, change: { kind: "rotate", successor: "B1" }, to: A0B1, status: { status: "usable", support: [p1] } }]);
    expect(model.changes(A0B1, "peer")).toEqual([]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([p1, observe(A0B0), observe(A0B1)], [A0B0, A0B1]);
  });

  it("is one fact however many receipts carried the same proof, beside the receipts that carried none", () => {
    const plain = observe(A0B1);
    const model = deriveContinuity([p1, plain, { ...p1 }, observe(A0B1)]);
    expect(model.facts).toEqual(ordered(p1, plain));
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: [p1] });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A0B1, replaces: "peer", support: [p1], derived: false, usable: true }]);
    const witnesses = [{ fact: p1, support: [p1] }, { fact: plain, support: ordered(p1, plain) }];
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: ordered(p1, plain).map((fact) => witnesses.find((witness) => witness.fact === fact)) });
  });
});

describe("local rotation and confirmation", () => {
  const o0 = observe(A0B0);
  const d1 = decide(A0B0, "A1");

  it("is unresolved until the predecessor address is confirmed, and never falls back to absence", () => {
    const waiting = deriveContinuity([d1]);
    expect(waiting.head(A0B0)).toEqual({ status: "unresolved", waiting: [d1] });
    expect(waiting.head(A1B0)).toEqual({ status: "unresolved", waiting: [d1] });
    expect(waiting.head(C("A2", "B0"))).toEqual({ status: "no-evidence" });
    expect(waiting.status(d1)).toEqual({ status: "waiting", because: expect.stringContaining("no observation") });
    expect(waiting.localDecisions(A0B0)).toEqual([{ fact: d1, at: A0B0, change: { kind: "rotate", successor: "A1" }, to: A1B0, status: waiting.status(d1) }]);
    const confirmed = deriveContinuity([d1, o0]);
    expect(confirmed.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ordered(d1, o0) });
    expect(confirmed.status(d1)).toEqual({ status: "usable", support: ordered(d1, o0) });
  });

  it("cannot confirm itself through what it derives", () => {
    const o1 = observe(A1B0);
    const model = deriveContinuity([d1, o1]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: [d1] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ fact: o1, support: [o1] }] });
  });

  it("admits nothing from a ring of decisions confirming one another", () => {
    const d2 = decide(A1B0, "A2");
    const model = deriveContinuity([d1, d2, observe(C("A2", "B0"))]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: [d1] });
    expect(model.head(A1B0)).toEqual({ status: "unresolved", waiting: [d2] });
  });

  it("takes decisions of the same change at two pairs of one context as joint support, not as a fork", () => {
    const p1 = rotated(A0B1, "B0");
    const d2 = decide(A0B1, "A1");
    const model = deriveContinuity([p1, d1, d2]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ordered(d1, d2, p1) });
    expect(model.history(A0B0).links).toContainEqual({ from: A0B1, to: A1B1, replaces: "local", support: ordered(d1, d2, p1), derived: false, usable: true });
  });

  it("confirms the predecessor through a usable peer successor, whose observation carried the rotation", () => {
    const p1 = rotated(A0B1, "B0");
    const model = deriveContinuity([p1, d1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ordered(d1, p1) });
    expect(model.status(d1)).toEqual({ status: "usable", support: ordered(d1, p1) });
  });

  it("supports a confirmation with the peer path to the observer, so the support alone re-derives it", () => {
    const p1 = rotated(A0B1, "B0");
    const p2 = rotated(A0B2, "B1");
    const facts = [p1, p2, d1, observe(C("A9", "B9"))];
    const model = deriveContinuity(facts);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: ordered(p1, p2).map((fact) => ({ fact, support: fact === p1 ? [p1] : ordered(p1, p2) })) });
    const path = model.path(A0B0, A1B0);
    expect(path).toEqual({ status: "path", channels: [A0B0, A1B0], support: ordered(d1, p1, p2) });
    if (path.status !== "path") throw new Error(path.status);
    expect(deriveContinuity(path.support).path(A0B0, A1B0)).toEqual(path);
  });
});

describe("both parties rotate", () => {
  const o0 = observe(A0B0);
  const d1 = decide(A0B0, "A1");
  const p1 = rotated(A0B1, "B0");
  const support = ordered(d1, o0, p1);

  it("joins in the pair of both successors without fabricating a receipt to A1", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support });
    expect(model.head(A1B0)).toEqual({ status: "head", channel: A1B1, support });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A1B1, support });
    expect(model.confirmation("A1", "B1")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: ordered(o0, p1).map((fact) => ({ fact, support: [fact] })) });
  });

  it("confirms A1 by a later proof-free receipt from B1", () => {
    const o2 = observe(A1B1);
    const model = deriveContinuity([o0, d1, p1, o2]);
    expect(model.confirmation("A1", "B1")).toEqual({ status: "confirmed", observations: [{ fact: o2, support: [o2] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ fact: o2, support: ordered(d1, o0, o2, p1) }] });
  });

  it("offers directed usable paths that preserve roles", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.path(A0B0, A1B1)).toEqual({ status: "path", channels: [A0B0, A0B1, A1B1], support });
    expect(model.path(A0B0, A0B0)).toEqual({ status: "path", channels: [A0B0], support: [] });
    expect(model.path(A0B1, A1B0)).toEqual({ status: "none" });
    expect(model.path(A1B1, A0B0)).toEqual({ status: "none" });
    expect(model.path(C("Q", "R"), A0B0)).toEqual({ status: "none" });
  });

  it("shows the join as derived links in the history", () => {
    const model = deriveContinuity([o0, d1, p1]);
    const history = model.history(A1B1);
    expect(history.links).toEqual([
      { from: A0B0, to: A0B1, replaces: "peer", support: [p1], derived: false, usable: true },
      { from: A0B0, to: A1B0, replaces: "local", support, derived: false, usable: true },
      { from: A0B1, to: A1B1, replaces: "local", support, derived: true, usable: true },
      { from: A1B0, to: A1B1, replaces: "peer", support, derived: true, usable: true },
    ]);
    expect(history.samePeer).toEqual([A0B1, A1B1]);
    expect(history.sameLocal).toEqual([A1B0, A1B1]);
    expect(model.history(A0B0).samePeer).toEqual([A0B0, A1B0]);
    expect(model.history(A0B0).sameLocal).toEqual([A0B0, A0B1]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([o0, d1, p1, observe(A1B1)], [A0B0, A0B1, A1B0, A1B1]);
  });
});

describe("competing changes", () => {
  const p1 = rotated(A0B1, "B0");
  const p2 = rotated(A0B2, "B0");

  it("reports competing peer successors in one context and selects neither", () => {
    const model = deriveContinuity([p1, p2]);
    expect(model.conflicts()).toEqual([
      {
        kind: "competing-changes",
        side: "peer",
        context: [A0B0],
        changes: [
          { change: { kind: "rotate", successor: "B1" }, facts: [p1] },
          { change: { kind: "rotate", successor: "B2" }, facts: [p2] },
        ],
        scope: [A0B0, A0B1, A0B2],
      },
    ]);
    const facts = ordered(p1, p2);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts });
    expect(model.status(p1)).toEqual({ status: "conflict", facts, because: expect.any(String) });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "conflict", facts });
    expect(model.path(A0B0, A0B1)).toEqual({ status: "conflict", facts });
  });

  it("scopes the peer's competition over the same-peer context", () => {
    const o0 = observe(A0B0);
    const d1 = decide(A0B0, "A1");
    const across = rotated(C("A1", "B2"), "B0");
    const model = deriveContinuity([o0, d1, p1, across]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", context: [A0B0, A1B0] }]);
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts: ordered(p1, across) });
    const unlinked = deriveContinuity([p1, across]);
    expect(unlinked.conflicts()).toEqual([]);
    expect(unlinked.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: [p1] });
  });

  it("reports two saved local successors as a fork even before either is confirmed", () => {
    const d1 = decide(A0B0, "A1");
    const d2 = decide(A0B0, "A2");
    const model = deriveContinuity([d1, d2]);
    const facts = ordered(d1, d2);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", context: [A0B0] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts });
    expect(model.head(C("A2", "B0"))).toEqual({ status: "conflict", facts });
    const confirmed = deriveContinuity([d1, d2, observe(A0B0)]);
    expect(confirmed.head(A0B0)).toEqual({ status: "conflict", facts });
    expect(confirmed.status(d1)).toMatchObject({ status: "conflict" });
  });

  it("leaves unrelated contexts usable", () => {
    const X0B0 = C("X0", "B0");
    const px = rotated(C("X0", "B1"), "B0");
    const model = deriveContinuity([p1, p2, px]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: C("X0", "B1"), support: [px] });
  });

  it("reports a cycle", () => {
    const back = rotated(A0B0, "B1");
    const model = deriveContinuity([p1, back]);
    const facts = ordered(p1, back);
    expect(model.conflicts()).toEqual([{ kind: "cycle", channels: [A0B0, A0B1], facts, scope: [A0B0, A0B1] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
  });

  it("refuses a join that would pair a DID with itself", () => {
    const o0 = observe(A0B0);
    const d1 = decide(A0B0, "A1");
    const toA1 = rotated(C("A0", "A1"), "B0");
    const model = deriveContinuity([o0, d1, toA1]);
    const facts = ordered(d1, o0, toA1);
    expect(model.conflicts()).toEqual([{ kind: "identity-collision", channels: [A0B0, A1B0, C("A0", "A1")], facts, scope: [C("A0", "A1"), A0B0, A1B0] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
  });

  it("derives the same conflicts from any enumeration order", () => {
    sameWhateverTheOrder([p1, p2, observe(A0B1)], [A0B0, A0B1]);
  });
});

describe("ending", () => {
  it("ends the head of the pair and of its same-peer context", () => {
    const e1 = peerEnd(A0B0);
    const model = deriveContinuity([observe(A0B0), decide(A0B0, "A1"), e1]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [e1] });
    expect(model.head(A1B0)).toEqual({ status: "ended", endings: [e1] });
    expect(model.history(A1B0).endings).toEqual([{ fact: e1, side: "peer", status: { status: "usable", support: [e1] } }]);
    expect(model.head(C("X0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("competes with a rotation of the same endpoint, whatever the order", () => {
    const e1 = peerEnd(A0B0);
    const p1 = rotated(A0B1, "B0");
    const model = deriveContinuity([e1, p1]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", changes: [{ change: { kind: "end" }, facts: [e1] }, { change: { kind: "rotate", successor: "B1" }, facts: [p1] }] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ordered(e1, p1) });
    sameWhateverTheOrder([e1, p1], [A0B0, A0B1]);
  });

  it("treats rotation followed by the successor ending as forward history", () => {
    const e1 = peerEnd(A0B1);
    const model = deriveContinuity([rotated(A0B1, "B0"), e1]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [e1] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: [e1] });
  });

  it("applies a local ending across the same-local context and supplies no joined head", () => {
    const e1 = localEnd(A0B0);
    const model = deriveContinuity([e1, rotated(A0B1, "B0")]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [e1] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: [e1] });
    expect(model.localDecisions(A0B1)).toEqual([{ fact: e1, at: A0B0, change: { kind: "end" }, to: null, status: { status: "usable", support: [e1] } }]);
  });

  it("competes with a local rotation of the same endpoint", () => {
    const e1 = localEnd(A0B0);
    const d1 = decide(A0B0, "A1");
    const model = deriveContinuity([e1, d1, observe(A0B0)]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ordered(d1, e1) });
  });

  it("lists every ending that applies, of either side, at any pair of the context", () => {
    const peerEndings = [peerEnd(A0B0), peerEnd(A1B0)];
    const acrossLocal = deriveContinuity([observe(A0B0), decide(A0B0, "A1"), ...peerEndings]);
    expect(acrossLocal.conflicts()).toEqual([]);
    expect(acrossLocal.head(A0B0)).toEqual({ status: "ended", endings: ordered(...peerEndings) });
    const localEndings = [localEnd(A0B0), localEnd(A0B1)];
    const acrossPeer = deriveContinuity([rotated(A0B1, "B0"), ...localEndings]);
    expect(acrossPeer.conflicts()).toEqual([]);
    expect(acrossPeer.head(A0B1)).toEqual({ status: "ended", endings: ordered(...localEndings) });
    expect(deriveContinuity([localEnd(A0B0), peerEnd(A0B0)]).head(A0B0)).toEqual({ status: "ended", endings: ordered(localEnd(A0B0), peerEnd(A0B0)) });
  });

  it("outranks a saved rotation still waiting for its predecessor address, which stays waiting", () => {
    const d1 = decide(A0B0, "A1");
    const e1 = peerEnd(A0B0);
    const model = deriveContinuity([d1, e1]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [e1] });
    expect(model.status(d1)).toMatchObject({ status: "waiting" });
    expect(deriveContinuity([d1]).head(A0B0)).toEqual({ status: "unresolved", waiting: [d1] });
  });
});

describe("observations", () => {
  it("confirm only their exact local recipient", () => {
    const o1 = observe(A0B0);
    const model = deriveContinuity([o1]);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ fact: o1, support: [o1] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "A0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("cannot restore continuation through a conflicted context", () => {
    const p1 = rotated(A0B1, "B0");
    const p2 = rotated(A0B2, "B0");
    const plain = observe(A0B1);
    const model = deriveContinuity([p1, p2, plain]);
    expect(model.confirmation("A0", "B1")).toEqual({ status: "conflict", facts: ordered(p1, p2) });
    expect(model.status(plain)).toMatchObject({ status: "conflict" });
  });

  it("stand on their own receipt where a rotation observed at the same pair does not: a conflict at the pair the peer left masks the rotation alone", () => {
    const fork = [rotated(C("A0", "Bp"), "Bz"), rotated(C("A0", "Bq"), "Bz")];
    const carried = rotated(A0B0, "Bp");
    const plain = observe(A0B0);
    const model = deriveContinuity([...fork, carried, plain]);
    expect(model.status(carried)).toEqual({ status: "conflict", facts: ordered(...fork), because: expect.any(String) });
    expect(model.status(plain)).toEqual({ status: "usable", support: [plain] });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ fact: plain, support: [plain] }] });
    expect(deriveContinuity([...fork, carried]).confirmation("A0", "B0")).toEqual({ status: "unconfirmed", unusable: [carried] });
    expect(model.changes(C("A0", "Bp"), "peer")).toEqual([{ fact: carried, at: C("A0", "Bp"), change: { kind: "rotate", successor: "B0" }, to: A0B0, status: model.status(carried) }]);
  });
});

describe("the head across a context", () => {
  /** A peer fork at A0Bz, whose scope reaches the two successor pairs but nothing after them. */
  const forkTo = (first: string, second: string) => [rotated(C("A0", first), "Bz"), rotated(C("A0", second), "Bz")];
  const forkAbove = forkTo("Bp", "Bq");
  /** B0 wrote to A0 carrying B0's rotation from Bp, a pair the fork reaches: the observation is in no usable continuity. */
  const s = rotated(A0B0, "Bp");
  /**
   * A local rotation from A0B0 to A1 that only `s` confirms: it links in
   * the positive graph, never in the usable one, though neither of its
   * pairs is in conflict.
   */
  const d = decide(A0B0, "A1");
  const unusablyConfirmed = [...forkAbove, s, d];
  /**
   * A0 → A1 made usably at A0B1, a pair that shares the usable same-local
   * context of A0B0 without being on its forward path: both lead to A0B2
   * by joins, as X0 became A0 at X0B0 and at X0B1 and the peer moved from
   * B0 and from B1 to B2 toward X0. Nothing addressed to A0 lies ahead of
   * A0B0, so whatever confirms `i` does not confirm `d`.
   */
  const i = decide(A0B1, "A1");
  const elsewhere = [decide(C("X0", "B0"), "A0"), decide(C("X0", "B1"), "A0"), rotated(C("X0", "B2"), "B0"), rotated(C("X0", "B2"), "B1"), observe(A0B1), i];
  const A1B2 = C("A1", "B2");

  it("applies an ending at another pair only through usable opposite-side links, and reports one only diagnostic links reach as a conflict", () => {
    const fork = forkTo("B0", "B5");
    for (const side of ["local", "peer"] as const) {
      const link = side === "local" ? rotated(A0B1, "B0") : decide(A0B0, "A1");
      const there = side === "local" ? A0B1 : A1B0;
      const end = side === "local" ? localEnd : peerEnd;
      const ending = end(A0B0);
      const facts = [observe(A0B0), link, observe(there), ending];
      expect(deriveContinuity(facts).head(there)).toEqual({ status: "ended", endings: [ending] });
      const model = deriveContinuity([...fork, ...facts]);
      expect(model.head(there)).toEqual({ status: "conflict", facts: [ending] });
      expect(model.history(there).endings.map((record) => record.fact)).toEqual([ending]);
      expect(model.path(A0B0, there)).toEqual({ status: "conflict", facts: ordered(...fork) });
      const direct = end(there);
      expect(deriveContinuity([...fork, ...facts, direct]).head(there)).toEqual({ status: "ended", endings: [direct] });
      sameWhateverTheOrder([...fork, ...facts], [A0B0, there]);
    }
  });

  it("takes the same change made usably at another pair of the context as provenance for a claim that is not usable, or still waiting", () => {
    expect(deriveContinuity(unusablyConfirmed).head(A0B0)).toEqual({ status: "conflict", facts: ordered(d, s) });
    const covered = deriveContinuity([...unusablyConfirmed, ...elsewhere]);
    const head = covered.head(A0B0);
    expect(head).toMatchObject({ status: "head", channel: A1B2 });
    expect(covered.path(A0B0, A1B2)).toEqual({ status: "path", channels: [A0B0, A0B2, A1B2], support: head.status === "head" ? head.support : [] });
    expect(covered.status(d)).toEqual({ status: "waiting", because: "the predecessor is confirmed only through continuity that is not usable" });
    expect(covered.history(A0B0).links).toContainEqual({ from: A0B0, to: A1B0, replaces: "local", support: ordered(d, s), derived: false, usable: false });
    expect(covered.history(A0B0).links).toContainEqual(expect.objectContaining({ from: A0B0, to: A0B2, derived: true, usable: true }));
    expect(deriveContinuity(elsewhere).head(A0B0)).toEqual(head);
    sameWhateverTheOrder([...unusablyConfirmed, ...elsewhere], [A0B0, A0B1, A0B2, A1B2]);

    const waiting = deriveContinuity([...elsewhere, d]);
    expect(waiting.head(A0B0)).toEqual(head);
    expect(waiting.status(d)).toEqual({ status: "waiting", because: expect.stringContaining("no observation") });
    expect(deriveContinuity([...elsewhere.filter((fact) => fact !== i), d]).head(A0B0)).toEqual({ status: "unresolved", waiting: [d] });
  });

  it("answers for a saved onward rotation anywhere in the context, and reports one only diagnostic history connects as a conflict", () => {
    const base = [...unusablyConfirmed, ...elsewhere];
    const A2B2 = C("A2", "B2");
    const w = decide(A1B0, "A2");
    const model = deriveContinuity([...base, w]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: [w] });
    expect(model.status(w)).toEqual({ status: "waiting", because: expect.stringContaining("no observation") });
    expect(model.localDecisions(A1B2).map((record) => record.fact)).toEqual([w]);
    expect(deriveContinuity([...base, decide(A1B2, "A2")]).head(A0B0)).toEqual({ status: "unresolved", waiting: [decide(A1B2, "A2")] });
    const scope = rotated(A1B2, "B0");
    const complete = deriveContinuity([...base, w, scope]);
    expect(complete.head(A0B0)).toMatchObject({ status: "head", channel: A2B2 });
    expect(complete.status(w)).toMatchObject({ status: "usable" });
    expect(complete.path(A0B0, A2B2).status).toBe("path");
    const independently = [observe(A1B2), decide(A1B2, "A2")];
    expect(deriveContinuity([...base, w, ...independently]).head(A0B0)).toMatchObject({ status: "head", channel: A2B2 });
    const other = decide(A1B2, "A3");
    expect(deriveContinuity([...base, w, other]).head(A0B0)).toEqual({ status: "conflict", facts: ordered(other, w) });
    const end = localEnd(A1B0);
    expect(deriveContinuity([...base, end]).head(A0B0)).toEqual({ status: "conflict", facts: [end] });
    sameWhateverTheOrder([...base, w], [A0B0, A1B0, A1B2]);
  });
});

describe("convergence and monotonicity", () => {
  it("gives the same view to replicas that hold the same facts, and a converged conflict is a converged state", () => {
    const o0 = observe(A0B0);
    const d1 = decide(A0B0, "A1");
    const p1 = rotated(A0B1, "B0");
    const p2 = rotated(C("A1", "B2"), "B0");
    const replicaA = [o0, d1, p1];
    const replicaB = [p2, o0];
    const channels = [A0B0, A0B1, A1B0, A1B1, C("A1", "B2")];
    const facts = [o0, d1, p1, p2];
    const merged = deriveContinuity([...replicaA, ...replicaB]);
    expect(view(deriveContinuity([...replicaB, ...replicaA]), channels, facts)).toEqual(view(merged, channels, facts));
    expect(deriveContinuity(replicaA).head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ordered(d1, o0, p1) });
    expect(merged.head(A0B0)).toEqual({ status: "conflict", facts: ordered(p1, p2) });
  });

  it("answers over a long rotation history", () => {
    const length = 3000;
    const facts: ContinuityFact[] = [];
    for (let i = 0; i < length; i++) facts.push(rotated(C("A0", `B${i + 1}`), `B${i}`));
    const model = deriveContinuity(facts);
    const last = C("A0", `B${length}`);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: last, support: ordered(...facts) });
    expect(model.path(A0B0, A0B1)).toEqual({ status: "path", channels: [A0B0, A0B1], support: [facts[0]] });
    const path = model.path(A0B0, last);
    expect(path.status === "path" && path.channels.length).toBe(length + 1);
    expect(model.confirmation("A0", `B${length}`)).toEqual({ status: "confirmed", observations: [{ fact: facts[length - 1], support: [facts[length - 1]] }] });
  });

  it("refuses a malformed fact without deriving anything", () => {
    expect(() => deriveContinuity([{ ...rotated(A0B1, "B0"), extra: 1 } as unknown as ContinuityFact])).toThrow(InvalidFact);
  });

  it("answers unknown facts and unknown pairs as such", () => {
    const model = deriveContinuity([]);
    expect(model.status(observe(A0B0))).toEqual({ status: "unknown" });
    expect(model.head(A0B0)).toEqual({ status: "no-evidence" });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0)).toEqual({ links: [], endings: [], samePeer: [A0B0], sameLocal: [A0B0] });
  });
});
