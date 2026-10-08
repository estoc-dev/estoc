/**
 * A vault and a message crossing between the two places the daemon
 * runs, Node and the browser's dedicated Worker: the Worker script is
 * bundled with esbuild and served, with SQLite's and didcomm's wasm,
 * to a headless Chromium over localhost (a secure context, which the
 * Worker's private file system needs). Skipped, loudly, when no
 * Chromium is found; `ESTOC_BROWSER=/path/to/chrome` names one.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { afterAll, describe, expect, it } from "vitest";

import { secretsResolverFor, unpack, type IMessage } from "@estoc/agent-core";
import { Message } from "@estoc/didcomm-node";
import { VAULT_VERSION, openPortable } from "@estoc/event-store";
import { openNodeSqlite } from "@estoc/event-store/node";
import { deriveIdentity, importSeed } from "@estoc/keystore";
import { envelopeOf, intentOf, plaintextCidOf, storeMessage, wirePlaintext, type Cid, type Did } from "@estoc/vault";

import { findChromium } from "../../event-store/test/browser/chromium.js";
import { openedOf, resolverOf, type CrossingInput, type CrossingOutput, type Document, type Parties, type Secrets, type WorkerReply } from "./browser/crossing.js";
import { CORPUS_PASSPHRASE, CORPUS_VAULT, expected, foldText, hashOf, readCorpus, snapshotText } from "./corpus.js";

const browserPath = findChromium();
if (browserPath === null) {
  console.warn("the crossing between Node and Chromium skipped: no Chromium found (set ESTOC_BROWSER to a Chrome or Chromium binary)");
}

const TIME_LIMIT = 120_000;

/** A `did:web` party known only to this test: the DIDComm document both runtimes resolve, and its secrets; the same `fill` gives the same keys. */
async function party(did: string, fill: number): Promise<{ document: Document; secrets: Secrets }> {
  const { ed25519, x25519 } = (await deriveIdentity(await importSeed(new Uint8Array(32).fill(fill)), "anchor")).privateJwks();
  const publicOf = ({ kty, crv, x }: JsonWebKey) => ({ kty, crv, x });
  return {
    document: {
      id: did,
      authentication: [`${did}#auth`],
      keyAgreement: [`${did}#agree`],
      verificationMethod: [
        { id: `${did}#auth`, type: "JsonWebKey2020", controller: did, publicKeyJwk: publicOf(ed25519) },
        { id: `${did}#agree`, type: "JsonWebKey2020", controller: did, publicKeyJwk: publicOf(x25519) },
      ],
      service: [],
    } as Document,
    secrets: [
      { id: `${did}#auth`, type: "JsonWebKey2020", privateKeyJwk: ed25519 },
      { id: `${did}#agree`, type: "JsonWebKey2020", privateKeyJwk: x25519 },
    ] as Secrets,
  };
}

async function parties(): Promise<Parties> {
  const [sender, recipient] = ["did:web:sender.example", "did:web:recipient.example"];
  const [ofSender, ofRecipient] = [await party(sender, 31), await party(recipient, 32)];
  return { sender, recipient, documents: { [sender]: ofSender.document, [recipient]: ofRecipient.document }, secrets: { sender: ofSender.secrets, recipient: ofRecipient.secrets } };
}

/** A message whose layers have something for each runtime to get wrong: text outside ASCII, members to order by code unit, an inline attachment of each kind, timing, an ACK request for itself and an additional header. */
function message({ sender, recipient }: Parties): { plaintext: IMessage; intentCid: Cid; plaintextCid: Cid } {
  const stored = storeMessage({ content: "héllo, 世界 👋", "Ärger": [1, 0.5, -3], zebra: { "é": null, e: true } }, [
    { id: "a1", media_type: "application/json", data: { json: { "ü": "✓", n: 1e-7 } } },
    { id: "a2", media_type: "text/plain", filename: "note.txt", data: { base64: "aGVsbG8sIOS4lueVjA==" } },
  ]);
  const payloads = new Map(stored.payloads.map(({ cid, bytes }) => [cid, bytes]));
  const id = "019b2a70-e2c8-7fb4-b63f-1aca32152062";
  const intent = intentOf(id, { type: "https://didcomm.org/basicmessage/2.0/message", thid: null, pthid: null, createdTime: 1788442800, expiresTime: 1788446400, pleaseAck: [""], ack: [], headers: { lang: "fr", "ünïcode": "✓" } }, stored.bodyCid);
  const plaintext = wirePlaintext(intent.value, id, stored.document, { from: sender as Did, to: [recipient as Did], fromPrior: null }, (root) => payloads.get(root)!);
  return { plaintext: plaintext as unknown as IMessage, intentCid: intent.cid, plaintextCid: plaintextCidOf(plaintext) };
}

async function sealedHere({ sender, recipient, documents, secrets }: Parties, plaintext: IMessage): Promise<string> {
  const [packed] = await new Message(plaintext).pack_encrypted(`${recipient}#agree`, `${sender}#agree`, null, resolverOf(documents), secretsResolverFor(secrets.sender), { forward: false });
  return packed;
}

