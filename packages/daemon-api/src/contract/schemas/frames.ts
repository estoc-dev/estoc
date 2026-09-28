import { z } from "zod";

import { EVENT_NAMES, type EventName, type Events, type Frame } from "../frames.js";
import { apiError } from "./errors.js";
import { linesState, logLine } from "./lines.js";
import { state } from "./state.js";
import { apiObject, apiValue, count } from "./values.js";

export const callId = count;

export const events: { readonly [Name in EventName]: z.ZodType<Events[Name]> } = { state, lines: linesState, log: logLine };

export const frame: z.ZodType<Frame> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("call"), id: callId, method: z.string().min(1), input: apiObject }),
  z.object({ kind: z.literal("result"), id: callId, value: apiValue }),
  z.object({ kind: z.literal("error"), id: callId, error: apiError }),
  z.object({ kind: z.literal("event"), name: z.enum(EVENT_NAMES), value: apiValue }),
  z.object({ kind: z.literal("fault"), error: apiError }),
]);
