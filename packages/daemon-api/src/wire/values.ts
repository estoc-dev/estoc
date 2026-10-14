/**
 * One reading of every value that crosses a port: what is wire data is
 * copied into a plain, normalized tree.
 */

import type { ApiValue } from "../contract/index.js";

/** A value as `readValue` copies it out: only that reading makes one, so what takes it needs no second look. */
export type WireValue = ApiValue & { readonly __wireValue: unique symbol };

export type Reading<T> = { ok: true; value: T } | { ok: false; code: "InvalidArgument" | "ResourceLimit"; message: string };

export interface ReadOptions {
  /** the members of a top-level record that carry bytes; a byte array anywhere else is not wire data */
  bytesAt?: readonly string[];
}

class Refused extends Error {}

/** A lone surrogate has no UTF-8 encoding: written out, it would turn into another character. */
const LONE_SURROGATE = /\p{Cs}/u;

const isPlainRecord = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** What an own property holds, read from its descriptor: an accessor is not wire data, whatever it would return, and is never run. */
const held = (descriptor: PropertyDescriptor): unknown => {
  if (!("value" in descriptor)) throw new Refused("an accessor is not wire data");
  return descriptor.value;
};

/** The bytes the view selects, and no other: a view of part of a buffer is copied out of it. */
export function exactBytes(view: Uint8Array): Uint8Array {
  const whole = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.constructor === Uint8Array;
  return whole ? view : new Uint8Array(view);
}

class Walk {
  private readonly ancestors = new Set<object>();

  constructor(private readonly bytesAt: ReadonlySet<string>) {}

  read(value: unknown, slot: boolean, root = false): ApiValue {
    switch (typeof value) {
      case "boolean":
        return value;
      case "string":
        if (LONE_SURROGATE.test(value)) throw new Refused("a string is not well-formed Unicode");
        return value;
      case "number":
        if (!Number.isFinite(value)) throw new Refused("a number is not finite");
        return value === 0 ? 0 : value;
      case "object":
        if (value === null) return null;
        if (value instanceof Uint8Array) {
          if (!slot) throw new Refused("bytes are not wire data here");
          return exactBytes(value);
        }
        if (this.ancestors.has(value)) throw new Refused("the value contains itself");
        this.ancestors.add(value);
        try {
          return Array.isArray(value) ? this.readArray(value) : this.readRecord(value, root);
        } finally {
          this.ancestors.delete(value);
        }
      default:
        throw new Refused(`a ${typeof value} is not wire data`);
    }
  }

  private readArray(value: unknown[]): ApiValue[] {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Refused("an array of a class is not wire data");
    const items: ApiValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined) throw new Refused("an array has a hole");
      const item = held(descriptor);
      if (item === undefined) throw new Refused("an array element is undefined");
      items.push(this.read(item, false));
    }
    return items;
  }

  private readRecord(value: object, root: boolean): ApiValue {
    if (!isPlainRecord(value)) throw new Refused("an object of a class is not wire data");
    const entries: [string, ApiValue][] = [];
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      const member = held(descriptor);
      if (member === undefined) continue;
      if (LONE_SURROGATE.test(key)) throw new Refused("a key is not well-formed Unicode");
      entries.push([key, this.read(member, root && this.bytesAt.has(key))]);
    }
    return Object.fromEntries(entries);
  }
}

/** `value` as wire data, or why it is none; `undefined` members are left out, negative zero reads as zero, bytes are copied to their selected view. */
export function readValue(value: unknown, options: ReadOptions = {}): Reading<WireValue> {
  const walk = new Walk(new Set(options.bytesAt ?? []));
  try {
    if (value === undefined) throw new Refused("the value is undefined");
    const read = walk.read(value, false, true) as WireValue;
    return { ok: true, value: read };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, code: "InvalidArgument", message: error.message };
    throw error;
  }
}
