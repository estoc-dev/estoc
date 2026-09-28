/**
 * The envelopes of one negotiated session. A call gets exactly one
 * result or error under its ID while the port stays writable; an event
 * has no reply; a fault ends the session and the daemon closes the
 * port, its unresolved calls left uncertain.
 */

import type { ApiError } from "./errors.js";
import type { LinesState, LogLine } from "./lines.js";
import type { State } from "./state.js";
import type { ApiObject, ApiValue } from "./values.js";

/** A positive safe integer, unique for the lifetime of one port. */
export type CallId = number;

export interface Events {
  state: State;
  lines: LinesState;
  log: LogLine;
}

export const EVENT_NAMES = ["state", "lines", "log"] as const satisfies readonly (keyof Events)[];

export type EventName = (typeof EVENT_NAMES)[number];

export type Frame =
  | { kind: "call"; id: CallId; method: string; input: ApiObject }
  | { kind: "result"; id: CallId; value: ApiValue }
  | { kind: "error"; id: CallId; error: ApiError }
  | { kind: "event"; name: EventName; value: ApiValue }
  | { kind: "fault"; error: ApiError };

export type FrameKind = Frame["kind"];
