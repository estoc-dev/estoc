/**
 * How a call fails at the SDK: the daemon's own error under `origin:
 * "daemon"`, or one the SDK raised under `origin: "client"`. A view
 * narrows a caught value with `isCallError` and branches on the code,
 * with no exception class to depend on.
 */

import { z } from "zod";

import { CLIENT_ERROR_CODES, schemas, type CallError, type ClientErrorCode } from "../contract/index.js";

const callError: z.ZodType<CallError> = z.discriminatedUnion("origin", [
  z.object({ origin: z.literal("daemon"), code: z.string().min(1), message: z.string(), effect: schemas.effect, messageId: schemas.messageId.nullable() }),
  z.object({ origin: z.literal("client"), code: z.enum(CLIENT_ERROR_CODES), message: z.string(), effect: schemas.effect, messageId: z.null() }),
]);

export function isCallError(value: unknown): value is CallError {
  return callError.safeParse(value).success;
}

/** A failure of the SDK's own; `effect` is `none` unless the operation had been handed to the transport. */
export function clientError(code: ClientErrorCode, message: string, effect: "none" | "possible" = "none"): CallError {
  return { origin: "client", code, message, effect, messageId: null };
}
