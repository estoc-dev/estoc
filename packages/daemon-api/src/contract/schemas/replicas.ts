import { z } from "zod";

import type { MergeResult } from "../methods.js";
import type { HistoryReceived, HistorySent, ReplicaListing, ReplicaRecord } from "../replicas.js";
import { displayTime, replicaId } from "./values.js";

export const mergeResult: z.ZodType<MergeResult> = z.object({
  added: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  objects: z.int().nonnegative(),
  repaired: z.int().nonnegative(),
  renewed: z.boolean(),
});

export const historySent: z.ZodType<HistorySent> = z.discriminatedUnion("outcome", [z.object({ at: displayTime, outcome: z.literal("sent") }), z.object({ at: displayTime, outcome: z.literal("failed"), because: z.string() })]);

export const replicaRecord: z.ZodType<ReplicaRecord> = z.object({
  replicaId,
  did: z.string(),
  self: z.boolean(),
  state: z.enum(["active", "removed"]),
  addedAt: displayTime.nullable(),
  removedAt: displayTime.nullable(),
  sent: historySent.nullable(),
});

export const replicaListing: z.ZodType<ReplicaListing> = z.object({ listedAt: displayTime, replicas: z.array(replicaRecord) });

const from = { from: replicaId, at: displayTime };

export const historyReceived: z.ZodType<HistoryReceived> = z.discriminatedUnion("status", [
  z.object({ ...from, status: z.literal("importing") }),
  z.object({ ...from, status: z.literal("imported"), merged: mergeResult }),
  z.object({ ...from, status: z.literal("failed"), because: z.string() }),
]);
