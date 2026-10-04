import { frameBytes } from "../app.js";
import { dispatch } from "../protocols/dispatch.js";
import { Sessions, type LiveSession, type SessionState } from "../transport/sessions.js";
import { depsForOrigin, type Env, type WorkerDeps } from "./env.js";

/**
 * The Durable Object holding every live WebSocket — the stateful heart the
 * stateless Worker cannot be.
 *
 * One instance for the whole mediator (idFromName("hub")), which is a direct
 * port of the Node server's in-memory session registry rather than the
 * per-account-object design: a session only learns which account it is *after*
 * its first authenticated frame, so connections cannot be routed to a
 * per-account object at upgrade time without a second registry anyway. At the
 * scale where one object's throughput becomes the bottleneck, that redesign
 * is the known next step.
 *
 * Sockets are hibernatable: the object can be evicted while connections stay
 * open, so each socket's proven DID and live-delivery flag ride along as its
 * serialized attachment, and the constructor rebuilds the registry from
 * whatever sockets survived.
 */

interface Attachment extends SessionState {
  /** The origin the socket connected on — which of the mediator's names it talks to. */
  origin: string | null;
}

interface Connection {
  session: LiveSession;
  origin: string | null;
}

/**
 * Close codes the runtime reports but no Close frame may carry (RFC 6455
 * §7.4.1): the client's frame had no code (1005), no frame arrived at all
 * (1006), or the TLS handshake failed (1015).
 */
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);

export class InboxHub {
  private sessions = new Sessions();
  private bySocket = new Map<WebSocket, Connection>();
  // One identity per origin, resolved lazily — the DO wakes from hibernation
  // with sockets but no request, so the origin rides each socket's attachment.
  private deps = new Map<string, Promise<WorkerDeps>>();

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {
    for (const ws of state.getWebSockets()) {
      this.adopt(ws);
    }
  }

  private depsFor(origin: string): Promise<WorkerDeps> {
    let deps = this.deps.get(origin);
    if (deps === undefined) {
      deps = depsForOrigin(this.env, origin);
      deps.catch(() => this.deps.delete(origin));
      this.deps.set(origin, deps);
    }
    return deps;
  }

  private adopt(ws: WebSocket, origin?: string): Connection {
    const saved = (ws.deserializeAttachment() ?? null) as Attachment | null;
    const connectedOn = origin ?? saved?.origin ?? null;
    const session = this.sessions.open(
      {
        send(packed: string): boolean {
          try {
            // Text frame — reaches every receiver as a plain string; binary
            // arrives as Blob/Buffer/ArrayBuffer depending on the environment.
            ws.send(packed);
            return true;
          } catch {
            return false;
          }
        },
        save(state: SessionState): void {
          ws.serializeAttachment({ ...state, origin: connectedOn } satisfies Attachment);
        },
      },
      saved
    );
    const connection = { session, origin: connectedOn };
    this.bySocket.set(ws, connection);
    return connection;
  }

  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      this.adopt(pair[1], new URL(request.url).origin);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // The Worker-facing side, unreachable from the internet (Durable Objects
    // only answer their binding): live-session queries and delivery pushes.
    const url = new URL(request.url);

    if (url.pathname === "/live") {
      const did = url.searchParams.get("did") ?? "";
      return Response.json({ live: this.sessions.wantsPush(did) });
    }

    if (url.pathname === "/push" && request.method === "POST") {
      const { did, packed } = (await request.json()) as {
        did: string;
        packed: string;
      };
      this.sessions.push(did, packed);
      return Response.json({ ok: true });
    }

    return new Response(null, { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const { session, origin } = this.bySocket.get(ws) ?? this.adopt(ws);
    if (origin === null) {
      // A socket from before origins were persisted — it cannot be answered
      // as the name it connected to, so it gets a fresh start instead.
      ws.close(1011, "reconnect");
      return;
    }
    try {
      const deps = await this.depsFor(origin);
      if (frameBytes(message) > deps.policy.maxMessageBytes) {
        console.warn("websocket envelope refused: too large");
        return;
      }
      const raw =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      const unpacked = await deps.ctx.unpack(raw);
      if (unpacked.verifiedFrom !== null) {
        session.bindFirst(unpacked.verifiedFrom);
      }

      const packed = await dispatch(unpacked, {
        ctx: deps.ctx,
        store: deps.store,
        config: deps.policy,
        sessions: this.sessions,
        blobs: deps.blobs,
        session,
        sender: unpacked.verifiedFrom,
        log: (message, error) => console.warn(message, error),
      });

      if (packed !== null) {
        session.send(packed);
      }
    } catch (err) {
      console.warn("websocket envelope refused", err);
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.drop(ws);
    // The runtime leaves a hibernatable socket's closing handshake to the
    // object; unanswered, the client waits out its close timeout and
    // records the connection as dropped (1006).
    if (UNSENDABLE_CLOSE_CODES.has(code)) {
      ws.close();
    } else {
      ws.close(code, reason);
    }
  }

  webSocketError(ws: WebSocket) {
    this.drop(ws);
  }

  private drop(ws: WebSocket) {
    this.bySocket.get(ws)?.session.close();
    this.bySocket.delete(ws);
  }
}
