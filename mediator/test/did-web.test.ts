import type { WebDidOptions } from "@estoc/did-web";
import { describe, expect, it } from "vitest";

import { DIDCommContext } from "../src/didcomm/didcomm.js";
import { WebDids, resolveDID } from "../src/didcomm/did-resolver.js";
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

describe("WebDids", () => {
  const resolving = (policy: WebDidOptions) => new WebDids(policy).resolve(DID);

  it("resolves a document that calls itself by the DID, fetched without following redirects, and reuses it", async () => {
    const { fetch, calls } = transport(() => json({ id: DID }));
    const dids = new WebDids({ fetch });

    expect((await dids.resolve(DID)).didDocument).toEqual({ id: DID });
    expect((await dids.resolve(DID)).didDocument).toEqual({ id: DID });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_OF_DID);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("reads at most 64 KiB of a document unless the policy says otherwise", async () => {
    for (const policy of [{}, { maxBytes: undefined }]) {
      expect((await resolving({ ...policy, fetch: transport(() => streamed(65, 1024)).fetch })).didResolutionMetadata).toEqual({
        error: "notFound",
        message: `${URL_OF_DID}: the document is larger than 65536 bytes`,
      });
    }
    expect((await resolving({ fetch: transport(() => streamed(65, 1024)).fetch, maxBytes: 128 * 1024 })).didResolutionMetadata.message).toMatch(/not JSON/);
  });

  it("answers a DID the policy refuses as an invalid DID, asking nothing of the transport, and any other failure as not found", async () => {
    const { fetch, calls } = transport(() => json({ id: "did:web:localhost%3A6379" }));
    expect((await new WebDids({ fetch }).resolve("did:web:localhost%3A6379")).didResolutionMetadata).toEqual({
      error: "invalidDid",
      message: "the policy refuses did:web:localhost%3A6379: a loopback authority",
    });
    expect(calls).toHaveLength(0);
    for (const answer of [() => json({ id: "did:web:elsewhere.example" }), () => new Response(null, { status: 503 })]) {
      expect((await resolving({ fetch: transport(answer).fetch })).didResolutionMetadata.error).toBe("notFound");
    }
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
