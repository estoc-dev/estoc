/**
 * What a message means, as the value each layer identifies: the intent,
 * one fixed application message under its intent CID, whichever ID,
 * channel or envelope carries it; the complete plaintext under its
 * plaintext CID; and between them the control headers as the wire
 * spells them, which the message events record. `readPlaintext` takes a
 * DIDComm plaintext apart into its stored content, its headers, its
 * intent and the addressing that is not intent; `wirePlaintext` puts an
 * intent back on the wire under a message ID. The two meet: reading what
 * `wirePlaintext` emits yields the intent it was given, under the same
 * CID.
 */

import { InvalidJson, canonicalText, canonicalize, deepFreeze, isJsonObject, isRawCid, parseStrict, type JsonObject, type JsonValue } from "@estoc/event-store";

import { documentCidOf, rawCidOfBytes, storeMessage, wireAttachment, type StoredMessage, type StoredMessageDocument } from "./document.js";
import { InvalidPlaintext } from "./errors.js";
import { canonicalWireId, sameWireId } from "./ids.js";
import { isDid, isEpochSeconds } from "./syntax.js";
import type { AdditionalHeaders, Cid, Did, EpochSeconds, Identified, IntentCid, MessageIn, MessageOut, PlaintextCid } from "./types.js";

/** The DIDComm plaintext media type: the `typ` header a plaintext carries. */
export const PLAINTEXT_TYP = "application/didcomm-plain+json";

/** The top-level DIDComm members a dedicated field models, or that a vault plaintext may not carry; none may appear in `headers`. */
export const RESERVED_HEADERS = [
  "typ",
  "id",
  "type",
  "from",
  "to",
  "created_time",
  "expires_time",
  "thid",
  "pthid",
  "please_ack",
  "ack",
  "from_prior",
  "return_route",
  "body",
  "attachments",
] as const;

const RESERVED = new Set<string>(RESERVED_HEADERS);

/** The kind and version that prefix the intent projection when it is hashed: a change to the projection's fields or encoding is a new version. */
const INTENT_KIND = "estoc.message.intent";
const INTENT_VERSION = 1;

/** The intent's reference to a message: `SELF` for the message itself, otherwise the referenced wire ID as spelled. */
export type MessageReference = string;
export const SELF: MessageReference = "";

/**
 * The control headers of a message as the wire spells them, the own ID
 * aside: what `message.out` and `message.in` record, and what the intent
 * is projected from once the own ID is known. Null is an absent header,
 * except `ack`, where absent is `[]`.
 */
export type ControlHeaders = {
  type: string;
  thid: string | null;
  pthid: string | null;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
  pleaseAck: string[] | null;
  ack: string[];
  headers: AdditionalHeaders;
};

/**
 * The fixed application message the intent CID identifies: the control
 * headers with every reference to the message itself folded to `SELF`,
 * and the stored document by its CID. Only `intentOf` makes one, and
 * what it hands out is frozen. The own ID, the addressing and the proof
 * are not in it: one intent may be sent under any ID, in any channel.
 */
export type Intent = {
  readonly type: string;
  readonly thid: MessageReference;
  readonly pthid: string | null;
  readonly createdTime: EpochSeconds | null;
  readonly expiresTime: EpochSeconds | null;
  readonly pleaseAck: readonly MessageReference[] | null;
  readonly ack: readonly string[];
  readonly document: Cid;
  readonly headers: AdditionalHeaders;
};

/** A plaintext taken apart: what is intent, what the events record, what is stored, and what is addressing. */
export type ReadPlaintext = {
  /** the plaintext as given, which `plaintextCid` identifies */
  plaintext: JsonObject;
  plaintextCid: PlaintextCid;
  /** the plaintext `id`, as spelled */
  id: string;
  /** the control headers as spelled */
  control: ControlHeaders;
  intent: Identified<IntentCid, Intent>;
  stored: StoredMessage;
  typ: string | null;
  from: Did | null;
  to: Did[] | null;
  fromPrior: string | null;
};

/** `headers` of an intent: a JSON object with no reserved member. */
export function checkHeaders(value: unknown, at = "headers"): AdditionalHeaders {
  if (!isJsonObject(value)) throw new InvalidPlaintext(`${at} must be a JSON object`);
  for (const name of Object.keys(value)) {
    if (RESERVED.has(name)) throw new InvalidPlaintext(`${at} carries the reserved header ${JSON.stringify(name)}`);
  }
  return value;
}

/**
 * The intent of a message, under its CID: `control` as the wire spells
 * it, `ownId` telling which thread and ACK references are the message's
 * own, and the stored document by its CID. Each field is checked, copied
 * and frozen before the CID is taken, so the CID is of the value handed
 * out and nothing the caller does to its input afterwards reaches it.
 * Nothing here reads a clock, a random source or a resolver.
 */
