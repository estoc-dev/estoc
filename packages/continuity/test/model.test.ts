import { describe, expect, it } from "vitest";

import { deriveContinuity, InvalidFact, type Channel, type Continuity, type ContinuityFact, type FactKey } from "../src/index.js";
import { C, D, decide, keyOf, localEnd, O, observe, peerEnd, permutations, rotate, T } from "./facts.js";

const A0B0 = C("A0", "B0");
const A0B1 = C("A0", "B1");
const A1B0 = C("A1", "B0");
const A1B1 = C("A1", "B1");

/** Every query result that has a fixed shape, so two derivations can be compared whole. */
function view(model: Continuity, channels: readonly Channel[], keys: readonly FactKey[]) {
  return {
    facts: model.facts,
    conflicts: model.conflicts(),
    heads: channels.map((channel) => model.head(channel)),
    histories: channels.map((channel) => model.history(channel)),
    confirmations: channels.map((channel) => model.confirmation(channel.localDid, channel.peerDid)),
    statuses: keys.map((key) => model.status(key)),
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
  const keys = facts.map(keyOf);
  const expected = view(deriveContinuity(facts), channels, keys);
  for (const order of ordersOf(facts)) expect(view(deriveContinuity(order), channels, keys)).toEqual(expected);
  return expected;
}

describe("receiving a peer rotation", () => {
  const p1 = rotate("p1", A0B0, "B1");
  const o1 = observe("p1", A0B1, true);

  it("moves the head of the old pair to the successor pair, supported by the transition", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: [T("p1")] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
    expect(model.status(T("p1"))).toEqual({ status: "usable", support: [T("p1")] });
    expect(model.status(O("p1"))).toEqual({ status: "usable", support: [O("p1"), T("p1")] });
  });

  it("confirms A0 in the B0 context through the successor's observation", () => {
    const model = deriveContinuity([p1, o1]);
    const observations = [{ key: O("p1"), at: A0B1, support: [O("p1"), T("p1")] }];
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "confirmed", observations });
  });

  it("does not touch another relationship sharing the peer DID", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([p1, o1, observe("ox", X0B0)]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: X0B0, support: [] });
    expect(model.changes(X0B0, "peer")).toEqual([]);
    expect(model.head(C("Y0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("lists the change for supersession checks across the same-peer context", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.changes(A0B0, "peer")).toEqual([{ key: T("p1"), at: A0B0, change: { kind: "rotate", successor: "B1" }, to: A0B1, status: { status: "usable", support: [T("p1")] } }]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([p1, o1, observe("o0", A0B0)], [A0B0, A0B1]);
  });

  it("adds support, not another successor, for repeated carriers of the same proof", () => {
    const model = deriveContinuity([p1, o1, rotate("p2", A0B0, "B1"), observe("p2", A0B1, true)]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: [T("p1"), T("p2")] });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A0B1, replaces: "peer", support: [T("p1"), T("p2")], derived: false, usable: true }]);
  });
});

