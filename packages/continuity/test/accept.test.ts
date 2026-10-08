import { describe, expect, it } from "vitest";

import { deriveContinuity, InvalidFact, validateFact, type Continuity, type ContinuityFact } from "../src/index.js";
import { C, decide, keyOf, localEnd, observe, peerEnd, permutations, rotate } from "./facts.js";

const A0B0 = C("A0", "B0");
const A0B1 = C("A0", "B1");

const p1 = rotate("p1", A0B0, "B1");
const o1 = observe("p1", A0B1, true);
const o0 = observe("o0", A0B0);
const d1 = decide("d1", A0B0, "A1", "o0");

describe("accepting facts", () => {
  it("gives the same answers whatever the order and repetition of the facts", () => {
    const facts = [p1, o1, o0, d1];
    const channels = [A0B0, A0B1, C("A1", "B0"), C("A1", "B1")];
    const answers = (model: Continuity) => ({
      facts: model.facts,
      conflicts: model.conflicts(),
      heads: channels.map((channel) => model.head(channel)),
      statuses: facts.map((fact) => model.status(keyOf(fact))),
    });
    const expected = answers(deriveContinuity(facts));
    for (const order of permutations(facts)) {
      expect(answers(deriveContinuity(order))).toEqual(expected);
      expect(answers(deriveContinuity([...order, ...order.slice(1), order[0]!]))).toEqual(expected);
    }
  });

  it("keeps an exact repeat once, whatever the order of its members", () => {
    const reordered = { evidence: "p1", change: { successor: "B1", kind: "rotate" }, at: { peerDid: "B0", localDid: "A0" }, kind: "peer-transition" } as unknown as ContinuityFact;
    expect(deriveContinuity([p1, { ...p1 }, reordered]).facts).toEqual([p1]);
  });

  it("keeps strings exact: another spelling is another fact, or another value", () => {
    expect(deriveContinuity([p1, { ...p1, evidence: "P1" }]).facts).toHaveLength(2);
    expect(() => deriveContinuity([p1, rotate("p1", A0B0, "b1")])).toThrow(InvalidFact);
  });

  it("refuses a second value under one key, since one receipt or one saved decision says one thing", () => {
    const pairs: [ContinuityFact, ContinuityFact][] = [
      [p1, rotate("p1", A0B0, "B2")],
      [p1, rotate("p1", C("A0", "B5"), "B1")],
      [p1, peerEnd("p1", A0B0)],
      [d1, decide("d1", A0B0, "A1")],
      [d1, localEnd("d1", A0B0)],
      [o1, observe("p1", A0B1)],
    ];
    for (const [fact, other] of pairs) {
      expect(() => deriveContinuity([fact, other]), JSON.stringify(other)).toThrow(/already has another value/);
      expect(() => deriveContinuity([other, fact]), JSON.stringify(other)).toThrow(InvalidFact);
    }
  });

  it("lists the facts by evidence, then by kind, in UTF-8 byte order", () => {
    const facts = ["z", "\u{1F600}", "！", "a"].map((evidence) => observe(evidence, A0B0));
    // U+FF01 is one UTF-16 unit above the surrogate range but encodes below U+1F600 in UTF-8
    expect(deriveContinuity(facts).facts.map((fact) => fact.evidence)).toEqual(["a", "z", "！", "\u{1F600}"]);
    const oneEvidence = [rotate("r", A0B0, "B1"), decide("r", A0B0, "A1"), observe("r", A0B1, true)];
    expect(deriveContinuity(oneEvidence).facts.map((fact) => fact.kind)).toEqual(["address-observed", "local-decision", "peer-transition"]);
  });
});

describe("validating a fact", () => {
  it("refuses a malformed fact wherever it sits", () => {
    const cases: unknown[] = [
      { ...p1, extra: true },
      { ...p1, evidence: "" },
      { ...p1, at: { localDid: "A0", peerDid: "A0" } },
      { ...p1, change: { kind: "rotate", successor: "B0" } },
      { ...p1, change: { kind: "rotate", successor: "A0" } },
      { ...p1, change: { kind: "end", successor: "B1" } },
      { ...d1, source: undefined },
      { ...localEnd("e1", A0B0), source: "o0" },
      { ...o1, carried: 1 },
      { ...o1, carried: null },
      { ...o1, evidence: "\uD800" },
      { kind: "channel", evidence: "x" },
      "p1",
      null,
    ];
    for (const value of cases) {
      expect(() => deriveContinuity([p1, value as ContinuityFact]), JSON.stringify(value)).toThrow(InvalidFact);
      expect(() => deriveContinuity([value as ContinuityFact, p1]), JSON.stringify(value)).toThrow(InvalidFact);
    }
  });

  it("requires explicit nulls", () => {
    const missingNull = { kind: "local-decision", at: A0B0, change: { kind: "rotate", successor: "A1" }, evidence: "x" };
    expect(() => validateFact(missingNull)).toThrow(InvalidFact);
  });

  it("reads only its own members, not ones a prototype supplies", () => {
    expect(() => validateFact(Object.create(p1))).toThrow(InvalidFact);
  });

  it("reads each member once: an accessor cannot answer differently later", () => {
    let reads = 0;
    const tricky = Object.defineProperty({ ...p1 }, "evidence", {
      enumerable: true,
      get: () => (reads++ === 0 ? "first" : "second"),
    }) as ContinuityFact;
    expect(validateFact(tricky).evidence).toBe("first");
    reads = 0;
    expect(deriveContinuity([tricky]).facts).toEqual([{ ...p1, evidence: "first" }]);
  });
});
