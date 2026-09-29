import { describe, expect, it } from "vitest";

import { invitationOf, invitationUrl, mediatorHost, mediatorInputOf } from "../../src/views/index.js";

const service = (endpoint: unknown) => "S" + btoa(JSON.stringify({ t: "dm", s: endpoint })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("what names a mediator", () => {
  it("is a DID as it is, an invitation link for the DID it discloses, or a URL to ask at", () => {
    expect(mediatorInputOf(" did:web:mediator.example ")).toEqual({ did: "did:web:mediator.example", url: null });
    expect(mediatorInputOf(invitationUrl("https://mediator.example/", invitationOf("did:peer:2.Ez6Mk", "oob", null)))).toEqual({ did: "did:peer:2.Ez6Mk", url: null });
    expect(mediatorInputOf("https://mediator.example")).toEqual({ did: null, url: "https://mediator.example" });
  });

  it("refuses nothing, and text that is neither", () => {
    expect(() => mediatorInputOf("")).toThrow("paste an invitation URL");
    expect(() => mediatorInputOf("mediator")).toThrow("not a DID or a URL");
    expect(() => mediatorInputOf("https://mediator.example/?_oob=nope")).toThrow("does not decode");
  });
});

describe("the host a mediator's DID names", () => {
  it("is the did:web domain, path segments dropped", () => {
    expect(mediatorHost("did:web:mediator.estoc.dev")).toBe("mediator.estoc.dev");
    expect(mediatorHost("did:web:mediator.example:some:path")).toBe("mediator.example");
    expect(mediatorHost("did:web:localhost%3A8080")).toBe("localhost:8080");
  });

  it("is the HTTP endpoint a did:peer:2 inlines, as a string or as an object, past services that are none", () => {
    expect(mediatorHost(`did:peer:2.Ez6MkKey.Vz6MkOther.${service("wss://mediator.example/ws")}.${service("https://mediator.example:8443/didcomm")}`)).toBe("mediator.example:8443");
    expect(mediatorHost(`did:peer:2.Ez6MkKey.${service({ uri: "http://localhost:8080", accept: ["didcomm/v2"] })}`)).toBe("localhost:8080");
    expect(mediatorHost(`did:peer:2.Ez6MkKey.Snot*base64.${service("https://mediator.example")}`)).toBe("mediator.example");
  });

  it("is null for a DID that names none", () => {
    expect(mediatorHost("did:peer:2.Ez6MkKey")).toBeNull();
    expect(mediatorHost(`did:peer:2.${service("not a url")}`)).toBeNull();
    expect(mediatorHost("did:peer:4zQmSomeone")).toBeNull();
    expect(mediatorHost("did:web:")).toBeNull();
  });
});
