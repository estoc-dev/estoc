import { describe, expect, it } from "vitest";

import { deriveContinuity, InvalidFact, mergeFacts, type Change, type Channel, type ContinuityFact, type Continuity } from "../src/index.js";
import { C, decide, localEnd, observe, peerEnd, permutations, rotate, snapshot } from "./facts.js";

const A0B0 = C("A0", "B0");
const A0B1 = C("A0", "B1");
const A1B0 = C("A1", "B0");
const A1B1 = C("A1", "B1");

/** Every query result that has a fixed shape, so two derivations can be compared whole. */
function view(model: Continuity, channels: readonly Channel[], ids: readonly string[]) {
  return {
    facts: model.facts,
    conflicts: model.conflicts(),
    heads: channels.map((channel) => model.head(channel)),
    histories: channels.map((channel) => model.history(channel)),
    confirmations: channels.map((channel) => model.confirmation(channel.localDid, channel.peerDid)),
    statuses: ids.map((id) => model.status(id)),
  };
}

function sameWhateverTheOrder(facts: readonly ContinuityFact[], channels: readonly Channel[]) {
  const ids = facts.map((fact) => fact.id);
  const expected = view(deriveContinuity(facts), channels, ids);
  for (const order of permutations(facts)) expect(view(deriveContinuity(order), channels, ids)).toEqual(expected);
  return expected;
}

describe("receiving a peer rotation", () => {
  const p1 = rotate("p1", A0B0, "B1", "receipt-1");
  const o1 = observe("o1", A0B1, "p1", "receipt-1");

  it("moves the head of the old pair to the successor pair, supported by the transition", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p1"] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
    expect(model.status("p1")).toEqual({ status: "usable", support: ["p1"] });
    expect(model.status("o1")).toEqual({ status: "usable", support: ["o1", "p1"] });
  });

  it("confirms A0 in the B0 context through the successor's observation", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A0B1, support: ["o1", "p1"] }] });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A0B1, support: ["o1", "p1"] }] });
  });

  it("does not touch another relationship sharing the peer DID", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([p1, o1, observe("ox", X0B0)]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: X0B0, support: [] });
    expect(model.changes(X0B0, "peer")).toEqual([]);
    expect(model.head(C("Y0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("lists the change for supersession checks across the local-only context", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.changes(A0B0, "peer")).toEqual([{ id: "p1", at: A0B0, change: { kind: "rotate", successor: "B1" }, to: A0B1, status: { status: "usable", support: ["p1"] } }]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([p1, o1, observe("o0", A0B0)], [A0B0, A0B1]);
  });

  it("adds support, not another successor, for repeated carriers of the same proof", () => {
    const p2 = rotate("p2", A0B0, "B1", "receipt-2");
    const model = deriveContinuity([p1, o1, p2, observe("o2", A0B1, "p2", "receipt-2")]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p1", "p2"] });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A0B1, replaces: "peer", support: ["p1", "p2"], derived: false, usable: true }]);
  });
});

