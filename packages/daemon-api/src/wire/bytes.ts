/**
 * How bytes cross a text port: standard padded base64 in a record that
 * says so. The record is recognized only where a method or event schema
 * places bytes; the same shape inside a message body is the body's own.
 */

export interface ByteWrapper {
  encoding: "base64";
  data: string;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type Base64Statics = { fromBase64?: (text: string, options: { lastChunkHandling: "strict" }) => Uint8Array };
type Base64Methods = { toBase64?: () => string };

/**
 * The decoded length of strict padded base64, or null when `text` is
 * none: known before decoding, so that an oversized backup is refused
 * unread. Strict as the platform's own strict decoder is, the bits a
 * padded last chunk leaves unused required to be zero, so that every
 * platform accepts the same texts whether it has that decoder or not.
 */
export function base64Length(text: string): number | null {
  if (!BASE64.test(text)) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (padding > 0) {
    const last = ALPHABET.indexOf(text[text.length - 1 - padding]!);
    if ((last & (padding === 2 ? 0b1111 : 0b11)) !== 0) return null;
  }
  return (text.length / 4) * 3 - padding;
}

/** `text` decoded, or null when it is not strict padded base64 by the rule of `base64Length`, on every platform alike. */
export function fromBase64(text: string): Uint8Array | null {
  if (base64Length(text) === null) return null;
  try {
    const { fromBase64: native } = Uint8Array as unknown as Base64Statics;
    if (native !== undefined) return native.call(Uint8Array, text, { lastChunkHandling: "strict" });
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  const { toBase64: native } = bytes as unknown as Base64Methods;
  if (native !== undefined) return native.call(bytes);
  let binary = "";
  for (let start = 0; start < bytes.length; start += CHUNK) binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  return btoa(binary);
}

export function isByteWrapper(value: unknown): value is ByteWrapper {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { encoding, data } = value as Record<string, unknown>;
  return encoding === "base64" && typeof data === "string";
}

export const wrapBytes = (bytes: Uint8Array): ByteWrapper => ({ encoding: "base64", data: toBase64(bytes) });
