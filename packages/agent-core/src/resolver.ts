/**
 * A presented DID resolved to the evidence the vault retains of a
 * peer: the presented spelling, the canonical DID, the document as
 * RFC 8785 bytes under their raw CID, the methods it authorizes and
 * the DIDComm service it names. A numalgo-4 long form resolves from
 * itself, its short form only through a long form already in
 * evidence. A `did:web` is fetched by `@estoc/did-web` over the
 * host's transport, under its network policy, and its document is
 * checked here to be one the vault retains.
 *
 * Every failure is `unavailable` — no answer now, the work stays
 * retryable — or `definitive` — an answer that closes the attempt.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import bs58 from "bs58";
import ipaddr from "ipaddr.js";
import { varint } from "multiformats";
import { bases } from "multiformats/basics";

import { isLongForm, isPeerDID4, isShortForm } from "@estoc/did-peer";
import { DEFAULT_TIMEOUT_MS, fetchWebDid, type WebDidOptions } from "@estoc/did-web";
import { InvalidJson, canonicalize, isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store";
import { InvalidDidDocument, InvalidPublicKey, authorizedMethodIds, canonicalDidOf, canonicalPublicKey, didcommServiceUris, peerResolution, rawCidOfBytes, type Cid, type Did, type DidUrl, type KeyType, type VaultFold } from "@estoc/vault";

import { bounded } from "./link.js";
import type { AgentTrace } from "./trace.js";

/** A resolved peer document, in the exact form the vault retains and the folds check. */
export interface Resolution {
  /** the spelling that was resolved */
  presentedDid: Did;
  /** the DID for folds and comparisons: a numalgo-4 short form, any other DID as presented */
  did: Did;
  document: JsonObject;
  /** `UTF8(RFC8785(document))`: the retained object */
  bytes: Uint8Array;
  cid: Cid;
  authenticationMethodIds: DidUrl[];
  keyAgreementMethodIds: DidUrl[];
  /** the first DIDComm service endpoint the document names, or null */
  service: string | null;
}

export type Resolved = { outcome: "resolved"; resolution: Resolution } | { outcome: "unavailable"; reason: string } | { outcome: "definitive"; reason: string };

/** The long form of a numalgo-4 short form already in evidence, or null. */
export type KnownLongForms = (shortFormDid: Did) => Did | null;

/**
 * How a `did:web` is fetched: `@estoc/did-web`'s policy, over the
 * host's transport. The body is read as strict JSON.
 */
export interface WebResolverOptions extends Omit<WebDidOptions, "fetch" | "parse"> {
  /** the transport, under the contract `WebDidOptions` states; without one no `did:web` is resolved */
  fetch?: typeof fetch;
}

export interface ResolverOptions extends WebResolverOptions {
  /** every network resolution goes to the `diag` stream */
  trace?: AgentTrace;
}

const DID_METHOD = /^did:([a-z0-9]+):/;

const RELATIONSHIPS = ["authentication", "assertionMethod", "keyAgreement", "capabilityDelegation", "capabilityInvocation"];
/** The members a JWK carries only when it holds a private or symmetric key. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
/** The members a public JWK of each key type carries, by RFC 7518 §6 and RFC 8037 §2. */
const PUBLIC_JWK_MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["EC", ["crv", "x", "y"]],
  ["OKP", ["crv", "x"]],
  ["RSA", ["n", "e"]],
]);
/** A CAIP-10 account ID: chain namespace, chain reference, account address. */
const CAIP_10 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/;
const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})+$/;
/**
 * The most characters one encoded key may run to before any decoder
 * runs on it: a bound on the decoding done for one key, since base58
 * decoding is quadratic in its length. Set well above the keys the
 * suites here carry, not to fit every key in every encoding.
 */
