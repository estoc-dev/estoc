import { describe, expect, it } from "vitest";

import { authorizedMethodIds, definedMethod, DIDDocumentError, serviceIds } from "../src/document.js";
import { isDid, isDidUrl, splitDidUrl } from "../src/did-url.js";
import { encodeLongForm, resolveLongForm } from "../src/did-peer-4.js";

const KEY = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const KEY2 = "z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2";

const LONG = encodeLongForm({
  verificationMethod: [
    { id: "#key-1", type: "Multikey", publicKeyMultibase: KEY },
    { id: "#key-2", type: "Multikey", publicKeyMultibase: KEY2 },
  ],
  authentication: ["#key-1", { id: "#embedded", type: "Multikey", publicKeyMultibase: KEY2 }],
  keyAgreement: ["#key-2"],
  service: [{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: "https://bob.example" }],
});
const DOCUMENT = resolveLongForm(LONG);

describe("isDid and isDidUrl", () => {
  it("hold a spelling to the DID Core grammar exactly as written", () => {
    expect(isDid("did:web:bob.example")).toBe(true);
    expect(isDid("did:web:bob%2Eexample")).toBe(true);
    expect(isDid("did:Web:bob.example")).toBe(false);
    expect(isDid("did:web:bob.example#key-1")).toBe(false);
    expect(isDidUrl("did:web:bob.example/path?versionId=1#key-1")).toBe(true);
    expect(isDidUrl("did:web:bob.example#key 1")).toBe(false);
    expect(isDidUrl("did:web:bob.example#a#b")).toBe(false);
    expect(isDidUrl("did:web:bob.example#%zz")).toBe(false);
    expect(isDidUrl("#key-1")).toBe(false);
  });
});

describe("splitDidUrl", () => {
  it("splits at the first path, query or fragment delimiter", () => {
    expect(splitDidUrl("did:web:bob.example#key-1")).toEqual(["did:web:bob.example", "#key-1"]);
    expect(splitDidUrl("did:web:bob.example?versionId=1#key-1")).toEqual(["did:web:bob.example", "?versionId=1#key-1"]);
    expect(splitDidUrl("did:web:bob.example/path#key-1")).toEqual(["did:web:bob.example", "/path#key-1"]);
    expect(splitDidUrl("did:web:bob.example")).toEqual(["did:web:bob.example", ""]);
  });
});

