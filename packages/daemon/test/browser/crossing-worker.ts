/**
 * The Chromium half of the crossing, in a dedicated Worker, where the
 * app runs its daemon: the kept vault is imported into the SQLite pool
 * and read there, each event and object hashed again, then restored
 * into a runtime and exported; the didcomm build the app loads opens
 * what Node sealed and seals the same plaintext in turn.
 */

import { secretsResolverFor, unpack, type DidcommApi } from "@estoc/agent-core";
import * as glue from "@estoc/didcomm/index_bg.js";
import { SqliteVault, eventCidOf, exportVault, openPortable, restoreVault } from "@estoc/event-store";
import { openSqlitePool, type SqlitePool } from "@estoc/event-store/browser";
import { Keys, rawCidOfBytes, vaultHeldRoots } from "@estoc/vault";

import { SCAN, foldText, readPortable, snapshotText } from "../corpus-read.js";
import { openedOf, resolverOf, type CrossingInput, type CrossingOutput, type WorkerReply } from "./crossing.js";

async function corpusIn(pool: SqlitePool, { bytes, passphrase }: CrossingInput["corpus"]): Promise<CrossingOutput["corpus"]> {
  await pool.importFile("kept", new Uint8Array(bytes));
  const source = openPortable(await pool.open("kept", "readonly"));
  try {
    const keys = await Keys.unlock(source.wrapped, passphrase, source.metadata.anchor);
    const { fold, snapshot } = await readPortable(source, keys);
    const events: string[] = [];
    for await (const event of source.vault.events.scan()) events.push(eventCidOf(event));
    const objects: string[] = [];
    for await (const cid of source.vault.objects.list()) {
      const object = await source.vault.objects.read(cid, Number.MAX_SAFE_INTEGER);
      if (object === null) throw new Error(`the vault lists ${cid} and holds no bytes for it`);
      objects.push(rawCidOfBytes(object));
    }
    const restored = new SqliteVault((await restoreVault(source, (mode) => pool.open("restored", mode), { heldRoots: vaultHeldRoots(null, SCAN), anchor: source.metadata.anchor })).runtime);
    try {
      await exportVault(restored, (mode) => pool.open("exported", mode), { heldRoots: vaultHeldRoots(keys, SCAN) });
    } finally {
      await restored.close();
    }
    return { fold: foldText(fold), snapshot: snapshotText(snapshot), events, objects, exported: Array.from(await pool.exportFile("exported")) };
  } finally {
    source.close();
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
