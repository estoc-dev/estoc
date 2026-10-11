import { describe, expect, it, test } from "vitest";

import { DEFINITIVE_TRANSPORT_CODES, MAX_DOCUMENT_BYTES, fetchWebDid, type WebDidOptions } from "../src/index.js";

const DID = "did:web:bob.example";
const URL_OF_DID = "https://bob.example/.well-known/did.json";
const DOCUMENT = { id: DID, verificationMethod: [] };

/** A transport answering every request with `answer`, keeping what it was asked. */
function transport(answer: (init?: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return answer(init);
  };
  return { fetch, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/did+json", ...headers } });
const answering = (answer: (init?: RequestInit) => Response | Promise<Response>) => transport(answer).fetch;
const failing = (err: unknown) => answering(() => Promise.reject(err));
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
const never = () => new Promise<never>(() => undefined);
const fetched = (options: WebDidOptions, did = DID) => fetchWebDid(did, options);

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

describe("fetchWebDid", () => {
  it("fetches the derived URL once, uncached, without following redirects, under a signal, and keeps a document that calls itself by the DID", async () => {
    const { fetch, calls } = transport(() => json(DOCUMENT));
    expect(await fetched({ fetch })).toEqual({ outcome: "resolved", url: new URL(URL_OF_DID), document: DOCUMENT });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_OF_DID);
    expect(calls[0]?.init).toMatchObject({ redirect: "manual", cache: "no-store", headers: { accept: "application/did+json, application/json" } });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks nothing of the transport for a DID the policy refuses", async () => {
    const { fetch, calls } = transport(() => json({ id: "did:web:localhost%3A6379" }));
    expect(await fetched({ fetch }, "did:web:localhost%3A6379")).toEqual({ outcome: "refused", reason: "the policy refuses did:web:localhost%3A6379: a loopback authority" });
    expect(await fetched({ fetch }, "did:web:10.0.0.1")).toEqual({ outcome: "refused", reason: "the policy refuses did:web:10.0.0.1: an IP-literal authority" });
    expect(calls).toEqual([]);
    expect(await fetched({ fetch, insecureLoopback: true }, "did:web:localhost%3A6379")).toMatchObject({ outcome: "resolved", url: new URL("http://localhost:6379/.well-known/did.json") });
  });

  test("the document must call itself by the presented string, byte for byte: host case folds no two DIDs into one", async () => {
    expect(await fetched({ fetch: answering(() => json(DOCUMENT)) }, "did:web:Bob.Example")).toMatchObject({ outcome: "definitive", reason: `the document is "${DID}"'s, not did:web:Bob.Example's` });
    expect(await fetched({ fetch: answering(() => json({ id: "did:web:Bob.Example" })) }, "did:web:Bob.Example")).toMatchObject({ outcome: "resolved" });
    expect(await fetched({ fetch: answering(() => json({ id: "did:web:elsewhere.example" })) })).toMatchObject({ outcome: "definitive" });
    expect(await fetched({ fetch: answering(() => json({})) })).toMatchObject({ outcome: "definitive", reason: `the document is undefined's, not ${DID}'s` });
  });

  it("tells no answer now from an answer that closes the attempt", async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(await fetched({ fetch: answering(() => new Response("", { status })) })).toMatchObject({ outcome: "unavailable", reason: `HTTP ${status}` });
    }
    for (const status of [404, 410]) {
      expect(await fetched({ fetch: answering(() => new Response("", { status })) })).toMatchObject({ outcome: "definitive", reason: `HTTP ${status}: not found or deactivated` });
    }
    expect(await fetched({ fetch: answering(() => new Response("", { status: 401 })) })).toMatchObject({ outcome: "definitive", reason: "HTTP 401" });
    expect(await fetched({ fetch: answering(() => Response.redirect("http://169.254.169.254/latest/meta-data/", 302)) })).toMatchObject({ outcome: "definitive", reason: "a redirect (302) is not followed" });
    expect(await fetched({ fetch: answering(() => new Response("{", { status: 200 })) })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("the document is not JSON") });
    expect(await fetched({ fetch: answering(() => new Response(Uint8Array.of(0x22, 0xff, 0x22), { status: 200 })) })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("the document is not JSON") });
    for (const body of [[DOCUMENT], "x", null]) {
      expect(await fetched({ fetch: answering(() => json(body)) }), JSON.stringify(body)).toMatchObject({ outcome: "definitive", reason: "the document is not a JSON object" });
    }
  });

  it("parses the body as the caller says, a throw refusing the document", async () => {
    const strict = (bytes: Uint8Array): unknown => {
      const text = new TextDecoder().decode(bytes);
      if (text.includes('"id":"x"')) throw new Error("a member twice");
      return JSON.parse(text);
    };
    const twice = new Response(`{"id":"x","id":"${DID}"}`, { status: 200 });
    expect(await fetched({ fetch: answering(() => twice.clone()) })).toMatchObject({ outcome: "resolved" });
    expect(await fetched({ fetch: answering(() => twice.clone()), parse: strict })).toMatchObject({ outcome: "definitive", reason: "the document is not JSON: a member twice" });
  });

  it("refuses a document past the bound, whether declared or streamed, once it is past", async () => {
    expect(await fetched({ fetch: answering(() => json(DOCUMENT, { "content-length": "70000" })), maxBytes: 65536 })).toMatchObject({ outcome: "definitive", reason: "the document is larger than 65536 bytes" });
    expect(await fetched({ fetch: answering(() => streamed(1000, 1024)), maxBytes: 4096 })).toMatchObject({ outcome: "definitive", reason: "the document is larger than 4096 bytes" });
    expect(await fetched({ fetch: answering(() => json({ ...DOCUMENT, note: "x".repeat(MAX_DOCUMENT_BYTES) })) })).toMatchObject({ outcome: "definitive", reason: `the document is larger than ${MAX_DOCUMENT_BYTES} bytes` });
    for (const cancel of [() => undefined, () => Promise.reject(new Error("cancel failed")), never]) {
      const oversize = answering(() => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(65)), cancel }), { status: 200 }));
      expect(await fetched({ fetch: oversize, maxBytes: 64, timeoutMs: 20 })).toMatchObject({ outcome: "definitive", reason: "the document is larger than 64 bytes" });
    }
  });

  test("a transport failure is final only by the transport's own code, found down the cause chain; the reason keeps the cause", async () => {
    const refusal = "bob.example resolves to 10.0.0.7, not a public address";
    const outcome = async (fetch: typeof globalThis.fetch) => {
      const { outcome, reason } = (await fetched({ fetch })) as { outcome: string; reason: string };
      return { outcome, reason };
    };
    expect(await outcome(failing(new TypeError("fetch failed", { cause: coded(DEFINITIVE_TRANSPORT_CODES.refused, refusal) })))).toEqual({ outcome: "definitive", reason: `the transport refused the connection: fetch failed: ${refusal}` });
    expect(await outcome(failing(coded("EBLOCKED", refusal)))).toEqual({ outcome: "definitive", reason: `the transport refused the connection: ${refusal}` });
    expect(await outcome(failing(new TypeError("fetch failed", { cause: coded(DEFINITIVE_TRANSPORT_CODES.noAddress, "no such name: bob.example") })))).toEqual({ outcome: "definitive", reason: "the authority has no address: fetch failed: no such name: bob.example" });
    for (const code of ["ENOTFOUND", "ENODATA", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(await outcome(failing(new TypeError("fetch failed", { cause: coded(code) })))).toEqual({ outcome: "unavailable", reason: `the fetch failed: fetch failed: ${code}` });
      expect(await outcome(failing(coded(code)))).toEqual({ outcome: "unavailable", reason: `the fetch failed: ${code}` });
    }
    expect(await outcome(failing(new TypeError("fetch failed")))).toEqual({ outcome: "unavailable", reason: "the fetch failed: fetch failed" });
    expect(await outcome(failing("no"))).toEqual({ outcome: "unavailable", reason: "the fetch failed: no" });

    const generic = (cause: unknown) => Object.assign(new Error("network operation failed", { cause }), { code: "ERR_NETWORK" });
    expect(await outcome(failing(generic(coded("EBLOCKED", refusal))))).toEqual({ outcome: "definitive", reason: `the transport refused the connection: network operation failed: ${refusal}` });
    expect(await outcome(failing(generic(coded("ENXDOMAIN", "no such name"))))).toEqual({ outcome: "definitive", reason: "the authority has no address: network operation failed: no such name" });
    expect(await outcome(failing(generic(coded("ENOTFOUND"))))).toEqual({ outcome: "unavailable", reason: "the fetch failed: network operation failed: ENOTFOUND" });
    expect(await outcome(failing({ code: "EBLOCKED", message: refusal }))).toEqual({ outcome: "definitive", reason: `the transport refused the connection: ${refusal}` });
    expect(await outcome(failing({ code: "ECONNRESET", message: "reset" }))).toEqual({ outcome: "unavailable", reason: "the fetch failed: reset" });

    const bodyFailing = (err: unknown) => answering(() => new Response(new ReadableStream({ start: (controller) => controller.error(err) }), { status: 200 }));
    expect(await outcome(bodyFailing(coded("EBLOCKED", refusal)))).toEqual({ outcome: "definitive", reason: `the transport refused the connection: ${refusal}` });
    expect(await outcome(bodyFailing(generic(coded("ENXDOMAIN", "no such name"))))).toEqual({ outcome: "definitive", reason: "the authority has no address: network operation failed: no such name" });
    expect(await outcome(bodyFailing(coded("ECONNRESET")))).toEqual({ outcome: "unavailable", reason: "the body did not arrive whole: ECONNRESET" });
  });

  test("one deadline covers the fetch to the last byte, whether or not the transport heeds the signal", async () => {
    const timedOut = { outcome: "unavailable", reason: "timed out: not resolved within 20 ms" };
    const cooperative: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)));
    expect(await fetched({ fetch: cooperative, timeoutMs: 20 })).toMatchObject(timedOut);
    expect(await fetched({ fetch: never, timeoutMs: 20 })).toMatchObject(timedOut);
    expect(await fetched({ fetch: answering(() => new Response(new ReadableStream({ pull: never }), { status: 200 })), timeoutMs: 20 })).toMatchObject(timedOut);
  });

  it("calls a transport on its own, not as a method of the options", async () => {
    const options = {
      fetch(this: unknown): Promise<Response> {
        return this === undefined ? Promise.resolve(json(DOCUMENT)) : Promise.reject(new TypeError("Illegal invocation"));
      },
    } as unknown as WebDidOptions;
    expect(await fetched(options)).toMatchObject({ outcome: "resolved" });
  });
});
