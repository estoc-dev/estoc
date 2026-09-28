import { describe, expect, it } from "vitest";

import { API_VERSION, WIRE_VERSION, schemas, type CallId, type Hello, type Limits, type Welcome } from "../../src/contract/index.js";
import { MAX_BOOTSTRAP_BYTES, readBootstrap, readFrame, readPayload, requestBudget, toBase64, VALUE_CHARGE, writeBootstrap, writeFrame, type Transport } from "../../src/wire/index.js";
import { openState } from "../contract/fixtures.js";

const limits: Limits = { maxFrameBytes: 1_000_000, maxBackupBytes: 1000, maxValueBytes: 5000, maxDepth: 8 };
const transports: Transport[] = ["text", "clone"];

describe("the bootstrap exchange on a port", () => {
  it.each(transports)("reads and writes each record on a %s port", (transport) => {
    const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };
    const written = writeBootstrap(hello, transport);
    expect(typeof written).toBe(transport === "text" ? "string" : "object");
    expect(readBootstrap(written, transport)).toEqual(hello);
    const welcome: Welcome = { kind: "welcome", wire: WIRE_VERSION, api: API_VERSION, implementation: "test", limits };
    expect(readBootstrap(writeBootstrap(welcome, transport), transport)).toEqual(welcome);
  });

  it("reads nothing else as a bootstrap record", () => {
    expect(readBootstrap('{"kind":"hello","wire":2,"apis":[1]}', "text")).toBeNull();
    expect(readBootstrap('{"kind":"call","id":1,"method":"attach","input":{}}', "text")).toBeNull();
    expect(readBootstrap("not json", "text")).toBeNull();
    expect(readBootstrap(new Uint8Array(2), "text")).toBeNull();
    expect(readBootstrap({ kind: "hello", wire: 1, apis: [1] }, "text")).toBeNull();
    expect(readBootstrap({ kind: "hello", wire: 1, apis: [1] }, "clone")).toEqual({ kind: "hello", wire: 1, apis: [1] });
    expect(readBootstrap('{"kind":"hello","wire":1,"apis":[1]}', "clone")).toBeNull();
  });

  it("does not read a text bootstrap record over its small bound", () => {
    const padded = JSON.stringify({ kind: "hello", wire: 1, apis: [1], note: "x".repeat(MAX_BOOTSTRAP_BYTES) });
    expect(readBootstrap(padded, "text")).toBeNull();
    const fitting = JSON.stringify({ kind: "hello", wire: 1, apis: [1], note: "x".repeat(MAX_BOOTSTRAP_BYTES - 100) });
    expect(readBootstrap(fitting, "text")).toEqual({ kind: "hello", wire: 1, apis: [1] });
  });
});

describe("an application frame on a port", () => {
  const error = { code: "WrongPhase", message: "locked", effect: "none", messageId: null } as const;

  it.each(transports)("round-trips each kind through a %s port with its payload unread", (transport) => {
    const frames = [
      { kind: "call", id: 1, method: "send", input: { target: { contactId: "c" }, content: { type: "t", body: { text: "hi", "$odd": [1] } } } },
      { kind: "result", id: 1, value: null },
      { kind: "result", id: 2, value: { level: "normal" } },
      { kind: "error", id: 3, error },
      { kind: "event", name: "state", value: openState },
      { kind: "event", name: "log", value: { epoch: "e", line: "l" } },
      { kind: "fault", error },
    ] as const;
    for (const frame of frames) {
      const written = writeFrame(frame, transport);
      expect(typeof written).toBe(transport === "text" ? "string" : "object");
      expect(readFrame(written, transport)).toEqual(frame);
    }
  });

  it.each(transports)("reads the same logical frame from either transport", (transport) => {
    const frame = { kind: "result", id: 7, value: JSON.parse('{"n":1.5,"s":"日本","list":[null,true,{"deep":{}}],"__proto__":{"own":1}}') as unknown } as const;
    const raw = readFrame(writeFrame(frame, transport), transport);
    expect(raw).toEqual(frame);
    const payload = readPayload((raw as { value: unknown }).value, transport, { bytesAt: [], maxBytes: 0 });
    expect(payload).toEqual({ ok: true, value: frame.value, size: expect.any(Number) as number });
  });

  it("reads no envelope from bad JSON, no record, an unknown kind, or a member of the wrong type", () => {
    expect(readFrame("{", "text")).toBeNull();
    expect(readFrame("[]", "text")).toBeNull();
    expect(readFrame("null", "text")).toBeNull();
    expect(readFrame(new Uint8Array(1), "text")).toBeNull();
    expect(readFrame({ kind: "call", id: 1, method: "attach", input: {} }, "text")).toBeNull();
    for (const bad of [
      { kind: "bootstrap", value: 1 },
      { kind: "call", id: 0, method: "attach", input: {} },
      { kind: "call", id: 1.5, method: "attach", input: {} },
      { kind: "call", id: "1", method: "attach", input: {} },
      { kind: "call", id: 1, method: 5, input: {} },
      { kind: "call", id: 1, method: "attach" },
      { kind: "result", id: 1 },
      { kind: "error", id: 1 },
      { kind: "event", name: "changed", value: 1 },
      { kind: "event", name: "toString", value: 1 },
      { kind: "event", value: 1 },
      { kind: "fault" },
      Object.assign(Object.create({ kind: "call", id: 1, method: "attach", input: {} }) as object, {}),
    ])
      expect(readFrame(bad, "clone")).toBeNull();
  });

  it("reads a call whose input is not a record as an envelope, for the payload reading to refuse", () => {
    const raw = readFrame({ kind: "call", id: 1, method: "unlock", input: [1] }, "clone");
    expect(raw?.kind).toBe("call");
    expect(schemas.methods.unlock.input.safeParse(readPayload([1], "clone", { bytesAt: [], maxBytes: 0 })).success).toBe(false);
  });

  it("throws on a frame of the writer's own that is not wire data, rather than writing something else", () => {
    expect(() => writeFrame({ kind: "result", id: 1, value: { n: NaN } }, "text")).toThrow(/not wire data/);
    expect(() => writeFrame({ kind: "event", name: "log", value: { epoch: "e", line: "l", at: new Date(0) } }, "clone")).toThrow(/not wire data/);
    expect(() => writeFrame({ kind: "result", id: 1, value: { bytes: new Uint8Array(1) } }, "text")).toThrow(/not wire data/);
  });
});

