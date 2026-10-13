/**
 * DASL CAR (https://dasl.ing/car.html): CARv1 over DASL CIDs. A header —
 * a length-prefixed DRISL map with `version: 1`, `roots` (an array of
 * CIDs) and whatever other metadata the writer put there — then blocks,
 * each a length-prefixed `CID ‖ data` where the CID is exactly the 36
 * bytes of a DASL CID. This is how a set of blocks travels as one file.
 *
 * Both directions are the profile's own definition rather than
 * `@ipld/car`'s: multiformats' varint for every length, the DRISL codec
 * for the header, the first 36 bytes of a block for its name. The
 * library's writer encodes no header member but `version` and `roots`
 * and takes a block whole, where a header here carries metadata and a
 * block is filled a chunk at a time into a buffer sized once. Its reader
 * refuses a header with any member beyond `version` and `roots`, decodes
 * the header into an object whose `__proto__` entry becomes a prototype
 * rather than a key, and takes a block's CID by the CID's own structure,
 * past the end of the section if need be and re-encoded, so a name that
 * is not the 36 bytes of a DASL CID can come back as one.
 */

import { varint } from "multiformats";

import { base32Encode, checkCid, CID_LENGTH, cidFromBytes, parseCid } from "./cid.js";
import { decodeDrisl, encodeDrisl, Float, Link, type Drisl } from "./drisl.js";

/** The members of a CAR header beside `version` and `roots`. */
export type CarMetadata = { readonly [key: string]: Drisl };

/** What a CAR header says beside `version: 1`. */
export interface CarHeader {
  roots: readonly string[];
  /** The header's other members, none when left out; neither `version` nor `roots` is one of them. */
  metadata?: CarMetadata;
}

/** A CAR read back: what the header named, every block whose bytes match its CID, and what was dropped. */
export interface Car {
  roots: string[];
  /** The header's members beside `version` and `roots`, in a map with no prototype: `__proto__` is a key like any other. */
  metadata: CarMetadata;
  /** CID → bytes, in the order first met; every occurrence of a block is checked against its CID, and a repeat that matches adds nothing. */
  blocks: Map<string, Uint8Array>;
  /**
   * The names of the occurrences dropped, one entry each: a CID whose
   * data does not hash to it, or — spelled `b` + base32 of its 36 bytes,
   * which no DASL CID shares — a block named by something that is not a
   * DASL CID.
   */
  bad: string[];
}

/** The length of a CAR with this header and blocks of these sizes, in any order. */
export function carLength(header: CarHeader, sizes: Iterable<number>): number {
  let length = sectionLength(encodeHeader(header).length);
  for (const size of sizes) length += sectionLength(CID_LENGTH + checkedSize(size));
  return length;
}

/**
 * A CAR written into one buffer of a length fixed in advance — the
 * `carLength` of its header and block sizes — block by block, each
 * declared by its name and size and then filled in chunks of any size.
 * A block that does not fit what is left, a chunk past its block, a
 * block begun before the last is full and a close short of the length
 * are refused, so what `close` hands over is exactly the CAR declared,
 * and the writer's to hand over: it takes nothing more once closed.
 */
export class CarWriter {
  readonly #bytes: Uint8Array;
  #at = 0;
  #owed = 0;
  #closed = false;

  constructor(header: CarHeader, length: number) {
    const encoded = encodeHeader(header);
    const least = sectionLength(encoded.length);
    if (!Number.isSafeInteger(length) || length < least) throw new Error(`a CAR with this header is at least ${least} bytes, not ${length}`);
    this.#bytes = new Uint8Array(length);
    this.#prefix(encoded.length);
    this.#put(encoded);
  }

