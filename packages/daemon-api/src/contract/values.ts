/**
 * The data both transports carry: finite, acyclic JSON trees, plus
 * byte arrays at the few schema locations a backup crosses. Object
 * identity, key order and shared references mean nothing; an optional
 * member set to `undefined` is the member omitted.
 */

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** A wire value: JSON data, with bytes wherever the method or event schema places them. */
export type ApiValue = JsonPrimitive | Uint8Array | ApiValue[] | ApiObject;

export interface ApiObject {
  [key: string]: ApiValue;
}
