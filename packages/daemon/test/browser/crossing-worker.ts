/**
 * The Chromium half of the crossing, in a dedicated Worker, where the
 * app runs its daemon: the kept vault's snapshot is read there, each
 * event and object hashed again, then restored into a runtime in the
 * SQLite pool and exported; the didcomm build the app loads opens what
 * Node sealed and seals the same plaintext in turn.
 */

import { secretsResolverFor, unpack, type DidcommApi } from "@estoc/agent-core";
import * as glue from "@estoc/didcomm/index_bg.js";
import { SqliteVault, eventCidOf, exportSnapshot, restoreSnapshot } from "@estoc/event-store";
import { openSqlitePool, type SqlitePool } from "@estoc/event-store/browser";
import { rawCidOfBytes, vaultHeldRoots } from "@estoc/vault";

import { SCAN, foldText, keptVault, readKept, snapshotText } from "../corpus-read.js";
import { openedOf, resolverOf, type CrossingInput, type CrossingOutput, type WorkerReply } from "./crossing.js";

async function corpusIn(pool: SqlitePool, { bytes, passphrase }: CrossingInput["corpus"]): Promise<CrossingOutput["corpus"]> {
  const kept = await keptVault(new Uint8Array(bytes), passphrase);
  const { vault, metadata } = kept.snapshot;
  const { fold, snapshot } = await readKept(kept);
  const events: string[] = [];
  for await (const event of vault.events.scan()) events.push(eventCidOf(event));
  const objects: string[] = [];
  for await (const cid of vault.objects.list()) {
    const object = await vault.objects.read(cid, Number.MAX_SAFE_INTEGER);
    if (object === null) throw new Error(`the snapshot lists ${cid} and holds no bytes for it`);
    objects.push(rawCidOfBytes(object));
  }
  const restored = new SqliteVault((await restoreSnapshot(kept.snapshot, () => pool.open("restored", "create"), { anchor: metadata.anchor })).runtime);
  try {
    const exported = await exportSnapshot(restored, { parts: "both", heldRoots: vaultHeldRoots(kept.keys, SCAN) });
    return { fold: foldText(fold), snapshot: snapshotText(snapshot), events, objects, exported: Array.from(exported) };
  } finally {
    await restored.close();
  }
}

/** The build the app loads, wired as the app wires it: the wasm's every import is the glue module. */
async function didcommOfThisBrowser(): Promise<DidcommApi> {
  const { instance } = await WebAssembly.instantiateStreaming(fetch("/didcomm.wasm"), { "./index_bg.js": glue as unknown as WebAssembly.ModuleImports });
  glue.__wbg_set_wasm(instance.exports);
  (instance.exports as { __wbindgen_start(): void }).__wbindgen_start();
  return { Message: glue.Message };
}

async function exchangeIn({ sender, recipient, documents, secrets, plaintext, sealed }: CrossingInput["exchange"]): Promise<CrossingOutput["exchange"]> {
  const didcomm = await didcommOfThisBrowser();
  const resolver = resolverOf(documents);
  const opened = openedOf(await unpack(didcomm, sealed, resolver, secretsResolverFor(secrets.recipient)), sealed);
  const message = new didcomm.Message(plaintext);
  try {
    const [ours] = await message.pack_encrypted(`${recipient}#agree`, `${sender}#agree`, null, resolver, secretsResolverFor(secrets.sender), { forward: false });
    return { opened, sealed: ours };
  } finally {
    message.free();
  }
}

self.onmessage = async ({ data }: MessageEvent<CrossingInput>) => {
  let reply: WorkerReply;
  try {
    const pool = await openSqlitePool({ directory: "crossing" });
    try {
      reply = { ok: true, output: { corpus: await corpusIn(pool, data.corpus), exchange: await exchangeIn(data.exchange) } };
    } finally {
      await pool.close();
    }
  } catch (err) {
    reply = { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err) };
  }
  self.postMessage(reply);
};
