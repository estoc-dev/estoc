import { describe, expect, it } from "vitest";

import { didWebFromUrl, webDidUrl } from "../src/index.js";

const urlOf = (did: string, insecureLoopback = false): string => {
  const derived = webDidUrl(did, insecureLoopback);
  return "url" in derived ? derived.url.href : `refused: ${derived.refused}`;
};

const refusalOf = (did: string, insecureLoopback = false): string => {
  const derived = webDidUrl(did, insecureLoopback);
  return "refused" in derived ? derived.refused : `url: ${derived.url.href}`;
};

describe("webDidUrl", () => {
  it("names a host's well-known document, and a path's own", () => {
    expect(urlOf("did:web:bob.example")).toBe("https://bob.example/.well-known/did.json");
    expect(urlOf("did:web:bob.example:user:alice")).toBe("https://bob.example/user/alice/did.json");
    expect(urlOf("did:web:bob.example%3A8443:dids")).toBe("https://bob.example:8443/dids/did.json");
    expect(urlOf("did:web:Bob.Example")).toBe("https://bob.example/.well-known/did.json");
    expect(urlOf("did:web:bob.example:%7Ealice")).toBe("https://bob.example/~alice/did.json");
  });

  it("refuses what DID syntax does not make a did:web", () => {
    for (const did of ["did:web:", "did:web:%ZZ", "did:web:bob.example:", "did:web:bob example", "did:web:bob.example#key", "did:web:bob.example/x", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", "web:bob.example"]) {
      expect(refusalOf(did), did).toBe("not a did:web");
    }
    expect(refusalOf("did:web:%C3")).toContain("percent-encoded UTF-8");
  });

  it("refuses an authority with more than a host and a port, and a path that would move", () => {
    expect(refusalOf("did:web:alice%40bob.example")).toContain("nothing else");
    expect(refusalOf("did:web:bob.example%2Fadmin")).toContain("nothing else");
    expect(refusalOf("did:web::x")).toContain("nothing else");
    expect(refusalOf("did:web:bob.example:..:secret")).toContain("path segment");
    expect(refusalOf("did:web:bob.example::x")).toContain("path segment");
    expect(refusalOf("did:web:bob.example:a%2Fb")).toContain("path segment");
    expect(refusalOf("did:web:bob.example:did.json%3Fx")).toContain("path segment");
    expect(refusalOf("did:web:bob.example%3Ax")).toContain("not a host");
  });

  it("refuses an IP literal, a reserved name or a loopback host", () => {
    expect(refusalOf("did:web:10.0.0.1")).toBe("an IP-literal authority");
    expect(refusalOf("did:web:169.254.169.254")).toBe("an IP-literal authority");
    expect(refusalOf("did:web:127.0.0.2")).toBe("an IP-literal authority");
    expect(refusalOf("did:web:%5B2001%3Adb8%3A%3A1%5D")).toBe("an IP-literal authority");
    expect(refusalOf("did:web:localhost%3A8080")).toBe("a loopback authority");
    expect(refusalOf("did:web:localhost.")).toBe("a loopback authority");
    expect(refusalOf("did:web:127.0.0.1")).toBe("a loopback authority");
    expect(refusalOf("did:web:0x7f000001")).toBe("a loopback authority");
    for (const did of ["did:web:printer.local", "did:web:printer.local.", "did:web:vault.internal", "did:web:app.localhost", "did:web:router.home.arpa", "did:web:1.0.0.10.in-addr.arpa"]) {
      expect(refusalOf(did), did).toContain("a reserved name");
    }
  });

  it("allows plain http to localhost or 127.0.0.1 only when asked, and an IP literal not even then", () => {
    expect(urlOf("did:web:localhost%3A8787", true)).toBe("http://localhost:8787/.well-known/did.json");
    expect(urlOf("did:web:127.0.0.1%3A8787:dids", true)).toBe("http://127.0.0.1:8787/dids/did.json");
    expect(refusalOf("did:web:%5B%3A%3A1%5D%3A8787", true)).toBe("an IP-literal authority");
    expect(refusalOf("did:web:10.0.0.1", true)).toBe("an IP-literal authority");
    expect(urlOf("did:web:bob.example", true)).toBe("https://bob.example/.well-known/did.json");
  });

  it("keeps a loopback port as the DID writes it, 443 on plain http included", () => {
    expect(urlOf("did:web:localhost", true)).toBe("http://localhost/.well-known/did.json");
    expect(urlOf("did:web:localhost%3A80", true)).toBe("http://localhost/.well-known/did.json");
    expect(urlOf("did:web:localhost%3A443", true)).toBe("http://localhost:443/.well-known/did.json");
    expect(urlOf("did:web:127.0.0.1%3A443:a", true)).toBe("http://127.0.0.1:443/a/did.json");
  });
});

describe("didWebFromUrl", () => {
  it("names the host, a percent-encoded port and one segment per path element", () => {
    expect(didWebFromUrl("https://mediator.example.com")).toBe("did:web:mediator.example.com");
    expect(didWebFromUrl("https://mediator.example.com:8443/didcomm/v2/")).toBe("did:web:mediator.example.com%3A8443:didcomm:v2");
    expect(didWebFromUrl(new URL("https://bob.example/~alice/a%20b"))).toBe("did:web:bob.example:%7Ealice:a%20b");
    expect(didWebFromUrl("http://localhost:8787")).toBe("did:web:localhost%3A8787");
    expect(didWebFromUrl("http://127.0.0.1:8787")).toBe("did:web:127.0.0.1%3A8787");
  });

  it("is the inverse of webDidUrl with loopback allowed", () => {
    for (const [url, document] of [
      ["https://mediator.example.com", "https://mediator.example.com/.well-known/did.json"],
      ["https://bob.example:8443/users/alice", "https://bob.example:8443/users/alice/did.json"],
      ["https://bob.example/~alice/a%20b", "https://bob.example/~alice/a%20b/did.json"],
      ["https://bob.example/users/alice/", "https://bob.example/users/alice/did.json"],
      ["http://localhost:8787", "http://localhost:8787/.well-known/did.json"],
      ["http://localhost:443", "http://localhost:443/.well-known/did.json"],
      ["http://127.0.0.1:443/a", "http://127.0.0.1:443/a/did.json"],
    ] as const) {
      expect(urlOf(didWebFromUrl(url), true), url).toBe(document);
    }
  });

  it("refuses a URL its did:web would not be fetched from", () => {
    expect(() => didWebFromUrl("http://mediator.example.com")).toThrow(/its document is fetched from https:\/\/mediator\.example\.com$/);
    expect(() => didWebFromUrl("https://localhost:8443")).toThrow(/its document is fetched from http:\/\/localhost:8443$/);
    expect(() => didWebFromUrl("http://[::1]:8787")).toThrow(/not a did:web/);
    expect(() => didWebFromUrl("https://10.0.0.1")).toThrow(/IP-literal/);
    expect(() => didWebFromUrl("https://printer.local")).toThrow(/reserved name/);
    expect(() => didWebFromUrl("https://bob.example/a%2Fb")).toThrow(/path segment/);
    expect(() => didWebFromUrl("https://bob.example/a//b")).toThrow(/path segment ""/);
    expect(() => didWebFromUrl("https://bob.example//a")).toThrow(/path segment ""/);
  });
});
