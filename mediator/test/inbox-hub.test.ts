import { fileURLToPath } from "node:url";

import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, experimental_readRawConfig } from "wrangler";
import WebSocket from "ws";

import {
  agent,
  ENCRYPTED,
  forwardOf,
  packAnonymous,
  plaintext,
  sealed,
  type TestAgent,
} from "./helpers.js";

/**
 * The Workers deployment on a local workerd, for what a socket double cannot
 * show: how the runtime closes and hibernates the inbox object's sockets.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

// The deployed configuration without its build step: the workspace libraries
// are built before any test runs, and rebuilding them here would rewrite
// files that other test files are importing.
const {
  rawConfig: { env: _environments, build: _build, ...deployed },
} = experimental_readRawConfig({ config: `${root}/wrangler.jsonc` });

const server = createTestHarness({ root, workers: [{ config: deployed }] });

let origin: URL;
let mediatorDid: string;

beforeAll(async () => {
  ({ url: origin } = await server.listen());
  mediatorDid = ((await (await server.fetch("/")).json()) as { did: string }).did;
}, 60_000);

afterAll(async () => {
  await server.close();
});

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
    setTimeout(() => reject(new Error("timed out waiting for a frame")), 5000);
  });
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    setTimeout(() => reject(new Error("timed out waiting for a Close frame")), 5000);
  });
}

async function request(
  ws: WebSocket,
  sender: TestAgent,
  type: string,
  body: Record<string, unknown>
) {
  const packed = await sender.ctx.packEncrypted(
    plaintext(type, body, { from: sender.did, to: [mediatorDid], return_route: "all" }),
    mediatorDid
  );
  const waiting = nextMessage(ws);
  ws.send(packed);
  return (await sender.ctx.unpack(await waiting)).message;
}

/** A socket of `owner`'s, mediated and in live-delivery mode. */
async function liveSocket(owner: TestAgent): Promise<WebSocket> {
  const ws = new WebSocket(new URL("/", origin.href.replace(/^http/, "ws")));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await request(ws, owner, "https://didcomm.org/coordinate-mediation/3.0/mediate-request", {});
  await request(ws, owner, "https://didcomm.org/messagepickup/3.0/live-delivery-change", {
    live_delivery: true,
  });
  return ws;
}

async function isLive(did: string): Promise<boolean> {
  const env = await server.getWorker<{ INBOX: DurableObjectNamespace }>().getEnv();
  const res = await env.INBOX.get(env.INBOX.idFromName("hub")).fetch(
    `https://inbox/live?did=${encodeURIComponent(did)}`
  );
  return ((await res.json()) as { live: boolean }).live;
}

describe("the inbox Durable Object", () => {
  it("answers a client's Close frame with its code and reason", async () => {
    const alice = await agent("alice-closes");
    const ws = await liveSocket(alice);
    expect(await isLive(alice.did)).toBe(true);

    const answer = closed(ws);
    ws.close(4000, "done");

    expect(await answer).toEqual({ code: 4000, reason: "done" });
    expect(await isLive(alice.did)).toBe(false);
  });

  it("answers a Close frame without a code with one without a code", async () => {
    const ws = await liveSocket(await agent("bob-closes"));

    const answer = closed(ws);
    ws.close();

    expect(await answer).toEqual({ code: 1005, reason: "" });
  });

  it("pushes to a socket that stayed open while the object hibernated", async () => {
    const carol = await agent("carol-hibernates");
    const ws = await liveSocket(carol);

    await server
      .getWorker()
      .evictDurableObject("INBOX", { name: "hub", webSockets: "hibernate" });

    const forward = forwardOf(carol.did, await sealed(carol, "while asleep"));
    const push = nextMessage(ws);
    const res = await server.fetch("/", {
      method: "POST",
      headers: { "content-type": ENCRYPTED },
      body: await packAnonymous(forward, mediatorDid),
    });
    expect(res.status).toBe(202);
    const { message } = await carol.ctx.unpack(await push);
    expect(message.type).toBe("https://didcomm.org/messagepickup/3.0/delivery");

    ws.close();
  });
});