describe("local rotation and confirmation", () => {
  const o0 = observe("o0", A0B0);
  const d1 = decide("d1", A0B0, "A1");

  it("is unresolved until the predecessor address is confirmed, and never falls back to absence", () => {
    const waiting = deriveContinuity([d1]);
    expect(waiting.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(waiting.head(A1B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(waiting.head(C("A2", "B0"))).toEqual({ status: "no-evidence" });
    expect(waiting.status("d1")).toEqual({ status: "waiting", because: expect.stringContaining("no observation") });
    expect(waiting.localDecisions(A0B0)).toEqual([{ id: "d1", at: A0B0, change: { kind: "rotate", successor: "A1" }, to: A1B0, status: waiting.status("d1") }]);
    const confirmed = deriveContinuity([d1, o0]);
    expect(confirmed.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["d1", "o0"] });
  });

  it("cannot confirm itself through what it derives", () => {
    const model = deriveContinuity([d1, observe("o1", A1B0)]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A1B0, support: ["o1"] }] });
  });

  it("admits nothing from a ring of decisions confirming one another", () => {
    const d2 = decide("d2", C("A1", "B0"), "A2");
    const model = deriveContinuity([d1, d2, observe("o2", C("A2", "B0"))]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(model.head(A1B0)).toEqual({ status: "unresolved", waiting: ["d2"], missing: [] });
  });

  it("uses the exact source the host named", () => {
    const named = decide("d1", A0B0, "A1", "o0");
    expect(deriveContinuity([named, o0]).head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["d1", "o0"] });
    expect(deriveContinuity([named, o0]).status("d1")).toEqual({ status: "usable", support: ["d1", "o0"] });
    const missing = deriveContinuity([named]);
    expect(missing.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: ["o0"] });
    expect(missing.head(A1B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: ["o0"] });
    expect(missing.status("d1")).toEqual({ status: "unresolved", missing: ["o0"] });
    const otherPeer = deriveContinuity([named, observe("o0", C("A0", "X0"))]);
    expect(otherPeer.status("d1")).toEqual({ status: "waiting", because: expect.stringContaining("o0") });
    expect(otherPeer.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    const otherLocal = deriveContinuity([named, observe("o0", C("A9", "B0"))]);
    expect(otherLocal.status("d1")).toEqual({ status: "invalid", because: expect.stringContaining("A9") });
    const notAnObservation = deriveContinuity([decide("d1", A0B0, "A1", "p"), rotate("p", A0B0, "B1")]);
    expect(notAnObservation.status("d1")).toEqual({ status: "invalid", because: expect.stringContaining("no address observation") });
  });

  it("takes a second decision for the same successor as provenance, not as a waiting fork", () => {
    const named = decide("d2", A0B0, "A1", "o-missing");
    const model = deriveContinuity([d1, o0, named]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["d1", "o0"] });
    expect(model.status("d2")).toEqual({ status: "unresolved", missing: ["o-missing"] });
    expect(deriveContinuity([d1, named]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1", "d2"], missing: ["o-missing"] });
  });

  it("confirms the predecessor through a usable peer successor", () => {
    const p1 = rotate("p1", A0B0, "B1", "receipt-1");
    const o1 = observe("o1", A0B1, "p1", "receipt-1");
    const model = deriveContinuity([p1, o1, d1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o1", "p1"] });
  });

  it("supports a confirmation with the peer path to the observer, so the support alone re-derives it", () => {
    const facts = [rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B2"), observe("o2", C("A0", "B2")), decide("d1", A0B0, "A1", "o2")];
    const model = deriveContinuity(facts);
    const path = model.path(A0B0, A1B0);
    expect(path).toEqual({ status: "path", channels: [A0B0, A1B0], support: ["d1", "o2", "p1", "p2"] });
    expect(model.status("d1")).toEqual({ status: "usable", support: ["d1", "o2", "p1", "p2"] });
    if (path.status !== "path") throw new Error(path.status);
    const replayed = deriveContinuity(facts.filter((fact) => path.support.includes(fact.id)));
    expect(replayed.path(A0B0, A1B0)).toEqual(path);
    const unnamed = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B2"), observe("o2", C("A0", "B2")), decide("d1", A0B0, "A1")]);
    expect(unnamed.status("d1")).toEqual({ status: "usable", support: ["d1", "o2", "p1", "p2"] });
  });

  it("names no source for an ending", () => {
    expect(() => deriveContinuity([{ ...localEnd("e1", A0B0), source: "o0" }])).toThrow(InvalidFact);
  });
});

describe("both parties rotate", () => {
  const o0 = observe("o0", A0B0);
  const d1 = decide("d1", A0B0, "A1");
  const p1 = rotate("p1", A0B0, "B1");

  it("joins in the pair of both successors without fabricating a receipt to A1", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(model.head(A1B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(model.confirmation("A1", "B1")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o0", at: A0B0, support: ["o0"] }] });
  });

  it("confirms A1 by a later proof-free receipt from B1", () => {
    const model = deriveContinuity([o0, d1, p1, observe("o2", A1B1)]);
    expect(model.confirmation("A1", "B1")).toEqual({ status: "confirmed", observations: [{ id: "o2", at: A1B1, support: ["o2"] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o2", at: A1B1, support: ["d1", "o0", "o2", "p1"] }] });
  });

  it("offers directed usable paths that preserve roles", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.path(A0B0, A1B1)).toEqual({ status: "path", channels: [A0B0, A0B1, A1B1], support: ["d1", "o0", "p1"] });
    expect(model.path(A0B0, A0B0)).toEqual({ status: "path", channels: [A0B0], support: [] });
    expect(model.path(A0B1, A1B0)).toEqual({ status: "none" });
    expect(model.path(A1B1, A0B0)).toEqual({ status: "none" });
    expect(model.path(C("Q", "R"), A0B0)).toEqual({ status: "none" });
  });

  it("shows the join as derived links in the history", () => {
    const model = deriveContinuity([o0, d1, p1]);
    const history = model.history(A1B1);
    expect(history.links).toEqual([
      { from: A0B0, to: A0B1, replaces: "peer", support: ["p1"], derived: false, usable: true },
      { from: A0B0, to: A1B0, replaces: "local", support: ["d1", "o0"], derived: false, usable: true },
      { from: A0B1, to: A1B1, replaces: "local", support: ["d1", "o0", "p1"], derived: true, usable: true },
      { from: A1B0, to: A1B1, replaces: "peer", support: ["d1", "o0", "p1"], derived: true, usable: true },
    ]);
    expect(history.localContext).toEqual([A0B1, A1B1]);
    expect(history.peerContext).toEqual([A1B0, A1B1]);
    expect(model.history(A0B0).localContext).toEqual([A0B0, A1B0]);
    expect(model.history(A0B0).peerContext).toEqual([A0B0, A0B1]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([o0, d1, p1, observe("o2", A1B1)], [A0B0, A0B1, A1B0, A1B1]);
  });
});

describe("competing changes", () => {
  it("reports competing peer successors in one context and selects neither", () => {
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A0B0, "B2");
    const model = deriveContinuity([p1, p2]);
    expect(model.conflicts()).toEqual([
      {
        kind: "competing-changes",
        side: "peer",
        context: [A0B0],
        changes: [
          { change: { kind: "rotate", successor: "B1" }, facts: ["p1"] },
          { change: { kind: "rotate", successor: "B2" }, facts: ["p2"] },
        ],
      },
    ]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.status("p1")).toEqual({ status: "conflict", facts: ["p1", "p2"], because: expect.any(String) });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.path(A0B0, A0B1)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
  });

  it("scopes the peer's competition over the local-only context", () => {
    const o0 = observe("o0", A0B0);
    const d1 = decide("d1", A0B0, "A1");
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A0B0, "B2");
    const p3 = rotate("p3", A1B0, "B1");
    const model = deriveContinuity([o0, d1, p1, p2, p3]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", context: [A0B0, A1B0] }]);
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts: ["p1", "p2", "p3"] });
    const unlinked = deriveContinuity([p1, rotate("p2", A1B0, "B2")]);
    expect(unlinked.conflicts()).toEqual([]);
    expect(unlinked.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p1"] });
  });

  it("reports two saved local successors as a fork even before either is confirmed", () => {
    const d1 = decide("d1", A0B0, "A1");
    const d2 = decide("d2", A0B0, "A2");
    const model = deriveContinuity([d1, d2]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", context: [A0B0] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    expect(model.head(C("A2", "B0"))).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    const confirmed = deriveContinuity([d1, d2, observe("o0", A0B0)]);
    expect(confirmed.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    expect(confirmed.status("d1")).toMatchObject({ status: "conflict" });
  });

  it("leaves unrelated contexts usable", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), rotate("px", X0B0, "B1")]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: C("X0", "B1"), support: ["px"] });
  });

  it("reports a cycle", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B0")]);
    expect(model.conflicts()).toEqual([{ kind: "cycle", channels: [A0B0, A0B1], facts: ["p1", "p2"] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
  });

  it("refuses a join that would pair a DID with itself", () => {
    const model = deriveContinuity([observe("o0", A0B0), decide("d1", A0B0, "A1"), rotate("p1", A0B0, "A1")]);
    expect(model.conflicts()).toEqual([{ kind: "identity-collision", channels: [A0B0, A1B0, C("A0", "A1")], facts: ["d1", "o0", "p1"] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "o0", "p1"] });
  });

  it("derives the same conflicts from any enumeration order", () => {
    sameWhateverTheOrder([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), observe("o1", A0B1, "p1", "receipt-p1")], [A0B0, A0B1]);
  });
});

describe("successors the other party's changes order", () => {
  const P_B = C("P", "B");
  const P_B2 = C("P", "B2");
  const X_B = C("X", "B");
  const X_B2 = C("X", "B2");
  const X2_B2 = C("X2", "B2");

  describe("a local address rotated once for the peer and again for the peer's successor", () => {
    const first = observe("first", P_B);
    const toX = decide("toX", P_B, "X", "first");
    const moved = rotate("moved", P_B, "B2", "receipt-second");
    const second = observe("second", P_B2, "moved", "receipt-second");
    const toX2 = decide("toX2", P_B2, "X2", "second");
    const facts = [first, toX, moved, second, toX2];

    it("leads every pair of the relationship to the later successor", () => {
      const model = deriveContinuity(facts);
      expect(model.conflicts()).toEqual([]);
      for (const channel of [P_B, P_B2, X_B, X_B2, X2_B2]) expect(model.head(channel)).toMatchObject({ status: "head", channel: X2_B2 });
      expect(model.head(P_B)).toEqual({ status: "head", channel: X2_B2, support: ["first", "moved", "second", "toX", "toX2"] });
      expect(model.status("toX")).toMatchObject({ status: "usable" });
      expect(model.status("toX2")).toMatchObject({ status: "usable" });
    });

    it("shows the superseded successor leading to the later one as a derived link", () => {
      const links = deriveContinuity(facts).history(P_B).links;
      expect(links).toContainEqual({ from: X_B2, to: X2_B2, replaces: "local", support: ["first", "moved", "second", "toX", "toX2"], derived: true, usable: true });
    });

    it("gives a path from the superseded successor's pair", () => {
      expect(deriveContinuity(facts).path(X_B, X2_B2)).toMatchObject({ status: "path", channels: [X_B, X_B2, X2_B2] });
    });

    it("is the same from any enumeration order", () => {
      sameWhateverTheOrder(facts, [P_B, P_B2, X_B, X_B2, X2_B2]);
    });

    it("waits for the later decision while it is not confirmed", () => {
      const model = deriveContinuity([first, toX, moved, second, decide("toX2", P_B2, "X2", "missing")]);
      expect(model.conflicts()).toEqual([]);
      expect(model.head(P_B)).toEqual({ status: "unresolved", waiting: ["toX2"], missing: ["missing"] });
    });

    it("holds when two replicas saved each decision", () => {
      const model = deriveContinuity([...facts, decide("toX-again", P_B, "X", "first"), decide("toX2-again", P_B2, "X2", "second")]);
      expect(model.conflicts()).toEqual([]);
      expect(model.head(P_B)).toMatchObject({ status: "head", channel: X2_B2 });
    });

    it("competes when the later pair also claims the earlier successor's rival at the earlier pair", () => {
      const model = deriveContinuity([...facts, decide("back", P_B, "X2", "first")]);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
      expect(model.head(P_B).status).toBe("conflict");
    });

    it("competes with an ending in the context", () => {
      const model = deriveContinuity([...facts, localEnd("end", P_B)]);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
    });

    it("orders a third successor after the second", () => {
      const B3 = "B3";
      const again = rotate("again", P_B2, B3, "receipt-third");
      const third = observe("third", C("P", B3), "again", "receipt-third");
      const toX3 = decide("toX3", C("P", B3), "X3", "third");
      const model = deriveContinuity([...facts, again, third, toX3]);
      expect(model.conflicts()).toEqual([]);
      for (const channel of [P_B, X_B, X_B2, X2_B2, C("X2", B3)]) expect(model.head(channel)).toMatchObject({ status: "head", channel: C("X3", B3) });
      expect(deriveContinuity([toX3, third, again, ...[...facts].reverse()]).head(P_B)).toEqual(model.head(P_B));
    });
  });

  describe("a peer address rotated once for the local address and again for its successor", () => {
    const B_P = C("B", "P");
    const B_X = C("B", "X");
    const B2_P = C("B2", "P");
    const B2_X = C("B2", "X");
    const B2_X2 = C("B2", "X2");
    const toX = rotate("toX", B_P, "X", "receipt-first");
    const first = observe("first", B_X, "toX", "receipt-first");
    const moved = decide("moved", B_P, "B2");
    const wrote = observe("wrote", B_P);
    const toX2 = rotate("toX2", B2_P, "X2", "receipt-second");
    const second = observe("second", B2_X2, "toX2", "receipt-second");
    const facts = [toX, first, wrote, moved, toX2, second];

    it("leads every pair of the relationship to the later successor", () => {
      const model = deriveContinuity(facts);
      expect(model.conflicts()).toEqual([]);
      for (const channel of [B_P, B_X, B2_P, B2_X, B2_X2]) expect(model.head(channel)).toMatchObject({ status: "head", channel: B2_X2 });
      sameWhateverTheOrder(facts, [B_P, B_X, B2_P, B2_X, B2_X2]);
    });

    it("competes when both successors were received at one pair", () => {
      const model = deriveContinuity([toX, first, rotate("toX2", B_P, "X2")]);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer" }]);
    });
  });

  describe("a superseded successor's own changes", () => {
    const first = observe("first", P_B);
    const toX = decide("toX", P_B, "X", "first");
    const moved = rotate("moved", P_B, "B2", "receipt-second");
    const second = observe("second", P_B2, "moved", "receipt-second");
    const toY = decide("toY", P_B2, "Y", "second");
    const local = [first, toX, moved, second, toY];
    const Y_B2 = C("Y", "B2");

    const A0_B0 = C("A0", "B0");
    const A1_B1 = C("A1", "B1");
    const A1_B2 = C("A1", "B2");
    const peer = [observe("o", A0_B0), decide("a0-a1", A0_B0, "A1", "o"), rotate("b0-b1", A0_B0, "B1"), rotate("b0-b2", C("A1", "B0"), "B2")];

    it("lists its replacement among its changes, at the pair it is replaced at", () => {
      const model = deriveContinuity(peer);
      const replaced = { id: "b0-b2", at: A1_B1, change: { kind: "rotate", successor: "B2" }, to: A1_B2, status: { status: "usable", support: ["b0-b2"] } };
      expect(model.changes(A1_B1, "peer")).toEqual([replaced]);
      expect(model.changes(C("A0", "B1"), "peer")).toEqual([replaced]);
      expect(model.changes(A1_B2, "peer")).toEqual([]);
      expect(model.changes(C("A2", "B1"), "peer")).toEqual([]);
      expect(deriveContinuity(local).changes(X_B, "local")).toMatchObject([{ id: "toY", at: X_B2, to: Y_B2 }]);
      expect(deriveContinuity(local).localDecisions(X_B2)).toEqual([]);
    });

    it("compete with its replacement when they name another successor at the pair it is replaced at", () => {
      const facts = [...peer, rotate("b1-b3", A1_B1, "B3")];
      const model = deriveContinuity(facts);
      expect(model.conflicts()).toEqual([
        {
          kind: "competing-changes",
          side: "peer",
          context: [C("A0", "B1"), A1_B1],
          changes: [
            { change: { kind: "rotate", successor: "B2" }, facts: ["b0-b2"] },
            { change: { kind: "rotate", successor: "B3" }, facts: ["b1-b3"] },
          ],
        },
      ]);
      for (const channel of [A0_B0, A1_B1, A1_B2, C("A1", "B3")]) expect(model.head(channel).status).toBe("conflict");
      expect(model.path(A1_B1, A1_B2).status).toBe("conflict");
      expect(model.path(A1_B1, C("A1", "B3")).status).toBe("conflict");
      expect(model.status("b1-b3")).toMatchObject({ status: "conflict" });
      expect(model.status("b0-b2")).toMatchObject({ status: "conflict" });
      sameWhateverTheOrder(facts, [A0_B0, A1_B1, A1_B2]);

      const ours = deriveContinuity([...local, observe("third", X_B2), decide("toZ", X_B2, "Z", "third")]);
      expect(ours.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", context: [X_B, X_B2], changes: [{ facts: ["toY"] }, { facts: ["toZ"] }] }]);
      expect(ours.head(P_B)).toEqual({ status: "conflict", facts: ["toY", "toZ"] });
    });

    it("compete with its replacement when it ends in the context it is replaced in", () => {
      const model = deriveContinuity([...peer, peerEnd("end", A1_B1)]);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", changes: [{ change: { kind: "end" }, facts: ["end"] }, { change: { kind: "rotate", successor: "B2" }, facts: ["b0-b2"] }] }]);
      expect(model.head(A1_B1).status).toBe("conflict");
      expect(model.head(A1_B2).status).toBe("conflict");

      const ours = deriveContinuity([...local, localEnd("end", X_B2)]);
      expect(ours.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
      expect(ours.head(P_B)).toEqual({ status: "conflict", facts: ["end", "toY"] });
    });

    it("add support when they name the same successor at that pair", () => {
      const model = deriveContinuity([...peer, rotate("b1-b2", A1_B1, "B2")]);
      expect(model.conflicts()).toEqual([]);
      expect(model.head(A0_B0)).toEqual({ status: "head", channel: A1_B2, support: ["a0-a1", "b0-b1", "b0-b2", "b1-b2", "o"] });
      expect(model.history(A0_B0).links).toContainEqual({ from: A1_B1, to: A1_B2, replaces: "peer", support: ["a0-a1", "b0-b1", "b0-b2", "b1-b2", "o"], derived: false, usable: true });
    });

    it("are superseded with it when made at an earlier pair", () => {
      const facts = [...local, observe("early", X_B), decide("toZ", X_B, "Z", "early")];
      const model = deriveContinuity(facts);
      expect(model.conflicts()).toEqual([]);
      for (const channel of [P_B, X_B, C("Z", "B"), C("Z", "B2")]) expect(model.head(channel)).toMatchObject({ status: "head", channel: Y_B2 });
      expect(deriveContinuity([...facts].reverse()).head(P_B)).toEqual(model.head(P_B));
    });

    it("supersede its replacement when made at a later pair", () => {
      const facts = [...local, rotate("again", P_B2, "B3"), observe("late", C("X", "B3")), decide("toZ", C("X", "B3"), "Z", "late")];
      const model = deriveContinuity(facts);
      expect(model.conflicts()).toEqual([]);
      for (const channel of [P_B, X_B, X_B2, Y_B2, C("Y", "B3")]) expect(model.head(channel)).toMatchObject({ status: "head", channel: C("Z", "B3") });
      expect(model.changes(Y_B2, "local")).toMatchObject([{ id: "toZ", at: C("Y", "B3"), to: C("Z", "B3") }]);
      expect(deriveContinuity([...facts].reverse()).head(P_B)).toEqual(model.head(P_B));
    });
  });

  describe("a replacement the complete changes do not imply", () => {
    const A0_P = C("A0", "P");
    const A1_X = C("A1", "X");
    const A1_U = C("A1", "U");
    const A1_W = C("A1", "W");
    const peer = [
      observe("o", A0_P),
      decide("a0-a1", A0_P, "A1", "o"),
      rotate("p-x", A0_P, "X"),
      rotate("p-y", C("A1", "P"), "Y"),
      rotate("x-u", C("A0", "X"), "U"),
      rotate("x-v", A1_X, "V"),
      rotate("u-w", A1_U, "W"),
      observe("independent", A1_U),
    ];
    const atU = (model: Continuity) => ({
      conflicts: model.conflicts(),
      changes: model.changes(A1_U, "peer"),
      head: model.head(A1_W),
      path: model.path(A1_U, A1_W),
      onward: model.status("u-w"),
      links: model.history(A1_U).links.filter((link) => link.from.localDid === "A1" && link.from.peerDid === "U"),
    });

    it("is not implied: the replacement of X's successor U fails once X's own change and its implied one compete, and U's onward change stands", () => {
      const model = deriveContinuity(peer);
      expect(model.conflicts()).toEqual([
        {
          kind: "competing-changes",
          side: "peer",
          context: [C("A0", "X"), A1_X],
          changes: [
            { change: { kind: "rotate", successor: "U" }, facts: ["x-u"] },
            { change: { kind: "rotate", successor: "V" }, facts: ["x-v"] },
            { change: { kind: "rotate", successor: "Y" }, facts: ["p-y"] },
          ],
        },
      ]);
      expect(model.history(A1_U).links.filter((link) => link.from.localDid === "A1" && link.from.peerDid === "U")).toEqual([{ from: A1_U, to: A1_W, replaces: "peer", support: ["u-w"], derived: false, usable: true }]);
      expect(model.changes(A1_U, "peer")).toMatchObject([{ id: "u-w", at: A1_U }]);
      expect(model.head(A1_W)).toEqual({ status: "head", channel: A1_W, support: [] });
      expect(model.path(A1_U, A1_W)).toMatchObject({ status: "path", support: ["u-w"] });
      expect(model.status("u-w")).toEqual({ status: "usable", support: ["u-w"] });
      expect(atU(deriveContinuity([...peer].reverse()))).toEqual(atU(model));
    });

    it("gives the same answers whether the competing change of X was received or implied", () => {
      const implied = atU(deriveContinuity(peer));
      const received = atU(deriveContinuity([...peer, rotate("x-y", A1_X, "Y")]));
      expect(received).toEqual({ ...implied, conflicts: [{ ...implied.conflicts[0], changes: [{ change: { kind: "rotate", successor: "U" }, facts: ["x-u"] }, { change: { kind: "rotate", successor: "V" }, facts: ["x-v"] }, { change: { kind: "rotate", successor: "Y" }, facts: ["p-y", "x-y"] }] }] });
    });

    it("frees what it would have competed with: U's own successors are ordered once the replacement that failed is gone, usable or not", () => {
      const facts = [...peer.filter((fact) => fact.id !== "u-w" && fact.id !== "independent"), rotate("u-z", C("A0", "U"), "Z"), rotate("u-w", A1_U, "W")];
      const model = deriveContinuity(facts);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", context: [C("A0", "X"), A1_X] }]);
      const links = model.history(A1_U).links;
      expect(links.filter((link) => link.from.peerDid === "U" && link.to.peerDid === "V")).toEqual([]);
      expect(links).toContainEqual({ from: C("A1", "Z"), to: A1_W, replaces: "peer", support: ["a0-a1", "o", "p-x", "u-w", "u-z", "x-u"], derived: true, usable: false });
      expect(model.changes(C("A1", "Z"), "peer")).toMatchObject([{ id: "u-w", at: C("A1", "Z"), to: A1_W }]);
      expect(atU(deriveContinuity([...facts].reverse()))).toEqual(atU(model));
    });

    it("is not implied on the local side either", () => {
      const ours = [
        rotate("b0-b1", C("P", "B0"), "B1"),
        observe("o0", C("P", "B0")),
        observe("o1", C("P", "B1")),
        decide("p-x", C("P", "B0"), "X", "o0"),
        decide("p-y", C("P", "B1"), "Y", "o1"),
        observe("ox0", C("X", "B0")),
        observe("ox1", C("X", "B1")),
        decide("x-u", C("X", "B0"), "U", "ox0"),
        decide("x-v", C("X", "B1"), "V", "ox1"),
        observe("ou1", C("U", "B1")),
        decide("u-w", C("U", "B1"), "W", "ou1"),
      ];
      const implied = deriveContinuity(ours);
      expect(implied.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", context: [C("X", "B0"), C("X", "B1")], changes: [{ facts: ["x-u"] }, { facts: ["x-v"] }, { facts: ["p-y"] }] }]);
      const fromU = (model: Continuity) => model.history(C("U", "B1")).links.filter((link) => link.from.localDid === "U" && link.from.peerDid === "B1");
      expect(fromU(implied)).toMatchObject([{ from: C("U", "B1"), to: C("W", "B1"), replaces: "local", derived: false, usable: true }]);
      expect(implied.path(C("U", "B1"), C("W", "B1")).status).toBe("path");
      const received = deriveContinuity([...ours, decide("x-y", C("X", "B1"), "Y", "ox1")]);
      expect(fromU(received)).toEqual(fromU(implied));
      expect(received.path(C("U", "B1"), C("W", "B1"))).toEqual(implied.path(C("U", "B1"), C("W", "B1")));
    });
  });

  describe("replacements the derivation does not settle", () => {
    const A3_Y = C("A3", "Y");
    const A3_Z = C("A3", "Z");
    // A1 returns to A0 towards X, and Y returns to B: what X → Y and the implied A2 → A0 join to leads back from
    // C(A2,B) to C(A0,B), which undoes the very order of B's successors that implied them.
    const peer = [
      observe("o-a0-b", C("A0", "B")),
      observe("o-a1-b", C("A1", "B")),
      observe("o-a1-x", C("A1", "X")),
      observe("o-a2-b", C("A2", "B")),
      decide("a0-a1", C("A0", "B"), "A1", "o-a0-b"),
      decide("a1-a2", C("A1", "B"), "A2", "o-a1-b"),
      decide("a1-a0", C("A1", "X"), "A0", "o-a1-x"),
      decide("a2-a3", C("A2", "B"), "A3", "o-a2-b"),
      rotate("b-x", C("A0", "B"), "X"),
      rotate("b-y", C("A2", "B"), "Y"),
      rotate("b-z", C("A3", "B"), "Z"),
      rotate("y-b", C("A0", "Y"), "B"),
    ];
    const atY = (model: Continuity) => ({
      unsettled: model.conflicts().filter((conflict) => conflict.kind === "unsettled-changes"),
      head: model.head(A3_Y),
      path: model.path(A3_Y, A3_Z),
      replacements: [...new Set(model.changes(A3_Y, "peer").map(({ at, change }) => JSON.stringify({ at, change })))].map((text) => JSON.parse(text) as { at: Channel; change: Change }),
      links: model.history(A3_Y).links.filter((link) => link.from.localDid === "A3" && link.from.peerDid === "Y"),
    });

    it("are implied and reported as unsettled, with a scope that grants no path", () => {
      const model = deriveContinuity(peer);
      const result = atY(model);
      expect(result.unsettled).toContainEqual({ kind: "unsettled-changes", side: "peer", context: [C("A0", "Y"), C("A1", "Y"), C("A2", "Y"), A3_Y], changes: [{ change: { kind: "rotate", successor: "Z" }, facts: ["b-z"] }] });
      expect(result.unsettled).toContainEqual({ kind: "unsettled-changes", side: "local", context: [C("A2", "B"), C("A2", "X"), C("A2", "Y")], changes: [{ change: { kind: "rotate", successor: "A0" }, facts: ["a1-a0"] }] });
      expect(result.replacements).toContainEqual({ at: A3_Y, change: { kind: "rotate", successor: "Z" } });
      expect(result.links).toContainEqual({ from: A3_Y, to: A3_Z, replaces: "peer", support: expect.arrayContaining(["a2-a3", "b-y", "b-z"]), derived: true, usable: false });
      expect(result.head).toMatchObject({ status: "conflict" });
      expect(result.path).toMatchObject({ status: "conflict" });
      expect(model.status("b-z")).toMatchObject({ status: "conflict" });
      expect(atY(deriveContinuity([...peer].reverse()))).toEqual(result);
    });

    it("answer the same for Y whether its replacement was received or implied, and list a received one once", () => {
      const implied = atY(deriveContinuity(peer));
      const received = atY(deriveContinuity([...peer, rotate("y-z", A3_Y, "Z")]));
      expect(received.head).toMatchObject({ status: "conflict" });
      expect(received.path).toMatchObject({ status: "conflict" });
      expect(received.replacements.filter(({ at }) => at.peerDid === "Y")).toEqual(implied.replacements.filter(({ at }) => at.peerDid === "Y"));
      expect(received.links.filter((link) => link.to.peerDid !== "Z")).toEqual(implied.links.filter((link) => link.to.peerDid !== "Z"));
      expect(received.links.filter((link) => link.to.peerDid === "Z")).toEqual([{ from: A3_Y, to: A3_Z, replaces: "peer", support: expect.arrayContaining(["y-z"]), derived: false, usable: false }]);
    });

    it("are reported on the local side the same way", () => {
      const ours = peer.flatMap((fact): ContinuityFact[] => {
        const at = C(fact.at.peerDid, fact.at.localDid);
        if (fact.kind === "address-observed") return [observe(fact.id, at)];
        if (fact.kind === "local-decision") return [rotate(fact.id, at, fact.change.kind === "rotate" ? fact.change.successor : "")];
        return [observe(`source-${fact.id}`, at), decide(fact.id, at, fact.change.kind === "rotate" ? fact.change.successor : "", `source-${fact.id}`)];
      });
      const model = deriveContinuity(ours);
      expect(model.conflicts()).toContainEqual({ kind: "unsettled-changes", side: "local", context: [C("Y", "A0"), C("Y", "A1"), C("Y", "A2"), C("Y", "A3")], changes: [{ change: { kind: "rotate", successor: "Z" }, facts: ["b-z"] }] });
      expect(model.changes(C("Y", "A3"), "local")).toContainEqual(expect.objectContaining({ id: "b-z", at: C("Y", "A3"), change: { kind: "rotate", successor: "Z" } }));
      expect(model.head(C("Y", "A3"))).toMatchObject({ status: "conflict" });
      expect(model.path(C("Y", "A3"), C("Z", "A3"))).toMatchObject({ status: "conflict" });
    });
  });

  describe("a successor claimed at several pairs", () => {
    const converging = [rotate("b1-b3", C("P", "B1"), "B3"), rotate("b2-b3", P_B2, "B3"), observe("o1", C("P", "B1")), observe("o2", P_B2), observe("o3", C("P", "B3"))];

    it("competes with one claimed at a pair that does not reach every one of them", () => {
      const model = deriveContinuity([...converging, decide("x", C("P", "B1"), "X", "o1"), decide("y2", P_B2, "Y", "o2"), decide("y3", C("P", "B3"), "Y", "o3")]);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", changes: [{ facts: ["x"] }, { facts: ["y2", "y3"] }] }]);
      expect(model.head(C("P", "B1"))).toEqual({ status: "conflict", facts: ["x", "y2", "y3"] });
    });

    it("supersedes one claimed at pairs that each reach every one of them", () => {
      const model = deriveContinuity([...converging, decide("x1", C("P", "B1"), "X", "o1"), decide("x2", P_B2, "X", "o2"), decide("y3", C("P", "B3"), "Y", "o3")]);
      expect(model.conflicts()).toEqual([]);
      for (const channel of [C("P", "B1"), P_B2, C("X", "B1")]) expect(model.head(channel)).toMatchObject({ status: "head", channel: C("Y", "B3") });
    });

    it("competes the same way when the peer's successors were received at them", () => {
      const ours = [observe("w1", C("A1", "P")), observe("w2", C("A2", "P")), decide("a1-a3", C("A1", "P"), "A3", "w1"), decide("a2-a3", C("A2", "P"), "A3", "w2")];
      const model = deriveContinuity([...ours, rotate("x", C("A1", "P"), "X"), rotate("y2", C("A2", "P"), "Y"), rotate("y3", C("A3", "P"), "Y")]);
      expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", changes: [{ facts: ["x"] }, { facts: ["y2", "y3"] }] }]);
    });
  });

  it("competes when the other party's changes fork, so that no order holds", () => {
    const facts = [
      observe("o", P_B),
      rotate("fork-1", P_B, "B1"),
      rotate("fork-2", P_B, "B2"),
      decide("d1", C("P", "B1"), "X1"),
      decide("d2", P_B2, "X2"),
    ];
    const model = deriveContinuity(facts);
    expect(model.conflicts().map((conflict) => conflict.kind)).toContain("competing-changes");
    expect(model.head(P_B).status).toBe("conflict");
  });
});

describe("ending", () => {
  it("ends the head of the pair and of its local-only context", () => {
    const model = deriveContinuity([observe("o0", A0B0), decide("d1", A0B0, "A1"), peerEnd("e1", A0B0)]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.head(A1B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.history(A1B0).endings).toEqual([{ id: "e1", at: A0B0, side: "peer", status: { status: "usable", support: ["e1"] } }]);
    expect(model.head(C("X0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("competes with a rotation of the same endpoint, whatever the order", () => {
    const model = deriveContinuity([peerEnd("e1", A0B0), rotate("p1", A0B0, "B1")]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", changes: [{ change: { kind: "end" }, facts: ["e1"] }, { change: { kind: "rotate", successor: "B1" }, facts: ["p1"] }] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["e1", "p1"] });
    sameWhateverTheOrder([peerEnd("e1", A0B0), rotate("p1", A0B0, "B1")], [A0B0, A0B1]);
  });

  it("treats rotation followed by the successor ending as forward history", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), peerEnd("e1", A0B1)]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: ["e1"] });
  });

  it("applies a local ending across the peer-only context and supplies no joined head", () => {
    const model = deriveContinuity([localEnd("e1", A0B0), rotate("p1", A0B0, "B1")]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.localDecisions(A0B1)).toEqual([{ id: "e1", at: A0B0, change: { kind: "end" }, to: null, status: { status: "usable", support: ["e1"] } }]);
  });

  it("competes with a local rotation of the same endpoint", () => {
    const model = deriveContinuity([localEnd("e1", A0B0), decide("d1", A0B0, "A1"), observe("o0", A0B0)]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "e1"] });
  });

  it("refuses an observation that claims an ending carried it", () => {
    const model = deriveContinuity([peerEnd("e1", A0B0, "receipt-1"), observe("o1", A0B1, "e1", "receipt-1")]);
    expect(model.status("o1")).toEqual({ status: "invalid", because: expect.stringContaining("ending") });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: ["o1"] });
  });
});

describe("observations", () => {
  it("must agree with the transition they claim to carry", () => {
    const p1 = rotate("p1", A0B0, "B1", "receipt-1");
    const cases: [ContinuityFact, string][] = [
      [observe("o1", A0B1, "p1", "receipt-2"), "another receipt"],
      [observe("o1", C("A9", "B1"), "p1", "receipt-1"), "A9"],
      [observe("o1", C("A0", "B2"), "p1", "receipt-1"), "B2"],
      [observe("o1", A0B1, "o9", "receipt-1"), "o9"],
    ];
    for (const [observation, mention] of cases) {
      const status = deriveContinuity([p1, observation]).status("o1");
      expect(status.status === "invalid" || status.status === "unresolved", JSON.stringify(observation)).toBe(true);
      expect(JSON.stringify(status)).toContain(mention);
    }
  });

  it("stays pending when its carried transition is not here, and cannot become proof-free", () => {
    const model = deriveContinuity([observe("o1", A0B1, "p1", "receipt-1")]);
    expect(model.status("o1")).toEqual({ status: "unresolved", missing: ["p1"] });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: ["o1"] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
  });

  it("confirms only its exact local recipient", () => {
    const model = deriveContinuity([observe("o1", A0B0)]);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A0B0, support: ["o1"] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "A0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("cannot restore continuation through a conflicted context", () => {
    const p1 = rotate("p1", A0B0, "B1", "receipt-1");
    const model = deriveContinuity([p1, rotate("p2", A0B0, "B2"), observe("o1", A0B1, "p1", "receipt-1"), observe("o3", A0B1)]);
    expect(model.confirmation("A0", "B1")).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.status("o3")).toMatchObject({ status: "conflict" });
  });
});

describe("identity conflicts", () => {
  const p1 = rotate("p1", A0B0, "B1", "receipt-1");
  const p1other = rotate("p1", A0B0, "B2", "receipt-1");

  it("retains both variants, links nothing through them and does not fall back to the predecessor", () => {
    const model = deriveContinuity([p1, p1other]);
    expect(model.conflicts()).toEqual([
      { kind: "competing-changes", side: "peer", context: [A0B0], changes: [{ change: { kind: "rotate", successor: "B1" }, facts: ["p1"] }, { change: { kind: "rotate", successor: "B2" }, facts: ["p1"] }] },
      { kind: "identity-conflict", id: "p1", variants: [p1, p1other] },
    ]);
    expect(model.status("p1")).toEqual({ status: "identity-conflict", variants: [p1, p1other] });
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1"] });
  });

  it("does not hide a collided forward change even when the variants agree on the successor", () => {
    const twin = { ...p1, receipt: "receipt-9" };
    const model = deriveContinuity([p1, twin]);
    expect(model.conflicts()).toEqual([{ kind: "identity-conflict", id: "p1", variants: [p1, twin] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1"] });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts: ["p1"] });
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A0B1, replaces: "peer", support: ["p1"], derived: false, usable: false }]);
  });

  it("lets independent unambiguous support for the same change remain usable", () => {
    const twin = { ...p1, receipt: "receipt-9" };
    const p2 = rotate("p2", A0B0, "B1", "receipt-2");
    const model = deriveContinuity([p1, twin, p2]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p2"] });
    expect(model.status("p2")).toEqual({ status: "usable", support: ["p2"] });
  });

  it("lets independent support for the same local rotation or ending establish the head, the collision kept as a diagnostic", () => {
    const d1 = decide("d1", A0B0, "A1");
    const twin = { ...d1, decision: "decision-other" };
    const o0 = observe("o0", A0B0);
    const independent = decide("independent", A0B0, "A1");
    const rotated = deriveContinuity([o0, d1, twin, independent]);
    expect(rotated.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["independent", "o0"] });
    expect(rotated.head(A1B0)).toEqual({ status: "head", channel: A1B0, support: [] });
    expect(rotated.path(A0B0, A1B0)).toEqual({ status: "path", channels: [A0B0, A1B0], support: ["independent", "o0"] });
    expect(rotated.status("d1")).toEqual({ status: "identity-conflict", variants: [d1, twin] });
    expect(rotated.status("independent")).toEqual({ status: "usable", support: ["independent", "o0"] });
    expect(rotated.history(A0B0).links).toEqual([{ from: A0B0, to: A1B0, replaces: "local", support: ["d1", "independent", "o0"], derived: false, usable: true }]);
    expect(deriveContinuity([o0, d1, twin, decide("independent", A0B0, "A2")]).head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "independent"] });
    sameWhateverTheOrder([o0, d1, twin, independent], [A0B0, A1B0]);
    for (const [end, variant] of [
      [localEnd("e1", A0B0), { ...localEnd("e1", A0B0), decision: "decision-other" }],
      [peerEnd("e1", A0B0), { ...peerEnd("e1", A0B0), receipt: "receipt-other" }],
    ] as const) {
      const alone = deriveContinuity([end, variant]);
      expect(alone.head(A0B0)).toEqual({ status: "conflict", facts: ["e1"] });
      const ended = deriveContinuity([end, variant, { ...end, id: "independent" }]);
      expect(ended.head(A0B0)).toEqual({ status: "ended", endings: ["independent"] });
      expect(ended.status("e1")).toEqual({ status: "identity-conflict", variants: [end, variant] });
      expect(ended.status("independent")).toEqual({ status: "usable", support: ["independent"] });
      const otherSide = end.kind === "local-decision" ? peerEnd("independent", A0B0) : localEnd("independent", A0B0);
      expect(deriveContinuity([end, variant, otherSide]).head(A0B0)).toEqual({ status: "conflict", facts: ["e1"] });
    }
  });

  it("scopes a fork by the claims made in its context, not by every variant of an ID involved", () => {
    const X0Y0 = C("X0", "Y0");
    const X0Y1 = C("X0", "Y1");
    const here = rotate("p", A0B0, "B1");
    const elsewhere = rotate("p", X0Y0, "Y1");
    const fork = rotate("fork", A0B0, "B2");
    const independent = rotate("independent", X0Y0, "Y1");
    const model = deriveContinuity([here, elsewhere, fork, independent]);
    expect(model.conflicts()).toEqual([
      { kind: "competing-changes", side: "peer", context: [A0B0], changes: [{ change: { kind: "rotate", successor: "B1" }, facts: ["p"] }, { change: { kind: "rotate", successor: "B2" }, facts: ["fork"] }] },
      { kind: "identity-conflict", id: "p", variants: [here, elsewhere] },
    ]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["fork", "p"] });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts: ["fork", "p"] });
    expect(model.head(X0Y0)).toEqual({ status: "head", channel: X0Y1, support: ["independent"] });
    expect(model.path(X0Y0, X0Y1)).toEqual({ status: "path", channels: [X0Y0, X0Y1], support: ["independent"] });
    expect(model.status("independent")).toEqual({ status: "usable", support: ["independent"] });
    expect(deriveContinuity([here, elsewhere, fork]).head(X0Y0)).toEqual({ status: "conflict", facts: ["p"] });
    sameWhateverTheOrder([here, elsewhere, fork, independent], [A0B0, A0B1, X0Y0, X0Y1]);
  });

  it("applies an ending at another pair only through usable opposite-side links, and reports an ambiguous scope instead of ending", () => {
    for (const side of ["local", "peer"] as const) {
      const link = side === "local" ? rotate("p", A0B0, "B1") : decide("d", A0B0, "A1");
      const linkTwin = link.kind === "peer-transition" ? { ...link, receipt: "receipt-other" } : { ...link, decision: "decision-other" };
      const there = side === "local" ? A0B1 : A1B0;
      const end = side === "local" ? localEnd : peerEnd;
      const e = end("e", there);
      const eTwin = e.kind === "peer-transition" ? { ...e, receipt: "receipt-other" } : { ...e, decision: "decision-other" };
      const facts = [...(side === "peer" ? [observe("o0", A0B0)] : []), link, linkTwin, observe("o1", there), e, eTwin, end("independent", A0B0)];
      const model = deriveContinuity(facts);
      expect(model.head(there)).toEqual({ status: "conflict", facts: ["e", "independent"] });
      expect(model.path(A0B0, there)).toEqual({ status: "none" });
      expect(model.status("independent")).toEqual({ status: "usable", support: ["independent"] });
      expect(model.history(there).endings.map((ending) => ending.id)).toEqual(["e", "e", "independent"]);
      expect(deriveContinuity(facts.filter((fact) => fact.id !== "e")).head(there)).toEqual({ status: "conflict", facts: ["independent"] });
      expect(deriveContinuity(facts.filter((fact) => fact.id !== link.id)).head(there)).toEqual({ status: "conflict", facts: ["e"] });
      const scoped = deriveContinuity([...facts, { ...link, id: "scope" }]);
      expect(scoped.head(there)).toEqual({ status: "ended", endings: ["independent"] });
      expect(scoped.path(A0B0, there).status).toBe("path");
      expect(deriveContinuity([...facts, end("direct", there)]).head(there)).toEqual({ status: "ended", endings: ["direct"] });
      const reversed = deriveContinuity([...facts].reverse());
      expect(view(reversed, [A0B0, there], facts.map((fact) => fact.id))).toEqual(view(model, [A0B0, there], facts.map((fact) => fact.id)));
    }
  });

  it("takes the same change made usably at another pair of the context as provenance for a collided or waiting claim", () => {
    for (const side of ["local", "peer"] as const) {
      const opposite = side === "local" ? rotate("opposite", A0B0, "B1") : decide("opposite", A0B0, "A1");
      const other = side === "local" ? A0B1 : A1B0;
      const collided = side === "local" ? decide("collided", A0B0, "A1") : rotate("collided", A0B0, "B1");
      const twin = collided.kind === "peer-transition" ? { ...collided, receipt: "receipt-other" } : { ...collided, decision: "decision-other" };
      const independent = side === "local" ? decide("independent", other, "A1") : rotate("independent", other, "B1");
      const o0 = observe("o0", A0B0);
      const o1 = observe("o1", other);
      const base = [o0, o1, opposite, independent];
      const model = deriveContinuity([...base, collided, twin]);
      const support = side === "local" ? ["independent", "o1", "opposite"] : ["independent", "o0", "opposite"];
      expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support });
      expect(model.head(A0B0)).toEqual(deriveContinuity(base).head(A0B0));
      expect(model.path(A0B0, A1B1)).toEqual({ status: "path", channels: [A0B0, other, A1B1], support });
      expect(model.conflicts()).toEqual([{ kind: "identity-conflict", id: "collided", variants: [collided, twin] }]);
      expect(model.status("independent")).toMatchObject({ status: "usable" });
      expect(model.head(side === "local" ? A1B0 : A0B1).status).toBe("conflict");
      const fork = { ...independent, at: A0B0, change: { kind: "rotate", successor: side === "local" ? "A2" : "B2" } } as const;
      expect(deriveContinuity([o0, o1, opposite, fork, collided, twin]).conflicts()).toMatchObject([{ kind: "competing-changes", side }, { kind: "identity-conflict" }]);
      expect(deriveContinuity([o0, o1, opposite, fork, collided, twin]).head(A0B0).status).toBe("conflict");
      expect(deriveContinuity([o0, o1, independent, collided, twin]).head(A0B0).status).toBe("conflict");
      sameWhateverTheOrder([...base, collided, twin], [A0B0, other, A1B1]);
    }
    const p = rotate("p", A0B0, "B1");
    const o = observe("o", A0B1);
    const independent = decide("independent", A0B1, "A1");
    const waiting = decide("d", A0B0, "A1", "missing");
    const covered = deriveContinuity([p, o, independent, waiting]);
    expect(covered.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["independent", "o", "p"] });
    expect(covered.status("d")).toEqual({ status: "unresolved", missing: ["missing"] });
    expect(deriveContinuity([p, o, waiting]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["d"], missing: ["missing"] });
  });

  it("answers for a saved onward rotation across the head's context, and reports one only diagnostic history scopes as an ambiguity", () => {
    const A2B1 = C("A2", "B1");
    const collided = decide("d", A0B0, "A1");
    const base = [rotate("p", A0B0, "B1"), observe("o", A0B1), decide("i", A0B1, "A1"), collided, { ...collided, decision: "decision-other" }];
    const head = { status: "head", channel: A1B1, support: ["i", "o", "p"] };
    expect(deriveContinuity(base).head(A0B0)).toEqual(head);
    const w = decide("w", A1B0, "A2", "missing");
    const model = deriveContinuity([...base, w]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["w"] });
    expect(model.status("w")).toEqual({ status: "unresolved", missing: ["missing"] });
    expect(model.localDecisions(A1B1).map((record) => record.id)).toEqual(["w"]);
    for (const onward of [decide("w", A1B0, "A2"), decide("w", A1B0, "A2", "source")]) {
      expect(deriveContinuity([...base, onward, { ...onward, decision: "decision-other" }]).head(A0B0)).toEqual({ status: "conflict", facts: ["w"] });
    }
    const ambiguousSource = [decide("w", A1B0, "A2", "source"), observe("source", A1B0), observe("source", A1B0, null, "receipt-other")];
    expect(deriveContinuity([...base, ...ambiguousSource]).head(A0B0)).toEqual({ status: "conflict", facts: ["w"] });
    const scope = rotate("scope", A1B0, "B1");
    expect(deriveContinuity([...base, w, scope]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["w"], missing: ["missing"] });
    expect(deriveContinuity([...base, ...ambiguousSource, scope]).head(A0B0)).toEqual({ status: "conflict", facts: ["source"] });
    expect(deriveContinuity([...base, { ...w, at: A1B1 }]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["w"], missing: ["missing"] });
    expect(deriveContinuity([...base, w, { ...collided, id: "entry" }]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["w"], missing: ["missing"] });
    expect(deriveContinuity([...base, w, observe("missing", A1B0)]).head(A0B0)).toEqual({ status: "conflict", facts: ["d", "missing", "o", "p", "w"] });
    const complete = deriveContinuity([...base, w, observe("missing", A1B0), scope]);
    expect(complete.head(A0B0)).toEqual({ status: "head", channel: A2B1, support: ["i", "missing", "o", "p", "scope", "w"] });
    expect(complete.path(A0B0, A2B1).status).toBe("path");
    expect(deriveContinuity([...base, w, observe("oh", A1B1), decide("x", A1B1, "A2", "oh")]).head(A0B0)).toEqual({ status: "head", channel: A2B1, support: ["i", "o", "oh", "p", "x"] });
    expect(deriveContinuity([...base, w, decide("other", A1B0, "A3", "another-missing")]).head(A0B0)).toEqual({ status: "conflict", facts: ["other", "w"] });
    expect(deriveContinuity([...base, localEnd("end", A1B0)]).head(A0B0)).toEqual({ status: "conflict", facts: ["end"] });
    sameWhateverTheOrder([...base, w], [A0B0, A1B0, A1B1]);
  });

  it("diagnoses a pending choice along its whole reference chain, so a collided carried transition outranks an ending", () => {
    const scope = rotate("scope", A0B0, "B1");
    const w = decide("w", A0B0, "A1", "s");
    const s = observe("s", A0B1, "t", "receipt-t");
    const t = rotate("t", A0B0, "B1", "receipt-t");
    const end = peerEnd("end", A0B1);
    const missing = deriveContinuity([scope, w, s]);
    expect(missing.head(A0B1)).toEqual({ status: "unresolved", waiting: ["w"], missing: ["t"] });
    expect(missing.head(A0B0)).toEqual({ status: "unresolved", waiting: ["w"], missing: ["t"] });
    expect(deriveContinuity([scope, w, s, end]).head(A0B1)).toEqual({ status: "ended", endings: ["end"] });
    const collided = deriveContinuity([scope, w, s, t, { ...t, receipt: "receipt-other" }]);
    expect(collided.head(A0B1)).toEqual({ status: "conflict", facts: ["t"] });
    expect(collided.head(A0B0)).toEqual({ status: "conflict", facts: ["t"] });
    expect(collided.status("w")).toEqual({ status: "conflict", facts: ["t"], because: expect.stringContaining("s") });
    expect(deriveContinuity([scope, w, s, t, { ...t, receipt: "receipt-other" }, end]).head(A0B1)).toEqual({ status: "conflict", facts: ["t"] });
    expect(deriveContinuity([scope, w, s, t]).head(A0B1)).toEqual({ status: "head", channel: A1B1, support: ["s", "scope", "t", "w"] });
    const covered = deriveContinuity([scope, w, s, t, { ...t, receipt: "receipt-other" }, observe("o", A0B1), decide("i", A0B1, "A1", "o")]);
    expect(covered.head(A0B1)).toEqual({ status: "head", channel: A1B1, support: ["i", "o"] });
    expect(deriveContinuity([scope, w, observe("s", A0B1, "t", "receipt-other"), t]).head(A0B1)).toEqual({ status: "unresolved", waiting: ["w"], missing: [] });
    sameWhateverTheOrder([scope, w, s, t, { ...t, receipt: "receipt-other" }], [A0B0, A0B1]);
  });

  it("cannot hide an alternative a variant creates", () => {
    const p2 = rotate("p2", A0B0, "B1", "receipt-2");
    const model = deriveContinuity([p1, p1other, p2]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.status("p2")).toMatchObject({ status: "conflict" });
  });

  it("does not hide a collided local decision behind its predecessor", () => {
    const d1 = decide("d1", A0B0, "A1");
    const twin = { ...d1, decision: "decision-other" };
    const o0 = observe("o0", A0B0);
    const confirmed = deriveContinuity([o0, d1, twin]);
    expect(confirmed.status("d1")).toEqual({ status: "identity-conflict", variants: [d1, twin] });
    expect(confirmed.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "o0"] });
    expect(confirmed.head(A1B0)).toEqual({ status: "conflict", facts: ["d1", "o0"] });
    expect(confirmed.history(A0B0).links).toEqual([{ from: A0B0, to: A1B0, replaces: "local", support: ["d1", "o0"], derived: false, usable: false }]);
    const waiting = deriveContinuity([d1, twin]);
    expect(waiting.head(A0B0)).toEqual({ status: "conflict", facts: ["d1"] });
    expect(waiting.head(A1B0)).toEqual({ status: "conflict", facts: ["d1"] });
    const forked = deriveContinuity([o0, d1, decide("d1", A0B0, "A2")]);
    expect(forked.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", changes: [{ facts: ["d1"] }, { facts: ["d1"] }] }, { kind: "identity-conflict", id: "d1" }]);
    expect(forked.head(A0B0)).toEqual({ status: "conflict", facts: ["d1"] });
    sameWhateverTheOrder([o0, d1, twin], [A0B0, A1B0]);
  });

  it("reports conflict for a reference to a collided identity instead of resolving it", () => {
    const twin = { ...p1, receipt: "receipt-9" };
    const o1 = observe("o1", A0B1, "p1", "receipt-1");
    const model = deriveContinuity([p1, twin, o1]);
    expect(model.status("o1")).toEqual({ status: "conflict", facts: ["p1"], because: expect.stringContaining("p1") });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: ["o1"] });
    const o0 = observe("o0", A0B0);
    const o0twin = observe("o0", A0B0, null, "receipt-other");
    const withDecision = deriveContinuity([o0, o0twin, decide("d1", A0B0, "A1", "o0")]);
    expect(withDecision.status("d1")).toEqual({ status: "conflict", facts: ["o0"], because: expect.stringContaining("o0") });
    expect(withDecision.head(A0B0)).toEqual({ status: "conflict", facts: ["o0"] });
  });

  it("survives arriving in either order or through a third replica", () => {
    const left = snapshot([p1]);
    const right = snapshot([p1other]);
    const expected = view(deriveContinuity(mergeFacts(left, right).facts), [A0B0, A0B1], ["p1"]);
    expect(view(deriveContinuity(mergeFacts(right, left).facts), [A0B0, A0B1], ["p1"])).toEqual(expected);
    const third = mergeFacts(mergeFacts(left, snapshot([])), mergeFacts(right, snapshot([])));
    expect(view(deriveContinuity(third.facts), [A0B0, A0B1], ["p1"])).toEqual(expected);
    expect(view(deriveContinuity(mergeFacts(third, left).facts), [A0B0, A0B1], ["p1"])).toEqual(expected);
  });
});

