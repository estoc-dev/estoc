import { describe, expect, it, test } from "vitest";
import { base32 } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { varint } from "multiformats";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import { carLength, CarWriter, decodeCar, decodeDrisl, drislCid, encodeCar, encodeDrisl, Float, Link, parseCid, rawCid, type Drisl } from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function closure(): Promise<{ root: string; blocks: Map<string, Uint8Array> }> {
  const a = utf8("a");
  const b = utf8("cc");
  const doc = encodeDrisl({ items: [new Link(parseCid(await rawCid(a))), new Link(parseCid(await rawCid(b)))] });
  const root = await drislCid(doc);
  return { root, blocks: new Map([[root, doc], [await rawCid(a), a], [await rawCid(b), b]]) };
}

/** One block of `x`, behind the given header. */
async function underHeader(header: Drisl | Uint8Array): Promise<{ car: Uint8Array; cid: string }> {
  const cid = await rawCid(utf8("x"));
  const bytes = header instanceof Uint8Array ? header : encodeDrisl(header);
  return { car: concat(prefixed(bytes), section(parseCid(cid).bytes, utf8("x"))), cid };
}

describe("DASL CAR", () => {
  it("round-trips a closure: a DRISL header {roots, version: 1}, then 36-byte CIDs and their bytes", async () => {
    const { root, blocks } = await closure();
    const car = encodeCar({ roots: [root] }, blocks);
    // header: varint length, then DRISL a2 65 "roots" 81 d8 2a 58 25 00 <36> 67 "version" 01
    const headerLength = car[0] as number;
    const header = car.subarray(1, 1 + headerLength);
    expect(hex(header.subarray(0, 8))).toBe("a26572" + "6f6f7473" + "81");
    expect(hex(header.subarray(header.length - 9))).toBe("6776657273696f6e01");
    expect(decodeDrisl(header)).toEqual({ roots: [new Link(parseCid(root))], version: 1 });
    const back = await decodeCar(car);
    expect(back.roots).toEqual([root]);
    expect(back.bad).toEqual([]);
    expect([...back.blocks.keys()]).toEqual([...blocks.keys()]);
    for (const [cid, bytes] of blocks) expect(back.blocks.get(cid)).toEqual(bytes);
  });

  it("writes the bytes @ipld/car writes for a header with no metadata", async () => {
    const { root, blocks } = await closure();
    const big = new Uint8Array(16384).fill(3);
    const cases: [string[], Map<string, Uint8Array>][] = [
      [[root], blocks],
      [[], new Map()],
      [[root, await rawCid(big)], new Map([[await rawCid(big), big], ...blocks])],
    ];
    for (const [roots, map] of cases) {
      const named = { roots: roots.map((cid) => CID.decode(parseCid(cid).bytes)) };
      const sections = [...map].map(([cid, bytes]) => ({ cid: CID.decode(parseCid(cid).bytes), bytes }));
      const length = sections.reduce((n, block) => n + CarBufferWriter.blockLength(block), CarBufferWriter.headerLength(named));
      const library = CarBufferWriter.createWriter(new ArrayBuffer(length), named);
      for (const block of sections) library.write(block);
      expect(hex(encodeCar({ roots }, map))).toBe(hex(library.close()));
    }
  });

  it("round-trips metadata beside roots and version — text, nested maps, links, bytes, a __proto__ member — in a header encoded as one DRISL map", async () => {
    const { root, blocks } = await closure();
    const link = new Link(parseCid(root));
    const metadata = withKeys([
      ["estoc", { snapshot: 1, seed: "a.b.c", content: { after: 0, through: 12 } }],
      ["__proto__", "a key"],
      ["paths", { "index.json": link }],
      ["salt", Uint8Array.of(1, 2, 3)],
    ]);
    const car = encodeCar({ roots: [root], metadata }, blocks);
    const [headerLength, prefix] = varint.decode(car);
    const header = car.subarray(prefix, prefix + headerLength);
    expect(hex(header)).toBe(hex(encodeDrisl(withKeys([...Object.entries(metadata), ["roots", [link]], ["version", 1]]))));
    const back = await decodeCar(car);
    expect(back.roots).toEqual([root]);
    expect(Object.getPrototypeOf(back.metadata)).toBeNull();
    expect(Object.keys(back.metadata).sort()).toEqual(["__proto__", "estoc", "paths", "salt"]);
    expect(back.metadata["__proto__"]).toBe("a key");
    expect(back.metadata["estoc"]).toEqual({ snapshot: 1, seed: "a.b.c", content: { after: 0, through: 12 } });
    expect(back.metadata["paths"]).toEqual({ "index.json": link });
    expect(back.metadata["salt"]).toEqual(Uint8Array.of(1, 2, 3));
    expect(encodeCar(back, back.blocks)).toEqual(car);
    expect((await decodeCar(encodeCar({ roots: [root] }, blocks))).metadata).toEqual({});
  });

  it("refuses metadata that names version or roots", async () => {
    const { root, blocks } = await closure();
    expect(() => encodeCar({ roots: [root], metadata: { version: 2 } }, blocks)).toThrow(/cannot name version/);
    expect(() => encodeCar({ roots: [root], metadata: { roots: [] } }, blocks)).toThrow(/cannot name roots/);
    expect(() => carLength({ roots: [], metadata: { version: 1 } }, [])).toThrow(/cannot name version/);
  });

  it("checks every occurrence of a block: a repeat whose bytes do not match is named in bad, before or after the bytes that do", async () => {
    const good = utf8("good");
    const cid = await rawCid(good);
    const name = parseCid(cid).bytes;
    const empty = encodeCar({ roots: [cid] }, new Map());
    for (const car of [concat(empty, section(name, good), section(name, utf8("evil"))), concat(empty, section(name, utf8("evil")), section(name, good))]) {
      const back = await decodeCar(car);
      expect([...back.blocks.keys()]).toEqual([cid]);
      expect(back.blocks.get(cid)).toEqual(good);
      expect(back.bad).toEqual([cid]);
    }
    const thrice = await decodeCar(concat(empty, section(name, utf8("evil")), section(name, utf8("evil")), section(name, good)));
    expect(thrice.bad).toEqual([cid, cid]);
  });

  it("drops a block whose bytes do not hash to its CID, and says so", async () => {
    const good = await rawCid(utf8("good"));
    const lie = await rawCid(utf8("what it claims"));
    const car = encodeCar({ roots: [good] }, new Map([[good, utf8("good")], [lie, utf8("not that")]]));
    const back = await decodeCar(car);
    expect([...back.blocks.keys()]).toEqual([good]);
    expect(back.bad).toEqual([lie]);
  });

  it("drops a block named by something that is not a DASL CID — dag-pb, CIDv0, zero bytes — and keeps the rest", async () => {
    const good = await rawCid(utf8("good"));
    const dagPb = CID.create(1, 0x70, await sha256.digest(utf8("node")));
    const v0 = CID.create(0, 0x70, await sha256.digest(utf8("node")));
    expect(dagPb.bytes.length).toBe(36);
    const car = encodeCar({ roots: [good] }, new Map([[good, utf8("good")]]));
    const withOthers = concat(car, section(dagPb.bytes, utf8("node")), section(v0.bytes, utf8("node")), section(new Uint8Array(36), utf8("")));
    const back = await decodeCar(withOthers);
    expect([...back.blocks.keys()]).toEqual([good]);
    expect(back.bad).toEqual([`b${base32.baseEncode(dagPb.bytes)}`, `b${base32.baseEncode(concat(v0.bytes, utf8("no")))}`, `b${base32.baseEncode(new Uint8Array(36))}`]);
    expect(back.bad[0]).toBe(dagPb.toString()); // the spelling multiformats gives the same bytes: a name, not a DASL CID
  });

  it("takes a block's name as its first 36 bytes: a CID whose version or codec is a varint not minimally encoded is no DASL CID, and what follows it is read as usual", async () => {
    const data = utf8("x");
    const cid = await rawCid(data);
    const name = parseCid(cid).bytes;
    const empty = encodeCar({ roots: [] }, new Map());
    for (const longer of [concat(Uint8Array.of(0x81, 0x00), name.subarray(1)), concat(name.subarray(0, 1), Uint8Array.of(0xd5, 0x00), name.subarray(2))]) {
      expect(longer.length).toBe(37);
      const back = await decodeCar(concat(empty, section(longer, data), section(name, data)));
      expect([...back.blocks.keys()]).toEqual([cid]);
      expect(back.bad).toEqual([`b${base32.baseEncode(longer.subarray(0, 36))}`]);
      const asRoot = concat(Uint8Array.of(0xa2, 0x65), utf8("roots"), Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, 38, 0x00), longer, Uint8Array.of(0x67), utf8("version"), Uint8Array.of(1));
      await expect(decodeCar((await underHeader(asRoot)).car)).rejects.toThrow(/not DRISL: a DASL CID is 36 bytes, not 37/);
    }
  });

  it("refuses a header that is not the CAR header: no roots, a version other than 1 or the float 1.0, non-DASL roots, not a map, non-canonical DRISL, empty", async () => {
    const good = await rawCid(utf8("x"));
    await expect(decodeCar((await underHeader({ version: 1 })).car)).rejects.toThrow(/roots are not CIDs/);
    await expect(decodeCar((await underHeader({ roots: [], version: 2 })).car)).rejects.toThrow(/version 2/);
    await expect(decodeCar((await underHeader({ roots: [], version: new Float(1) })).car)).rejects.toThrow(/version 1\.0 is not 1/);
    await expect(decodeCar((await underHeader({ roots: [good], version: 1 })).car)).rejects.toThrow(/roots are not CIDs/);
    await expect(decodeCar((await underHeader([1])).car)).rejects.toThrow(/not a map/);
    await expect(decodeCar((await underHeader(new Uint8Array([0xa2, 0x65, ...utf8("roots"), 0x80, 0x67, ...utf8("version"), 0x18, 0x01]))).car)).rejects.toThrow(/not DRISL/);
    await expect(decodeCar(new Uint8Array([0x00]))).rejects.toThrow(/empty/);
  });

  it("reads a header with other metadata beside roots and version, nested or not, and a __proto__ entry as a key like any other", async () => {
    const good = await rawCid(utf8("x"));
    const roots = [new Link(parseCid(good))];
    const headers: { [key: string]: Drisl }[] = [
      withKeys([["note", "hi"], ["roots", roots], ["version", 1]]),
      withKeys([["masl", { paths: { "index.json": roots[0]! } }], ["roots", roots], ["version", 1]]),
      withKeys([["__proto__", "metadata"], ["roots", roots], ["version", 1]]),
    ];
    for (const header of headers) {
      const back = await decodeCar((await underHeader(header)).car);
      expect(back.roots).toEqual([good]);
      expect([...back.blocks.keys()]).toEqual([good]);
      expect(Object.keys(back.metadata)).toEqual(Object.keys(header).filter((key) => key !== "roots" && key !== "version"));
    }
    // roots under a __proto__ entry are that entry's value, not the header's roots
    const inherited = encodeDrisl(withKeys([["version", 1], ["__proto__", { roots }]]));
    expect(Object.keys(decodeDrisl(inherited) as object)).toEqual(["version", "__proto__"]);
    await expect(decodeCar((await underHeader(inherited)).car)).rejects.toThrow(/roots are not CIDs/);
  });

  it("refuses a CARv2 around the same blocks", async () => {
    const cid = await rawCid(utf8("x"));
    const car = encodeCar({ roots: [cid] }, new Map([[cid, utf8("x")]]));
    // the pragma, then characteristics, data offset, data size and index offset around the CARv1
    const v2 = new Uint8Array(51 + car.length);
    v2.set([0x0a, 0xa1, 0x67, ...utf8("version"), 0x02]);
    const fields = new DataView(v2.buffer, 11);
    fields.setBigUint64(16, 51n, true);
    fields.setBigUint64(24, BigInt(car.length), true);
    v2.set(car, 51);
    await expect(decodeCar(v2)).rejects.toThrow(/version 2 is not 1/);
  });

  it("refuses a truncated file and a section shorter than a CID", async () => {
    const { root, blocks } = await closure();
    const car = encodeCar({ roots: [root] }, blocks);
    await expect(decodeCar(car.subarray(0, car.length - 1))).rejects.toThrow(/truncated/);
    await expect(decodeCar(concat(car, prefixed(new Uint8Array(10))))).rejects.toThrow(/shorter than a CID/);
    await expect(decodeCar(concat(car, prefixed(new Uint8Array(35))))).rejects.toThrow(/shorter than a CID/);
  });

  it("round-trips many roots, no roots, an empty block, a big section and a view into a larger buffer, and keeps a repeated CID once", async () => {
    const big = new Uint8Array(300_000).fill(7);
    const cid = await rawCid(big);
    const other = await rawCid(utf8("o"));
    const back = await decodeCar(encodeCar({ roots: [cid, other] }, new Map([[cid, big], [other, utf8("o")]])));
    expect(back.roots).toEqual([cid, other]);
    expect(back.blocks.get(cid)?.length).toBe(300_000);
    expect(await decodeCar(encodeCar({ roots: [] }, new Map()))).toEqual({ roots: [], metadata: {}, blocks: new Map(), bad: [] });
    const empty = await rawCid(new Uint8Array(0));
    expect((await decodeCar(encodeCar({ roots: [empty] }, new Map([[empty, new Uint8Array(0)]])))).blocks.get(empty)).toEqual(new Uint8Array(0));
    const twice = concat(encodeCar({ roots: [] }, new Map([[other, utf8("o")]])), section(parseCid(other).bytes, utf8("o")));
    expect((await decodeCar(twice)).blocks.size).toBe(1);
    const backing = new Uint8Array(twice.length + 13).fill(0xff);
    backing.set(twice, 5);
    expect(await decodeCar(backing.subarray(5, 5 + twice.length))).toEqual(await decodeCar(twice));
  });

  it("refuses a length that is not minimally encoded, header or block; lengths across the one- and two-byte boundaries read back", async () => {
    const empty = encodeCar({ roots: [] }, new Map());
    expect(empty[0]).toBeLessThan(0x80);
    const overlongHeader = concat(new Uint8Array([(empty[0] as number) | 0x80, 0]), empty.subarray(1));
    await expect(decodeCar(overlongHeader)).rejects.toThrow(/minimally/);
    const data = utf8("x");
    const cid = await rawCid(data);
    const car = encodeCar({ roots: [cid] }, new Map([[cid, data]]));
    const offset = 1 + (car[0] as number);
    expect(car[offset]).toBe(37);
    const overlongBlock = concat(car.subarray(0, offset), new Uint8Array([37 | 0x80, 0]), car.subarray(offset + 1));
    await expect(decodeCar(overlongBlock)).rejects.toThrow(/minimally/);
    for (const size of [127 - 36, 128 - 36, 16383 - 36, 16384 - 36]) {
      const big = new Uint8Array(size).fill(1);
      const c = await rawCid(big);
      const back = await decodeCar(encodeCar({ roots: [c] }, new Map([[c, big]])));
      expect(back.blocks.get(c)?.length).toBe(size);
      expect(back.bad).toEqual([]);
    }
  });

  test("encodeCar takes only DASL CIDs", async () => {
    expect(() => encodeCar({ roots: ["bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"] }, new Map())).toThrow(/0x70/);
    expect(() => encodeCar({ roots: [] }, new Map([["nope", utf8("x")]]))).toThrow(/base32/);
  });
});

