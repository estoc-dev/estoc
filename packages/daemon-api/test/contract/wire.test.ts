import { describe, expect, it } from "vitest";

import { API_VERSION, CLIENT_ERROR_CODES, DAEMON_ERROR_CODES, EVENT_NAMES, WIRE_VERSION, schemas } from "../../src/contract/index.js";
import { linesState, openState } from "./fixtures.js";

const { hello, welcome, incompatible, bootstrap, frame, apiError, events } = schemas;

const limits = { maxFrameBytes: 1_000_000, maxBackupBytes: 500_000, maxValueBytes: 600_000, maxDepth: 64 };

describe("the bootstrap exchange", () => {
  it("reads a hello, a welcome and an incompatible", () => {
    expect(hello.parse({ kind: "hello", wire: 1, apis: [1] })).toEqual({ kind: "hello", wire: 1, apis: [1] });
    const welcomed = { kind: "welcome", wire: 1, api: 1, implementation: "estoc-daemon 0.4.0", limits };
    expect(welcome.parse(welcomed)).toEqual(welcomed);
    const refused = { kind: "incompatible", wire: 1, supported: [1], message: "update estoc-daemon" };
    expect(incompatible.parse(refused)).toEqual(refused);
    expect(bootstrap.parse(refused)).toEqual(refused);
  });

  it("speaks wire version 1 only", () => {
    expect(WIRE_VERSION).toBe(1);
    expect(API_VERSION).toBe(1);
    expect(hello.safeParse({ kind: "hello", wire: 2, apis: [1] }).success).toBe(false);
    expect(hello.safeParse({ kind: "hello", wire: "1", apis: [1] }).success).toBe(false);
  });

  it("lists API versions as positive integers", () => {
    expect(hello.safeParse({ kind: "hello", wire: 1, apis: [0] }).success).toBe(false);
    expect(hello.safeParse({ kind: "hello", wire: 1, apis: [1.5] }).success).toBe(false);
    expect(hello.safeParse({ kind: "hello", wire: 1, apis: [] }).success).toBe(true);
  });

  it("lets a structured-clone port advertise no frame limit and requires the other bounds", () => {
    expect(welcome.safeParse({ kind: "welcome", wire: 1, api: 1, implementation: "", limits: { ...limits, maxFrameBytes: null } }).success).toBe(true);
    expect(welcome.safeParse({ kind: "welcome", wire: 1, api: 1, implementation: "", limits: { ...limits, maxBackupBytes: null } }).success).toBe(false);
    expect(welcome.safeParse({ kind: "welcome", wire: 1, api: 1, implementation: "", limits: { ...limits, maxDepth: 0 } }).success).toBe(false);
  });

  it("does not take an application frame for a bootstrap record", () => {
    expect(bootstrap.safeParse({ kind: "call", id: 1, method: "attach", input: {} }).success).toBe(false);
  });
});

describe("an application frame", () => {
  const error = { code: "WrongPhase", message: "the vault is locked", effect: "none", messageId: null };

  it("reads each kind", () => {
    expect(frame.parse({ kind: "call", id: 1, method: "attach", input: {} })).toEqual({ kind: "call", id: 1, method: "attach", input: {} });
    expect(frame.parse({ kind: "result", id: 1, value: null })).toEqual({ kind: "result", id: 1, value: null });
    expect(frame.parse({ kind: "error", id: 1, error })).toEqual({ kind: "error", id: 1, error });
    expect(frame.parse({ kind: "event", name: "log", value: { epoch: "e", line: "hello" } })).toEqual({ kind: "event", name: "log", value: { epoch: "e", line: "hello" } });
    expect(frame.parse({ kind: "fault", error })).toEqual({ kind: "fault", error });
  });

  it("carries bytes in a value, for the schema of the method to place", () => {
    const bytes = new Uint8Array([1, 2]);
    const parsed = frame.parse({ kind: "result", id: 2, value: { name: "ada.estoc", bytes } });
    expect(parsed.kind === "result" && parsed.value).toEqual({ name: "ada.estoc", bytes });
  });

  it.each([0, -1, 1.5, 2 ** 53, "1"])("rejects the call ID %s", (id) => {
    expect(frame.safeParse({ kind: "call", id, method: "attach", input: {} }).success).toBe(false);
  });

  it("requires a call's input to be a record and its method to be named", () => {
    expect(frame.safeParse({ kind: "call", id: 1, method: "attach", input: [] }).success).toBe(false);
    expect(frame.safeParse({ kind: "call", id: 1, method: "attach", input: null }).success).toBe(false);
    expect(frame.safeParse({ kind: "call", id: 1, method: "", input: {} }).success).toBe(false);
    expect(frame.safeParse({ kind: "call", id: 1, method: "attach", args: [] }).success).toBe(false);
  });

  it("names events from a closed list", () => {
    expect(EVENT_NAMES).toEqual(["state", "lines", "log"]);
    expect(frame.safeParse({ kind: "event", name: "changed", value: {} }).success).toBe(false);
    expect(frame.safeParse({ kind: "bootstrap", value: {} }).success).toBe(false);
  });

  it("rejects a non-finite number anywhere in a value", () => {
    expect(frame.safeParse({ kind: "result", id: 1, value: { n: NaN } }).success).toBe(false);
    expect(frame.safeParse({ kind: "call", id: 1, method: "m", input: { n: [Infinity] } }).success).toBe(false);
  });

  it("has a schema for each event's value", () => {
    expect(events.state.parse(openState)).toEqual(openState);
    expect(events.lines.parse(linesState)).toEqual(linesState);
    expect(events.log.parse({ epoch: "epoch-1", line: "x" })).toEqual({ epoch: "epoch-1", line: "x" });
    expect(events.lines.safeParse(openState).success).toBe(false);
  });
});

describe("an API error", () => {
  it("states a code, a message, an effect and a message ID or null", () => {
    expect(apiError.parse({ code: "OperationFailed", message: "boom", effect: "possible", messageId: "m-1" })).toEqual({ code: "OperationFailed", message: "boom", effect: "possible", messageId: "m-1" });
  });

  it("keeps the vocabulary open: a code it does not know still reads", () => {
    expect(apiError.safeParse({ code: "SomethingNewer", message: "", effect: "possible", messageId: null }).success).toBe(true);
    expect(apiError.safeParse({ code: "", message: "", effect: "possible", messageId: null }).success).toBe(false);
  });

  it("knows only two effects", () => {
    expect(apiError.safeParse({ code: "OperationFailed", message: "", effect: "unknown", messageId: null }).success).toBe(false);
    expect(apiError.safeParse({ code: "OperationFailed", message: "", messageId: null }).success).toBe(false);
  });

  it("does not carry an origin: that is the SDK's to assign", () => {
    const parsed = apiError.parse({ code: "WrongPhase", message: "", effect: "none", messageId: null, origin: "daemon" });
    expect("origin" in parsed).toBe(false);
  });

  it("lists the baseline daemon codes and the client codes without overlap in meaning", () => {
    expect(DAEMON_ERROR_CODES).toHaveLength(13);
    expect(CLIENT_ERROR_CODES).toHaveLength(7);
    expect(new Set(DAEMON_ERROR_CODES).size).toBe(DAEMON_ERROR_CODES.length);
    expect(new Set(CLIENT_ERROR_CODES).size).toBe(CLIENT_ERROR_CODES.length);
  });
});
