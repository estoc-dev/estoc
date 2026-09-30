import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it, vi } from "vitest";

import type { AttachmentDescriptor, MessageRecord } from "../src/core/types.js";

// the store reaches for the service worker's registration, which a build provides
vi.mock("../src/core/pwa.js", () => ({ isInstalled: () => false, setupPwa: () => undefined }));

const { default: Bubble } = await import("../src/renderers/Bubble.vue");

const photo: AttachmentDescriptor = { id: "a1", description: null, filename: "photo.jpg", mediaType: "image/jpeg", format: null, lastModifiedTime: null, byteCount: 1024, content: { kind: "base64", cid: "bafyphoto" }, hash: null, signed: false };

const message = (body: MessageRecord["body"]): MessageRecord =>
  ({
    messageId: "m-1",
    direction: "in",
    channelId: null,
    contactIds: [],
    at: "2026-09-28T10:00:00.000Z",
    headers: { type: "https://didcomm.org/basicmessage/2.0/message", thid: null, pthid: null, createdTime: null, expiresTime: null },
    body,
    kind: "application",
    effectType: null,
    input: null,
    delivery: null,
    acknowledged: false,
    late: false,
    verification: { status: "not-present" },
    manualAction: null,
    diagnostics: [],
    summary: null,
  }) as unknown as MessageRecord;

const rendered = (body: MessageRecord["body"]) => renderToString(createSSRApp({ render: () => h(Bubble, { message: message(body) }, { default: () => "hi back" }) }));

describe("the frame a message sits in", () => {
  it("lists what an available message carries as attachments, by descriptor, with nothing that opens one", async () => {
    const html = await rendered({ state: "available", body: { content: "hi back" }, attachments: [photo] });
    expect(html).toContain("hi back");
    expect(html).toContain("data-attachments");
    expect(html).toContain("photo.jpg");
    expect(html).toContain("image/jpeg · 1 KB");
    expect(html).toContain("base64 bafyphoto");
    expect(html).toContain("nothing here opens it yet");
    expect(html).not.toMatch(/<a |<button[^>]*>(open|download)/i);
  });

  it("lists nothing under a message that carries none", async () => {
    const html = await rendered({ state: "available", body: { content: "hi back" }, attachments: [] });
    expect(html).toContain("hi back");
    expect(html).not.toContain("data-attachments");
  });

  it("offers More under an available message at first, and no Erase confirmation yet", async () => {
    const html = await rendered({ state: "available", body: { content: "hi back" }, attachments: [] });
    expect(html).toContain("data-more");
    expect(html).not.toContain("data-erase");
    expect(html).not.toMatch(/>erase</);
  });

  it("offers nothing to erase on a message erased or not here", async () => {
    for (const body of [{ state: "erased" }, { state: "missing" }] as const) {
      const html = await rendered(body);
      expect(html).not.toContain("data-more");
    }
  });

  it("shows neither content nor attachments of a message erased or not here", async () => {
    for (const [body, said] of [
      [{ state: "erased" }, "erased"],
      [{ state: "missing" }, "the content is not here"],
    ] as const) {
      const html = await rendered(body);
      expect(html).toContain(said);
      expect(html).not.toContain("hi back");
      expect(html).not.toContain("data-attachments");
    }
  });
});
