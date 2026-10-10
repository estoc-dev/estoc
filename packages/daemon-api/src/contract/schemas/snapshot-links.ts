import { z } from "zod";

import type { PublishedSnapshotLink, SnapshotLink, SnapshotLinkRecord } from "../snapshot-links.js";
import { displayTime } from "./values.js";

const isHttpUrl = (text: string): boolean => URL.canParse(text) && ["http:", "https:"].includes(new URL(text).protocol);

export const snapshotLink: z.ZodType<SnapshotLink> = z.object({
  url: z.string().refine(isHttpUrl, { message: "expected an HTTP URL" }),
  hash: z.string().min(1),
  // 43 characters carry 258 bits: the last one's low two are zero in the one spelling 32 bytes have
  key: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, { message: "expected 32 bytes of base64url without padding" }),
});

const hash = z.string().min(1);
const pending = z.object({ status: z.literal("pending"), hash, placedAt: displayTime, retainUntil: displayTime.nullable() });
const published = z.object({ status: z.literal("published"), hash, placedAt: displayTime, retainUntil: displayTime, link: snapshotLink });

export const publishedSnapshotLink: z.ZodType<PublishedSnapshotLink> = published;

export const snapshotLinkRecord: z.ZodType<SnapshotLinkRecord> = z.discriminatedUnion("status", [pending, published]);