export function intentOf(ownId: string, control: ControlHeaders, document: Cid): Identified<IntentCid, Intent> {
  const own = canonicalWireId(nonEmpty(ownId, "the own ID"));
  const self = (reference: string): MessageReference => (canonicalWireId(reference) === own ? SELF : reference);
  const thid = optional(control.thid, "thid", nonEmpty);
  const createdTime = optional(control.createdTime, "createdTime", epochSeconds);
  const expiresTime = optional(control.expiresTime, "expiresTime", epochSeconds);
  checkExpiry(createdTime, expiresTime);
  if (!isRawCid(document)) throw new InvalidPlaintext("document must be a raw DASL CID");
  const intent: Intent = deepFreeze({
    type: nonEmpty(control.type, "type"),
    thid: thid === null ? SELF : self(thid),
    pthid: optional(control.pthid, "pthid", nonEmpty),
    createdTime,
    expiresTime,
    pleaseAck: optional(control.pleaseAck, "pleaseAck", strings)?.map(self) ?? null,
    ack: optional(control.ack, "ack", strings) ?? [],
    document,
    headers: checkHeaders(copyOf(control.headers, "headers")),
  });
  return { cid: cidOf([INTENT_KIND, INTENT_VERSION, intentProjection(intent)], "the intent projection") as IntentCid, value: intent };
}

/** The intent projection: the object the intent CID is taken over, after the kind and version. */
export function intentProjection(intent: Intent): JsonObject {
  return {
    type: intent.type,
    thid: intent.thid,
    pthid: intent.pthid,
    created_time: intent.createdTime,
    expires_time: intent.expiresTime,
    please_ack: intent.pleaseAck === null ? null : [...intent.pleaseAck],
    ack: [...intent.ack],
    document: intent.document,
    headers: intent.headers,
  };
}

/** The CID of one complete plaintext: every member it carries, explicit nulls, addressing and proof included. */
export function plaintextCidOf(plaintext: JsonObject): PlaintextCid {
  return cidOf(plaintext, "the plaintext") as PlaintextCid;
}

function cidOf(value: JsonValue, what: string): Cid {
  try {
    return rawCidOfBytes(canonicalize(value));
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidPlaintext(`${what} is not I-JSON: ${err.message}`);
    throw err;
  }
}

/** `value` as its own JSON: an own copy with nothing but I-JSON in it, or `InvalidPlaintext`. */
function copyOf(value: unknown, at: string): JsonValue {
  try {
    return parseStrict(canonicalText(value));
  } catch (err) {
    if (err instanceof InvalidJson) throw new InvalidPlaintext(`${at} is not I-JSON: ${err.message}`);
    throw err;
  }
}

/**
 * Does the message ask for its own acknowledgment? Null and `[]` do
 * not; `SELF` and its own wire ID, in any case, do. A receipt is given
 * to the message that asks for it, naming that message alone, so a
 * request for another message asks nothing of this vault; the stored
 * array is never rewritten.
 */
export function requestsAck(currentWireId: string, pleaseAck: readonly string[] | null): boolean {
  return pleaseAck !== null && pleaseAck.some((target) => target === SELF || sameWireId(target, currentWireId));
}

/**
 * The thread a reply to the carrier is on: the carrier's canonical wire
 * ID when the carrier is in its own thread, by an absent `thid` or one
 * that is its own ID in any case, otherwise its thread as spelled. The
 * same thread for every spelling of one input, so that every replica
 * answering it makes one reply intent.
 */
export function replyThread(carrier: { readonly wireMessageId: string; readonly thid: string | null }): string {
  return carrier.thid === null || sameWireId(carrier.thid, carrier.wireMessageId) ? canonicalWireId(carrier.wireMessageId) : carrier.thid;
}

type Recorded = Pick<MessageOut, "msgType" | "thid" | "pthid" | "createdTime" | "expiresTime" | "pleaseAck" | "ack" | "headers" | "bodyCid">;

function recordedIntent(ownId: string, data: Recorded): Identified<IntentCid, Intent> {
  const { msgType: type, thid, pthid, createdTime, expiresTime, pleaseAck, ack, headers } = data;
  return intentOf(ownId, { type, thid, pthid, createdTime, expiresTime, pleaseAck, ack, headers }, data.bodyCid);
}

/** The intent a `message.out` records, the message ID being the own ID. */
export function intentOfOutbound(data: MessageOut): Identified<IntentCid, Intent> {
  return recordedIntent(data.messageId, data);
}

/** The intent a `message.in` records, the wire ID being the own ID. */
export function intentOfInbound(data: MessageIn): Identified<IntentCid, Intent> {
  return recordedIntent(data.wireMessageId, data);
}

/**
 * A DIDComm plaintext, as parsed, taken apart. Absent and null optional
 * headers both read as absent; a present one must have its type.
 * `return_route` is refused outright: a vault application plaintext
 * never carries it.
 */
