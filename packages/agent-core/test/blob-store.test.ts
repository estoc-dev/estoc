import { afterEach, describe, expect, it } from "vitest";

import { scanVault, canonicalDid } from "@estoc/vault";

import { Agent, BLOB_TOO_LARGE, BlobStore, BlobTooLarge, BlobTransferFailed, MediatorRefused, SEAL_OVERHEAD, openBlob, readBlob, sealBlob } from "../src/index.js";
import type { FakeMediator } from "./fake-mediator.js";
import { didcomm, newMediator, party, type Party } from "./helpers.js";

const closing: { close: () => void; runtime: Party["runtime"] }[] = [];

afterEach(async () => {
  for (const { close, runtime } of closing.splice(0)) {
    close();
    await runtime.close();
  }
});

/** A runtime with an arrangement toward `mediator`, its agent open and not connected, and the blob store it speaks to as its replica. */
async function storing(mediator: FakeMediator): Promise<Party & { agent: Agent; store: BlobStore }> {
  const p = await party(mediator, 1);
  const agent = await Agent.open(p, { didcomm, fetch: p.linkOptions.fetch as typeof fetch, WebSocket: mediator.WebSocket, trace: p.trace, localOptions: p.runtime.local.options, privateAddresses: false, liveDelivery: false });
  closing.push({ close: () => agent.close(), runtime: p.runtime });
  return { ...p, agent, store: await agent.blobStore(p.mediationId) };
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
    const unanswered = new BlobStore(alice.link, { fetch: () => new Promise<Response>(() => undefined) });
    await expect(unanswered.upload({ ...placed, upload: { ...placed.upload!, expires: Date.now() + 50 } }, sealed.bytes)).rejects.toMatchObject({ name: "TimeoutError" });
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

  it("fails on an answer that is no 2xx", async () => {
    const fetch = (async () => new Response("gone", { status: 410 })) as typeof globalThis.fetch;
    const failed = await readBlob("http://blobs.example/b/x", { maxBytes: 2500, timeoutMs: 1000, fetch }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(BlobTransferFailed);
    expect(failed).toMatchObject({ transfer: "read", status: 410 });
  });
});
