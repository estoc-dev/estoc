import { describe, expect, it } from "vitest";

import { frozen, remembered } from "../src/remembered.js";

class Refused extends Error {}

function counted(limit?: number) {
  const worked: string[] = [];
  const compute = (input: string): string[] => {
    worked.push(input);
    if (input.startsWith("!")) throw new Refused(input);
    if (input.startsWith("?")) throw new Error(input);
    return [input];
  };
  return { worked, of: remembered(compute, (error) => error instanceof Refused, limit) };
}

describe("a remembered function", () => {
  it("works one input out once and hands every caller the same result", () => {
    const { worked, of } = counted();
    const first = of("a");
    expect(first).toEqual(["a"]);
    expect(of("a")).toBe(first);
    expect(of("b")).toEqual(["b"]);
    expect(worked).toEqual(["a", "b"]);
  });

  it("keeps a refusal of the input and throws the same one again, and works out anew what failed for another reason", () => {
    const { worked, of } = counted();
    const refusal = (input: string): unknown => {
      try {
        of(input);
      } catch (error) {
        return error;
      }
      throw new Error(`${input} was not refused`);
    };
    const first = refusal("!a");
    expect(first).toBeInstanceOf(Refused);
    expect(refusal("!a")).toBe(first);
    expect(refusal("?b")).not.toBe(refusal("?b"));
    expect(worked).toEqual(["!a", "?b", "?b"]);
  });

  it("forgets the input kept longest once it holds its limit, results and refusals alike, and works a forgotten one out to an equal result", () => {
    const { worked, of } = counted(2);
    const first = of("a");
    expect(() => of("!b")).toThrow(Refused);
    of("c");
    expect(worked).toEqual(["a", "!b", "c"]);

    expect(() => of("!b")).toThrow(Refused);
    of("c");
    expect(worked).toEqual(["a", "!b", "c"]);

    const again = of("a");
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
    expect(worked).toEqual(["a", "!b", "c", "a"]);
    expect(() => of("!b")).toThrow(Refused);
    expect(worked).toEqual(["a", "!b", "c", "a", "!b"]);
  });
});

describe("frozen", () => {
  it("freezes every object and array of a value, and hands values that are neither back as they are", () => {
    const value = frozen({ list: [{ deep: { deeper: [1] } }], text: "a", nothing: null });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.list[0]!.deep.deeper)).toBe(true);
    expect(() => value.list.push({ deep: { deeper: [] } })).toThrow(TypeError);
    expect(frozen("text")).toBe("text");
    expect(frozen(null)).toBe(null);
  });

  it("freezes a value nested deeper than the call stack allows", () => {
    const depth = 20_000;
    const value = JSON.parse(`{"extra":${"[".repeat(depth)}0${"]".repeat(depth)}}`) as { extra: unknown };
    expect(frozen(value)).toBe(value);
    let frozenLevels = 0;
    for (let level: unknown = value.extra; Object.isFrozen(level) && Array.isArray(level); level = level[0]) frozenLevels += 1;
    expect(Object.isFrozen(value)).toBe(true);
    expect(frozenLevels).toBe(depth);
  });
});