describe("local rotation and confirmation", () => {
  const o0 = observe("o0", A0B0);
  const d1 = decide("d1", A0B0, "A1");

  it("is unresolved until the predecessor address is confirmed, and never falls back to absence", () => {
    const waiting = deriveContinuity([d1]);
    expect(waiting.head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [] });
    expect(waiting.head(A1B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [] });
    expect(waiting.head(C("A2", "B0"))).toEqual({ status: "no-evidence" });
    expect(waiting.status(D("d1"))).toEqual({ status: "waiting", because: expect.stringContaining("no observation") });
    expect(waiting.localDecisions(A0B0)).toEqual([{ key: D("d1"), at: A0B0, change: { kind: "rotate", successor: "A1" }, to: A1B0, status: waiting.status(D("d1")) }]);
    const confirmed = deriveContinuity([d1, o0]);
    expect(confirmed.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: [D("d1"), O("o0")] });
  });

  it("cannot confirm itself through what it derives", () => {
    const model = deriveContinuity([d1, observe("o1", A1B0)]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ key: O("o1"), at: A1B0, support: [O("o1")] }] });
  });

  it("admits nothing from a ring of decisions confirming one another", () => {
    const d2 = decide("d2", A1B0, "A2");
    const model = deriveContinuity([d1, d2, observe("o2", C("A2", "B0"))]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [] });
    expect(model.head(A1B0)).toEqual({ status: "unresolved", waiting: [D("d2")], missing: [] });
  });

  it("uses the exact source the host named: the observation of that receipt", () => {
    const named = decide("d1", A0B0, "A1", "o0");
    expect(deriveContinuity([named, o0]).head(A0B0)).toEqual({ status: "head", channel: A1B0, support: [D("d1"), O("o0")] });
    expect(deriveContinuity([named, o0]).status(D("d1"))).toEqual({ status: "usable", support: [D("d1"), O("o0")] });
    const missing = deriveContinuity([named]);
    expect(missing.head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [O("o0")] });
    expect(missing.head(A1B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [O("o0")] });
    expect(missing.status(D("d1"))).toEqual({ status: "unresolved", missing: [O("o0")] });
    const otherPeer = deriveContinuity([named, observe("o0", C("A0", "X0"))]);
    expect(otherPeer.status(D("d1"))).toEqual({ status: "waiting", because: expect.stringContaining("o0") });
    expect(otherPeer.head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d1")], missing: [] });
    const otherLocal = deriveContinuity([named, observe("o0", C("A9", "B0"))]);
    expect(otherLocal.status(D("d1"))).toEqual({ status: "invalid", because: expect.stringContaining("A9") });
    const transitionOnly = deriveContinuity([decide("d1", A0B0, "A1", "p"), rotate("p", A0B0, "B1")]);
    expect(transitionOnly.status(D("d1"))).toEqual({ status: "unresolved", missing: [O("p")] });
  });

  it("takes a second decision for the same successor as provenance, not as a waiting fork", () => {
    const named = decide("d2", A0B0, "A1", "o-missing");
    const model = deriveContinuity([d1, o0, named]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: [D("d1"), O("o0")] });
    expect(model.status(D("d2"))).toEqual({ status: "unresolved", missing: [O("o-missing")] });
    expect(deriveContinuity([d1, named]).head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d1"), D("d2")], missing: [O("o-missing")] });
  });

  it("takes confirmed decisions for the same successor as joint support", () => {
    const model = deriveContinuity([o0, d1, decide("d2", A0B0, "A1")]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: [D("d1"), D("d2"), O("o0")] });
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A1B0, replaces: "local", support: [D("d1"), D("d2"), O("o0")], derived: false, usable: true }]);
  });

  it("confirms the predecessor through a usable peer successor", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), observe("p1", A0B1, true), d1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: [D("d1"), O("p1"), T("p1")] });
  });

  it("supports a confirmation with the peer path to the observer, so the support alone re-derives it", () => {
    const facts = [rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B2"), observe("o2", C("A0", "B2")), decide("d1", A0B0, "A1", "o2")];
    const model = deriveContinuity(facts);
    const path = model.path(A0B0, A1B0);
    const support = [D("d1"), O("o2"), T("p1"), T("p2")];
    expect(path).toEqual({ status: "path", channels: [A0B0, A1B0], support });
    expect(model.status(D("d1"))).toEqual({ status: "usable", support });
    if (path.status !== "path") throw new Error(path.status);
    const replayed = deriveContinuity(facts.filter((fact) => path.support.some((key) => key.kind === fact.kind && key.evidence === fact.evidence)));
    expect(replayed.path(A0B0, A1B0)).toEqual(path);
    const unnamed = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B2"), observe("o2", C("A0", "B2")), d1]);
    expect(unnamed.status(D("d1"))).toEqual({ status: "usable", support });
  });
});