const MAX_MATERIAL_CHARS = 1024;
/** About how long the document checks run between giving the loop back, so the deadline on the whole resolution can fire between them. */
const CHECK_SLICE_MS = 10;
// What the vault reads is listed here because it exports no table of
// it, and its `canonicalPublicKey` fails the same way on a key it does
// not read and on one it reads and finds wrong.
const READ_JWK_CURVES: ReadonlyMap<string, readonly KeyType[]> = new Map([
  ["OKP", ["Ed25519", "X25519"]],
  ["EC", ["P-256", "P-384", "P-521", "secp256k1"]],
]);
const READ_MULTICODECS: ReadonlyMap<number, KeyType> = new Map([
  [0xed, "Ed25519"],
  [0xec, "X25519"],
  [0xe7, "secp256k1"],
  [0x1200, "P-256"],
  [0x1201, "P-384"],
  [0x1202, "P-521"],
]);
const RAW_KEY_BYTES = 32;
interface Suite {
  /** the material a method of the suite carries, one of these */
  readonly material: readonly string[];
  /** the kind of key the suite is for, when it is for one kind */
  readonly keyType?: KeyType;
}
/**
 * The known suites. Any other type is another suite's: its method is
 * kept with whatever material it carries, and whether that is a
 * usable key is decided where the key is used.
 */
const SUITES: ReadonlyMap<string, Suite> = new Map([
  ["JsonWebKey2020", { material: ["publicKeyJwk"] }],
  ["Multikey", { material: ["publicKeyMultibase"] }],
  ["Ed25519VerificationKey2020", { material: ["publicKeyMultibase"], keyType: "Ed25519" }],
  ["X25519KeyAgreementKey2020", { material: ["publicKeyMultibase"], keyType: "X25519" }],
  ["Ed25519VerificationKey2018", { material: ["publicKeyBase58"], keyType: "Ed25519" }],
  ["X25519KeyAgreementKey2019", { material: ["publicKeyBase58"], keyType: "X25519" }],
  ["EcdsaSecp256k1VerificationKey2019", { material: ["publicKeyJwk", "publicKeyHex"], keyType: "secp256k1" }],
  ["EcdsaSecp256k1RecoveryMethod2020", { material: ["blockchainAccountId", "publicKeyJwk", "publicKeyHex"], keyType: "secp256k1" }],
]);
const METHOD_MEMBERS = new Set(["id", "type", "controller"]);

// RFC 3986 §3, component by component, on the raw string: the
// platform's URL parser escapes and normalizes what it is given rather
// than refusing it. A bracketed host is captured and checked apart:
// `ipaddr.js` decides whether it is an IPv6 address, and the grammar
// adds what the library does not hold to — a dotted tail in strict
// decimal, no zone identifier, IPvFuture under its own rule.
const PCHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})";
const QUERY_OR_FRAGMENT = `(?:${PCHAR}|[/?])*`;
const REG_CHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})";
const HOST = `(?:\\[([^\\]]*)\\]|${REG_CHAR}*)`;
const AUTHORITY = `(?:(?:${REG_CHAR}|:)*@)?${HOST}(?::[0-9]*)?`;
const HIER_PART = `(?://${AUTHORITY}(?:/${PCHAR}*)*|/(?:${PCHAR}+(?:/${PCHAR}*)*)?|${PCHAR}+(?:/${PCHAR}*)*|)`;
const URI = new RegExp(`^[A-Za-z][A-Za-z0-9+.-]*:${HIER_PART}(?:\\?${QUERY_OR_FRAGMENT})?(?:#${QUERY_OR_FRAGMENT})?$`);
const IPV_FUTURE = /^[vV][0-9A-Fa-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/;
const IPV6_CHARS = /^[0-9A-Fa-f:.]+$/;
const DEC_OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const IPV4 = new RegExp(`^${DEC_OCTET}(?:\\.${DEC_OCTET}){3}$`);

function definitive(reason: string): Resolved {
  return { outcome: "definitive", reason };
}

function unavailable(reason: string): Resolved {
  return { outcome: "unavailable", reason };
}

function messageOf(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(err);
}

function isIpLiteral(literal: string): boolean {
  if (IPV_FUTURE.test(literal)) return true;
  if (!IPV6_CHARS.test(literal) || !ipaddr.IPv6.isValid(literal)) return false;
  return !literal.includes(".") || IPV4.test(literal.slice(literal.lastIndexOf(":") + 1));
}

function isUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = URI.exec(value);
  return match !== null && (match[1] === undefined || isIpLiteral(match[1]));
}

