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

export class Sessions implements LiveSink {
  private byDid = new Map<string, Set<Session>>();

  bind(did: string, session: Session): void {
    const set = this.byDid.get(indexed(did)) ?? new Set();
    set.add(session);
    this.byDid.set(indexed(did), set);
  }

  drop(did: string | null, session: Session): void {
    if (did === null) {
      return;
    }
    const set = this.byDid.get(indexed(did));
    if (set !== undefined) {
      set.delete(session);
      if (set.size === 0) {
        this.byDid.delete(indexed(did));
      }
    }
  }

  liveSessionsFor(did: string): Session[] {
    return [...(this.byDid.get(indexed(did)) ?? [])].filter(
      (session) => session.liveDelivery
    );
  }

  wantsPush(ownerDid: string): boolean {
    return this.liveSessionsFor(ownerDid).length > 0;
  }

  push(ownerDid: string, packedDelivery: string): void {
    for (const session of this.liveSessionsFor(ownerDid)) {
      session.send(packedDelivery);
    }
  }
}