describe("both parties rotate", () => {
  const o0 = observe("o0", A0B0);
  const d1 = decide("d1", A0B0, "A1");
  const p1 = rotate("p1", A0B0, "B1");
  const support = [D("d1"), O("o0"), T("p1")];

  it("joins in the pair of both successors without fabricating a receipt to A1", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support });
    expect(model.head(A1B0)).toEqual({ status: "head", channel: A1B1, support });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A1B1, support });
    expect(model.confirmation("A1", "B1")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ key: O("o0"), at: A0B0, support: [O("o0")] }] });
  });

  it("confirms A1 by a later proof-free receipt from B1", () => {
    const model = deriveContinuity([o0, d1, p1, observe("o2", A1B1)]);
    expect(model.confirmation("A1", "B1")).toEqual({ status: "confirmed", observations: [{ key: O("o2"), at: A1B1, support: [O("o2")] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ key: O("o2"), at: A1B1, support: [D("d1"), O("o0"), O("o2"), T("p1")] }] });
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
      { from: A0B0, to: A0B1, replaces: "peer", support: [T("p1")], derived: false, usable: true },
      { from: A0B0, to: A1B0, replaces: "local", support: [D("d1"), O("o0")], derived: false, usable: true },
      { from: A0B1, to: A1B1, replaces: "local", support, derived: true, usable: true },
      { from: A1B0, to: A1B1, replaces: "peer", support, derived: true, usable: true },
    ]);
    expect(history.samePeer).toEqual([A0B1, A1B1]);
    expect(history.sameLocal).toEqual([A1B0, A1B1]);
    expect(model.history(A0B0).samePeer).toEqual([A0B0, A1B0]);
    expect(model.history(A0B0).sameLocal).toEqual([A0B0, A0B1]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([o0, d1, p1, observe("o2", A1B1)], [A0B0, A0B1, A1B0, A1B1]);
  });
});

describe("competing changes", () => {
  it("reports competing peer successors in one context and selects neither", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2")]);
    expect(model.conflicts()).toEqual([
      {
        kind: "competing-changes",
        side: "peer",
        context: [A0B0],
        changes: [
          { change: { kind: "rotate", successor: "B1" }, facts: [T("p1")] },
          { change: { kind: "rotate", successor: "B2" }, facts: [T("p2")] },
        ],
        scope: [A0B0, A0B1, C("A0", "B2")],
      },
    ]);
    const facts = [T("p1"), T("p2")];
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts });
    expect(model.status(T("p1"))).toEqual({ status: "conflict", facts, because: expect.any(String) });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "conflict", facts });
    expect(model.path(A0B0, A0B1)).toEqual({ status: "conflict", facts });
  });

  it("scopes the peer's competition over the same-peer context", () => {
    const o0 = observe("o0", A0B0);
    const d1 = decide("d1", A0B0, "A1");
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A1B0, "B2");
    const model = deriveContinuity([o0, d1, p1, p2]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", context: [A0B0, A1B0] }]);
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts: [T("p1"), T("p2")] });
    const unlinked = deriveContinuity([p1, p2]);
    expect(unlinked.conflicts()).toEqual([]);
    expect(unlinked.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: [T("p1")] });
  });

  it("reports two saved local successors as a fork even before either is confirmed", () => {
    const d1 = decide("d1", A0B0, "A1");
    const d2 = decide("d2", A0B0, "A2");
    const model = deriveContinuity([d1, d2]);
    const facts = [D("d1"), D("d2")];
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", context: [A0B0] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts });
    expect(model.head(C("A2", "B0"))).toEqual({ status: "conflict", facts });
    const confirmed = deriveContinuity([d1, d2, observe("o0", A0B0)]);
    expect(confirmed.head(A0B0)).toEqual({ status: "conflict", facts });
    expect(confirmed.status(D("d1"))).toMatchObject({ status: "conflict" });
  });

  it("leaves unrelated contexts usable", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), rotate("px", X0B0, "B1")]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: C("X0", "B1"), support: [T("px")] });
  });

  it("reports a cycle", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B0")]);
    expect(model.conflicts()).toEqual([{ kind: "cycle", channels: [A0B0, A0B1], facts: [T("p1"), T("p2")], scope: [A0B0, A0B1] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: [T("p1"), T("p2")] });
  });

  it("refuses a join that would pair a DID with itself", () => {
    const model = deriveContinuity([observe("o0", A0B0), decide("d1", A0B0, "A1"), rotate("p1", A0B0, "A1")]);
    const facts = [D("d1"), O("o0"), T("p1")];
    expect(model.conflicts()).toEqual([{ kind: "identity-collision", channels: [A0B0, A1B0, C("A0", "A1")], facts, scope: [C("A0", "A1"), A0B0, A1B0] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts });
  });

  it("derives the same conflicts from any enumeration order", () => {
    sameWhateverTheOrder([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), observe("p1", A0B1, true)], [A0B0, A0B1]);
  });
});

