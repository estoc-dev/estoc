import { reconnecting, type Client } from "@estoc/daemon-api/client";
import { messagePortOf, webSocketOf, type Port } from "@estoc/daemon-api/wire";

/**
 * The daemon as this page reaches it. By default a dedicated worker,
 * alive as long as the tab, holding the vault in this origin's storage.
 * Or a process on this machine over a WebSocket, its vault a file on
 * disk: either this very page was served by `estoc-daemon` (it marks its
 * index.html with a `<meta name="estoc-daemon">`, the socket is this
 * origin's, and the link it printed carries the token as `?token=`), or
 * the page was opened with `?_daemon=ws://…?token=…` from what the daemon
 * printed, a choice remembered here until `?_daemon=off`. The token is
 * the only key either way; a page without one is answered by nobody and
 * says so. Either way the UI holds one client of the API and nothing
 * else: a connection that ends is followed by another, negotiated and
 * attached afresh, and a call the old one lost stays lost.
 */

const DAEMON_KEY = "estoc:daemon";
const TOKEN_KEY = "estoc:daemon-token";

/** Read (and strip) `?_daemon=` from the URL, remembering the choice; the remembered URL, if any. */
export function takeDaemonUrl(): string | null {
  const url = new URL(location.href);
  const given = url.searchParams.get("_daemon");
  if (given !== null) {
    url.searchParams.delete("_daemon");
    history.replaceState(null, "", url);
    try {
      if (given === "off" || given === "") {
        localStorage.removeItem(DAEMON_KEY);
      } else {
        localStorage.setItem(DAEMON_KEY, given);
      }
    } catch {
      // no storage: this page only
      return given === "off" || given === "" ? null : given;
    }
  }
  try {
    return localStorage.getItem(DAEMON_KEY);
  } catch {
    return null;
  }
}

export interface Started {
  client: Client;
  /** where the daemon is: in this page, or at a socket */
  where: "worker" | string;
}

/**
 * The socket of the daemon that served this page, if one did: this
 * origin's, with the token read (and stripped) from `?token=` and
 * remembered, so a reload or a second tab here gets in too.
 */
function servedByDaemon(): string | null {
  const meta = document.querySelector('meta[name="estoc-daemon"]');
  if (meta === null) {
    return null;
  }
  const url = new URL(location.href);
  let token = url.searchParams.get("token");
  if (token !== null) {
    url.searchParams.delete("token");
    history.replaceState(null, "", url);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // no storage: this page only
    }
  } else {
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
  }
  const socket = new URL(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`);
  if (token !== null) {
    socket.searchParams.set("token", token);
  }
  return socket.href;
}

/** A port of the worker's own, one session's: the worker serves each port it is handed. */
function portTo(worker: Worker): Port {
  const { port1, port2 } = new MessageChannel();
  worker.postMessage(port2, [port2]);
  return messagePortOf(port1);
}

export function startDaemon(): Started {
  const remote = servedByDaemon() ?? takeDaemonUrl();
  if (remote === null) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return { client: reconnecting(() => portTo(worker)), where: "worker" };
  }
  return { client: reconnecting(() => webSocketOf(new WebSocket(remote)), { delayMs: 2000 }), where: remote };
}
