import { describe, expect, it } from "vitest";

import { PHASES, schemas } from "../../src/contract/index.js";
import { openState, snapshot, withPath } from "./fixtures.js";

const { state, stateValue, revisionMarker } = schemas;

describe("a state value", () => {
  it("accepts the open phase with its hold and snapshot", () => {
    expect(state.parse(openState)).toEqual(openState);
  });

  it.each(["booting", "unreadable"] as const)("lets %s hold a file or none", (phase) => {
    expect(stateValue.parse({ phase, hold: null, detail: "taking the files" }).hold).toBeNull();
    expect(stateValue.parse({ phase, hold: "hold-1", detail: null }).hold).toBe("hold-1");
  });

  it.each(["elsewhere", "onboarding", "foreign"] as const)("refuses a hold under %s", (phase) => {
    expect(stateValue.parse({ phase, hold: null, detail: null }).phase).toBe(phase);
    expect(stateValue.safeParse({ phase, hold: "hold-1", detail: null }).success).toBe(false);
  });

  it.each(["damaged", "locked"] as const)("requires a hold under %s", (phase) => {
    expect(stateValue.parse({ phase, hold: "hold-1", detail: "the history stops reading whole" }).hold).toBe("hold-1");
    expect(stateValue.safeParse({ phase, hold: null, detail: null }).success).toBe(false);
  });

  it("requires open to carry a snapshot and a hold", () => {
    expect(stateValue.safeParse({ phase: "open", hold: "hold-1", detail: null }).success).toBe(false);
    expect(stateValue.safeParse({ phase: "open", hold: null, snapshot }).success).toBe(false);
  });

  it("carries no snapshot outside open, whatever was sent", () => {
    const parsed = stateValue.parse({ phase: "locked", hold: "hold-1", detail: null, snapshot });
    expect("snapshot" in parsed).toBe(false);
  });

  it("rejects a phase it does not know", () => {
    expect(stateValue.safeParse({ phase: "unreachable", hold: null, detail: null }).success).toBe(false);
  });

  it("names every phase once", () => {
    expect(new Set(PHASES).size).toBe(8);
  });
});

describe("a revision", () => {
  it.each([0, -1, 1.5, 2 ** 53, NaN])("rejects %s", (revision) => {
    expect(revisionMarker.safeParse({ epoch: "epoch-1", revision }).success).toBe(false);
    expect(state.safeParse(withPath(openState, ["revision"], revision)).success).toBe(false);
  });

  it("accepts the largest safe integer", () => {
    expect(revisionMarker.parse({ epoch: "epoch-1", revision: Number.MAX_SAFE_INTEGER }).revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("requires a non-empty epoch", () => {
    expect(revisionMarker.safeParse({ epoch: "", revision: 1 }).success).toBe(false);
  });
});
