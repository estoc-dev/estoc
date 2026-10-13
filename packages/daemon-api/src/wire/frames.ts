/**
 * Frames as a port carries them: the bootstrap records, and after them
 * the application envelopes with their payloads. Reading is in two
 * steps, the envelope first and its payload once the method or event
 * it belongs to is known, since that is what says where bytes may be
 * and what budget the payload has.
 */

import { schemas, type Bootstrap, type CallId, type EventName, type Limits } from "../contract/index.js";
import { base64Length, fromBase64, isByteWrapper, wrapBytes } from "./bytes.js";
import type { Transport } from "./port.js";
import { readValue, VALUE_CHARGE, type Budget, type Reading, type WireValue } from "./values.js";

/** Room for a long implementation text or a long list of versions; a bootstrap record is small. */
export const MAX_BOOTSTRAP_BYTES = 4096;

const parse = (data: unknown): unknown => {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
};

export function readBootstrap(data: unknown, transport: Transport): Bootstrap | null {
  if (transport === "text" && typeof data === "string" && data.length > MAX_BOOTSTRAP_BYTES) return null;
  const record = transport === "text" ? parse(data) : data;
  const parsed = schemas.bootstrap.safeParse(record);
  return parsed.success ? parsed.data : null;
}

export function writeBootstrap(record: Bootstrap, transport: Transport): unknown {
  return transport === "text" ? JSON.stringify(record) : record;
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
 * The envelope of `data`, or null when it is no frame at all: bad JSON,
 * no record, no such kind, or a member missing or of the wrong type.
 * Members the envelope does not know stay on the frame, unread: they
 * mean nothing, but a bound on the whole frame charges them too.
 */
export function readFrame(data: unknown, transport: Transport): RawFrame | null {
  const record = transport === "text" ? parse(data) : data;
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
  /** the most bytes one such member may carry, decoded */
  maxBytes: number;
  budget?: Budget;
}

/**
 * A payload as wire data. On a text port the byte members arrive as
 * base64 records and are decoded here, their decoded length checked
 * first; on a structured-clone port they arrive as byte arrays. What
 * stands at a byte member without being either is left for the schema
 * to refuse.
 */
export function readPayload(raw: unknown, transport: Transport, options: PayloadOptions): Reading<WireValue> {
  let payload = raw;
  if (options.bytesAt.length > 0 && isRecord(raw)) {
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    let translated = false;
    for (const member of options.bytesAt) {
      const descriptor = descriptors[member];
      const held: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (transport === "text" && isByteWrapper(held)) {
        const length = base64Length(held.data);
        if (length === null) return { ok: false, code: "InvalidArgument", message: `${member} is not strict padded base64` };
        if (length > options.maxBytes) return { ok: false, code: "ResourceLimit", message: `${member} decodes to ${length} bytes, over ${options.maxBytes}` };
        const bytes = fromBase64(held.data);
        if (bytes === null) return { ok: false, code: "InvalidArgument", message: `${member} is not strict padded base64` };
        descriptors[member] = { value: bytes, enumerable: true, configurable: true, writable: true };
        translated = true;
      } else if (held instanceof Uint8Array && held.byteLength > options.maxBytes) {
        return { ok: false, code: "ResourceLimit", message: `${member} carries ${held.byteLength} bytes, over ${options.maxBytes}` };
      }
    }
    if (translated) payload = Object.create(Object.getPrototypeOf(raw) as object | null, descriptors) as unknown;
  }
  return readValue(payload, { bytesAt: options.bytesAt, budget: options.budget });
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

/**
 * `frame` as the port carries it. On a text port the byte members
 * become base64 records and the frame one JSON text; a read payload
 * holds bytes only at the top-level members it was read with.
 */
export function writeFrame(frame: WireFrame, transport: Transport): unknown {
  const value = payloadOf(frame);
  if (transport === "clone") return withPayload(frame, value);
  const payload = isRecord(value) ? Object.fromEntries(Object.entries(value).map(([member, held]) => [member, held instanceof Uint8Array ? wrapBytes(held) : held])) : value;
  return JSON.stringify(withPayload(frame, payload));
}