describe("ending", () => {
  it("ends the head of the pair and of its same-peer context", () => {
    const model = deriveContinuity([observe("o0", A0B0), decide("d1", A0B0, "A1"), peerEnd("e1", A0B0)]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [T("e1")] });
    expect(model.head(A1B0)).toEqual({ status: "ended", endings: [T("e1")] });
    expect(model.history(A1B0).endings).toEqual([{ key: T("e1"), at: A0B0, side: "peer", status: { status: "usable", support: [T("e1")] } }]);
    expect(model.head(C("X0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("competes with a rotation of the same endpoint, whatever the order", () => {
    const model = deriveContinuity([peerEnd("e1", A0B0), rotate("p1", A0B0, "B1")]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", changes: [{ change: { kind: "end" }, facts: [T("e1")] }, { change: { kind: "rotate", successor: "B1" }, facts: [T("p1")] }] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: [T("e1"), T("p1")] });
    sameWhateverTheOrder([peerEnd("e1", A0B0), rotate("p1", A0B0, "B1")], [A0B0, A0B1]);
  });

  it("treats rotation followed by the successor ending as forward history", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), peerEnd("e1", A0B1)]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [T("e1")] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: [T("e1")] });
  });

  it("applies a local ending across the same-local context and supplies no joined head", () => {
    const model = deriveContinuity([localEnd("e1", A0B0), rotate("p1", A0B0, "B1")]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: [D("e1")] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: [D("e1")] });
    expect(model.localDecisions(A0B1)).toEqual([{ key: D("e1"), at: A0B0, change: { kind: "end" }, to: null, status: { status: "usable", support: [D("e1")] } }]);
  });

  it("competes with a local rotation of the same endpoint", () => {
    const model = deriveContinuity([localEnd("e1", A0B0), decide("d1", A0B0, "A1"), observe("o0", A0B0)]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: [D("d1"), D("e1")] });
  });

  it("lists every ending that applies, of either side", () => {
    for (const end of [localEnd, peerEnd]) {
      const model = deriveContinuity([end("e1", A0B0), end("e2", A0B0)]);
      expect(model.conflicts()).toEqual([]);
      expect(model.head(A0B0)).toEqual({ status: "ended", endings: [keyOf(end("e1", A0B0)), keyOf(end("e2", A0B0))] });
    }
    expect(deriveContinuity([localEnd("e1", A0B0), peerEnd("e2", A0B0)]).head(A0B0)).toEqual({ status: "ended", endings: [D("e1"), T("e2")] });
  });

  it("refuses an observation whose receipt carried an ending", () => {
    const model = deriveContinuity([peerEnd("e1", A0B0), observe("e1", A0B1, true)]);
    expect(model.status(O("e1"))).toEqual({ status: "invalid", because: expect.stringContaining("ending") });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: [O("e1")] });
  });
});

