import { describe, expect, it } from "vitest";

import { shownAttachment } from "../src/renderers/attachments.js";
import type { AttachmentDescriptor } from "../src/core/types.js";

const descriptor = (over: Partial<AttachmentDescriptor> = {}): AttachmentDescriptor => ({
  id: null,
  description: null,
  filename: null,
  mediaType: null,
  format: null,
  lastModifiedTime: null,
  byteCount: null,
  content: { kind: "base64", cid: "bafyphoto" },
  hash: null,
  signed: false,
  ...over,
});

describe("an attachment as the thread shows it", () => {
  it("is named by its file name, its kind and size said, and its content referred to as the text it is", () => {
    expect(shownAttachment(descriptor({ id: "a1", filename: "photo.jpg", mediaType: "image/jpeg", byteCount: 1024 }))).toEqual({ name: "photo.jpg", details: "image/jpeg · 1 KB", reference: "base64 bafyphoto" });
  });

  it("falls back to the description, then the ID, then to being an attachment", () => {
    expect(shownAttachment(descriptor({ description: "the plan", id: "a1" })).name).toBe("the plan");
    expect(shownAttachment(descriptor({ id: "a1" })).name).toBe("attachment a1");
    expect(shownAttachment(descriptor()).name).toBe("an attachment");
  });

  it("says only what the descriptor says: no details when it gives none, links listed as links", () => {
    const linked = shownAttachment(descriptor({ content: { kind: "links", links: ["https://example.org/a", "https://example.org/b"] }, signed: true, byteCount: 3 * 1024 * 1024 }));
    expect(linked).toEqual({ name: "an attachment", details: "3.0 MB · signed", reference: "https://example.org/a https://example.org/b" });
    expect(shownAttachment(descriptor()).details).toBe("");
    expect(shownAttachment(descriptor({ byteCount: 12 })).details).toBe("12 B");
  });
});