describe("CarWriter", () => {
  it("fills blocks a chunk at a time, empty chunks among them, into the bytes encodeCar writes at once", async () => {
    const { root, blocks } = await closure();
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    const all = new Map([...blocks, [await rawCid(big), big], [await rawCid(new Uint8Array(0)), new Uint8Array(0)]]);
    const header = { roots: [root], metadata: { estoc: { snapshot: 1 } } };
    const writer = new CarWriter(header, carLength(header, [...all.values()].map((bytes) => bytes.length)));
    for (const [cid, bytes] of all) {
      writer.block(cid, bytes.length);
      writer.write(new Uint8Array(0));
      for (let at = 0; at < bytes.length; at += 4096) writer.write(bytes.subarray(at, at + 4096));
    }
    expect(hex(writer.close())).toBe(hex(encodeCar(header, all)));
  });

  it("refuses a chunk past its block, a block begun before the last is full, and a close short of either", async () => {
    const cid = await rawCid(utf8("abc"));
    const header = { roots: [cid] };
    const length = carLength(header, [3, 3]);
    const past = new CarWriter(header, length);
    past.block(cid, 3);
    expect(() => past.write(utf8("abcd"))).toThrow(/4 bytes is past the 3 left/);
    past.write(utf8("ab"));
    expect(() => past.write(utf8("cd"))).toThrow(/2 bytes is past the 1 left/);
    expect(() => past.block(cid, 3)).toThrow(/block before is 1 bytes short/);
    expect(() => past.close()).toThrow(/last block is 1 bytes short/);
    past.write(utf8("c"));
    expect(() => past.close()).toThrow(/is \d+ of the \d+ bytes it was given/);
    expect(() => new CarWriter(header, length).write(utf8("a"))).toThrow(/past the 0 left/);
  });

  it("refuses a block that does not fit what is left, and a length shorter than the header or not a whole number", async () => {
    const cid = await rawCid(utf8("abc"));
    const header = { roots: [cid] };
    const writer = new CarWriter(header, carLength(header, [3]));
    expect(() => writer.block(cid, 4)).toThrow(/does not fit/);
    writer.block(cid, 3);
    writer.write(utf8("abc"));
    expect(() => writer.block(cid, 0)).toThrow(/does not fit in the 0 bytes left/);
    const least = carLength(header, []);
    expect(() => new CarWriter(header, least - 1)).toThrow(/at least/);
    expect(() => new CarWriter(header, least + 0.5)).toThrow(/at least/);
    expect(() => new CarWriter(header, least).block(cid, -1)).toThrow(/whole number/);
    expect(() => carLength(header, [1.5])).toThrow(/whole number/);
    expect(() => new CarWriter(header, carLength(header, [3])).block("nope", 3)).toThrow(/base32/);
  });

  it("hands over its bytes once and takes nothing more", async () => {
    const cid = await rawCid(new Uint8Array(0));
    const writer = new CarWriter({ roots: [] }, carLength({ roots: [] }, []));
    const car = writer.close();
    expect(await decodeCar(car)).toEqual({ roots: [], metadata: {}, blocks: new Map(), bad: [] });
    expect(() => writer.close()).toThrow(/closed/);
    expect(() => writer.write(new Uint8Array(0))).toThrow(/closed/);
    expect(() => writer.block(cid, 0)).toThrow(/closed/);
  });
});

