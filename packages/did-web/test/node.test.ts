import { createServer } from "node:http";
import { text } from "node:stream/consumers";

import { Agent, MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFINITIVE_TRANSPORT_CODES, fetchWebDid } from "../src/index.js";
import { guardedFetch, isPublicAddress } from "../src/node.js";

describe("isPublicAddress", () => {
  it("knows a public unicast address from the rest", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe("guardedFetch", () => {
  it("refuses a loopback literal, a loopback name, a private literal and another scheme without connecting, as a final answer", async () => {
    let reached = 0;
    const server = createServer((_req, res) => {
      reached += 1;
      res.end("secret");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const refused = { message: expect.stringMatching(/^refused: /), code: DEFINITIVE_TRANSPORT_CODES.refused };
    try {
      await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject(refused);
      await expect(guardedFetch(`http://localhost:${port}/`)).rejects.toMatchObject(refused);
      await expect(guardedFetch(`http://[::1]:${port}/`)).rejects.toMatchObject(refused);
      await expect(guardedFetch("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject(refused);
      await expect(guardedFetch("ftp://bob.example/did.json")).rejects.toMatchObject({ ...refused, message: expect.stringContaining("scheme") });
      expect(reached).toBe(0);
    } finally {
      server.close();
    }
  });

  describe("to a public server", () => {
    const PUBLIC = "https://public.example";
    const mock = new MockAgent();
    mock.disableNetConnect();
    const server = mock.get(PUBLIC);
    const dispatch = Agent.prototype.dispatch;

    // undici's mock stands in for the public server, handed the body as the
    // server would read it; a request to any other origin goes out through
    // the guarded agent as it would.
    beforeEach(() => {
      vi.spyOn(Agent.prototype, "dispatch").mockImplementation(function (this: Agent, options, handler) {
        if (String(options.origin) !== PUBLIC) return dispatch.call(this, options, handler);
        const body = options.body == null ? Promise.resolve(undefined) : text(options.body as AsyncIterable<Uint8Array>);
        void body.then((read) => server.dispatch({ ...options, body: read }, handler));
        return true;
      });
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(() => mock.close());

    it("answers a redirect with the redirect itself, whatever the request asks, and connects to nothing it points at", async () => {
      let reached = 0;
      const local = createServer((_req, res) => {
        reached += 1;
        res.end("secret");
      });
      await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
      const location = `http://127.0.0.1:${(local.address() as { port: number }).port}/`;
      server.intercept({ path: "/moved" }).reply(302, "", { headers: { location } }).persist();
      try {
        for (const request of [guardedFetch(`${PUBLIC}/moved`), guardedFetch(`${PUBLIC}/moved`, { redirect: "follow" }), guardedFetch(new Request(`${PUBLIC}/moved`))]) {
          const response = await request;
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toBe(location);
        }
        await expect(guardedFetch(`${PUBLIC}/moved`, { redirect: "error" })).rejects.toThrow();
        expect(reached).toBe(0);
      } finally {
        local.close();
      }
    });

    it("sends a Request as fetch would: its method, headers and body with init over them, its length, and its abort", async () => {
      const contentType = "application/didcomm-encrypted+json";
      server.intercept({ path: "/inbox", method: "POST", body: "packed", headers: { "content-type": contentType, "content-length": "6" } }).reply(202, "taken").times(2);

      const request = new Request(`${PUBLIC}/inbox`, { method: "PUT", headers: { "content-type": contentType }, body: "packed" });
      expect((await guardedFetch(request, { method: "POST" })).status).toBe(202);
      expect((await guardedFetch(`${PUBLIC}/inbox`, { method: "POST", headers: { "content-type": contentType }, body: "packed" })).status).toBe(202);

      const stopped = new AbortController();
      stopped.abort();
      await expect(guardedFetch(new Request(`${PUBLIC}/inbox`, { signal: stopped.signal }))).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  it("holds under fetchWebDid: a did:web on loopback that the name check allows is still refused at lookup", async () => {
    const fetched = await fetchWebDid("did:web:localhost%3A8787", { fetch: guardedFetch, insecureLoopback: true });
    expect(fetched).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("the transport refused the connection: refused: localhost resolves to") });
  });
});