describe("bytes crossing a port", () => {
  const bytes = new Uint8Array(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3);
  const slots = schemas.methods.exportBackup.bytes.result;

  it("go as a byte array on a structured-clone port, and as base64 on a text port, and read back the same", () => {
    const frame = { kind: "result", id: 1, value: { name: "ada.estoc", bytes } } as const;
    const cloned = writeFrame(frame, "clone", slots) as { value: { bytes: Uint8Array } };
    expect(cloned.value.bytes).toBeInstanceOf(Uint8Array);
    expect([...cloned.value.bytes]).toEqual([1, 2, 3]);
    expect(cloned.value.bytes.buffer.byteLength).toBe(3);
    const text = writeFrame(frame, "text", slots) as string;
    expect(JSON.parse(text)).toEqual({ kind: "result", id: 1, value: { name: "ada.estoc", bytes: { encoding: "base64", data: "AQID" } } });
    for (const transport of transports) {
      const raw = readFrame(transport === "text" ? text : cloned, transport) as { value: unknown };
      const read = readPayload(raw.value, transport, { bytesAt: slots, maxBytes: 3 });
      expect(read.ok && [...(read.value as { bytes: Uint8Array }).bytes]).toEqual([1, 2, 3]);
      expect(read.ok && read.size).toBe(VALUE_CHARGE + (VALUE_CHARGE + 4) + (VALUE_CHARGE + 9) + (VALUE_CHARGE + 5) + VALUE_CHARGE + 3);
    }
  });

  it("read the wrapper only at the members named; elsewhere it is the record it looks like", () => {
    const body = { encoding: "base64", data: "AQID" };
    const read = readPayload({ content: { body } }, "text", { bytesAt: ["backup"], maxBytes: 3 });
    expect(read.ok && read.value).toEqual({ content: { body } });
    const untouched = readPayload({ backup: { encoding: "base64", data: "AQID" } }, "clone", { bytesAt: ["backup"], maxBytes: 3 });
    expect(untouched.ok && untouched.value).toEqual({ backup: { encoding: "base64", data: "AQID" } });
    expect(schemas.methods.mergeBackup.input.safeParse(untouched.ok && untouched.value).success).toBe(false);
  });

  it("refuse a backup over the byte bound before decoding it, on either transport", () => {
    const text = readPayload({ backup: { encoding: "base64", data: "AQIDBA==" } }, "text", { bytesAt: ["backup"], maxBytes: 3 });
    expect(text).toEqual({ ok: false, code: "ResourceLimit", message: expect.stringMatching(/4 bytes, over 3/) as string });
    const clone = readPayload({ backup: new Uint8Array(4) }, "clone", { bytesAt: ["backup"], maxBytes: 3 });
    expect(clone).toEqual({ ok: false, code: "ResourceLimit", message: expect.stringMatching(/4 bytes, over 3/) as string });
    expect(readPayload({ backup: new Uint8Array(3) }, "clone", { bytesAt: ["backup"], maxBytes: 3 }).ok).toBe(true);
  });

  it("refuse base64 that is not strict and padded, unused bits of a padded chunk that are set among it", () => {
    for (const data of ["AQI", "AQ ID", "AQID\n", "AQ=", "A===", "AB==", "AAB="]) {
      const read = readPayload({ backup: { encoding: "base64", data } }, "text", { bytesAt: ["backup"], maxBytes: 100 });
      expect(read).toEqual({ ok: false, code: "InvalidArgument", message: expect.stringMatching(/base64/) as string });
    }
  });

  it("charge the decoded bytes against the budget, not the base64 text", () => {
    const budget = { maxValueBytes: VALUE_CHARGE + (VALUE_CHARGE + 6) + VALUE_CHARGE + 300, maxDepth: 8 };
    const data = toBase64(new Uint8Array(300));
    expect(readPayload({ backup: { encoding: "base64", data } }, "text", { bytesAt: ["backup"], maxBytes: 300, budget }).ok).toBe(true);
    const over = readPayload({ backup: { encoding: "base64", data: toBase64(new Uint8Array(301)) } }, "text", { bytesAt: ["backup"], maxBytes: 301, budget });
    expect(over).toEqual({ ok: false, code: "ResourceLimit", message: expect.any(String) as string });
  });

  it("leave a getter at a byte member for the reading to refuse, unrun", () => {
    let ran = 0;
    const input = {
      get backup() {
        ran++;
        return new Uint8Array(1);
      },
    };
    expect(readPayload(input, "clone", { bytesAt: ["backup"], maxBytes: 10 })).toEqual({ ok: false, code: "InvalidArgument", message: expect.stringMatching(/accessor/) as string });
    expect(ran).toBe(0);
  });
});

