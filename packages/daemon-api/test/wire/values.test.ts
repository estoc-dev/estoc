import { describe, expect, it } from "vitest";

import { exactBytes, readValue } from "../../src/wire/index.js";

const read = (value: unknown, options?: Parameters<typeof readValue>[1]): { value: unknown } => {
  const reading = readValue(value, options);
  if (!reading.ok) throw new Error(`${reading.code}: ${reading.message}`);
  return reading;
};

const refused = (value: unknown, options?: Parameters<typeof readValue>[1]) => {
  const reading = readValue(value, options);
  if (reading.ok) throw new Error("read");
  return reading;
};

describe("a value read as wire data", () => {
  it("is copied as a plain tree with every own key, __proto__ among them", () => {
    const source = JSON.parse('{"__proto__":{"kept":true},"constructor":"ordinary","list":[1,"two",null,{"deep":[[]]}]}');
    const { value } = read(source);
    expect(value).toEqual(source);
    expect(value).not.toBe(source);
    expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getPrototypeOf((value as { list: unknown[] }).list[3])).toBe(Object.prototype);
  });

  it("reads a record with no prototype as a record", () => {
    const source = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(read(source).value).toEqual({ a: 1 });
  });

  it("reads negative zero as zero and refuses a number that is not finite", () => {
    expect(Object.is(read(-0).value, 0)).toBe(true);
    expect(Object.is((read({ n: -0 }).value as { n: number }).n, 0)).toBe(true);
    expect(Object.is(read(JSON.parse("-0")).value, 0)).toBe(true);
    for (const n of [NaN, Infinity, -Infinity]) expect(refused([n]).code).toBe("InvalidArgument");
  });

  it("refuses a string or a key holding a lone surrogate, which no UTF-8 spells, and keeps a pair and the replacement character", () => {
    for (const value of ["\ud800", "a\udc00", "\ude00\ud83d", { "\ud83d": 1 }, { ok: "\ufffd", ["\udfff"]: 1 }, ["fine", "\ud83dx"]]) {
      expect(refused(value)).toEqual({ ok: false, code: "InvalidArgument", message: expect.stringMatching(/well-formed/) as string });
    }
    expect(read({ "😀": "😀", "\ufffd": "\ufffd" }).value).toEqual({ "😀": "😀", "\ufffd": "\ufffd" });
  });

  it("leaves out a record member that is undefined and refuses an undefined element or root", () => {
    expect(read({ a: 1, b: undefined }).value).toEqual({ a: 1 });
    expect("b" in (read({ a: 1, b: undefined }).value as object)).toBe(false);
    expect(refused([1, undefined]).code).toBe("InvalidArgument");
    expect(refused(undefined).code).toBe("InvalidArgument");
    // eslint-disable-next-line no-sparse-arrays
    expect(refused([1, , 3]).code).toBe("InvalidArgument");
  });

  it("refuses what is not wire data: functions, symbols, bigint, dates, maps, sets, class instances, getters and cycles", () => {
    class Thing {}
    for (const value of [() => 1, Symbol("s"), 1n, new Date(0), new Map(), new Set(), new Thing(), Promise.resolve()]) expect(refused({ value }).code).toBe("InvalidArgument");
    const withGetter = {
      get late() {
        return 1;
      },
    };
    expect(refused(withGetter).code).toBe("InvalidArgument");
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(refused(loop).message).toMatch(/contains itself/);
    const ring: unknown[] = [];
    ring.push({ ring });
    expect(refused(ring).message).toMatch(/contains itself/);
  });

  it("reads an array by its own elements alone: an accessor is refused unrun, an inherited index is a hole, a subclass is no array", () => {
    let ran = 0;
    const withGetter: unknown[] = [];
    Object.defineProperty(withGetter, "0", {
      enumerable: true,
      get() {
        ran++;
        return "value";
      },
    });
    expect(refused(withGetter).message).toMatch(/accessor/);
    const throwing: unknown[] = [];
    Object.defineProperty(throwing, "0", {
      enumerable: true,
      get() {
        throw new Error("never run");
      },
    });
    expect(refused(throwing).message).toMatch(/accessor/);
    expect(ran).toBe(0);
    const inherited: unknown[] = [];
    inherited.length = 1;
    (Array.prototype as unknown as Record<number, unknown>)[0] = "filled in";
    try {
      expect(refused(inherited).message).toMatch(/hole/);
    } finally {
      delete (Array.prototype as unknown as Record<number, unknown>)[0];
    }
    class Tuple extends Array<number> {}
    expect(refused(Tuple.of(1, 2)).message).toMatch(/class/);
    expect(read([1, "two", [3]]).value).toEqual([1, "two", [3]]);
  });

  it("reads a shared reference at each occurrence", () => {
    const shared = { x: "shared" };
    expect(read([shared, shared]).value).toEqual([shared, shared]);
  });

  it("ignores symbol-keyed and non-enumerable members, as JSON does", () => {
    const source: Record<string | symbol, unknown> = { kept: 1, [Symbol("hidden")]: 2 };
    Object.defineProperty(source, "quiet", { value: 3, enumerable: false });
    expect(read(source).value).toEqual({ kept: 1 });
  });
});

describe("bytes in a value", () => {
  it("are read only at the members named, and copied to the selected view", () => {
    const buffer = new Uint8Array([9, 1, 2, 3, 9]).buffer;
    const view = new Uint8Array(buffer, 1, 3);
    const { value } = read({ backup: view }, { bytesAt: ["backup"] });
    const backup = (value as { backup: Uint8Array }).backup;
    expect([...backup]).toEqual([1, 2, 3]);
    expect(backup.buffer).not.toBe(buffer);
    expect(backup.buffer.byteLength).toBe(3);
    expect(refused({ other: view }, { bytesAt: ["backup"] }).message).toMatch(/not wire data here/);
    expect(refused({ backup: { nested: view } }, { bytesAt: ["backup"] }).code).toBe("InvalidArgument");
    expect(refused({ backup: [view] }, { bytesAt: ["backup"] }).code).toBe("InvalidArgument");
    expect(refused(view).code).toBe("InvalidArgument");
  });

  it("keeps a plain array that is the whole of its buffer as it is", () => {
    const whole = new Uint8Array([1, 2, 3]);
    expect(exactBytes(whole)).toBe(whole);
    const partial = whole.subarray(1);
    expect(exactBytes(partial)).not.toBe(partial);
    expect([...exactBytes(partial)]).toEqual([2, 3]);
    class Tagged extends Uint8Array {}
    const tagged = new Tagged([4, 5]);
    expect(exactBytes(tagged)).not.toBe(tagged);
    expect(exactBytes(tagged).constructor).toBe(Uint8Array);
  });
});
