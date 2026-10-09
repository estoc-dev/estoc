import { describe, expect, it } from "vitest";

import { deriveContinuity, factIdentity, InvalidFact, validateFact, type Continuity, type ContinuityFact } from "../src/index.js";
import { C, decide, localEnd, observe, peerEnd, permutations, rotated } from "./facts.js";

const A0B0 = C("A0", "B0");
const A0B1 = C("A0", "B1");

const p1 = rotated(A0B1, "B0");
const o0 = observe(A0B0);
const d1 = decide(A0B0, "A1");

describe("accepting facts", () => {
  it("gives the same answers whatever the order and repetition of the facts", () => {
    const facts = [p1, o0, d1, peerEnd(C("A9", "B0"))];
    const channels = [A0B0, A0B1, C("A1", "B0"), C("A1", "B1")];
    const answers = (model: Continuity) => ({
      facts: model.facts,
      conflicts: model.conflicts(),
      heads: channels.map((channel) => model.head(channel)),
      statuses: facts.map((fact) => model.status(fact)),
    });
    const expected = answers(deriveContinuity(facts));
    for (const order of permutations(facts)) {
      expect(answers(deriveContinuity(order))).toEqual(expected);
      expect(answers(deriveContinuity([...order, ...order.slice(1), order[0]!]))).toEqual(expected);
    }
  });

  it("keeps facts that say the same thing once, whatever the order of their members", () => {
    const reordered = { rotatedFrom: "B0", at: { peerDid: "B1", localDid: "A0" }, kind: "address-observed" } as unknown as ContinuityFact;
    expect(deriveContinuity([p1, { ...p1 }, reordered]).facts).toEqual([p1]);
    expect(deriveContinuity([d1, decide(A0B0, "A1"), o0, observe(A0B0)]).facts).toHaveLength(2);
  });

  it("keeps strings exact: another spelling is another fact", () => {
    expect(deriveContinuity([p1, rotated(A0B1, "b0")]).facts).toHaveLength(2);
    expect(deriveContinuity([o0, observe(C("A0", "b0"))]).facts).toHaveLength(2);
  });

  it("keeps an observation that carried a rotation beside one that carried none, and one per predecessor, at the same pair", () => {
    const model = deriveContinuity([observe(A0B1), observe(A0B1), p1, rotated(A0B1, "B0"), rotated(A0B1, "B9")]);
    expect(model.facts).toHaveLength(3);
    expect(model.conflicts()).toEqual([]);
  });

  it("lists the facts in the UTF-8 byte order of their identities", () => {
    const facts = ["z", "\u{1F600}", "！", "a"].map((peerDid) => observe(C("A0", peerDid)));
    // U+FF01 is one UTF-16 unit above the surrogate range but encodes below U+1F600 in UTF-8
    expect(deriveContinuity(facts).facts.map((fact) => fact.at.peerDid)).toEqual(["a", "z", "！", "\u{1F600}"]);
    // at one pair the identities part at the first member after `at`: `change` before `kind`
    const atOnePair = [peerEnd(A0B0), o0, d1];
    expect(deriveContinuity(atOnePair).facts.map((fact) => fact.kind)).toEqual(["local-decision", "address-observed", "peer-ended"]);
  });
});

describe("the identity of a fact", () => {
  it("is the one the model keys by: member order is not part of it, every string is", () => {
    const reordered = { change: { successor: "A1", kind: "rotate" }, kind: "local-decision", at: { peerDid: "B0", localDid: "A0" } } as unknown as ContinuityFact;
    expect(factIdentity(reordered)).toBe(factIdentity(d1));
    expect(factIdentity(decide(A0B0, "a1"))).not.toBe(factIdentity(d1));
    const model = deriveContinuity([d1, o0]);
    expect(model.status(reordered)).toEqual(model.status(d1));
    expect(model.status(observe(C("A0", "b0")))).toEqual({ status: "unknown" });
  });

  it("is refused for a value the profile refuses, and so is the status of one", () => {
    const malformed = { ...o0, extra: true } as unknown as ContinuityFact;
    expect(() => factIdentity(malformed)).toThrow(InvalidFact);
    expect(() => deriveContinuity([o0]).status(malformed)).toThrow(InvalidFact);
  });
});

describe("validating a fact", () => {
  it("refuses a malformed fact wherever it sits", () => {
    const cases: unknown[] = [
      { ...p1, extra: true },
      { ...p1, rotatedFrom: "" },
      { ...p1, rotatedFrom: undefined },
      { ...p1, rotatedFrom: 1 },
      { ...p1, rotatedFrom: "\uD800" },
      { ...p1, at: { localDid: "A0", peerDid: "A0" } },
      rotated(A0B1, "B1"),
      rotated(A0B1, "A0"),
      decide(A0B0, "A0"),
      decide(A0B0, "B0"),
      { ...d1, change: { kind: "end", successor: "A1" } },
      { ...d1, change: { kind: "rotate" } },
      { ...peerEnd(A0B0), change: { kind: "end" } },
      { ...localEnd(A0B0), rotatedFrom: null },
      { kind: "peer-transition", at: A0B0, change: { kind: "rotate", successor: "B1" } },
      "p1",
      null,
    ];
    for (const value of cases) {
      expect(() => deriveContinuity([p1, value as ContinuityFact]), JSON.stringify(value)).toThrow(InvalidFact);
      expect(() => deriveContinuity([value as ContinuityFact, p1]), JSON.stringify(value)).toThrow(InvalidFact);
    }
  });

  it("requires explicit nulls", () => {
    expect(() => validateFact({ kind: "address-observed", at: A0B0 })).toThrow(InvalidFact);
  });

  it("reads only its own members, not ones a prototype supplies", () => {
    expect(() => validateFact(Object.create(p1))).toThrow(InvalidFact);
  });

  it("reads each member once: an accessor cannot answer differently later", () => {
    let reads = 0;
    const tricky = Object.defineProperty({ ...p1 }, "rotatedFrom", {
      enumerable: true,
      get: () => (reads++ === 0 ? "B5" : "B6"),
    }) as ContinuityFact;
    expect(validateFact(tricky)).toEqual(rotated(A0B1, "B5"));
    reads = 0;
    expect(deriveContinuity([tricky]).facts).toEqual([rotated(A0B1, "B5")]);
  });
});