  /** Begin the block named `cid`, of `size` bytes, for `write` to fill. */
  block(cid: string, size: number): void {
    this.#open();
    if (this.#owed > 0) throw new Error(`the block before is ${this.#owed} bytes short`);
    const name = parseCid(cid).bytes;
    const section = CID_LENGTH + checkedSize(size);
    const left = this.#bytes.length - this.#at;
    if (sectionLength(section) > left) throw new Error(`a block of ${size} bytes does not fit in the ${left} bytes left`);
    this.#prefix(section);
    this.#put(name);
    this.#owed = size;
  }

  /** The next bytes of the block begun. */
  write(chunk: Uint8Array): void {
    this.#open();
    if (chunk.length > this.#owed) throw new Error(`a chunk of ${chunk.length} bytes is past the ${this.#owed} left of the block`);
    this.#put(chunk);
    this.#owed -= chunk.length;
  }

  /** The CAR, once every block declared is full and the length is reached. */
  close(): Uint8Array {
    this.#open();
    if (this.#owed > 0) throw new Error(`the last block is ${this.#owed} bytes short`);
    if (this.#at !== this.#bytes.length) throw new Error(`the CAR is ${this.#at} of the ${this.#bytes.length} bytes it was given`);
    this.#closed = true;
    return this.#bytes;
  }

  #open(): void {
    if (this.#closed) throw new Error("the CAR is closed");
  }

  #prefix(length: number): void {
    varint.encodeTo(length, this.#bytes, this.#at);
    this.#at += varint.encodingLength(length);
  }

  #put(bytes: Uint8Array): void {
    this.#bytes.set(bytes, this.#at);
    this.#at += bytes.length;
  }
}

/** Encode a CAR: the header, then `blocks` in map order. Every CID must be a DASL CID. */
export function encodeCar(header: CarHeader, blocks: Map<string, Uint8Array>): Uint8Array {
  const writer = new CarWriter(header, carLength(header, [...blocks.values()].map((bytes) => bytes.length)));
  for (const [cid, bytes] of blocks) {
    writer.block(cid, bytes.length);
    writer.write(bytes);
  }
  return writer.close();
}

/**
 * Decode a CAR and check every block against its CID. Throws on a
 * malformed container — a header that is not a DRISL map with the integer
 * `version: 1` and `roots` of DASL CIDs, a length that is not a minimal
 * varint, a truncated section, a section shorter than a CID; a block is
 * never a reason to throw, only to drop. The blocks are views into
 * `bytes`, not copies.
 */
export async function decodeCar(bytes: Uint8Array): Promise<Car> {
  let at = 0;
  const section = (): Uint8Array => {
    const [length, prefix] = varint.decode(bytes, at);
    const start = at + prefix;
    if (start + length > bytes.length) throw new Error("truncated CAR");
    at = start + length;
    return bytes.subarray(start, at);
  };
  const header = section();
  if (header.length === 0) throw new Error("CAR header is empty");
  const { roots, metadata } = decodeHeader(header);
  const blocks = new Map<string, Uint8Array>();
  const bad: string[] = [];
  while (at < bytes.length) {
    const block = section();
    if (block.length < CID_LENGTH) throw new Error("CAR block shorter than a CID");
    const name = block.subarray(0, CID_LENGTH);
    const data = block.subarray(CID_LENGTH);
    let cid;
    try {
      cid = cidFromBytes(name);
    } catch {
      bad.push(`b${base32Encode(name)}`);
      continue;
    }
    try {
      await checkCid(cid, data);
    } catch {
      bad.push(cid.text);
      continue;
    }
    if (!blocks.has(cid.text)) blocks.set(cid.text, data);
  }
  return { roots, metadata, blocks, bad };
}

function encodeHeader({ roots, metadata = {} }: CarHeader): Uint8Array {
  const header = Object.create(null) as { [key: string]: Drisl };
  for (const key of Object.keys(metadata)) {
    if (key === "version" || key === "roots") throw new Error(`CAR metadata cannot name ${key}, a member of the header itself`);
    header[key] = metadata[key] as Drisl;
  }
  header["roots"] = roots.map((root) => new Link(parseCid(root)));
  header["version"] = 1;
  return encodeDrisl(header);
}

function decodeHeader(bytes: Uint8Array): { roots: string[]; metadata: CarMetadata } {
  let doc: Drisl;
  try {
    doc = decodeDrisl(bytes);
  } catch (err) {
    throw new Error(`CAR header is not DRISL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc) || doc instanceof Uint8Array || doc instanceof Link || doc instanceof Float) {
    throw new Error("CAR header is not a map");
  }
  // the integer 1: the float 1.0 decodes as a Float and is refused here
  if (doc["version"] !== 1) throw new Error(`CAR version ${String(doc["version"])} is not 1`);
  const roots = doc["roots"];
  if (!Array.isArray(roots) || !roots.every((root) => root instanceof Link)) throw new Error("CAR header roots are not CIDs");
  const metadata = Object.create(null) as { [key: string]: Drisl };
  for (const key of Object.keys(doc)) if (key !== "version" && key !== "roots") metadata[key] = doc[key] as Drisl;
  return { roots: roots.map((root) => root.cid.text), metadata };
}

function sectionLength(length: number): number {
  return varint.encodingLength(length) + length;
}

function checkedSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`a block's size is a whole number of bytes, not ${size}`);
  return size;
}