describe("observations", () => {
  it("must agree with the transition their receipt carried", () => {
    const p1 = rotate("p1", A0B0, "B1");
    const cases: [ContinuityFact, string][] = [
      [observe("p1", C("A9", "B1"), true), "A9"],
      [observe("p1", C("A0", "B2"), true), "B2"],
    ];
    for (const [observation, mention] of cases) {
      expect(deriveContinuity([p1, observation]).status(O("p1")), JSON.stringify(observation)).toEqual({ status: "invalid", because: expect.stringContaining(mention) });
    }
  });

  it("stays pending when its carried transition is not here, and cannot become proof-free", () => {
    const model = deriveContinuity([observe("p1", A0B1, true)]);
    expect(model.status(O("p1"))).toEqual({ status: "unresolved", missing: [T("p1")] });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: [O("p1")] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
  });

  it("confirms only its exact local recipient", () => {
    const model = deriveContinuity([observe("o1", A0B0)]);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ key: O("o1"), at: A0B0, support: [O("o1")] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "A0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("cannot restore continuation through a conflicted context", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), observe("p1", A0B1, true), observe("o3", A0B1)]);
    expect(model.confirmation("A0", "B1")).toEqual({ status: "conflict", facts: [T("p1"), T("p2")] });
    expect(model.status(O("o3"))).toMatchObject({ status: "conflict" });
  });
});

