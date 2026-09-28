import { describe, expect, it } from "vitest";

import { schemas } from "../../src/contract/index.js";

const { displayTime, isDisplayTime } = schemas;

describe("a display time", () => {
  it.each(["2026-09-28T10:00:00.000Z", "2024-02-29T23:59:59.999Z", "1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "0000-02-29T00:00:00.000Z", "0001-01-01T00:00:00.000Z", "0099-12-31T23:59:59.999Z", "0100-01-01T00:00:00.000Z"])("accepts %s", (text) => {
    expect(displayTime.parse(text)).toBe(text);
  });

  it.each([
    ["a day the month does not have", "2026-02-30T10:00:00.000Z"],
    ["a leap day in a common year", "2023-02-29T10:00:00.000Z"],
    ["a leap day in year 1", "0001-02-29T00:00:00.000Z"],
    ["a leap day in year 100", "0100-02-29T00:00:00.000Z"],
    ["an expanded year", "+002026-09-28T10:00:00.000Z"],
    ["a negative year", "-000001-01-01T00:00:00.000Z"],
    ["a 60th second", "2026-09-28T10:00:60.000Z"],
    ["a 13th month", "2026-13-01T10:00:00.000Z"],
    ["a 24th hour", "2026-09-28T24:00:00.000Z"],
    ["two fractional digits", "2026-09-28T10:00:00.00Z"],
    ["no fractional digits", "2026-09-28T10:00:00Z"],
    ["an offset instead of Z", "2026-09-28T10:00:00.000+00:00"],
    ["no zone", "2026-09-28T10:00:00.000"],
    ["a lower-case separator", "2026-09-28t10:00:00.000Z"],
    ["a space separator", "2026-09-28 10:00:00.000Z"],
    ["a two-digit year", "26-09-28T10:00:00.000Z"],
    ["surrounding whitespace", " 2026-09-28T10:00:00.000Z"],
    ["an empty string", ""],
  ])("rejects %s", (_, text) => {
    expect(isDisplayTime(text)).toBe(false);
    expect(displayTime.safeParse(text).success).toBe(false);
  });

  it("orders instants by literal comparison", () => {
    const earlier = displayTime.parse("2026-09-28T09:59:59.999Z");
    const later = displayTime.parse("2026-09-28T10:00:00.000Z");
    expect(earlier < later).toBe(true);
  });
});
