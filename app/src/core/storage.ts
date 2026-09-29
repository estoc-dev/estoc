/**
 * What the page itself asks the browser about its storage. The vault is
 * the daemon's (src/daemon/worker.ts: a SQLite database in a directory of
 * this origin's private file system); these two calls are Window-only, so
 * the UI makes them and shows the answer on the You screen.
 */

/**
 * Ask the browser to treat this origin's storage as persistent — not
 * evictable under pressure. Chromium grants it silently to installed apps
 * and to sites the user engages with; Firefox asks; Safari grants it to
 * home-screen apps. Returns whether it is now persisted.
 */
export async function persistStorage(): Promise<boolean> {
  if (!("storage" in navigator) || typeof navigator.storage.persist !== "function") {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (!("storage" in navigator) || typeof navigator.storage.persisted !== "function") {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Why the browser refuses this page the private file system its worker
 * keeps the vault in; null where it grants it. Firefox refuses it in a
 * private window.
 */
export async function fileSystemRefused(): Promise<string | null> {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    return "this browser has no private file system for pages";
  }
  try {
    await navigator.storage.getDirectory();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