describe("the head across a context", () => {
  /** A peer fork at A0Bz, whose scope reaches the two successor pairs but nothing after them. */
  const forkTo = (first: string, second: string) => [rotate("f1", C("A0", "Bz"), first), rotate("f2", C("A0", "Bz"), second)];
  const forkAbove = forkTo("Bp", "Bq");
  /**
   * A local rotation from A0B0 to A1 confirmed only by receipt `s`,
   * whose carried transition leaves A0Bp, a pair the fork reaches: the
   * rotation links in the positive graph, never in the usable one,
   * though neither of its pairs is in conflict.
   */
  const unusablyConfirmed = [...forkAbove, rotate("s", C("A0", "Bp"), "B0"), observe("s", A0B0, true), decide("d", A0B0, "A1", "s")];

  it("applies an ending at another pair only through usable opposite-side links, and reports one only diagnostic links reach as a conflict", () => {
    const fork = forkTo("B0", "B5");
    for (const side of ["local", "peer"] as const) {
      const link = side === "local" ? rotate("p", A0B0, "B1") : decide("d", A0B0, "A1");
      const there = side === "local" ? A0B1 : A1B0;
      const end = side === "local" ? localEnd : peerEnd;
      const ending = end("e", A0B0);
      const facts = [observe("o0", A0B0), link, observe("o1", there), ending];
      expect(deriveContinuity(facts).head(there)).toEqual({ status: "ended", endings: [keyOf(ending)] });
      const model = deriveContinuity([...fork, ...facts]);
      expect(model.head(there)).toEqual({ status: "conflict", facts: [keyOf(ending)] });
      expect(model.history(there).endings.map((record) => record.key)).toEqual([keyOf(ending)]);
      expect(model.path(A0B0, there)).toEqual({ status: "conflict", facts: [T("f1"), T("f2")] });
      const direct = end("direct", there);
      expect(deriveContinuity([...fork, ...facts, direct]).head(there)).toEqual({ status: "ended", endings: [keyOf(direct)] });
      sameWhateverTheOrder([...fork, ...facts], [A0B0, there]);
    }
  });

  it("takes the same change made usably at another pair of the context as provenance for a claim that is not usable", () => {
    const p = rotate("p", A0B0, "B1");
    const o = observe("o", A0B1);
    const independent = decide("independent", A0B1, "A1");
    const support = [D("independent"), O("o"), T("p")];
    const covered = deriveContinuity([...unusablyConfirmed, p, o, independent]);
    expect(covered.head(A0B0)).toEqual({ status: "head", channel: A1B1, support });
    expect(covered.path(A0B0, A1B1)).toEqual({ status: "path", channels: [A0B0, A0B1, A1B1], support });
    expect(covered.status(D("d"))).toEqual({ status: "conflict", facts: [T("f1"), T("f2")], because: expect.stringContaining("s") });
    expect(covered.history(A0B0).links).toContainEqual({ from: A0B0, to: A1B0, replaces: "local", support: [D("d"), O("s"), T("s")], derived: false, usable: false });
    expect(deriveContinuity([...unusablyConfirmed, p, o]).head(A0B0).status).toBe("conflict");
    sameWhateverTheOrder([...unusablyConfirmed, p, o, independent], [A0B0, A0B1, A1B1]);
    const waiting = decide("d", A0B0, "A1", "missing");
    const provenance = deriveContinuity([p, o, independent, waiting]);
    expect(provenance.head(A0B0)).toEqual({ status: "head", channel: A1B1, support });
    expect(provenance.status(D("d"))).toEqual({ status: "unresolved", missing: [O("missing")] });
    expect(deriveContinuity([p, o, waiting]).head(A0B0)).toEqual({ status: "unresolved", waiting: [D("d")], missing: [O("missing")] });
  });

  it("answers for a saved onward rotation anywhere in the context, and reports one only diagnostic history connects as a conflict", () => {
    const A2B1 = C("A2", "B1");
    const base = [...unusablyConfirmed, rotate("p", A0B0, "B1"), observe("o", A0B1), decide("i", A0B1, "A1")];
    expect(deriveContinuity(base).head(A0B0)).toEqual({ status: "head", channel: A1B1, support: [D("i"), O("o"), T("p")] });
    const w = decide("w", A1B0, "A2", "missing");
    const model = deriveContinuity([...base, w]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: [D("w")] });
    expect(model.status(D("w"))).toEqual({ status: "unresolved", missing: [O("missing")] });
    expect(model.localDecisions(A1B1).map((record) => record.key)).toEqual([D("w")]);
    const unresolved = { status: "unresolved", waiting: [D("w")], missing: [O("missing")] };
    const scope = rotate("scope", A1B0, "B1");
    expect(deriveContinuity([...base, w, scope]).head(A0B0)).toEqual(unresolved);
    expect(deriveContinuity([...base, { ...w, at: A1B1 }]).head(A0B0)).toEqual(unresolved);
    expect(deriveContinuity([...base, w, decide("usably", A0B0, "A1")]).head(A0B0)).toEqual(unresolved);
    expect(deriveContinuity([...base, w, observe("missing", A1B0)]).head(A0B0)).toEqual({ status: "conflict", facts: [D("d"), O("missing"), T("p"), O("s"), T("s"), D("w")] });
    const complete = deriveContinuity([...base, w, observe("missing", A1B0), scope]);
    expect(complete.head(A0B0)).toEqual({ status: "head", channel: A2B1, support: [D("i"), O("missing"), O("o"), T("p"), T("scope"), D("w")] });
    expect(complete.path(A0B0, A2B1).status).toBe("path");
    expect(deriveContinuity([...base, w, observe("oh", A1B1), decide("x", A1B1, "A2", "oh")]).head(A0B0)).toEqual({ status: "head", channel: A2B1, support: [D("i"), O("o"), O("oh"), T("p"), D("x")] });
    expect(deriveContinuity([...base, w, decide("other", A1B1, "A3", "another-missing")]).head(A0B0)).toEqual({ status: "conflict", facts: [D("other"), D("w")] });
    expect(deriveContinuity([...base, localEnd("end", A1B0)]).head(A0B0)).toEqual({ status: "conflict", facts: [D("end")] });
    sameWhateverTheOrder([...base, w], [A0B0, A1B0, A1B1]);
  });

  it("diagnoses a pending choice along its whole reference chain, so a conflicted carried transition outranks an ending", () => {
    const scope = rotate("scope", A0B0, "B1");
    const w = decide("w", A0B0, "A1", "t");
    const s = observe("t", A0B1, true);
    const t = rotate("t", C("A0", "Bp"), "B1");
    const end = peerEnd("end", A0B1);
    const missing = deriveContinuity([scope, w, s]);
    expect(missing.head(A0B1)).toEqual({ status: "unresolved", waiting: [D("w")], missing: [T("t")] });
    expect(missing.head(A0B0)).toEqual({ status: "unresolved", waiting: [D("w")], missing: [T("t")] });
    expect(deriveContinuity([scope, w, s, end]).head(A0B1)).toEqual({ status: "ended", endings: [T("end")] });
    expect(deriveContinuity([scope, w, s, t]).head(A0B1)).toEqual({ status: "head", channel: A1B1, support: [T("scope"), O("t"), T("t"), D("w")] });
    const conflicted = deriveContinuity([...forkAbove, scope, w, s, t]);
    const conflict = { status: "conflict", facts: [T("f1"), T("f2"), T("scope"), O("t"), T("t"), D("w")] };
    expect(conflicted.head(A0B1)).toEqual(conflict);
    expect(conflicted.head(A0B0)).toEqual(conflict);
    expect(conflicted.status(D("w"))).toEqual({ status: "conflict", facts: [T("f1"), T("f2")], because: expect.stringContaining("t") });
    expect(deriveContinuity([...forkAbove, scope, w, s, t, end]).head(A0B1)).toEqual(conflict);
    const covered = deriveContinuity([...forkAbove, scope, w, s, t, observe("o", A0B1), decide("i", A0B1, "A1", "o")]);
    expect(covered.head(A0B1)).toEqual({ status: "head", channel: A1B1, support: [D("i"), O("o")] });
    sameWhateverTheOrder([...forkAbove, scope, w, s, t], [A0B0, A0B1]);
  });
});