function isDid(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    canonicalDidOf(value);
    return true;
  } catch (err) {
    if (err instanceof InvalidDidDocument) return false;
    throw err;
  }
}

function jwkFault(jwk: unknown): string | null {
  if (!isJsonObject(jwk)) return "an object";
  const secret = PRIVATE_JWK_MEMBERS.find((member) => jwk[member] !== undefined);
  if (secret !== undefined) return `a public key, without the private member ${secret}`;
  const kty = jwk["kty"];
  if (typeof kty !== "string") return "a JWK with a string kty";
  const missing = (PUBLIC_JWK_MEMBERS.get(kty) ?? []).find((member) => typeof jwk[member] !== "string");
  return missing === undefined ? null : `a ${kty} JWK with a string ${missing}`;
}

function encodedKeyFault(value: unknown, what: string, decode: (text: string) => Uint8Array): string | null {
  if (typeof value !== "string" || value.length > MAX_MATERIAL_CHARS) return `${what} within ${MAX_MATERIAL_CHARS} characters`;
  try {
    return decode(value).length > 0 ? null : what;
  } catch {
    return what;
  }
}

function decodeMultibase(text: string): Uint8Array {
  const base = Object.values(bases).find((candidate) => text.startsWith(candidate.prefix));
  if (base === undefined) throw new Error("no multibase prefix");
  return base.decode(text);
}

const MATERIAL_FAULTS: ReadonlyMap<string, (value: unknown) => string | null> = new Map([
  ["publicKeyJwk", jwkFault],
  ["publicKeyMultibase", (value) => encodedKeyFault(value, "a multibase-encoded value", decodeMultibase)],
  ["publicKeyBase58", (value) => encodedKeyFault(value, "a base58btc-encoded value", (text) => bs58.decode(text))],
  ["publicKeyHex", (value) => (typeof value === "string" && value.length <= MAX_MATERIAL_CHARS && HEX_BYTES.test(value) ? null : `hex-encoded bytes within ${MAX_MATERIAL_CHARS} characters`)],
  ["blockchainAccountId", (value) => (typeof value === "string" && CAIP_10.test(value) ? null : "a CAIP-10 account ID")],
]);

function invalidKey(read: () => unknown): string | null {
  try {
    read();
    return null;
  } catch (err) {
    if (err instanceof InvalidPublicKey) return err.message;
    throw err;
  }
}

/** The multicodec code a base58btc multibase key carries, or what is wrong with the value as one. */
function multicodecOf(text: string): number | string {
  if (!text.startsWith(bases.base58btc.prefix)) return "not under the base58btc prefix";
  try {
    const decoded = bases.base58btc.decode(text);
    const [code, length] = varint.decode(decoded);
    return decoded.length > length ? code : "no key bytes after the code";
  } catch (err) {
    return messageOf(err);
  }
}

