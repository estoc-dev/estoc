import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

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

  it("holds under fetchWebDid: a did:web on loopback that the name check allows is still refused at lookup", async () => {
    const fetched = await fetchWebDid("did:web:localhost%3A8787", { fetch: guardedFetch, insecureLoopback: true });
    expect(fetched).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("the transport refused the connection: refused: localhost resolves to") });
  });
});