test("carLength is the length of the CAR encodeCar writes, across the one- and two-byte varint boundaries", async () => {
  for (const size of [0, 1, 127 - 36, 128 - 36, 16383 - 36, 16384 - 36]) {
    const bytes = new Uint8Array(size).fill(9);
    const cid = await rawCid(bytes);
    for (const header of [{ roots: [] }, { roots: [cid] }, { roots: [cid], metadata: { pad: "x".repeat(130) } }]) {
      expect(carLength(header, [])).toBe(encodeCar(header, new Map()).length);
      expect(carLength(header, [size])).toBe(encodeCar(header, new Map([[cid, bytes]])).length);
    }
  }
});

/** A map with exactly these keys, `__proto__` among them if named: an object with no prototype takes it as a plain property. */
function withKeys(entries: [string, Drisl][]): { [key: string]: Drisl } {
  const out = Object.create(null) as { [key: string]: Drisl };
  for (const [key, value] of entries) out[key] = value;
  return out;
}

function prefixed(bytes: Uint8Array): Uint8Array {
  return concat(varint.encodeTo(bytes.length, new Uint8Array(varint.encodingLength(bytes.length))), bytes);
}

function section(name: Uint8Array, data: Uint8Array): Uint8Array {
  return prefixed(concat(name, data));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
