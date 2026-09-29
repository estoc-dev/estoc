import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

import { serveApi, type Port, type Session } from "@estoc/daemon-api/wire";

import { attachTo, limitsOf, methodsOf } from "../adapter.js";
import type { DaemonCore } from "../daemon.js";
import { staticHandler } from "./static.js";

export interface SocketOptions {
  /** the loopback address to listen on; never 0.0.0.0 by default */
  bind?: string;
  port: number;
  /** what a client must present as `?token=` to be answered at all */
  token: string;
  /** a directory of the built app to serve at `/`; without it plain HTTP gets a 426 */
  appDir?: string;
  /** the largest backup taken in or handed out, from which the other bounds a view is told follow; 512 MiB unless set */
  maxBackupBytes?: number;
  /** a failure of the daemon's own while answering a view, for the host's log */
  failed?(error: unknown): void;
}

export interface ServedOver {
  daemon: DaemonCore;
  /** the URL a view connects to, token included */
  url: string;
  /** where the app is served, when `appDir` was given */
  appUrl: string | null;
  close(): Promise<void>;
}

/** Sockets let in and not yet attached, at most; one more is closed at once. */
const MAX_PENDING = 16;

/** The WebSocket close code for an endpoint that is over what it takes on for now (RFC 6455 §7.4.1). */
const TRY_AGAIN_LATER = 1013;

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

/**
 * The daemon behind a WebSocket: one daemon, any number of views, each
 * socket a port the API is served over from the bootstrap on. Access
 * control is one rule: a socket is answered only with the token
 * (`?token=`), whoever asks — a page this daemon served, a page
 * elsewhere, another process on this machine; anything without it is
 * closed before a word is read. With `appDir` the daemon serves the app
 * itself, and hands the page the token in the link it prints.
 *
 * On top of that a request is answered only when `Host` is a name this
 * server actually answers to: a loopback name, the bound address, or
 * (bound to every interface) an address of this machine — all at the
 * bound port. A page anywhere can point a name of its own at 127.0.0.1
 * (DNS rebinding) and reach us; it gets nothing, socket or file.
 */
export async function serveOver(options: SocketOptions, daemon: DaemonCore): Promise<ServedOver> {
  const limits = limitsOf("text", options.maxBackupBytes);
  const failed = options.failed ?? (() => undefined);
  const methods = methodsOf(daemon, limits, { failed });
  const pending = new Set<Session>();

  const files = options.appDir === undefined ? null : staticHandler(options.appDir);
  const bind = options.bind ?? "127.0.0.1";
  let boundPort = options.port;
  const hostAllowed = (req: IncomingMessage) => hostIsOurs(req.headers.host, bind, boundPort);
  const http = createServer((req, res) => {
    if (!hostAllowed(req)) {
      res.writeHead(421, { "content-type": "text/plain" }).end("estoc-daemon: not a host of mine\n");
      return;
    }
    if (files === null) {
      res.writeHead(426, { "content-type": "text/plain" }).end("estoc-daemon: connect over WebSocket\n");
      return;
    }
    files(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes ?? undefined });
  http.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req) || !tokenMatches(req, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A frame the socket will not take — over `maxPayload`, text that is not UTF-8 — is an error on it, which closes it; unheard, the error would end the process.
      ws.on("error", () => undefined);
      if (pending.size >= MAX_PENDING) {
        ws.close(TRY_AGAIN_LATER, "too many sockets waiting to attach");
        return;
      }
      const session = serveApi(socketPort(ws), {
        methods,
        limits,
        implementation: `estoc-daemon ${version}`,
        attach: (attaching) => {
          pending.delete(attaching);
          return attachTo(daemon.publisher, attaching);
        },
        failed,
      });
      pending.add(session);
      session.onClose(() => pending.delete(session));
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, bind, () => resolve());
  });
  const address = http.address();
  boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  const hostPart = bind.includes(":") ? `[${bind}]` : bind;
  return {
    daemon,
    url: `ws://${hostPart}:${boundPort}/?token=${encodeURIComponent(options.token)}`,
    appUrl: files === null ? null : `http://${hostPart}:${boundPort}/?token=${encodeURIComponent(options.token)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => http.close(() => resolve()));
      }).then(() => daemon.close()),
  };
}

/** `Host` names this server: a loopback name, the bound address, or any address of this machine when bound to all — at the bound port. */
function hostIsOurs(header: string | undefined, bind: string, port: number): boolean {
  if (header === undefined) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(`http://${header}`);
  } catch {
    return false;
  }
  if (Number(url.port || "80") !== port) {
    return false;
  }
  const name = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "::ffff:127.0.0.1") {
    return true;
  }
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === "";
  if (!wildcard) {
    return name === bind.toLowerCase();
  }
  return Object.values(networkInterfaces()).some((addrs) => addrs?.some((a) => a.address.toLowerCase() === name));
}

function tokenMatches(req: IncomingMessage, token: string): boolean {
  const given = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A socket of the server's as a text port. A send resolves once the
 * frame is written out, so a reader that takes its time is felt by the
 * session's queue and nowhere else; a binary frame is handed over as
 * the bytes it is, which no session reads as a frame.
 */
function socketPort(ws: WebSocket): Port {
  return {
    transport: "text",
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        if (ws.readyState !== ws.OPEN) return resolve();
        ws.send(data as string, (error) => (error ? reject(error) : resolve()));
      }),
    listen(handlers) {
      ws.on("message", (data, isBinary) => handlers.message(isBinary ? data : data.toString()));
      ws.on("close", () => handlers.close());
    },
    close() {
      ws.close();
    },
  };
}
