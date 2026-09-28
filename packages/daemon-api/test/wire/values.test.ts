import { describe, expect, it } from "vitest";

import { exactBytes, readValue, utf8Length, VALUE_CHARGE } from "../../src/wire/index.js";

const read = (value: unknown, options?: Parameters<typeof readValue>[1]) => {
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

  it("reads a shared reference at each occurrence and charges it each time", () => {
    const shared = { x: "shared" };
    const { value, size } = read([shared, shared]);
    expect(value).toEqual([shared, shared]);
    expect(size).toBe(VALUE_CHARGE + 2 * (VALUE_CHARGE + (VALUE_CHARGE + 1) + VALUE_CHARGE + 6));
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

  it("are one value of their length, not an array of numbers", () => {
    const { size } = read({ backup: new Uint8Array(100) }, { bytesAt: ["backup"] });
    expect(size).toBe(VALUE_CHARGE + (VALUE_CHARGE + 6) + VALUE_CHARGE + 100);
  });
});

describe("the logical size", () => {
  it("charges 8 per value, a string's UTF-8 length, and 8 plus the UTF-8 length per key", () => {
    expect(read(null).size).toBe(8);
    expect(read(true).size).toBe(8);
    expect(read(12345).size).toBe(8);
    expect(read("").size).toBe(8);
    expect(read("héllo").size).toBe(8 + 6);
    expect(read("日本").size).toBe(8 + 6);
    expect(read("😀").size).toBe(8 + 4);
    expect(read([]).size).toBe(8);
    expect(read([1, 2]).size).toBe(8 + 8 + 8);
    expect(read({}).size).toBe(8);
    expect(read({ ab: "c" }).size).toBe(8 + (8 + 2) + (8 + 1));
    expect(read({ 日: [{}] }).size).toBe(8 + (8 + 3) + 8 + 8);
  });

  it("measures UTF-8 as the encoder would, a lone surrogate as three bytes", () => {
    expect(utf8Length("plain")).toBe(5);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("𝄞")).toBe(4);
    expect(utf8Length("\ud83d")).toBe(3);
    expect(utf8Length("\ud83dx")).toBe(4);
    expect(utf8Length("a€𝄞\ud83d")).toBe(1 + 3 + 4 + 3);
    expect(utf8Length("混合 mixed 😀")).toBe(6 + 1 + 5 + 1 + 4);
  });

  it("stops at the budget without reading the rest", () => {
    const budget = { maxValueBytes: 100, maxDepth: 64 };
    expect(read({ small: "x" }, { budget }).size).toBeLessThanOrEqual(100);
    const reading = refused({ text: "y".repeat(1000) }, { budget });
    expect(reading.code).toBe("ResourceLimit");
    let visited = 0;
    const counting = Array.from(
      { length: 1000 },
      () =>
        new Proxy(
          { n: 1 },
          {
            ownKeys(target) {
              visited++;
              return Reflect.ownKeys(target);
            },
          },
        ),
    );
    expect(refused(counting, { budget }).code).toBe("ResourceLimit");
    expect(visited).toBeLessThan(20);
    const many = Array.from({ length: 1000 }, () => 1);
    expect(refused(many, { budget }).code).toBe("ResourceLimit");
  });

  it("counts a long string by its shorter UTF-16 length first, so that a huge one is never scanned", () => {
    const budget = { maxValueBytes: 64, maxDepth: 64 };
    const huge = "z".repeat(1 << 24);
    const start = Date.now();
    expect(refused(huge, { budget }).code).toBe("ResourceLimit");
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("the depth", () => {
  it("has the root at depth 1 and every nesting one deeper, leaves included", () => {
    const budget = { maxValueBytes: 10_000, maxDepth: 3 };
    expect(read({ a: { b: 1 } }, { budget }).value).toEqual({ a: { b: 1 } });
    expect(refused({ a: { b: { c: 1 } } }, { budget }).code).toBe("ResourceLimit");
    expect(read({ a: { b: [] } }, { budget }).value).toEqual({ a: { b: [] } });
    expect(refused({ a: { b: [1] } }, { budget }).message).toMatch(/deeper than 3/);
    expect(refused([[[1]]], { budget }).code).toBe("ResourceLimit");
    expect(read([[1]], { budget }).value).toEqual([[1]]);
  });

  it("bounds a nest whose byte charge is small", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 100; i++) nested = [nested];
    expect(refused(nested, { budget: { maxValueBytes: 1_000_000, maxDepth: 64 } }).code).toBe("ResourceLimit");
    expect(read(nested, { budget: { maxValueBytes: 1_000_000, maxDepth: 101 } }).size).toBe(101 * 8);
  });
});