function isSecp256k1Point(hex: string): boolean {
  try {
    secp256k1.Point.fromHex(hex);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fault in the key a method's material holds. Content rules apply
 * only to a representation that is known — a suite's prescribed one,
 * or a JWK or multicodec key of a kind the vault reads — since an
 * unknown suite may lay its bytes out its own way.
 */
function keyFault(entry: JsonObject, type: string, suite: Suite | undefined): string | null {
  const expects = suite?.keyType;
  const wrongKind = (kind: KeyType | undefined, other: string) => (expects !== undefined && kind !== expects ? `of type ${type} carries a ${expects} key, not ${kind ?? other}` : null);
  const jwk = entry["publicKeyJwk"];
  if (isJsonObject(jwk)) {
    const kty = String(jwk["kty"]);
    const crv = jwk["crv"];
    const kind = (READ_JWK_CURVES.get(kty) ?? []).find((curve) => curve === crv);
    const wrong = wrongKind(kind, `a ${kty} JWK${typeof crv === "string" ? ` of curve ${crv}` : ""}`);
    if (wrong !== null) return wrong;
    const fault = kind === undefined ? null : invalidKey(() => canonicalPublicKey(jwk));
    if (fault !== null) return `has a publicKeyJwk that is a ${kind} key: ${fault}`;
  }
  const multibase = entry["publicKeyMultibase"];
  if (typeof multibase === "string" && suite?.material.includes("publicKeyMultibase")) {
    const code = multicodecOf(multibase);
    if (typeof code === "string") return `has a publicKeyMultibase that is a base58btc multicodec key: ${code}`;
    const kind = READ_MULTICODECS.get(code);
    const wrong = wrongKind(kind, `one under multicodec 0x${code.toString(16)}`);
    if (wrong !== null) return wrong;
    const fault = kind === undefined ? null : invalidKey(() => canonicalPublicKey(multibase));
    if (fault !== null) return `has a publicKeyMultibase that is the ${kind} key its code says: ${fault}`;
  }
  const base58 = entry["publicKeyBase58"];
  if (typeof base58 === "string" && (expects === "Ed25519" || expects === "X25519") && bs58.decode(base58).length !== RAW_KEY_BYTES) return `of type ${type} carries a ${expects} key of ${RAW_KEY_BYTES} bytes`;
  const hex = entry["publicKeyHex"];
  if (typeof hex === "string" && expects === "secp256k1" && !isSecp256k1Point(hex)) return "has a publicKeyHex that is a point on secp256k1";
  return null;
}

function methodFault(entry: unknown): string | null {
  if (!isJsonObject(entry)) return "is an object";
  if (typeof entry["id"] !== "string") return "has a string id";
  if (typeof entry["type"] !== "string") return "has a string type";
  if (!isDid(entry["controller"])) return "has a DID controller";
  for (const [member, faultOf] of MATERIAL_FAULTS) {
    const value = entry[member];
    if (value === undefined) continue;
    const fault = faultOf(value);
    if (fault !== null) return `has a ${member} that is ${fault}`;
  }
  if (entry["publicKeyMultibase"] !== undefined && entry["publicKeyJwk"] !== undefined) return "carries publicKeyMultibase or publicKeyJwk, not both";
  const type = entry["type"];
  const suite = SUITES.get(type);
  if (suite === undefined) {
    if (!Object.keys(entry).some((member) => !METHOD_MEMBERS.has(member))) return `of type ${type} carries its verification material`;
  } else if (!suite.material.some((member) => entry[member] !== undefined)) {
    return `of type ${type} carries ${suite.material.join(" or ")}`;
  }
  return keyFault(entry, type, suite);
}

function endpointFault(endpoint: unknown): string | null {
  if (typeof endpoint === "string") return isUri(endpoint) ? null : "has a serviceEndpoint that is a URI";
  if (!isJsonObject(endpoint)) return "has a serviceEndpoint that is a URI or an object";
  const uri = endpoint["uri"];
  return uri === undefined || isUri(uri) ? null : "has a serviceEndpoint whose uri is a URI";
}

function serviceFault(entry: unknown): string | null {
  if (!isJsonObject(entry)) return "is an object";
  if (typeof entry["id"] !== "string") return "has a string id";
  const type = entry["type"];
  if (typeof type !== "string" && !(Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string"))) return "has a type, a string or strings";
  const endpoint = entry["serviceEndpoint"];
  if (Array.isArray(endpoint)) {
    if (endpoint.length === 0) return "has a serviceEndpoint that is not empty";
    return endpoint.map(endpointFault).find((fault) => fault !== null) ?? null;
  }
  return endpointFault(endpoint);
}

/**
 * The shape a fetched document must have before its relationships are
 * read: every method an object with an ID, a type, a DID controller
 * and the material its type defines, public if it is a JWK; every
 * service an object with a URI as its own ID, a type and an endpoint
 * that is a URI or an object. This is a published document, not a
 * numalgo-4 input: nothing is filled in for it, so a controller must
 * be there, and it may carry what this agent never uses — a method of
 * another suite with its own key format, a service of another kind —
 * since whether a key is usable is decided where the key is used.
 * The checks run in slices with the loop given back between them, so
 * the deadline on the whole resolution can end them.
 */
async function checkShape(document: JsonObject, did: Did, signal: AbortSignal): Promise<void> {
  let sliceBegan = performance.now();
  const pause = async (): Promise<void> => {
    if (performance.now() - sliceBegan < CHECK_SLICE_MS) return;
    await new Promise<void>((next) => setTimeout(next, 0));
    signal.throwIfAborted();
    sliceBegan = performance.now();
  };
  const each = async (member: string, faultOf: (entry: unknown) => string | null): Promise<void> => {
    const entries = document[member];
    if (entries === undefined) return;
    if (!Array.isArray(entries)) throw new InvalidDidDocument(`${member} is an array`);
    for (const [i, entry] of entries.entries()) {
      const fault = faultOf(entry);
      if (fault !== null) throw new InvalidDidDocument(`${member}[${i}] ${fault}`);
      await pause();
    }
  };
  await each("alsoKnownAs", (entry) => (typeof entry === "string" ? null : "is a string"));
  await each("verificationMethod", methodFault);
  await each("service", serviceFault);
  for (const relationship of RELATIONSHIPS) await each(relationship, (entry) => (typeof entry === "string" ? null : methodFault(entry)));
  const serviceIds = new Set<string>();
  (document["service"] as JsonObject[] | undefined)?.forEach((service, i) => {
    const reference = service["id"] as string;
    const id = reference.startsWith("#") || reference.startsWith("?") ? did + reference : reference;
    if (!isUri(id)) throw new InvalidDidDocument(`service[${i}].id is a URI or a reference into the document: ${JSON.stringify(reference)}`);
    if (serviceIds.has(id)) throw new InvalidDidDocument(`two services are ${id}`);
    serviceIds.add(id);
  });
}

/** The full resolution over a document the vault's rules accept, or a throw the caller classifies as definitive. */
function resolutionOf(presentedDid: Did, did: Did, document: JsonObject, bytes: Uint8Array, cid: Cid): Resolution {
  return {
    presentedDid,
    did,
    document,
    bytes,
    cid,
    authenticationMethodIds: authorizedMethodIds(document, "authentication"),
    keyAgreementMethodIds: authorizedMethodIds(document, "keyAgreement"),
    service: didcommServiceUris(document)[0] ?? null,
  };
}

/** A numalgo-4 DID from its validated long form, presented under either spelling. */
function resolvePeer(presented: string, known: KnownLongForms): Resolved {
  let longForm: string;
  if (isLongForm(presented)) {
    longForm = presented;
  } else if (isShortForm(presented)) {
    const found = known(presented as Did);
    if (found === null) return definitive(`no long form of ${presented} is in evidence`);
    longForm = found;
  } else {
    return definitive("not a did:peer:4 long or short form");
  }
  try {
    const { did, document, bytes, cid } = peerResolution(longForm);
    return { outcome: "resolved", resolution: resolutionOf(presented as Did, did, document, bytes, cid) };
  } catch (err) {
    if (err instanceof InvalidDidDocument) return definitive(err.message);
    throw err;
  }
}

/** The fetched document as the vault retains it, or why it is not one, checked under the deadline of the whole resolution. */
async function retained(did: Did, document: JsonObject, signal: AbortSignal, timeoutMs: number): Promise<Resolved> {
  try {
    await bounded(signal, () => checkShape(document, did, signal));
  } catch (err) {
    if (err instanceof InvalidDidDocument) return definitive(`the document is not one the vault retains: ${messageOf(err)}`);
    if (signal.aborted) return unavailable(`timed out: not resolved within ${timeoutMs} ms`);
    throw err;
  }
  try {
    const canonical = canonicalize(document);
    return { outcome: "resolved", resolution: resolutionOf(did, did, document, canonical, rawCidOfBytes(canonical)) };
  } catch (err) {
    if (err instanceof InvalidDidDocument || err instanceof InvalidJson) return definitive(`the document is not one the vault retains: ${messageOf(err)}`);
    throw err;
  }
}

/**
 * A `did:web` fetched and retained. One deadline covers the whole
 * resolution; the diagnostic written after it neither holds the
 * outcome nor overturns it.
 */
async function resolveWeb(presented: string, options: ResolverOptions): Promise<Resolved> {
  try {
    canonicalDidOf(presented);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return definitive(err.message);
    throw err;
  }
  if (options.fetch === undefined) return definitive("no transport: a did:web is fetched only over one that holds the network policy");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  const fetched = await fetchWebDid(presented, { fetch: options.fetch, maxBytes: options.maxBytes, timeoutMs, insecureLoopback: options.insecureLoopback, parse: parseStrict });
  if (fetched.outcome === "refused") return definitive(fetched.reason);
  let outcome: Resolved;
  if (fetched.outcome === "unavailable") outcome = unavailable(fetched.reason);
  else if (fetched.outcome === "definitive") outcome = definitive(fetched.reason);
  // read by `parseStrict`, so the object is JSON as the vault holds it
  else outcome = await retained(presented as Did, fetched.document as JsonObject, signal, timeoutMs);
  const trace = options.trace;
  if (trace !== undefined) {
    const entry = { did: presented, url: fetched.url.href, outcome: outcome.outcome, ...(outcome.outcome === "resolved" ? { cid: outcome.resolution.cid } : { reason: outcome.reason }), ms: Date.now() - started };
    await bounded(signal, () => trace.append("diag", "resolve", entry)).catch(() => undefined);
  }
  return outcome;
}

/**
 * Resolve a presented DID. A numalgo-4 DID needs no network and no
 * options; `known` supplies the long form of a short form already in
 * evidence, and nothing else can. A `did:web` goes to the network
 * under the options' policy. Any other method is unsupported, which
 * is a definitive answer.
 */
export async function resolve(presented: string, known: KnownLongForms, options: ResolverOptions = {}): Promise<Resolved> {
  const method = DID_METHOD.exec(presented)?.[1];
  if (method === "peer") return isPeerDID4(presented) ? resolvePeer(presented, known) : definitive("only numalgo 4 of did:peer is supported");
  if (method === "web") return resolveWeb(presented, options);
  return definitive(method === undefined ? `not a DID: ${JSON.stringify(presented)}` : `unsupported DID method ${method}`);
}

/**
 * Every numalgo-4 long form the fold has in evidence, by short form:
 * what a peer presented and was resolved under, what an intent was
 * addressed to, this vault's own entities and mediation identities,
 * the mediator as any creation or grant of an arrangement spells it,
 * and the mediator a retained document of this vault's own entity
 * sends through, which another replica may have minted before its
 * arrangement's long form reached here. A short form presented later
 * resolves through it. A spelling is validated when looked up — its
 * hash, its document, the short form it derives — so that an invalid
 * one in evidence never stands in for a valid one recorded beside it.
 */
export function knownLongForms(fold: VaultFold): KnownLongForms {
  const candidates = new Map<Did, Set<Did>>();
  const note = (spelling: Did | null | undefined): void => {
    if (spelling === null || spelling === undefined || !isLongForm(spelling)) return;
    const shortForm = spelling.slice(0, spelling.lastIndexOf(":")) as Did;
    const found = candidates.get(shortForm);
    if (found === undefined) candidates.set(shortForm, new Set([spelling]));
    else found.add(spelling);
  };
  for (const event of fold.set.of("peer.resolved")) note(event.data.presentedDid);
  for (const event of fold.set.of("message.in")) note(event.data.presentedDid);
  for (const event of fold.set.of("message.out")) note(event.data.recipientDid);
  for (const event of fold.set.of("did.created")) note(event.data.longFormDid);
  for (const event of fold.set.of("mediation.created")) {
    note(event.data.me.did);
    note(event.data.mediatorDid);
  }
  for (const event of fold.set.of("mediation.granted")) note(event.data.routingDid);
  for (const entity of fold.dids.entities.values()) if (entity.routeTarget?.kind === "mediated") note(entity.routeTarget.routingDid);
  return (shortFormDid) => {
    for (const candidate of candidates.get(shortFormDid) ?? []) {
      try {
        if (peerResolution(candidate).did === shortFormDid) return candidate;
      } catch (err) {
        if (!(err instanceof InvalidDidDocument)) throw err;
      }
    }
    return null;
  };
}
