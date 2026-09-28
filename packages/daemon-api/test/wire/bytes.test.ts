import { describe, expect, it } from "vitest";

import { base64Length, fromBase64, isByteWrapper, toBase64, wrapBytes } from "../../src/wire/index.js";

describe("base64 on the text path", () => {
  it("round-trips every length, padded", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 57, 58, 59, 1000]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) % 256);
      const text = toBase64(bytes);
      expect(text.length % 4).toBe(0);
      expect(base64Length(text)).toBe(length);
      expect([...fromBase64(text)]).toEqual([...bytes]);
    }
  });

  it("encodes as the standard alphabet says", () => {
    expect(toBase64(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("+/+/");
    expect(toBase64(new Uint8Array([0x00]))).toBe("AA==");
    expect(toBase64(new Uint8Array([0x00, 0x00]))).toBe("AAA=");
  });

  it("knows the decoded length of strict padded base64 before decoding it, and nothing else as base64", () => {
    expect(base64Length("")).toBe(0);
    expect(base64Length("AQID")).toBe(3);
    expect(base64Length("AQ==")).toBe(1);
    expect(base64Length("AQI=")).toBe(2);
    for (const text of ["AQI", "AQ=", "A===", "AQ==AQ==", " AQID", "AQID\n", "AQ-D", "AQ_D", "====", "AQID="]) expect(base64Length(text)).toBeNull();
  });

  it("recognizes the wrapper by its two members and nothing looser", () => {
    expect(isByteWrapper({ encoding: "base64", data: "AQID" })).toBe(true);
    expect(isByteWrapper(wrapBytes(new Uint8Array([1])))).toBe(true);
    expect(isByteWrapper({ encoding: "base64", data: "AQID", extra: 1 })).toBe(true);
    expect(isByteWrapper({ encoding: "hex", data: "00" })).toBe(false);
    expect(isByteWrapper({ encoding: "base64", data: 1 })).toBe(false);
    expect(isByteWrapper({ data: "AQID" })).toBe(false);
    expect(isByteWrapper(["base64", "AQID"])).toBe(false);
    expect(isByteWrapper(null)).toBe(false);
  });

  it("encodes a view of part of a buffer as that part only", () => {
    const view = new Uint8Array(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3);
    expect(toBase64(view)).toBe("AQID");
  });
});
