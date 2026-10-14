import { describe, expect, it } from "vitest";

import { API_VERSION, WIRE_VERSION, schemas, type Hello, type Incompatible, type Limits, type Welcome } from "../../src/contract/index.js";
import { MAX_BOOTSTRAP_BYTES, ownFrame, readBootstrap, readFrame, readPayload, writeBootstrap, writeFrame } from "../../src/wire/index.js";
import { openState } from "../contract/fixtures.js";
import { cbor, concat, hex } from "./ports.js";

const limits: Limits = { maxFrameBytes: 1_000_000, maxBackupBytes: 1000 };
const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };

/** A call of `lock` whose input is the data item `input` spells, the envelope written as a wire writer would. */
const callWith = (input: Uint8Array): Uint8Array => concat(hex("a4"), cbor("kind"), cbor("call"), cbor("id"), cbor(1), cbor("method"), cbor("lock"), cbor("input"), input);

const inputOf = (data: Uint8Array): unknown => {
  const frame = readFrame(data);
  if (frame?.kind !== "call") throw new Error("no call was read");
  return frame.input;
};

describe("the bootstrap exchange on a port", () => {
  it("writes each record as one CBOR data item and reads it back", () => {
    const written = writeBootstrap(hello);
    expect(written).toBeInstanceOf(Uint8Array);
    expect(readBootstrap(written)).toEqual(hello);
    const welcome: Welcome = { kind: "welcome", wire: WIRE_VERSION, api: API_VERSION, implementation: "test", limits };
    expect(readBootstrap(writeBootstrap(welcome))).toEqual(welcome);
    const incompatible: Incompatible = { kind: "incompatible", wire: WIRE_VERSION, supported: [API_VERSION], message: "update the view" };
    expect(readBootstrap(writeBootstrap(incompatible))).toEqual(incompatible);
  });

  it("reads nothing else as a bootstrap record: another wire version, a frame, no CBOR, or no bytes at all", () => {
    expect(readBootstrap(cbor({ kind: "hello", wire: 1, apis: [1] }))).toBeNull();
    expect(readBootstrap(cbor({ kind: "call", id: 1, method: "attach", input: {} }))).toBeNull();
    expect(readBootstrap(hex("ff"))).toBeNull();
    expect(readBootstrap(new Uint8Array(0))).toBeNull();
    expect(readBootstrap(hello)).toBeNull();
    expect(readBootstrap(JSON.stringify(hello))).toBeNull();
    expect(readBootstrap("a0")).toBeNull();
  });

  it("does not decode a bootstrap record over its small bound", () => {
    expect(readBootstrap(cbor({ ...hello, note: "x".repeat(MAX_BOOTSTRAP_BYTES) }))).toBeNull();
    expect(readBootstrap(cbor({ ...hello, note: "x".repeat(MAX_BOOTSTRAP_BYTES - 100) }))).toEqual(hello);
  });
});

