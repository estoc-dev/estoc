import { z } from "zod";

import type { ConnectionRecord, DeliverySource, DiscardRecord, DrainRecord, Lines, LinesState, LogLine, RecipientsRecord, WaitingDeliveryRecord } from "../lines.js";
import { epoch, mediationId, revision } from "./values.js";

const strings = z.array(z.string());

export const recipientsRecord: z.ZodType<RecipientsRecord> = z.object({
  wanted: strings,
  added: strings,
  refused: z.array(z.object({ did: z.string(), because: z.string() })),
});

export const drainRecord: z.ZodType<DrainRecord> = z.object({ acked: z.int().nonnegative(), ended: z.enum(["empty", "left", "rounds"]) });

export const connectionRecord: z.ZodType<ConnectionRecord> = z.object({
  mediationId,
  unreachable: z.string().nullable(),
  recipients: recipientsRecord.nullable(),
  drained: drainRecord.nullable(),
  live: z.boolean(),
});

export const deliverySource: z.ZodType<DeliverySource> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pickup"), mediationId, deliveryId: z.string() }),
  z.object({ kind: z.literal("direct") }),
]);

export const waitingDeliveryRecord: z.ZodType<WaitingDeliveryRecord> = z.object({ key: z.string(), source: deliverySource, reason: z.string(), held: z.boolean() });

export const discardRecord: z.ZodType<DiscardRecord> = z.object({ source: deliverySource, reason: z.string() });

export const lines: z.ZodType<Lines> = z.object({
  connections: z.array(connectionRecord),
  waiting: z.array(waitingDeliveryRecord),
  discarded: z.array(discardRecord),
});

export const linesState: z.ZodType<LinesState> = z.object({ epoch, revision, value: lines });

export const logLine: z.ZodType<LogLine> = z.object({ epoch, line: z.string() });