export function readPlaintext(value: unknown): ReadPlaintext {
  if (!isJsonObject(value)) throw new InvalidPlaintext("a plaintext must be a JSON object");
  if (Object.hasOwn(value, "return_route")) throw new InvalidPlaintext("return_route is not allowed in a vault plaintext");
  const id = nonEmpty(value.id, "id");
  const type = nonEmpty(value.type, "type");
  const typ = optional(value.typ, "typ", (typ, at) => {
    if (typ !== PLAINTEXT_TYP) throw new InvalidPlaintext(`${at} must be ${JSON.stringify(PLAINTEXT_TYP)}`);
    return typ;
  });
  const from = optional(value.from, "from", did);
  const to = optional(value.to, "to", (to, at) => {
    if (!Array.isArray(to)) throw new InvalidPlaintext(`${at} must be an array of DIDs`);
    return to.map((entry, i) => did(entry, `${at}[${i}]`));
  });
  const thid = optional(value.thid, "thid", nonEmpty);
  const pthid = optional(value.pthid, "pthid", nonEmpty);
  const createdTime = optional(value.created_time, "created_time", epochSeconds);
  const expiresTime = optional(value.expires_time, "expires_time", epochSeconds);
  checkExpiry(createdTime, expiresTime);
  const pleaseAck = optional(value.please_ack, "please_ack", strings);
  const ack = optional(value.ack, "ack", strings) ?? [];
  const fromPrior = optional(value.from_prior, "from_prior", (proof, at) => {
    if (typeof proof !== "string") throw new InvalidPlaintext(`${at} must be a string`);
    return proof;
  });
  const stored = storeMessage(value.body, value.attachments);
  const headers = checkHeaders(copyOf(Object.fromEntries(Object.entries(value).filter(([name]) => !RESERVED.has(name))), "headers"));
  const control: ControlHeaders = { type, thid, pthid, createdTime, expiresTime, pleaseAck, ack, headers };
  const intent = intentOf(id, control, stored.bodyCid);
  return { plaintext: value, plaintextCid: plaintextCidOf(value), id, control, intent, stored, typ, from, to, fromPrior };
}

function optional<T>(value: unknown, at: string, check: (value: unknown, at: string) => T): T | null {
  return value === undefined || value === null ? null : check(value, at);
}

function nonEmpty(value: unknown, at: string): string {
  if (typeof value !== "string" || value === "") throw new InvalidPlaintext(`${at} must be a non-empty string`);
  return value;
}

function did(value: unknown, at: string): Did {
  if (!isDid(value)) throw new InvalidPlaintext(`${at} must be a DID`);
  return value as Did;
}

function epochSeconds(value: unknown, at: string): EpochSeconds {
  if (!isEpochSeconds(value)) throw new InvalidPlaintext(`${at} must be an integer count of seconds`);
  return value;
}

function checkExpiry(createdTime: EpochSeconds | null, expiresTime: EpochSeconds | null): void {
  if (createdTime !== null && expiresTime !== null && expiresTime <= createdTime) throw new InvalidPlaintext("expires_time must be later than created_time");
}

function strings(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new InvalidPlaintext(`${at} must be an array of strings`);
  return [...(value as string[])];
}

/** The addressing and proof a preparation adds to an intent: what the plaintext CID covers beyond it and the own ID. */
export type Addressing = { from: Did; to: Did[]; fromPrior: string | null };

/**
 * The complete innermost plaintext of an intent under `id`: `typ`,
 * `id`, `type`, `from`, `to` and `body` always; timing, `pthid` and
 * `from_prior` only when non-null; `thid` only when the thread is
 * another message's; `please_ack` whenever the intent has one, even
 * empty, a self reference as `""`; `ack` and `attachments` when
 * non-empty; every additional header at the top level. `document` is
 * the stored document the intent names, and is checked to be it;
 * `payloadOf` supplies each inline attachment's bytes by its root.
 */
export function wirePlaintext(intent: Intent, id: string, document: StoredMessageDocument, addressing: Addressing, payloadOf: (root: Cid) => Uint8Array): JsonObject {
  const documentCid = documentCidOf(document);
  if (documentCid !== intent.document) throw new InvalidPlaintext(`the document is ${documentCid}, not the intent's ${intent.document}`);
  const plaintext: JsonObject = { ...checkHeaders(intent.headers) };
  plaintext.typ = PLAINTEXT_TYP;
  plaintext.id = nonEmpty(id, "id");
  plaintext.type = intent.type;
  plaintext.from = addressing.from;
  plaintext.to = [...addressing.to];
  if (intent.createdTime !== null) plaintext.created_time = intent.createdTime;
  if (intent.expiresTime !== null) plaintext.expires_time = intent.expiresTime;
  if (intent.thid !== SELF) plaintext.thid = intent.thid;
  if (intent.pthid !== null) plaintext.pthid = intent.pthid;
  if (intent.pleaseAck !== null) plaintext.please_ack = [...intent.pleaseAck];
  if (intent.ack.length > 0) plaintext.ack = [...intent.ack];
  if (addressing.fromPrior !== null) plaintext.from_prior = addressing.fromPrior;
  plaintext.body = document.body;
  if (document.attachments.length > 0) {
    plaintext.attachments = document.attachments.map((stored) => wireAttachment(stored, stored.data.kind === "links" ? null : payloadOf(stored.data.root)));
  }
  return plaintext;
}
