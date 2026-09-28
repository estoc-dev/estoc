import { z } from "zod";

import type { ChannelId, ContactId, ConversationId, DidId, DisplayTime, Epoch, EventCid, ExecutionId, Hold, MediationId, MessageId, Revision } from "../ids.js";
import type { ApiObject, ApiValue, JsonObject, JsonValue } from "../values.js";

/** A finite number; negative zero reads as zero, since the two transports carry it as one value. */
export const finite: z.ZodType<number> = z.number().transform((value) => (value === 0 ? 0 : value));

/** A positive safe integer: what counts, correlates and measures. */
export const count: z.ZodType<number> = z.int().positive();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A dictionary keyed by data: every own key kept, `__proto__` among them, which the library's own record parser drops. */
export const record = <Value>(value: z.ZodType<Value>): z.ZodType<{ [key: string]: Value }> =>
  z.custom<Record<string, unknown>>(isRecord, { message: "expected a record" }).transform((input, ctx) => {
    const entries: [string, Value][] = [];
    for (const key of Object.keys(input)) {
      const parsed = value.safeParse(input[key]);
      if (parsed.success) entries.push([key, parsed.data]);
      else for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] });
    }
    return Object.fromEntries(entries);
  });

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), finite, z.string(), z.array(jsonValue), record(jsonValue)]));

export const jsonObject: z.ZodType<JsonObject> = record(jsonValue);

/** Bytes at a location a method schema names; anywhere else a byte array is not wire data. */
export const bytes: z.ZodType<Uint8Array> = z.instanceof(Uint8Array);

export const apiValue: z.ZodType<ApiValue> = z.lazy(() => z.union([z.null(), z.boolean(), finite, z.string(), bytes, z.array(apiValue), record(apiValue)]));

export const apiObject: z.ZodType<ApiObject> = record(apiValue);

const id = <Id extends string>(): z.ZodType<Id, string> => z.string().min(1).transform((value) => value as Id);

export const contactId = id<ContactId>();
export const messageId = id<MessageId>();
export const didId = id<DidId>();
export const mediationId = id<MediationId>();
export const executionId = id<ExecutionId>();
export const eventCid = id<EventCid>();
export const conversationId = id<ConversationId>();
export const hold = id<Hold>();
export const epoch = id<Epoch>();
/** Validated as a string only: a view never takes the pair apart. */
export const channelId = id<ChannelId>();
export const revision: z.ZodType<Revision> = count;

const DISPLAY_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The spelling, and the instant it names: a day the month does not have, or a 60th second, is no time. */
export function isDisplayTime(text: string): text is DisplayTime {
  if (!DISPLAY_TIME.test(text)) return false;
  const instant = Date.parse(text);
  return Number.isFinite(instant) && new Date(instant).toISOString() === text;
}

export const displayTime: z.ZodType<DisplayTime, string> = z.string().refine(isDisplayTime, { message: "expected a UTC instant spelled YYYY-MM-DDTHH:mm:ss.sssZ" }).transform((value) => value as DisplayTime);