describe("convergence and monotonicity", () => {
  it("gives the same view to replicas that hold the same facts, and a converged conflict is a converged state", () => {
    const o0 = observe("o0", A0B0);
    const replicaA = [o0, decide("d1", A0B0, "A1"), rotate("p1", A0B0, "B1")];
    const replicaB = [rotate("p2", A1B0, "B2"), o0];
    const channels = [A0B0, A0B1, A1B0, A1B1, C("A1", "B2")];
    const keys = [O("o0"), D("d1"), T("p1"), T("p2")];
    const merged = deriveContinuity([...replicaA, ...replicaB]);
    expect(view(deriveContinuity([...replicaB, ...replicaA]), channels, keys)).toEqual(view(merged, channels, keys));
    expect(deriveContinuity(replicaA).head(A0B0)).toEqual({ status: "head", channel: A1B1, support: [D("d1"), O("o0"), T("p1")] });
    expect(merged.head(A0B0)).toEqual({ status: "conflict", facts: [T("p1"), T("p2")] });
  });

  it("answers over a long rotation history", () => {
    const length = 3000;
    const facts: ContinuityFact[] = [];
    for (let i = 0; i < length; i++) facts.push(rotate(`p${String(i).padStart(4, "0")}`, C("A0", `B${i}`), `B${i + 1}`));
    const model = deriveContinuity(facts);
    const last = C("A0", `B${length}`);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: last, support: facts.map(keyOf) });
    expect(model.path(A0B0, C("A0", "B1"))).toEqual({ status: "path", channels: [A0B0, C("A0", "B1")], support: [T("p0000")] });
    const path = model.path(A0B0, last);
    expect(path.status === "path" && path.channels.length).toBe(length + 1);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("refuses a malformed fact without deriving anything", () => {
    expect(() => deriveContinuity([{ ...rotate("p1", A0B0, "B1"), extra: 1 } as unknown as ContinuityFact])).toThrow(InvalidFact);
  });

  it("answers unknown keys and unknown pairs as such", () => {
    const model = deriveContinuity([]);
    expect(model.status(T("nope"))).toEqual({ status: "unknown" });
    expect(model.head(A0B0)).toEqual({ status: "no-evidence" });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0)).toEqual({ links: [], endings: [], samePeer: [A0B0], sameLocal: [A0B0] });
  });
});
