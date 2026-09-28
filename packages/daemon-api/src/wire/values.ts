/**
 * One reading of every value that crosses a port, on both transports:
 * what is wire data is copied into a plain, normalized tree, with its
 * logical size and depth charged against a budget as it goes, so that
 * a request over the bounds is refused before all of it is read.
 */

import type { ApiValue } from "../contract/index.js";

/** The bounds of one request: its logical size, and its nesting with the root at depth 1. */
export interface Budget {
  maxValueBytes: number;
  maxDepth: number;
}

export type Reading<T> = { ok: true; value: T; size: number } | { ok: false; code: "InvalidArgument" | "ResourceLimit"; message: string };

export interface ReadOptions {
  /** the members of a top-level record that carry bytes; a byte array anywhere else is not wire data */
  bytesAt?: readonly string[];
  budget?: Budget;
}

/** Every value, array and record charges 8; a string its UTF-8 length; a key 8 and its UTF-8 length; bytes their length. */
export const VALUE_CHARGE = 8;

class Refused extends Error {
  constructor(
    readonly code: "InvalidArgument" | "ResourceLimit",
    message: string,
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();
const scratch = new Uint8Array(8192);

/** The UTF-8 length of `text` as the platform encoder writes it, a lone surrogate as the replacement character; measured through a small buffer, never encoded whole. */
export function utf8Length(text: string): number {
  let length = 0;
  for (let from = 0; from < text.length; ) {
    const { read, written } = encoder.encodeInto(from === 0 ? text : text.slice(from), scratch);
    from += read;
    length += written;
  }
  return length;
}

const isPlainRecord = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** What an own property holds, read from its descriptor: an accessor is not wire data, whatever it would return, and is never run. */
const held = (descriptor: PropertyDescriptor): unknown => {
  if (!("value" in descriptor)) throw new Refused("InvalidArgument", "an accessor is not wire data");
  return descriptor.value;
};

/** The bytes the view selects, and no other: a view of part of a buffer is copied out of it. */
export function exactBytes(view: Uint8Array): Uint8Array {
  const whole = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.constructor === Uint8Array;
  return whole ? view : new Uint8Array(view);
}

class Walk {
  size = 0;
  private readonly ancestors = new Set<object>();

  constructor(
    private readonly budget: Budget | null,
    private readonly bytesAt: ReadonlySet<string>,
  ) {}

  read(value: unknown, depth: number, slot: boolean): ApiValue {
    if (this.budget !== null && depth > this.budget.maxDepth) throw new Refused("ResourceLimit", `the value nests deeper than ${this.budget.maxDepth}`);
    this.charge(VALUE_CHARGE);
    switch (typeof value) {
      case "boolean":
        return value;
      case "string":
        // The shorter UTF-16 length first, so that a string far over the budget is refused unmeasured.
        this.charge(value.length);
        this.charge(utf8Length(value) - value.length);
        return value;
      case "number":
        if (!Number.isFinite(value)) throw new Refused("InvalidArgument", "a number is not finite");
        return value === 0 ? 0 : value;
      case "object":
        if (value === null) return null;
        if (value instanceof Uint8Array) {
          if (!slot) throw new Refused("InvalidArgument", "bytes are not wire data here");
          this.charge(value.byteLength);
          return exactBytes(value);
        }
        if (this.ancestors.has(value)) throw new Refused("InvalidArgument", "the value contains itself");
        this.ancestors.add(value);
        try {
          return Array.isArray(value) ? this.readArray(value, depth) : this.readRecord(value, depth);
        } finally {
          this.ancestors.delete(value);
        }
      default:
        throw new Refused("InvalidArgument", `a ${typeof value} is not wire data`);
    }
  }

  private readArray(value: unknown[], depth: number): ApiValue[] {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Refused("InvalidArgument", "an array of a class is not wire data");
    const items: ApiValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined) throw new Refused("InvalidArgument", "an array has a hole");
      const item = held(descriptor);
      if (item === undefined) throw new Refused("InvalidArgument", "an array element is undefined");
      items.push(this.read(item, depth + 1, false));
    }
    return items;
  }

  private readRecord(value: object, depth: number): ApiValue {
    if (!isPlainRecord(value)) throw new Refused("InvalidArgument", "an object of a class is not wire data");
    const entries: [string, ApiValue][] = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      const member = held(descriptor);
      if (member === undefined) continue;
      this.charge(VALUE_CHARGE + utf8Length(key));
      entries.push([key, this.read(member, depth + 1, depth === 1 && this.bytesAt.has(key))]);
    }
    return Object.fromEntries(entries);
  }

  private charge(amount: number): void {
    this.size += amount;
    if (this.budget !== null && this.size > this.budget.maxValueBytes) throw new Refused("ResourceLimit", `the value is larger than ${this.budget.maxValueBytes} bytes`);
  }
}

/** `value` as wire data, or why it is none; `undefined` members are left out, negative zero reads as zero, bytes are copied to their selected view. */
export function readValue(value: unknown, options: ReadOptions = {}): Reading<ApiValue> {
  const walk = new Walk(options.budget ?? null, new Set(options.bytesAt ?? []));
  try {
    if (value === undefined) throw new Refused("InvalidArgument", "the value is undefined");
    const read = walk.read(value, 1, false);
    return { ok: true, value: read, size: walk.size };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