describe("authorizedMethodIds", () => {
  it("lists references resolved against the document id and embedded methods by their own ids, in order", () => {
    expect(authorizedMethodIds(DOCUMENT, "authentication")).toEqual([`${LONG}#key-1`, `${LONG}#embedded`]);
    expect(authorizedMethodIds(DOCUMENT, "keyAgreement")).toEqual([`${LONG}#key-2`]);
    expect(authorizedMethodIds(DOCUMENT, "assertionMethod")).toEqual([]);
  });

  it("resolves a query reference as it resolves a fragment reference", () => {
    const document = { id: "did:web:bob.example", verificationMethod: [{ id: "?versionId=1#a", type: "Multikey", publicKeyMultibase: KEY }], authentication: ["?versionId=1#a"] };
    expect(authorizedMethodIds(document, "authentication")).toEqual(["did:web:bob.example?versionId=1#a"]);
  });

  it("keeps an absolute reference, into this document or another, and lists a repeated method once", () => {
    const web = {
      id: "did:web:bob.example",
      verificationMethod: [{ id: "did:web:bob.example#a", type: "Multikey", controller: "did:web:bob.example", publicKeyMultibase: KEY }],
      authentication: ["#a", "did:web:bob.example#a", "did:web:other.example#k"],
    };
    expect(authorizedMethodIds(web, "authentication")).toEqual(["did:web:bob.example#a", "did:web:other.example#k"]);
  });

  it("refuses a reference into this document that names no method, a path-relative reference, an entry of another shape, and a document without a DID", () => {
    const base = { id: "did:web:bob.example", verificationMethod: [{ id: "#a", type: "Multikey", publicKeyMultibase: KEY }] };
    expect(() => authorizedMethodIds({ ...base, authentication: ["#a", "#b"] }, "authentication")).toThrow(/authentication\[1\] references no verification method/);
    expect(() => authorizedMethodIds({ ...base, authentication: ["a"] }, "authentication")).toThrow(DIDDocumentError);
    expect(() => authorizedMethodIds({ ...base, authentication: ["#a b"] }, "authentication")).toThrow(DIDDocumentError);
    expect(() => authorizedMethodIds({ ...base, authentication: [1] }, "authentication")).toThrow(DIDDocumentError);
    expect(() => authorizedMethodIds({ ...base, authentication: "#a" }, "authentication")).toThrow(DIDDocumentError);
    expect(() => authorizedMethodIds({ ...base, verificationMethod: ["#a"], authentication: [] }, "authentication")).toThrow(/verificationMethod\[0\] is an object/);
    expect(() => authorizedMethodIds({ verificationMethod: [] }, "authentication")).toThrow(/document id/);
  });

  it("refuses two different methods under one id, wherever each is defined, and takes one method defined twice alike", () => {
    const a = { id: "#a", type: "Multikey", publicKeyMultibase: KEY };
    const other = { ...a, publicKeyMultibase: KEY2 };
    const listed = { id: "did:web:bob.example", verificationMethod: [a, { ...other, id: "did:web:bob.example#a" }], authentication: ["#a"] };
    expect(() => authorizedMethodIds(listed, "authentication")).toThrow(/two different verification methods are did:web:bob.example#a/);
    const embedded = { id: "did:web:bob.example", verificationMethod: [a], authentication: ["#a"], keyAgreement: [other] };
    expect(() => authorizedMethodIds(embedded, "authentication")).toThrow(DIDDocumentError);
    const alike = { id: "did:web:bob.example", verificationMethod: [a], authentication: [{ publicKeyMultibase: KEY, type: "Multikey", id: "#a" }] };
    expect(authorizedMethodIds(alike, "authentication")).toEqual(["did:web:bob.example#a"]);
  });
});

describe("definedMethod", () => {
  it("gives the exact entry a listed or an embedded method has", () => {
    expect(definedMethod(DOCUMENT, `${LONG}#key-1`)).toEqual({ id: "#key-1", type: "Multikey", controller: LONG, publicKeyMultibase: KEY });
    expect(definedMethod(DOCUMENT, `${LONG}#embedded`)).toEqual({ id: "#embedded", type: "Multikey", controller: LONG, publicKeyMultibase: KEY2 });
  });

  it("refuses an id the document defines no method under, a reference into another DID included", () => {
    expect(() => definedMethod(DOCUMENT, `${LONG}#key-9`)).toThrow(/defines no verification method/);
    expect(() => definedMethod(DOCUMENT, "did:web:other.example#key-1")).toThrow(DIDDocumentError);
  });
});

describe("serviceIds", () => {
  it("lists every service by its absolute id, in order", () => {
    expect(serviceIds(DOCUMENT)).toEqual([`${LONG}#service`]);
    expect(serviceIds({ id: "did:web:bob.example" })).toEqual([]);
  });

  it("refuses two services under one id, a service that is not an object, and an id that is not a DID URL", () => {
    const service = { id: "#same", type: "DIDCommMessaging", serviceEndpoint: "https://bob.example" };
    expect(() => serviceIds({ id: "did:web:bob.example", service: [service, { ...service, id: "did:web:bob.example#same" }] })).toThrow(/two services are did:web:bob.example#same/);
    expect(() => serviceIds({ id: "did:web:bob.example", service: ["#same"] })).toThrow(/service\[0\] is an object/);
    expect(() => serviceIds({ id: "did:web:bob.example", service: [{ ...service, id: "same" }] })).toThrow(DIDDocumentError);
  });
});
