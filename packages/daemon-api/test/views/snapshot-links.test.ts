import { describe, expect, it } from "vitest";

import { schemas, type SnapshotLink } from "../../src/contract/index.js";
import { parseSnapshotLink, snapshotLinkUrl } from "../../src/views/index.js";
import { utf8ToBase64url } from "../../src/views/base64url.js";

const link: SnapshotLink = { url: "https://mediator.example/b/7f3a?x=1", hash: "bciqexamplehash", key: "A".repeat(42) + "w" };

describe("a snapshot link", () => {
  it("rides a URL's fragment as base64url in `snapshot`, leaving the URL's query alone, and is read back from the URL or the parameter alone", () => {
    const text = snapshotLinkUrl("https://estoc.example/app/?y=2", link);
    const url = new URL(text);
    const param = new URLSearchParams(url.hash.slice(1)).get("snapshot")!;
    expect(url.origin + url.pathname + url.search).toBe("https://estoc.example/app/?y=2");
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseSnapshotLink(text)).toEqual(link);
    expect(parseSnapshotLink(`  ${param}\n`)).toEqual(link);
    expect(schemas.snapshotLink.parse(parseSnapshotLink(text))).toEqual(link);
  });

  it("keeps only what a link carries", () => {
    expect(parseSnapshotLink(utf8ToBase64url(JSON.stringify({ ...link, passphrase: "nope" })))).toEqual(link);
  });

  it("refuses what is no snapshot link, with the reason", () => {
    const encoded = (value: unknown) => utf8ToBase64url(JSON.stringify(value));
    expect(() => parseSnapshotLink(" ")).toThrow("nothing to read");
    expect(() => parseSnapshotLink("https://estoc.example/app/?_oob=abc")).toThrow("carries no snapshot link");
    expect(() => parseSnapshotLink("https://estoc.example/#snapshot=not*base64url")).toThrow("does not decode");
    expect(() => parseSnapshotLink(utf8ToBase64url("not json"))).toThrow("does not decode");
    expect(() => parseSnapshotLink(encoded({ ...link, url: "file:///etc/passwd" }))).toThrow("url expected an HTTP URL");
    expect(() => parseSnapshotLink(encoded({ ...link, key: "short" }))).toThrow("key expected 32 bytes");
    expect(() => parseSnapshotLink(encoded({ ...link, hash: "" }))).toThrow("malformed");
    expect(() => parseSnapshotLink(encoded([link]))).toThrow("malformed");
  });
});