async function bundled(): Promise<string> {
  const out = await build({ entryPoints: [fileURLToPath(new URL("./browser/crossing-worker.ts", import.meta.url))], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false });
  return out.outputFiles[0]?.text ?? "";
}

async function inChromium(executablePath: string, input: CrossingInput, dir: string): Promise<CrossingOutput> {
  const required = createRequire(import.meta.url);
  const files: Record<string, [string, string | Uint8Array]> = {
    "/worker.js": ["text/javascript; charset=utf-8", await bundled()],
    "/sqlite3.wasm": ["application/wasm", await readFile(createRequire(required.resolve("@estoc/event-store")).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"))],
    "/didcomm.wasm": ["application/wasm", await readFile(path.join(path.dirname(required.resolve("@estoc/didcomm")), "index_bg.wasm"))],
  };
  const server = http.createServer((req, res) => {
    const [type, body] = files[req.url ?? ""] ?? ["text/html; charset=utf-8", '<!doctype html><meta charset="utf-8"><title>crossing</title>'];
    res.setHeader("content-type", type);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const context = await chromium.launchPersistentContext(path.join(dir, "profile"), { executablePath, headless: true, chromiumSandbox: false });
  let expired: ReturnType<typeof setTimeout> | undefined;
  try {
    const tab = context.pages()[0] ?? (await context.newPage());
    tab.on("console", (line) => {
      if (line.type() === "error" || line.type() === "warning") console.error(`browser ${line.type()}:`, line.text());
    });
    await tab.goto(`http://127.0.0.1:${port}/`);
    const reply = await Promise.race([
      tab.evaluate(
        (given) =>
          new Promise<WorkerReply>((resolve, reject) => {
            const worker = new Worker("/worker.js", { type: "module" });
            worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => resolve(data);
            worker.onerror = (event) => reject(new Error(`the Worker failed: ${event.message}`));
            worker.postMessage(given);
          }),
        input
      ),
      new Promise<never>((_, reject) => {
        expired = setTimeout(() => reject(new Error(`the browser did not finish within ${TIME_LIMIT / 1000} s`)), TIME_LIMIT);
      }),
    ]);
    if (!reply.ok) throw new Error(`in Chromium: ${reply.error}`);
    return reply.output;
  } finally {
    clearTimeout(expired);
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "estoc-crossing-"));
const exchange = await parties();
const sent = message(exchange);
const sealed = await sealedHere(exchange, sent.plaintext);
const output = browserPath === null ? undefined : await inChromium(browserPath, { corpus: { bytes: Array.from(await readFile(CORPUS_VAULT)), passphrase: CORPUS_PASSPHRASE }, exchange: { ...exchange, plaintext: sent.plaintext, sealed } }, dir);

afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(output === undefined)("the kept vault, crossing to Chromium", () => {
  const corpus = (): CrossingOutput["corpus"] => output!.corpus;

  it("reads there to the fold kept beside it and is shown there as the records kept beside it", async () => {
    expect(hashOf(corpus().fold)).toBe(await expected("fold.sha256"));
    expect(corpus().snapshot).toBe(await expected("snapshot.json"));
  });

  it("has, hashed there, each event and object under the CID it is kept under", async () => {
    const source = openPortable(openNodeSqlite(CORPUS_VAULT, { mode: "readonly" }));
    try {
      const events: string[] = [];
      for await (const event of source.vault.events.scan()) events.push(event.cid);
      const objects: string[] = [];
      for await (const cid of source.vault.objects.list()) objects.push(cid);
      expect(corpus().events).toEqual(events);
      expect(corpus().objects).toEqual(objects);
    } finally {
      source.close();
    }
  });

  it("restored and exported there, comes back a snapshot of this vault version that reads here as the vault it was", async () => {
    const file = path.join(dir, "exported.sqlite");
    await writeFile(file, new Uint8Array(corpus().exported));
    const source = openPortable(openNodeSqlite(file, { mode: "readonly" }));
    try {
      expect(source.metadata.version).toBe(VAULT_VERSION);
    } finally {
      source.close();
    }
    const read = await readCorpus(file);
    expect(hashOf(foldText(read.fold))).toBe(await expected("fold.sha256"));
    expect(snapshotText(read.snapshot)).toBe(await expected("snapshot.json"));
  });
});

describe.skipIf(output === undefined)("an envelope sealed by the didcomm build of one runtime", () => {
  const opened = { plaintext: sent.plaintext, sealer: `${exchange.sender}#agree`, intentCid: sent.intentCid, plaintextCid: sent.plaintextCid };

  it("opens in the other to the plaintext sealed, under the intent and plaintext CIDs its sender has", async () => {
    const crossed = output!.exchange;
    expect(crossed.opened).toEqual({ ...opened, envelopeCid: envelopeOf(sealed).cid });
    const back = openedOf(await unpack({ Message }, crossed.sealed, resolverOf(exchange.documents), secretsResolverFor(exchange.secrets.recipient)), crossed.sealed);
    expect(back).toEqual({ ...opened, envelopeCid: envelopeOf(crossed.sealed).cid });
  });
});