describe("a request's budget", () => {
  const call = (id: number, method: string, rest: Record<string, unknown> = {}) => ({ ...rest, kind: "call" as const, id: id as CallId, method, input: {} });

  it("charges the call's envelope against the frame bound and its input at depth 2", () => {
    const budget = requestBudget(limits, call(12, "unlock"));
    const envelope = VALUE_CHARGE + (VALUE_CHARGE + 4) + (VALUE_CHARGE + 4) + (VALUE_CHARGE + 2) + VALUE_CHARGE + (VALUE_CHARGE + 6) + (VALUE_CHARGE + 6) + (VALUE_CHARGE + 5);
    expect(budget).toEqual({ ok: true, value: { maxValueBytes: limits.maxValueBytes - envelope, maxDepth: limits.maxDepth - 1 }, size: envelope + VALUE_CHARGE });
  });

  it("charges the members of the frame the envelope does not know, and refuses the frame at the bound", () => {
    const plain = requestBudget(limits, call(1, "lock"));
    const extra = requestBudget(limits, call(1, "lock", { extra: "x".repeat(100) }));
    expect(plain.ok && extra.ok && plain.value.maxValueBytes - extra.value.maxValueBytes).toBe(VALUE_CHARGE + 5 + VALUE_CHARGE + 100);
    const over = requestBudget(limits, call(1, "lock", { extra: "x".repeat(limits.maxValueBytes) }));
    expect(over).toEqual({ ok: false, code: "ResourceLimit", message: expect.any(String) as string });
    let deep: unknown = "x";
    for (let i = 0; i < limits.maxDepth; i++) deep = [deep];
    expect(requestBudget(limits, call(1, "lock", { deep }))).toEqual({ ok: false, code: "ResourceLimit", message: expect.stringMatching(/deeper/) as string });
    expect(requestBudget(limits, call(1, "lock", { when: new Date(0) }))).toEqual({ ok: false, code: "InvalidArgument", message: expect.any(String) as string });
  });

  it("keeps the members the envelope does not know on the frame it reads, for the bound to see", () => {
    const frame = readFrame({ kind: "call", id: 1, method: "lock", input: {}, extra: 1 }, "clone");
    expect(frame).toEqual({ kind: "call", id: 1, method: "lock", input: {}, extra: 1 });
    expect(writeFrame(frame!, "clone")).toEqual({ kind: "call", id: 1, method: "lock", input: {} });
  });

  it("refuses the frame when the envelope alone is over the bound, and leaves the input exactly the rest", () => {
    const envelope = requestBudget(limits, call(1, "x"));
    const size = envelope.ok ? envelope.size : 0;
    expect(requestBudget({ ...limits, maxValueBytes: size - 1 }, call(1, "x"))).toEqual({ ok: false, code: "ResourceLimit", message: expect.any(String) as string });
    const exact = requestBudget({ ...limits, maxValueBytes: size }, call(1, "x"));
    expect(exact.ok && exact.value.maxValueBytes).toBe(VALUE_CHARGE);
    const budget = exact.ok ? exact.value : { maxValueBytes: 0, maxDepth: 0 };
    expect(readPayload({}, "clone", { bytesAt: [], maxBytes: 0, budget }).ok).toBe(true);
    expect(readPayload({ a: 1 }, "clone", { bytesAt: [], maxBytes: 0, budget })).toEqual({ ok: false, code: "ResourceLimit", message: expect.any(String) as string });
  });
});
