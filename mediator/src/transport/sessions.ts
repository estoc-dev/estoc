import { isLongForm, longToShort } from "@estoc/did-peer";

import type { LiveSink, Session } from "../protocols/types.js";

/**
 * The WebSocket connections currently open, indexed by the DID each one has
 * proven. A session joins the index on its first authenticated message and
 * leaves when the socket closes; live delivery consults the index, so a
 * closed socket stops receiving pushes by ceasing to exist.
 *
 * A did:peer:4 is indexed under its short form: a connection proves the DID
 * in whichever spelling it sealed with, and mail is pushed to the spelling
 * the store keeps, which need not be the same one.
 *
 * Used wherever the sockets and the index live in the same memory: the Node
 * server process, and the inbox Durable Object on Workers.
 */
const indexed = (did: string): string => (isLongForm(did) ? longToShort(did) : did);

type Index = Map<string, Set<LiveSession>>;

/** What a session holds apart from its socket: what a host whose sockets outlive it keeps beside each one. */
export interface SessionState {
  did: string | null;
  liveDelivery: boolean;
  returnRoute: boolean;
}

/** The transport's side of a session. */
export interface Socket {
  /** Push a packed message to the client; false once the connection is gone. */
  send(packed: string): boolean;
  /** Keeps `state` beside the socket, for a host whose sockets outlive it: called with the state a new session starts with, and on every change while the session is open. */
  save?(state: SessionState): void;
}

let openSession: (index: Index, socket: Socket, saved: SessionState | null) => LiveSession;

/**
 * A session the registry opened, which the transport holding its socket
 * binds and closes. It is indexed under the first DID it proves and under
 * no other while it is open: live delivery needs a DID to index the
 * connection under, and a session that could re-bind mid-flight could be
 * walked onto someone else's inbox by a single crafted envelope. Once
 * closed it is indexed under none, and a proof that completes after the
 * close binds nothing.
 */
export class LiveSession implements Session {
  static {
    openSession = (index, socket, saved) => new LiveSession(index, socket, saved);
  }

  private readonly state: SessionState = { did: null, liveDelivery: false, returnRoute: false };
  private closed = false;

  private constructor(
    private readonly index: Index,
    private readonly socket: Socket,
    saved: SessionState | null
  ) {
    if (saved === null) {
      this.save();
      return;
    }
    this.state.liveDelivery = saved.liveDelivery;
    this.state.returnRoute = saved.returnRoute;
    if (saved.did !== null) {
      this.join(saved.did);
    }
  }

  get did(): string | null {
    return this.state.did;
  }

  get liveDelivery(): boolean {
    return this.state.liveDelivery;
  }

  set liveDelivery(value: boolean) {
    this.state.liveDelivery = value;
    this.save();
  }

  get returnRoute(): boolean {
    return this.state.returnRoute;
  }

  set returnRoute(value: boolean) {
    this.state.returnRoute = value;
    this.save();
  }

  send(packed: string): boolean {
    return this.socket.send(packed);
  }

  /** Binds the session to `did`, the sender an envelope on it proved, unless it has proven one already or has closed. */
  bindFirst(did: string): void {
    if (this.state.did !== null || this.closed) {
      return;
    }
    this.join(did);
    this.save();
  }

  /** Takes the session out of the index for good: its socket has closed. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.state.did === null) {
      return;
    }
    const key = indexed(this.state.did);
    const set = this.index.get(key);
    if (set !== undefined) {
      set.delete(this);
      if (set.size === 0) {
        this.index.delete(key);
      }
    }
  }

  private join(did: string): void {
    this.state.did = did;
    const key = indexed(did);
    const set = this.index.get(key) ?? new Set();
    set.add(this);
    this.index.set(key, set);
  }

  private save(): void {
    if (!this.closed) {
      this.socket.save?.({ ...this.state });
    }
  }
}

export class Sessions implements LiveSink {
  private readonly byDid: Index = new Map();

  /**
   * A session over `socket`: one just accepted, bound to no DID yet; or,
   * given the state a host saved for a socket that outlived it, the same
   * session again, bound to the DID that state names.
   */
  open(socket: Socket, saved: SessionState | null = null): LiveSession {
    return openSession(this.byDid, socket, saved);
  }

  wantsPush(ownerDid: string): boolean {
    return this.liveSessionsFor(ownerDid).length > 0;
  }

  push(ownerDid: string, packedDelivery: string): void {
    for (const session of this.liveSessionsFor(ownerDid)) {
      session.send(packedDelivery);
    }
  }

  private liveSessionsFor(did: string): LiveSession[] {
    return [...(this.byDid.get(indexed(did)) ?? [])].filter((session) => session.liveDelivery);
  }
}
