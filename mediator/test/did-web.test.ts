import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { DIDCommContext } from "../src/didcomm/didcomm.js";
import { WebDids, resolveDID, webDidUrl, type WebDidPolicy } from "../src/didcomm/did-resolver.js";
import { guardedFetch, isPublicAddress } from "../src/guarded-fetch.js";
import { mintIdentity } from "../src/identity-core.js";

const DID = "did:web:mediator.example";
const URL_OF_DID = "https://mediator.example/.well-known/did.json";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A transport answering every request with `answer`, keeping what it was asked. */
function transport(answer: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/did+json", ...headers } });

/** A body of `chunks` pieces of `size` bytes, with no declared length. */
function streamed(chunks: number, size: number): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(size).fill(0x20));
      },
    })
  );
}

describe("webDidUrl", () => {
  it("names a host's well-known document, and a path's own", () => {
    expect(String(webDidUrl(DID))).toBe(URL_OF_DID);
    expect(String(webDidUrl("did:web:mediator.example%3A8443:users:alice"))).toBe(
      "https://mediator.example:8443/users/alice/did.json"
    );
  });

  it("refuses an IP literal, a reserved name or a loopback host before any request", () => {
    for (const did of [
      "did:web:10.0.0.1",
      "did:web:169.254.169.254",
      "did:web:127.0.0.2",
      "did:web:%5B%3A%3A1%5D",
      "did:web:printer.local",
      "did:web:db.internal",
      "did:web:app.localhost",
      "did:web:localhost%3A6379",
      "did:web:127.0.0.1",
      "did:web:0x7f.1",
    ]) {
      expect(typeof webDidUrl(did), did).toBe("string");
    }
  });

  it("refuses an authority with more than a host and a port, and a path that would move", () => {
    for (const did of [
      "did:web:user%40mediator.example",
      "did:web:mediator.example%2Fadmin",
      "did:web:mediator.example:..",
      "did:web:mediator.example::x",
      "did:web:mediator.example%ZZ",
      "did:web:",
    ]) {
      expect(typeof webDidUrl(did), did).toBe("string");
    }
  });

  it("allows plain http to localhost or 127.0.0.1 only when asked", () => {
    expect(String(webDidUrl("did:web:localhost%3A8787", true))).toBe("http://localhost:8787/.well-known/did.json");
    expect(String(webDidUrl("did:web:127.0.0.1%3A8787", true))).toBe("http://127.0.0.1:8787/.well-known/did.json");
    expect(typeof webDidUrl("did:web:10.0.0.1", true)).toBe("string");
  });
});

describe("WebDids", () => {
  const resolving = (policy: WebDidPolicy) => new WebDids(policy).resolve(DID);

  it("resolves a document that calls itself by the DID, fetched without following redirects, and reuses it", async () => {
    const { fetch, calls } = transport(() => json({ id: DID }));
    const dids = new WebDids({ fetch });

    expect((await dids.resolve(DID)).didDocument).toEqual({ id: DID });
    expect((await dids.resolve(DID)).didDocument).toEqual({ id: DID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_OF_DID);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not follow a redirect", async () => {
    const { fetch, calls } = transport(
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
    );
    const result = await resolving({ fetch });
    expect(result.didDocument).toBeNull();
    expect(result.didResolutionMetadata.message).toMatch(/redirect/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a document past the bound, whether declared or streamed", async () => {
    const declared = transport(() => json({ id: DID }, { "content-length": "70000" }));
    expect((await resolving({ fetch: declared.fetch })).didResolutionMetadata.message).toMatch(/larger than 65536 bytes/);

    const unbounded = transport(() => streamed(1000, 1024));
    expect((await resolving({ fetch: unbounded.fetch, maxBytes: 4096 })).didResolutionMetadata.message).toMatch(
      /larger than 4096 bytes/
    );
  });

  it("refuses a document that names another DID, or is not a JSON object", async () => {
    for (const body of [{ id: "did:web:elsewhere.example" }, { id: "did:web:Mediator.example" }, ["x"], "x"]) {
      const { fetch } = transport(() => json(body));
      expect((await resolving({ fetch })).didDocument, JSON.stringify(body)).toBeNull();
    }
  });

  it("gives up once the whole fetch outlasts the timeout", async () => {
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const result = await resolving({ fetch, timeoutMs: 50 });
    expect(result.didDocument).toBeNull();
    expect(result.didResolutionMetadata.message).toMatch(/longer than 50 ms/);
  });

  it("asks nothing of the transport for a name the policy refuses", async () => {
    const { fetch, calls } = transport(() => json({ id: "did:web:localhost%3A6379" }));
    const result = await new WebDids({ fetch }).resolve("did:web:localhost%3A6379");
    expect(result.didResolutionMetadata.error).toBe("invalidDid");
    expect(calls).toHaveLength(0);
  });

  it("keeps no failure: the next resolution asks again", async () => {
    let status = 503;
    const { fetch, calls } = transport(() => (status === 503 ? new Response("busy", { status }) : json({ id: DID })));
    const dids = new WebDids({ fetch });
    expect((await dids.resolve(DID)).didDocument).toBeNull();
    status = 200;
    expect((await dids.resolve(DID)).didDocument).toEqual({ id: DID });
    expect(calls).toHaveLength(2);
  });
});

describe("resolveDID", () => {
  it("resolves no did:web without a network policy", async () => {
    expect((await resolveDID(DID)).didResolutionMetadata.error).toBe("methodNotSupported");
  });
});

describe("DIDCommContext", () => {
  it("fetches a did:web it meets under its own policy, and none without one", async () => {
    const mediator = await mintIdentity("https://mediator.example", "web");
    const alice = await mintIdentity("https://alice.example", "peer2");
    const { fetch } = transport(() => json(mediator.webDidDoc));

    const withPolicy = new DIDCommContext(alice.did, alice.didDoc, alice.secrets, { web: new WebDids({ fetch }) });
    const without = new DIDCommContext(alice.did, alice.didDoc, alice.secrets);

    expect((await withPolicy.resolve(mediator.did))?.id).toBe(mediator.did);
    expect(await without.resolve(mediator.did)).toBeNull();
  });
});

describe("guardedFetch", () => {
  it("tells a public unicast address from the rest", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses a loopback literal, a name that resolves to loopback and a private literal without connecting", async () => {
    let reached = 0;
    const server = createServer((_req, res) => {
      reached += 1;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/refused/);
      await expect(guardedFetch(`http://localhost:${port}/`)).rejects.toThrow(/refused/);
      await expect(guardedFetch(`http://[::1]:${port}/`)).rejects.toThrow(/refused/);
      await expect(guardedFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/refused/);
      await expect(guardedFetch("ftp://mediator.example/did.json")).rejects.toThrow(/refused/);
      expect(reached).toBe(0);
    } finally {
      server.close();
    }
  });

  it("holds under the resolver: a did:web on loopback allowed by the name is still refused at lookup", async () => {
    const result = await new WebDids({ fetch: guardedFetch, insecureLoopback: true }).resolve("did:web:localhost%3A8787");
    expect(result.didDocument).toBeNull();
    expect(result.didResolutionMetadata.message).toMatch(/refused/);
  });
});
