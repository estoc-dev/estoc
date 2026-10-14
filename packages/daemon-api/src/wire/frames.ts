/**
 * Frames as a port carries them: each one CBOR data item, the bootstrap
 * records first and the application envelopes with their payloads
 * after them. Reading is in two steps, the envelope first and its
 * payload once the method or event it belongs to is known, since that
 * is what says where bytes may be and what budget the payload has.
 */

import type { DecodeOptions } from "cbor2";
import { decode } from "cbor2/decoder";
import { encode } from "cbor2/encoder";

import { schemas, type Bootstrap, type CallId, type EventName, type Limits } from "../contract/index.js";
import { readValue, VALUE_CHARGE, type Budget, type Reading, type WireValue } from "./values.js";

/** Room for a long implementation text or a long list of versions; a bootstrap record is small. */
export const MAX_BOOTSTRAP_BYTES = 4096;

/**
 * A frame is plain data: definite lengths, no simple value but the
 * booleans and null, each integer and length in its shortest form, so
 * that a key has one encoding and a repeated key is seen as one. A tag
 * is left a tag, whatever a bundle registered, for the value reading to
 * refuse. The decoder's own depth bound guards its stack only: it counts
 * an array deeper than a map, and the advertised depth is the value
 * reading's to check.
 */
const DECODING: DecodeOptions = {
  rejectDuplicateKeys: true,
  rejectUndefined: true,
  rejectSimple: true,
  rejectStreaming: true,
  requirePreferred: true,
  ignoreGlobalTags: true,
};

/** The one data item that is the whole of `data`, or undefined when there is none. */
function decoded(data: unknown): unknown {
  // The decoder would read a string as hex.
  if (!(data instanceof Uint8Array)) return undefined;
  try {
    return decode(data, DECODING);
  } catch {
    return undefined;
  }
}

export function readBootstrap(data: unknown): Bootstrap | null {
  if (data instanceof Uint8Array && data.byteLength > MAX_BOOTSTRAP_BYTES) return null;
  const parsed = schemas.bootstrap.safeParse(decoded(data));
  return parsed.success ? parsed.data : null;
}

export function writeBootstrap(record: Bootstrap): Uint8Array {
  return encode(record);
}

type Frame<Payload> =
  | { kind: "call"; id: CallId; method: string; input: Payload }
  | { kind: "result"; id: CallId; value: Payload }
  | { kind: "error"; id: CallId; error: Payload }
  | { kind: "event"; name: EventName; value: Payload }
  | { kind: "fault"; error: Payload };

/** A frame whose payload is not yet read as wire data: what reading an envelope gives. */
export type RawFrame = Frame<unknown>;

/** A frame whose payload is read as wire data: what writing takes. */
export type WireFrame = Frame<WireValue>;

const isCallId = (id: unknown): id is CallId => typeof id === "number" && Number.isSafeInteger(id) && id > 0;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isEventName = (name: unknown): name is EventName => typeof name === "string" && Object.hasOwn(schemas.events, name);

/**
 * The envelope of `data`, or null when it is no frame at all: no single
 * CBOR data item, no record, no such kind, or a member missing or of
 * the wrong type. Members the envelope does not know stay on the
 * frame, unread: they mean nothing, but a bound on the whole frame
 * charges them too.
 */
export function readFrame(data: unknown): RawFrame | null {
  const record = decoded(data);
  if (!isRecord(record)) return null;
  const { kind, id, method, name, input, value, error } = record;
  switch (kind) {
    case "call":
      return isCallId(id) && typeof method === "string" && input !== undefined ? { ...record, kind, id, method, input } : null;
    case "result":
      return isCallId(id) && value !== undefined ? { ...record, kind, id, value } : null;
    case "error":
      return isCallId(id) && error !== undefined ? { ...record, kind, id, error } : null;
    case "event":
      return isEventName(name) && value !== undefined ? { ...record, kind, name, value } : null;
    case "fault":
      return error !== undefined ? { ...record, kind, error } : null;
    default:
      return null;
  }
}

export interface PayloadOptions {
  /** the members of a record payload that carry bytes */
  bytesAt: readonly string[];
  /** the most bytes one such member may carry */
  maxBytes: number;
  budget?: Budget;
}

/** A payload as wire data, each byte member's length checked before the rest is read. */
export function readPayload(raw: unknown, options: PayloadOptions): Reading<WireValue> {
  if (isRecord(raw)) {
    for (const member of options.bytesAt) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, member);
      const held: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (held instanceof Uint8Array && held.byteLength > options.maxBytes) return { ok: false, code: "ResourceLimit", message: `${member} carries ${held.byteLength} bytes, over ${options.maxBytes}` };
    }
  }
  return readValue(raw, { bytesAt: options.bytesAt, budget: options.budget });
}

/** What a call's input may still charge once the rest of its frame has, unknown members included: the bound is on the whole frame. */
export function requestBudget(limits: Limits, call: Extract<RawFrame, { kind: "call" }>): Reading<Budget> {
  const envelope = readValue({ ...call, input: null }, { budget: limits });
  if (!envelope.ok) return envelope;
  const budget = { maxValueBytes: limits.maxValueBytes - (envelope.size - VALUE_CHARGE), maxDepth: limits.maxDepth - 1 };
  return { ok: true, value: budget, size: envelope.size };
}

const payloadOf = (frame: RawFrame): unknown => (frame.kind === "call" ? frame.input : frame.kind === "error" || frame.kind === "fault" ? frame.error : frame.value);

/** `frame`'s envelope around `payload`, without the members the envelope does not know. */
function withPayload<Payload>(frame: RawFrame, payload: Payload): Frame<Payload> {
  switch (frame.kind) {
    case "call":
      return { kind: frame.kind, id: frame.id, method: frame.method, input: payload };
    case "result":
      return { kind: frame.kind, id: frame.id, value: payload };
    case "error":
      return { kind: frame.kind, id: frame.id, error: payload };
    case "event":
      return { kind: frame.kind, name: frame.name, value: payload };
    case "fault":
      return { kind: frame.kind, error: payload };
  }
}

/**
 * A frame of the sender's own, its payload read as wire data: a value
 * that is none is a defect, thrown rather than sent as something else.
 */
export function ownFrame(frame: RawFrame, bytesAt: readonly string[] = []): WireFrame {
  const read = readValue(payloadOf(frame), { bytesAt });
  if (!read.ok) throw new Error(`the ${frame.kind} frame is not wire data: ${read.message}`);
  return withPayload(frame, read.value);
}

/** `frame` as the port carries it, in a buffer of its own. */
export function writeFrame(frame: WireFrame): Uint8Array {
  return encode(withPayload(frame, payloadOf(frame)));
}
