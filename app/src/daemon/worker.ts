import { openSqlitePool } from "@estoc/event-store/browser";
import type { DidcommApi } from "@estoc/agent-core";
import { attachTo, createDaemon, limitsOf, methodsOf, type DaemonHost, type DaemonStorage } from "@estoc/daemon";
import { messagePortOf, serveApi } from "@estoc/daemon-api/wire";

import { Message, initDidcomm } from "../didcomm/wasm.js";
import { cacheSeedKey, cachedSeedKey, forgetSeedKey } from "./keycache.js";
import { FOLDER_VAULT, POOL_DIRECTORY } from "./places.js";

/**
 * The daemon in a dedicated worker of this page: the vault is one SQLite
 * database in a pool of access handles over a directory of this origin's
 * private file system (one identity per install), and a snapshot on its
 * way in or out is a database beside it. The pool is one worker's at a
 * time, by a Web Lock it takes with the directory, so a second tab waits
 * for the first to close. The unlocked seed waits in IndexedDB between
 * sessions as a non-extractable key. The worker's life is the tab's.
 *
 * The daemon boots as soon as the worker does, whether or not a view is
 * looking. The page reaches it over the API: each message port the page
 * hands over is one view's session, served from the bootstrap on.
 */
async function storage(): Promise<DaemonStorage> {
  const pool = await openSqlitePool({ directory: POOL_DIRECTORY });
  return {
    has: async (name) => pool.names().includes(name),
    open: (name, mode) => pool.open(name, mode),
    exportFile: (name) => pool.exportFile(name),
    importFile: (name, bytes) => pool.importFile(name, bytes),
    async remove(name) {
      if (pool.names().includes(name)) pool.remove(name);
    },
    close: () => pool.close(),
  };
}

const host: DaemonHost = {
  storage,
  async foreign() {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getDirectoryHandle(FOLDER_VAULT);
    } catch {
      return null;
    }
    return "this browser holds a vault of the folder format, which this version does not read or migrate; it is left as it is";
  },
  cachedSeedKey,
  cacheSeedKey,
  forgetSeedKey,
  async didcomm(): Promise<DidcommApi> {
    await initDidcomm();
    return { Message };
  },
  onOnline: (callback) => self.addEventListener("online", callback),
};

const daemon = createDaemon(host, () => undefined);
const limits = limitsOf("clone");
const failed = (error: unknown) => console.error("estoc daemon:", error);
const methods = methodsOf(daemon, limits, { failed });

self.addEventListener("message", ({ data }: MessageEvent) => {
  if (!(data instanceof MessagePort)) return;
  serveApi(messagePortOf(data), { methods, limits, implementation: `estoc-app ${__APP_VERSION__}`, attach: (session) => attachTo(daemon.publisher, session), failed });
});

void daemon.boot();
