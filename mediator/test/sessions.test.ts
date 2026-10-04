import { describe, expect, it } from "vitest";

import { Sessions, type SessionState } from "../src/transport/sessions.js";
import { peer4Agent } from "./helpers.js";

function socket() {
  const sent: string[] = [];
  const saved: SessionState[] = [];
  return {
    sent,
    saved,
    send(packed: string): boolean {
      sent.push(packed);
      return true;
    },
    save(state: SessionState): void {
      saved.push(state);
    },
  };
}

describe("a live session", () => {
  it("keeps the first DID it proves and is pushed to under that DID alone", () => {
    const sessions = new Sessions();
    const alice = socket();
    const session = sessions.open(alice);
    session.liveDelivery = true;

    session.bindFirst("did:example:alice");
    session.bindFirst("did:example:mallory");

    expect(session.did).toBe("did:example:alice");
    expect(sessions.wantsPush("did:example:mallory")).toBe(false);
    sessions.push("did:example:alice", "for alice");
    expect(alice.sent).toEqual(["for alice"]);
  });

  it("leaves the index when its socket closes", () => {
    const sessions = new Sessions();
    const session = sessions.open(socket());
    session.liveDelivery = true;
    session.bindFirst("did:example:alice");

    session.close();

    expect(sessions.wantsPush("did:example:alice")).toBe(false);
  });

  it("binds nothing once closed, so a proof that completes after the close leaves it out of the index", () => {
    const sessions = new Sessions();
    const session = sessions.open(socket());

    session.close();
    session.bindFirst("did:example:alice");
    session.liveDelivery = true;

    expect(session.did).toBeNull();
    expect(sessions.wantsPush("did:example:alice")).toBe(false);
  });

  it("saves the state it starts with and every change while open, and nothing once closed", () => {
    const held = socket();
    const session = new Sessions().open(held);

    session.bindFirst("did:example:alice");
    session.liveDelivery = true;
    session.returnRoute = true;
    session.close();
    session.liveDelivery = false;

    expect(held.saved).toEqual([
      { did: null, liveDelivery: false, returnRoute: false },
      { did: "did:example:alice", liveDelivery: false, returnRoute: false },
      { did: "did:example:alice", liveDelivery: true, returnRoute: false },
      { did: "did:example:alice", liveDelivery: true, returnRoute: true },
    ]);
  });

  it("restored from what it saved is indexed under the saved DID again, saving nothing", () => {
    const sessions = new Sessions();
    const held = socket();

    const session = sessions.open(held, { did: "did:example:alice", liveDelivery: true, returnRoute: true });
    session.bindFirst("did:example:mallory");

    expect(session.did).toBe("did:example:alice");
    expect(session.returnRoute).toBe(true);
    expect(held.saved).toEqual([]);
    sessions.push("did:example:alice", "for alice");
    expect(held.sent).toEqual(["for alice"]);
  });
});

describe("the session registry", () => {
  it("pushes a did:peer:4 to a socket that proved it in either spelling", async () => {
    const agent = await peer4Agent(null);
    const sessions = new Sessions();
    const long = socket();
    const short = socket();
    for (const [held, did] of [
      [long, agent.longForm],
      [short, agent.did],
    ] as const) {
      const session = sessions.open(held);
      session.liveDelivery = true;
      session.bindFirst(did);
    }

    sessions.push(agent.did, "pushed");

    expect(sessions.wantsPush(agent.longForm)).toBe(true);
    expect(long.sent).toEqual(["pushed"]);
    expect(short.sent).toEqual(["pushed"]);
  });

  it("pushes only to the sessions that turned live delivery on", () => {
    const sessions = new Sessions();
    const live = socket();
    const quiet = socket();
    const listening = sessions.open(live);
    listening.liveDelivery = true;
    listening.bindFirst("did:example:alice");
    sessions.open(quiet).bindFirst("did:example:alice");

    sessions.push("did:example:alice", "pushed");

    expect(live.sent).toEqual(["pushed"]);
    expect(quiet.sent).toEqual([]);
  });
});