describe("convergence and monotonicity", () => {
  it("gives the same view to replicas that hold the same facts, and a converged conflict is a converged state", () => {
    const o0 = observe("o0", A0B0);
    const d1 = decide("d1", A0B0, "A1");
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A0B0, "B2");
    const replicaA = snapshot([o0, d1, p1]);
    const replicaB = snapshot([p2, o0]);
    const merged = mergeFacts(replicaA, replicaB);
    const channels = [A0B0, A0B1, A1B0, A1B1, C("A1", "B2")];
    const ids = ["o0", "d1", "p1", "p2"];
    expect(view(deriveContinuity(mergeFacts(replicaB, replicaA).facts), channels, ids)).toEqual(view(deriveContinuity(merged.facts), channels, ids));
    expect(deriveContinuity(replicaA.facts).head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(deriveContinuity(merged.facts).head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
  });

  it("answers over a long rotation history", () => {
    const length = 3000;
    const facts: ContinuityFact[] = [];
    for (let i = 0; i < length; i++) facts.push(rotate(`p${String(i).padStart(4, "0")}`, C("A0", `B${i}`), `B${i + 1}`));
    const model = deriveContinuity(facts);
    const last = C("A0", `B${length}`);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: last, support: facts.map((fact) => fact.id) });
    expect(model.path(A0B0, C("A0", "B1"))).toEqual({ status: "path", channels: [A0B0, C("A0", "B1")], support: ["p0000"] });
    const path = model.path(A0B0, last);
    expect(path.status === "path" && path.channels.length).toBe(length + 1);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("refuses a malformed fact without deriving anything", () => {
    expect(() => deriveContinuity([{ ...rotate("p1", A0B0, "B1"), extra: 1 } as unknown as ContinuityFact])).toThrow(InvalidFact);
  });

  it("answers unknown IDs and unknown pairs as such", () => {
    const model = deriveContinuity([]);
    expect(model.status("nope")).toEqual({ status: "unknown" });
    expect(model.head(A0B0)).toEqual({ status: "no-evidence" });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0)).toEqual({ links: [], endings: [], localContext: [A0B0], peerContext: [A0B0] });
  });
});
