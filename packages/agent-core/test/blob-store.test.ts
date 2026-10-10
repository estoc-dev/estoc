import { afterEach, describe, expect, it } from "vitest";

import { scanVault, canonicalDid } from "@estoc/vault";

import { Agent, BLOB_TOO_LARGE, BlobStore, BlobTooLarge, LinkClosed, MediatorLink, MediatorRefused, SEAL_OVERHEAD, openBlob, readBlob, sealBlob } from "../src/index.js";
import type { FakeMediator } from "./fake-mediator.js";
import { didcomm, newMediator, party, type Party } from "./helpers.js";

const closing: { close: () => void; runtime: Party["runtime"] }[] = [];

afterEach(async () => {
  for (const { close, runtime } of closing.splice(0)) {
    close();
    await runtime.close();
  }
});

/** A runtime with an arrangement toward `mediator`, its agent open and not connected, the blob store it speaks to as its replica, and every request the agent sent. */
async function storing(mediator: FakeMediator): Promise<Party & { agent: Agent; store: BlobStore; sent: string[] }> {
  const p = await party(mediator, 1);
  const sent: string[] = [];
  const transport = p.linkOptions.fetch as typeof fetch;
  const counting = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${init?.method ?? "GET"} ${String(input)}`);
    return transport(input, init);
  }) as typeof fetch;
  const agent = await Agent.open(p, { didcomm, fetch: counting, WebSocket: mediator.WebSocket, trace: p.trace, localOptions: p.runtime.local.options, privateAddresses: false, liveDelivery: false });
  closing.push({ close: () => agent.close(), runtime: p.runtime });
  return { ...p, agent, store: await agent.blobStore(p.mediationId), sent };
}

const filled = (length: number): Uint8Array => new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);

/** A blob served a chunk at a time, saying how many chunks were pulled and whether the reader cancelled. */
function trickling(chunks: number, chunkBytes: number, headers: Record<string, string> = {}) {
  const seen = { pulls: 0, cancelled: false };
  const fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          seen.pulls += 1;
          if (seen.pulls > chunks) controller.close();
          else controller.enqueue(filled(chunkBytes));
        },
        cancel() {
          seen.cancelled = true;
        },
      }),
      { headers }
    )) as typeof globalThis.fetch;
  return { fetch, seen };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

/** Each way letting a body go can come out: at once, failing, or not at all. */
const lettingGo = [() => undefined, () => Promise.reject(new Error("cancel failed")), never];

/** Every request answered `status`, with a body of two bytes whose cancelling comes to what `cancel` does. */
function answering(status: number, cancel: () => unknown, headers: Record<string, string> = {}): typeof globalThis.fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(filled(2)), cancel: cancel as UnderlyingSourceCancelCallback }), { status, headers })) as typeof globalThis.fetch;
}

describe("the blob store of a runtime's replica", () => {
  it("keeps a blob as the replica's own, uploaded once and read back by its URL until it is deleted", async () => {
    const mediator = await newMediator();
    const alice = await storing(mediator);
    const plaintext = filled(5000);
    const sealed = await sealBlob(plaintext);

    const placed = await alice.store.put(sealed.hash, sealed.bytes.length);
    expect(placed.upload).not.toBeNull();
    await alice.store.upload(placed, sealed.bytes);

    const replica = (await scanVault(alice.runtime.vault, alice.keys)).replicas.replicas.get(alice.runtime.author);
    expect([...mediator.blobs.values()].map(({ owner }) => owner)).toEqual([canonicalDid(replica!.did!)]);
    expect(canonicalDid(replica!.did!)).not.toBe(canonicalDid(alice.created.data.me.did));

    const renewed = await alice.store.put(sealed.hash, sealed.bytes.length);
    expect(renewed.url).toBe(placed.url);
    expect(renewed.upload).toBeNull();

    const read = await readBlob(placed.url, { maxBytes: sealed.bytes.length, timeoutMs: 1000, fetch: mediator.fetch });
    expect(await openBlob(read, sealed)).toEqual(plaintext);

    await alice.store.delete(sealed.hash);
    await expect(readBlob(placed.url, { maxBytes: sealed.bytes.length, timeoutMs: 1000, fetch: mediator.fetch })).rejects.toMatchObject({ name: "BlobTransferFailed", transfer: "read", status: 404 });
  });

  it("takes a plaintext of the mediator's limit less the overhead, and refuses one byte more as too large", async () => {
    const mediator = await newMediator();
    mediator.blobLimits = { maxBytes: 4096, quotaBytes: 1 << 20, retainSeconds: 60 };
    const alice = await storing(mediator);
    const limits = await alice.store.limits();
    expect(limits).toEqual(mediator.blobLimits);

    const fits = await sealBlob(filled(limits!.maxBytes - SEAL_OVERHEAD));
    expect(fits.bytes.length).toBe(limits!.maxBytes);
    await alice.store.upload(await alice.store.put(fits.hash, fits.bytes.length), fits.bytes);

    const over = await sealBlob(filled(limits!.maxBytes - SEAL_OVERHEAD + 1));
    const refused = await alice.store.put(over.hash, over.bytes.length).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(MediatorRefused);
    expect((refused as MediatorRefused).code).toBe(BLOB_TOO_LARGE);
  });

  it("has no limits at a mediator that keeps no blobs", async () => {
    const mediator = await newMediator();
    const alice = await storing(mediator);
    mediator.blobLimits = null;
    expect(await alice.store.limits()).toBeNull();
  });

  it("fails an upload the store will not take", async () => {
    const mediator = await newMediator();
    const alice = await storing(mediator);
    const sealed = await sealBlob(filled(100));
    const placed = await alice.store.put(sealed.hash, sealed.bytes.length);
    const other = (await sealBlob(filled(100))).bytes;
    await expect(alice.store.upload(placed, other)).rejects.toMatchObject({ name: "BlobTransferFailed", transfer: "upload", status: 400 });
  });

  it("gives an upload up once its grant expires", async () => {
    const mediator = await newMediator();
    const alice = await storing(mediator);
    const sealed = await sealBlob(filled(100));
    const placed = await alice.store.put(sealed.hash, sealed.bytes.length);
    const unanswered = new BlobStore(new MediatorLink({ ...alice.linkOptions, fetch: never }));
    await expect(unanswered.upload({ ...placed, upload: { ...placed.upload!, expires: Date.now() + 50 } }, sealed.bytes)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("settles an upload on the store's answer, whatever letting the answer's body go comes to", async () => {
    const mediator = await newMediator();
    const alice = await storing(mediator);
    const sealed = await sealBlob(filled(100));
    const placed = await alice.store.put(sealed.hash, sealed.bytes.length);
    for (const cancel of lettingGo) {
      const answered = (status: number) => new BlobStore(new MediatorLink({ ...alice.linkOptions, fetch: answering(status, cancel) }));
      await expect(answered(200).upload(placed, sealed.bytes)).resolves.toBeUndefined();
      await expect(answered(400).upload(placed, sealed.bytes)).rejects.toMatchObject({ name: "BlobTransferFailed", transfer: "upload", status: 400 });
    }
  });

  it("sends nothing once the agent it came from is closed", async () => {
    const mediator = await newMediator();
    const alice = await storing(mediator);
    const sealed = await sealBlob(filled(100));
    const placed = await alice.store.put(sealed.hash, sealed.bytes.length);
    const sent = alice.sent.length;
    alice.agent.close();
    await expect(alice.store.limits()).rejects.toBeInstanceOf(LinkClosed);
    await expect(alice.store.put(sealed.hash, sealed.bytes.length)).rejects.toBeInstanceOf(LinkClosed);
    await expect(alice.store.upload(placed, sealed.bytes)).rejects.toBeInstanceOf(LinkClosed);
    await expect(alice.store.delete(sealed.hash)).rejects.toBeInstanceOf(LinkClosed);
    expect(alice.sent).toHaveLength(sent);
    expect([...mediator.blobs.values()].map(({ bytes }) => bytes)).toEqual([null]);
  });
});

describe("a blob read", () => {
  it("stops once the bytes run over the most it takes, reading no further", async () => {
    const { fetch, seen } = trickling(100, 1000);
    await expect(readBlob("http://blobs.example/b/x", { maxBytes: 2500, timeoutMs: 1000, fetch })).rejects.toBeInstanceOf(BlobTooLarge);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulls).toBeLessThan(10);
  });

  it("refuses a blob that declares more bytes than it takes, before reading any of them", async () => {
    const { fetch, seen } = trickling(100, 1000, { "content-length": "100000" });
    await expect(readBlob("http://blobs.example/b/x", { maxBytes: 2500, timeoutMs: 1000, fetch })).rejects.toBeInstanceOf(BlobTooLarge);
    expect(seen.cancelled).toBe(true);
  });

  it("gives up at its deadline", async () => {
    const seen = { cancelled: false };
    const fetch = (async () => new Response(new ReadableStream<Uint8Array>({ cancel: () => void (seen.cancelled = true) }))) as typeof globalThis.fetch;
    await expect(readBlob("http://blobs.example/b/x", { maxBytes: 2500, timeoutMs: 50, fetch })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seen.cancelled).toBe(true);
  });

  it("fails as the answer, or the most it takes, says, whatever letting the body go comes to", async () => {
    const read = (fetch: typeof globalThis.fetch) => readBlob("http://blobs.example/b/x", { maxBytes: 1, timeoutMs: 50, fetch });
    for (const cancel of lettingGo) {
      await expect(read(answering(410, cancel))).rejects.toMatchObject({ name: "BlobTransferFailed", transfer: "read", status: 410 });
      await expect(read(answering(200, cancel, { "content-length": "2" }))).rejects.toBeInstanceOf(BlobTooLarge);
      await expect(read(answering(200, cancel))).rejects.toBeInstanceOf(BlobTooLarge);
    }
  });
});