describe("an application frame on a port", () => {
  const error = { code: "WrongPhase", message: "locked", effect: "none", messageId: null } as const;

  it("round-trips each kind as one CBOR data item in a buffer of its own, its payload unread", () => {
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
      const written = writeFrame(ownFrame(frame));
      expect(written).toBeInstanceOf(Uint8Array);
      expect(written.byteOffset).toBe(0);
      expect(written.byteLength).toBe(written.buffer.byteLength);
      expect(readFrame(written)).toEqual(frame);
    }
  });

  it("keeps every key of a payload, __proto__ among them, as a member of its own", () => {
    const value = JSON.parse('{"n":1.5,"s":"日本","list":[null,true,{"deep":{}}],"__proto__":{"own":1}}') as unknown;
    const raw = readFrame(writeFrame(ownFrame({ kind: "result", id: 7, value })));
    const payload = readPayload((raw as { value: unknown }).value, { bytesAt: [], maxBytes: 0 });
    expect(payload).toEqual({ ok: true, value });
    const read = (payload.ok ? payload.value : null) as object;
    expect(Object.hasOwn(read, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  });

  it("reads a number whatever width it was written in, and negative zero as zero", () => {
    expect(readPayload(inputOf(callWith(hex("a16161fb3ff8000000000000"))), { bytesAt: [], maxBytes: 0 })).toEqual({ ok: true, value: { a: 1.5 } });
    expect(readPayload(inputOf(callWith(hex("a16161fa3fc00000"))), { bytesAt: [], maxBytes: 0 })).toEqual({ ok: true, value: { a: 1.5 } });
    const zero = readPayload(inputOf(callWith(hex("a16161f98000"))), { bytesAt: [], maxBytes: 0 });
    expect(zero.ok && Object.is((zero.value as unknown as { a: number }).a, 0)).toBe(true);
  });

  it("reads no envelope from what is no single CBOR data item, without throwing", () => {
    const written = writeFrame(ownFrame({ kind: "call", id: 1, method: "lock", input: {} }));
    for (const bad of [
      "a0",
      '{"kind":"call","id":1,"method":"lock","input":{}}',
      { kind: "call", id: 1, method: "lock", input: {} },
      [...written],
      new Uint8Array(0),
      written.subarray(0, written.byteLength - 1),
      concat(written, hex("00")),
      concat(written, written),
      callWith(hex("a162c32800")),
      callWith(hex("a1616162c328")),
      callWith(hex("63eda080")),
    ])
      expect(readFrame(bad)).toBeNull();
  });

  it("reads no envelope from an item a writer of plain data would not make: a key twice, undefined, another simple value, an indefinite length, a longer encoding than needed", () => {
    for (const item of [
      "a2616101616102",
      "a2616101780161 02",
      "a16161f7",
      "a16161e0",
      "a16161f3",
      "a161619f01ff",
      "a161617f6161ff",
      "bf616101ff",
      "a161611801",
      "a161611a00000001",
      "a17801 6101",
      "a16161580101",
      "a1616159000101",
    ]) {
      const data = callWith(hex(item.replace(/ /g, "")));
      expect(readFrame(data), item).toBeNull();
    }
    expect(readFrame(concat(hex("a4"), cbor("kind"), cbor("call"), cbor("id"), hex("1801"), cbor("method"), cbor("lock"), cbor("input"), hex("a0")))).toBeNull();
  });

  it("is refused, not thrown, when it nests past what the decoder takes", () => {
    for (const nest of ["81", "a16161"]) {
      const deep = callWith(concat(hex(nest.repeat(100_000)), hex("00")));
      expect(() => readFrame(deep)).not.toThrow();
      expect(readFrame(deep)).toBeNull();
    }
  });

  it("leaves a tag, a map keyed by other than text, an integer past the safe range and a number that is not finite to the payload reading, which refuses each", () => {
    for (const item of ["c100", "c074323031332d30332d32315432303a30343a30305a", "c2420100", "a10101", "a18001", "1b0020000000000000", "3b0020000000000000", "f97e00", "f97c00", "f9fc00", "fb7ff8000000000000"]) {
      const input = inputOf(callWith(concat(hex("a16161"), hex(item))));
      expect(readPayload(input, { bytesAt: [], maxBytes: 0 }), item).toEqual({ ok: false, code: "InvalidArgument", message: expect.any(String) as string });
    }
    expect(readFrame(hex("c1a0"))).toBeNull();
    expect(readFrame(hex("a10101"))).toBeNull();
  });

  it("reads no envelope from no record, an unknown kind, or a member missing or of the wrong type", () => {
    for (const bad of [
      [],
      null,
      "call",
      { kind: "bootstrap", value: 1 },
      { kind: "call", id: 0, method: "attach", input: {} },
      { kind: "call", id: 1.5, method: "attach", input: {} },
      { kind: "call", id: "1", method: "attach", input: {} },
      { kind: "call", id: 2 ** 53, method: "attach", input: {} },
      { kind: "call", id: 1, method: 5, input: {} },
      { kind: "call", id: 1, method: "attach" },
      { kind: "result", id: 1 },
      { kind: "error", id: 1 },
      { kind: "event", name: "changed", value: 1 },
      { kind: "event", name: "toString", value: 1 },
      { kind: "event", value: 1 },
      { kind: "fault" },
    ])
      expect(readFrame(cbor(bad))).toBeNull();
  });

  it("reads a call whose input is not a record as an envelope, for the method's schema to refuse", () => {
    const read = readPayload(inputOf(cbor({ kind: "call", id: 1, method: "unlock", input: [1] })), { bytesAt: [], maxBytes: 0 });
    expect(read).toEqual({ ok: true, value: [1] });
    expect(schemas.methods.unlock.input.safeParse(read.ok && read.value).success).toBe(false);
  });

  it("keeps the members the envelope does not know on the frame it reads, and writes none of them", () => {
    const frame = readFrame(cbor({ kind: "call", id: 1, method: "lock", input: {}, extra: 1 }));
    expect(frame).toEqual({ kind: "call", id: 1, method: "lock", input: {}, extra: 1 });
    expect(readFrame(writeFrame(ownFrame(frame!)))).toEqual({ kind: "call", id: 1, method: "lock", input: {} });
  });

  it("throws on a frame of the writer's own that is not wire data, rather than writing something else", () => {
    expect(() => ownFrame({ kind: "result", id: 1, value: { n: NaN } })).toThrow(/not wire data/);
    expect(() => ownFrame({ kind: "event", name: "log", value: { epoch: "e", line: "l", at: new Date(0) } })).toThrow(/not wire data/);
    expect(() => ownFrame({ kind: "result", id: 1, value: { bytes: new Uint8Array(1) } })).toThrow(/not wire data/);
    expect(() => ownFrame({ kind: "result", id: 1, value: { text: "\ud800" } })).toThrow(/well-formed/);
  });
});

describe("bytes crossing a port", () => {
  const bytes = new Uint8Array(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3);
  const slots = schemas.methods.exportBackup.bytes.result;

  it("go as a CBOR byte string and read back as an array of their own, which the frame's buffer no longer touches", () => {
    const written = writeFrame(ownFrame({ kind: "result", id: 1, value: { name: "ada.estoc", bytes } }, slots));
    expect(written).toEqual(cbor({ kind: "result", id: 1, value: { name: "ada.estoc", bytes: new Uint8Array([1, 2, 3]) } }));
    const raw = readFrame(written) as { value: unknown };
    const read = readPayload(raw.value, { bytesAt: slots, maxBytes: 3 });
    expect(read.ok && read.value).toEqual({ name: "ada.estoc", bytes: new Uint8Array([1, 2, 3]) });
    const held = (read.ok ? read.value : null) as unknown as { bytes: Uint8Array };
    expect(held.bytes.buffer).not.toBe(written.buffer);
    written.fill(0);
    expect([...held.bytes]).toEqual([1, 2, 3]);
  });

  it("are wire data only at the members named; a record shaped like the old base64 wrapper is the record it is", () => {
    const elsewhere = inputOf(cbor({ kind: "call", id: 1, method: "send", input: { content: { body: new Uint8Array(3) } } }));
    expect(readPayload(elsewhere, { bytesAt: ["backup"], maxBytes: 3 })).toEqual({ ok: false, code: "InvalidArgument", message: expect.stringMatching(/not wire data here/) as string });
    const wrapper = { encoding: "base64", data: "AQID" };
    const read = readPayload(inputOf(cbor({ kind: "call", id: 1, method: "mergeBackup", input: { backup: wrapper } })), { bytesAt: ["backup"], maxBytes: 3 });
    expect(read.ok && read.value).toEqual({ backup: wrapper });
    expect(schemas.methods.mergeBackup.input.safeParse(read.ok && read.value).success).toBe(false);
  });

  it("refuse a backup over the byte bound before the rest is read", () => {
    const over = inputOf(cbor({ kind: "call", id: 1, method: "mergeBackup", input: { backup: new Uint8Array(4), extra: NaN } }));
    expect(readPayload(over, { bytesAt: ["backup"], maxBytes: 3 })).toEqual({ ok: false, code: "ResourceLimit", message: expect.stringMatching(/4 bytes, over 3/) as string });
    expect(readPayload({ backup: new Uint8Array(3) }, { bytesAt: ["backup"], maxBytes: 3 }).ok).toBe(true);
  });

  it("leave a getter at a byte member for the reading to refuse, unrun", () => {
    let ran = 0;
    const input = {
      get backup() {
        ran++;
        return new Uint8Array(1);
      },
    };
    expect(readPayload(input, { bytesAt: ["backup"], maxBytes: 10 })).toEqual({ ok: false, code: "InvalidArgument", message: expect.stringMatching(/accessor/) as string });
    expect(ran).toBe(0);
  });
});
