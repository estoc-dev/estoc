import { serveOver, type ServedOver, type SocketOptions } from "./socket.js";
import { createDaemon } from "../daemon.js";
import type { DaemonHost } from "../host.js";

export interface ServeOptions extends SocketOptions {
  host: DaemonHost;
}

export type Served = ServedOver;

/** The daemon behind a WebSocket, under the rules of `serveOver`: one daemon, any number of views, each answered only with the token. */
export function serveDaemon(options: ServeOptions): Promise<Served> {
  return serveOver(options, createDaemon(options.host, () => undefined));
}
