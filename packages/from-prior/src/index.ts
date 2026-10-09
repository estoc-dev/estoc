/**
 * @estoc/from-prior — the DIDComm v2 `from_prior` proof: a compact JWT
 * the prior DID's authentication key signs, whose `iss` is the prior
 * DID, whose `sub` is the new DID, and which omits `sub` to end the
 * relationship instead. This module inspects a token without verifying
 * it, verifies one against the issuer's long form the host retained,
 * binds a verified proof to the receipt it arrived on, and creates one
 * with a signing capability the host supplies. A binding answers in the
 * proof's own terms, who wrote to whom and from which DID; what that
 * means for a relationship is the host's projection. Between inspecting
 * and verifying, a precheck applies every rule of the profile that
 * needs no issuer document, so a token that can never verify or bind
 * is refused before the host waits for material. The supported profile
 * is did:peer:4 issuers and subjects and Ed25519 keys; DID equivalence
 * is the did:peer:4 short form, and nothing rewrites a signed byte.
 *
 * A received ending carries no sender, so the standard's basic form
 * binds it to no particular relationship. This profile binds an ending
 * only when its JWT names the recipient in `aud`; an ending without an
 * audience verifies but does not bind.
 */

import { authorizedMethodIds, decodeLongForm, definedMethod, DIDDocumentError, isLongForm, isShortForm, longToShort, resolveLongForm, splitDidUrl } from "@estoc/did-peer";
import { base58, base64urlnopad } from "@scure/base";
import { compactVerify, decodeJwt, decodeProtectedHeader, errors, type JWK, type JWTPayload } from "jose";

export type Did = string;

export const FROM_PRIOR_PROFILE = "estoc-from-prior/1";
export const FROM_PRIOR_ALG = "EdDSA";

/**
 * Why a token is not a proof: its form, the profile it does not meet,
 * the receipt it cannot bind to, the document that is not its issuer's,
 * or its signature.
 */
export type FromPriorFailure = "form" | "profile" | "binding" | "document" | "signature";

export class InvalidFromPrior extends Error {
  override readonly name = "InvalidFromPrior";
  constructor(
    message: string,
    readonly failure: FromPriorFailure
  ) {
    super(message);
  }
}

export type DidUrl = string;

/** A DID as it was presented and the identity that spelling validates to. */
export type DidSpelling = Readonly<{ presented: Did; canonical: Did }>;

export type UnverifiedFromPrior = Readonly<{
  header: Readonly<{ alg: string; typ: string | undefined; kid: string }>;
  claims: Readonly<{ iss: string; sub: string | undefined; aud: string | undefined; iat: number }>;
}>;

/** What the host authenticated about the receipt before it has the issuer's material. */
export type PrecheckBinding = Readonly<{ authenticatedSender: Did }>;

const verified: unique symbol = Symbol("verified");

export type VerifiedChange = Readonly<{ kind: "rotate"; successor: DidSpelling }> | Readonly<{ kind: "end"; audience: DidSpelling | null }>;

/** A proof that verified under the profile: the issuer's declaration, before any receipt binding. */
export type VerifiedFromPrior = Readonly<{
  readonly [verified]: true;
  profile: typeof FROM_PRIOR_PROFILE;
  token: string;
  issuer: DidSpelling;
  change: VerifiedChange;
  iat: number;
  method: DidUrl;
}>;

/** What the host established about the receipt by decrypting and authenticating the envelope. */
export type Receipt = Readonly<{
  /** the token exactly as the receipt carried it */
  token: string;
  /** the local DID the envelope was actually addressed to */
  recipient: Did;
  /**
   * the authenticated sender; null only when the host established that
   * the envelope was anonymous and the plaintext carried no `from`
   */
  sender: Did | null;
}>;

/** What a bound proof establishes about its receipt, in short-form DIDs. */
export type BoundChange =
  | Readonly<{ kind: "rotate"; recipient: Did; issuer: Did; successor: Did }>
  | Readonly<{ kind: "end"; recipient: Did; issuer: Did }>;

export type Binding =
  | Readonly<{ status: "bound"; change: BoundChange }>
  | Readonly<{ status: "mismatch"; because: string }>
  | Readonly<{ status: "unbound"; because: string }>;

/**
 * A key the host holds under an authentication method of the issuer's
 * document, reduced to signing bytes so that a key behind a hardware
 * wallet or a keystore that exposes no key object can sign too.
 */
export type Signer = Readonly<{
  methodId: DidUrl;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}>;

export type ProofRequest = Readonly<{
  issuer: Did;
  change: Readonly<{ kind: "rotate"; successor: Did }> | Readonly<{ kind: "end"; audience: Did }>;
  iat: number;
  /** the issuer's long-form did:peer:4, which is its document */
  issuerLongForm: Did;
}>;

const ED25519_MULTICODEC = [0xed, 0x01];
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

function form(message: string): InvalidFromPrior {
  return new InvalidFromPrior(message, "form");
}

function profile(message: string): InvalidFromPrior {
  return new InvalidFromPrior(message, "profile");
}

function unbindable(message: string): InvalidFromPrior {
  return new InvalidFromPrior(message, "binding");
}

/** The identity a did:peer:4 spelling names, its long form checked against its hash. */
function canonicalDid(spelling: unknown, what: string): DidSpelling {
  if (typeof spelling !== "string") throw profile(`${what} is a string`);
  if (isShortForm(spelling)) return { presented: spelling, canonical: spelling };
  if (!isLongForm(spelling)) throw profile(`${what} is a did:peer:4`);
  try {
    decodeLongForm(spelling);
  } catch (err) {
    throw profile(`${what} does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { presented: spelling, canonical: longToShort(spelling) };
}

/** A DID URL naming a method: a did:peer:4 spelling and one non-empty fragment. */
function methodUrl(url: unknown, what: string): { did: DidSpelling; fragment: string } {
  if (typeof url !== "string") throw profile(`${what} is a string`);
  const hash = url.indexOf("#");
  if (hash < 0 || url.indexOf("#", hash + 1) >= 0 || hash === url.length - 1) throw profile(`${what} is a DID URL with one fragment`);
  return { did: canonicalDid(url.slice(0, hash), `the DID of ${what}`), fragment: url.slice(hash + 1) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ProtectedHeader = Readonly<Record<string, unknown>> & Readonly<{ alg: string; typ: string | undefined; kid: string }>;

type Decoded = Readonly<{ header: ProtectedHeader; claims: UnverifiedFromPrior["claims"] }>;

/** The token's segments decoded and checked for shape: what it says, not what it proves. */
function decode(jwt: string): Decoded {
  checkSegments(jwt);
  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: JWTPayload;
  try {
    header = decodeProtectedHeader(jwt);
    payload = decodeJwt(jwt);
  } catch (err) {
    throw form(`not a compact JWT: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof header.alg !== "string") throw form("the protected header names an alg");
  if (typeof header.kid !== "string") throw form("the protected header names a kid");
  if (header.typ !== undefined && typeof header.typ !== "string") throw form("typ is a string");
  checkHeaderExtensions(header);
  return { header: { ...header, alg: header.alg, typ: header.typ, kid: header.kid }, claims: claimsOf(payload) };
}

/**
 * The three segments as received, each base64url without padding,
 * whitespace or other characters (RFC 7515 §2, §5.2). They are checked
 * before the library reads them, because its decoder tolerates some of
 * what the grammar excludes, and they are not normalized, because the
 * signing input is the segments as received. The signature has the
 * length of an Ed25519 signature; whether it verifies needs the
 * issuer's key.
 */
function checkSegments(jwt: string): void {
  const segments = jwt.split(".");
  if (segments.length !== 3) throw form("not a compact JWT: the token is three segments");
  const [header, payload, signature] = segments as [string, string, string];
  segmentBytes(header, "protected header");
  segmentBytes(payload, "payload");
  if (segmentBytes(signature, "signature").length !== ED25519_SIGNATURE_BYTES) throw form(`the signature is ${ED25519_SIGNATURE_BYTES} bytes`);
}

function segmentBytes(segment: string, what: string): Uint8Array {
  try {
    return base64urlnopad.decode(segment);
  } catch {
    throw form(`not a compact JWT: the ${what} segment is base64url without padding or whitespace`);
  }
}

function unverifiedOf({ header, claims }: Decoded): UnverifiedFromPrior {
  return { header: { alg: header.alg, typ: header.typ, kid: header.kid }, claims };
}

/**
 * A token's protected header and claims, decoded and checked for shape
 * only: three unpadded base64url segments, the header members and
 * claims this profile reads, the RFC 7797 pairing of `b64` and `crit`,
 * and a signature segment of the right length. What this returns is
 * what the token says, not a proof; it lets the host find the issuer's
 * material, and `precheckFromPrior` applies the profile to it.
 */
export function inspectFromPrior(jwt: string): UnverifiedFromPrior {
  return unverifiedOf(decode(jwt));
}

/**
 * Every rule of the profile that needs no issuer document, applied
 * before the host has one: the algorithm, the optional media type, the
 * critical headers, the DIDs and the shape of the change; and, when the
 * host gives the authenticated sender of the receipt, that a rotation's
 * successor is that sender. A token this refuses can never verify or
 * bind, so the host need not wait for material. What it returns is still
 * unverified: nothing here checks a key or a signature, and an ending's
 * binding is decided by `bindFromPrior` alone.
 */
export function precheckFromPrior(jwt: string, binding?: PrecheckBinding): UnverifiedFromPrior {
  const decoded = decode(jwt);
  const { change } = checkProfile(decoded);
  if (binding !== undefined && change.kind === "rotate") {
    let sender: DidSpelling;
    try {
      sender = canonicalDid(binding.authenticatedSender, "the sender");
    } catch (err) {
      throw unbindable(err instanceof Error ? err.message : String(err));
    }
    if (sender.canonical !== change.successor.canonical) throw unbindable(`sub is ${change.successor.presented} but the sender is ${sender.presented}`);
  }
  return unverifiedOf(decoded);
}

/** The profile rules a decoded token meets or fails without its issuer's document. */
function checkProfile({ header, claims }: Decoded): { issuer: DidSpelling; change: VerifiedChange } {
  if (header.alg !== FROM_PRIOR_ALG) throw profile(`alg is ${FROM_PRIOR_ALG}`);
  if (!isJwtType(header.typ)) throw profile("typ, when present, is JWT or application/jwt");
  if (Array.isArray(header["crit"])) {
    for (const name of header["crit"]) if (name !== "b64") throw profile(`the critical header ${name} is not one this profile understands`);
  }
  const issuer = canonicalDid(claims.iss, "iss");
  const kid = methodUrl(header.kid, "kid");
  if (kid.did.canonical !== issuer.canonical) throw profile("the kid names a key of iss");
  return { issuer, change: profileChange(claims, issuer) };
}

/**
 * RFC 7515 §4.1.11 has `crit` as a non-empty array of header names with
 * no repetition. RFC 7797 lets a JWS declare an unencoded payload with
 * `b64`, requires `crit` to list it, and forbids `false` for a JWT
 * (§6, §7). The library reads `b64` only when `crit` names it, so a
 * token that omits `crit` would otherwise be verified as if its payload
 * were encoded; and it tolerates a repeated entry, which is refused
 * here. Whether each listed header is one this profile understands is
 * a profile question, checked with the rest of the profile.
 */
function checkHeaderExtensions(header: Record<string, unknown>): void {
  const crit = header["crit"];
  if (crit !== undefined) {
    if (!Array.isArray(crit) || crit.length === 0 || crit.some((name) => typeof name !== "string" || name.length === 0)) throw form("crit, when present, is an array of non-empty strings");
    if (new Set(crit).size !== crit.length) throw form("crit lists no header twice");
  }
  if (Object.hasOwn(header, "b64")) {
    if (header["b64"] !== true) throw form("b64, when present, is true: a JWT's payload is base64url-encoded");
    if (!Array.isArray(crit) || !crit.includes("b64")) throw form("crit lists b64 when the header has it");
  } else if (Array.isArray(crit) && crit.includes("b64")) {
    throw form("crit names b64 only when the header has it");
  }
}

function claimsOf(payload: JWTPayload): UnverifiedFromPrior["claims"] {
  if (typeof payload.iss !== "string") throw form("iss is a string");
  if (Object.hasOwn(payload, "sub") && typeof payload.sub !== "string") throw form("sub, when present, is a string");
  if (Object.hasOwn(payload, "aud") && typeof payload.aud !== "string") throw form("aud, when present, is one string");
  if (!Number.isSafeInteger(payload.iat)) throw form("iat is an integer");
  if (Object.hasOwn(payload, "exp") || Object.hasOwn(payload, "nbf")) throw form("a from_prior has no exp or nbf; this profile evaluates no validity window");
  return { iss: payload.iss, sub: payload.sub, aud: payload.aud as string | undefined, iat: payload.iat as number };
}

const decoder = new TextDecoder();

/**
 * The claims a verified signature covers, read again from the bytes the
 * library verified. They are the claims the pre-verification decode
 * read, so the issuer whose document was consulted and whose key the
 * `kid` named is the issuer returned: both reads take the same payload
 * segment through the library's one base64url decoder; once
 * `checkHeaderExtensions` passes, `b64` cannot be `false`, so the
 * verified payload is that segment decoded; and `decodeJwt` already
 * decoded those bytes as UTF-8 with a fatal decoder, so this decode
 * yields the same text.
 */
function verifiedClaims(payload: Uint8Array): UnverifiedFromPrior["claims"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    throw form("the payload is JSON");
  }
  if (!isPlainObject(parsed)) throw form("the payload is an object");
  return claimsOf(parsed as JWTPayload);
}

/**
 * RFC 7519 makes `typ` optional and its value a media type, compared
 * case-insensitively; both spellings the RFC gives for a JWT are
 * accepted, and creation emits the short one.
 */
function isJwtType(typ: string | undefined): boolean {
  if (typ === undefined) return true;
  const lower = typ.toLowerCase();
  return lower === "jwt" || lower === "application/jwt";
}

type Method = { id: string; key: JWK };

/**
 * The method's key as the JWK the library verifies with. A
 * `publicKeyJwk` is passed whole, so the library refuses one that
 * carries a private key, or whose `use`, `key_ops` or `alg`
 * (RFC 7517 §4.2–4.4) does not allow verifying EdDSA. Its `x` is
 * checked first to be the key's 32 bytes in unpadded base64url
 * (RFC 8037 §2): runtimes import a JWK with padding, whitespace or
 * other characters differently, and the same proof would verify in one
 * and not in another.
 */
function ed25519Jwk(method: Record<string, unknown>, id: string): JWK {
  const multibase = method["publicKeyMultibase"];
  const jwk = method["publicKeyJwk"];
  if (typeof multibase === "string" && jwk === undefined) {
    if (!multibase.startsWith("z")) throw new InvalidFromPrior(`${id}: publicKeyMultibase is base58btc`, "document");
    let bytes: Uint8Array;
    try {
      bytes = base58.decode(multibase.slice(1));
    } catch {
      throw new InvalidFromPrior(`${id}: publicKeyMultibase is base58btc`, "document");
    }
    if (bytes.length !== ED25519_MULTICODEC.length + ED25519_KEY_BYTES || bytes[0] !== ED25519_MULTICODEC[0] || bytes[1] !== ED25519_MULTICODEC[1]) throw new InvalidFromPrior(`${id} is not an Ed25519 key`, "document");
    return { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(bytes.subarray(ED25519_MULTICODEC.length)) };
  }
  if (isPlainObject(jwk) && multibase === undefined) {
    const x = jwk["x"];
    if (jwk["kty"] !== "OKP" || jwk["crv"] !== "Ed25519" || typeof x !== "string") throw new InvalidFromPrior(`${id} is not an Ed25519 key`, "document");
    let bytes: Uint8Array;
    try {
      bytes = base64urlnopad.decode(x);
    } catch {
      throw new InvalidFromPrior(`${id}: publicKeyJwk x is base64url without padding or whitespace`, "document");
    }
    if (bytes.length !== ED25519_KEY_BYTES) throw new InvalidFromPrior(`${id} is not an Ed25519 key`, "document");
    return { ...jwk };
  }
  throw new InvalidFromPrior(`${id} carries one of publicKeyMultibase and publicKeyJwk`, "document");
}

/**
 * The issuer's document, resolved from the long form the host retained:
 * the long form's hash covers the document, so a key found in it is the
 * issuer's own.
 */
function issuerDocument(longForm: Did, issuer: DidSpelling): Record<string, unknown> {
  if (typeof longForm !== "string" || !isLongForm(longForm)) throw new InvalidFromPrior("the issuer's material is a long-form did:peer:4", "document");
  let document: unknown;
  try {
    document = resolveLongForm(longForm);
  } catch (err) {
    throw new InvalidFromPrior(`the issuer's long form does not resolve: ${err instanceof Error ? err.message : String(err)}`, "document");
  }
  if (longToShort(longForm) !== issuer.canonical) throw new InvalidFromPrior(`the long form is ${longForm}'s, not ${issuer.presented}'s`, "document");
  if (!isPlainObject(document)) throw new InvalidFromPrior("the issuer document is an object", "document");
  return document;
}

function read<T>(reading: () => T): T {
  try {
    return reading();
  } catch (err) {
    if (err instanceof DIDDocumentError) throw new InvalidFromPrior(err.message, "document");
    throw err;
  }
}

/**
 * The authentication method of the issuer's document that `kid` names,
 * the document read as `@estoc/did-peer` reads any DID document: of the
 * methods it authorizes for authentication, the one whose DID is the
 * kid's, in either form, and whose fragment is the kid's byte for byte.
 */
function authenticationMethod(documentId: string, document: Record<string, unknown>, kid: string): Method {
  const target = methodUrl(kid, "kid");
  const named = (id: string): boolean => {
    const [did, rest] = splitDidUrl(id);
    if (rest !== `#${target.fragment}`) return false;
    try {
      return canonicalDid(did, "a method id").canonical === target.did.canonical;
    } catch {
      return false;
    }
  };
  const id = read(() => authorizedMethodIds(document, "authentication")).find(named);
  if (id === undefined) throw new InvalidFromPrior(`${kid} is not an authentication method of ${documentId}`, "document");
  return { id: kid, key: ed25519Jwk(read(() => definedMethod(document, id)), id) };
}

function profileChange(claims: UnverifiedFromPrior["claims"], issuer: DidSpelling): VerifiedChange {
  if (claims.sub !== undefined) {
    const successor = canonicalDid(claims.sub, "sub");
    if (successor.canonical === issuer.canonical) throw profile("sub is another DID than iss");
    if (claims.aud !== undefined) throw profile("a rotation names no aud");
    return { kind: "rotate", successor };
  }
  const audience = claims.aud === undefined ? null : canonicalDid(claims.aud, "aud");
  if (audience !== null && audience.canonical === issuer.canonical) throw profile("aud is another DID than iss");
  return { kind: "end", audience };
}

/**
 * Verify a token against the issuer's retained long form: the protected
 * `kid` names an authentication method of the document that long form
 * encodes, that method's Ed25519 key verifies the JWS, and the claims
 * the signature covers meet the profile. The document-independent rules
 * are the ones `precheckFromPrior` applies, so the two never diverge.
 * The library checks the key and the signature only: every rule of the
 * token it applies has been applied before, so a failure other than the
 * signature's is the key's. The profile has no time-bound claim and
 * consults no clock. The token is retained as given; a failure says
 * whether form, profile, document or signature failed.
 */
export async function verifyFromPrior(jwt: string, issuerLongForm: Did): Promise<VerifiedFromPrior> {
  const decoded = decode(jwt);
  const { issuer } = checkProfile(decoded);
  const document = issuerDocument(issuerLongForm, issuer);
  const method = authenticationMethod(issuerLongForm, document, decoded.header.kid);
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(jwt, method.key, { algorithms: [FROM_PRIOR_ALG] }));
  } catch (err) {
    if (err instanceof errors.JWSSignatureVerificationFailed) throw new InvalidFromPrior(`the signature does not verify under ${method.id}`, "signature");
    throw new InvalidFromPrior(`${method.id} is not a public Ed25519 key that verifies ${FROM_PRIOR_ALG}: ${err instanceof Error ? err.message : String(err)}`, "document");
  }
  const claims = verifiedClaims(payload);
  const signedIssuer = canonicalDid(claims.iss, "iss");
  return {
    [verified]: true,
    profile: FROM_PRIOR_PROFILE,
    token: jwt,
    issuer: signedIssuer,
    change: profileChange(claims, signedIssuer),
    iat: claims.iat,
    method: method.id,
  } as VerifiedFromPrior;
}

/**
 * Bind a verified proof to the receipt it arrived on. A rotation binds
 * when the receipt carries this very token and its authenticated
 * sender is the successor: the successor wrote to the recipient, having
 * rotated from the issuer. An ending binds when the receipt is
 * anonymous and the proof names the recipient as its audience: the
 * issuer ended what it had with the recipient. The bound change names
 * the recipient, the issuer and, for a rotation, the successor; the
 * host projects it into its own model. Anything else binds nothing.
 */
export function bindFromPrior(proof: VerifiedFromPrior, receipt: Receipt): Binding {
  if (receipt.token !== proof.token) return { status: "mismatch", because: "the receipt carries another token than the proof" };
  let recipient: DidSpelling;
  let sender: DidSpelling | null;
  try {
    recipient = canonicalDid(receipt.recipient, "the recipient");
    sender = receipt.sender === null ? null : canonicalDid(receipt.sender, "the sender");
  } catch (err) {
    return { status: "mismatch", because: err instanceof Error ? err.message : String(err) };
  }
  if (recipient.canonical === proof.issuer.canonical) return { status: "mismatch", because: "the recipient is the issuer" };
  if (proof.change.kind === "rotate") {
    const successor = proof.change.successor;
    if (sender === null) return { status: "mismatch", because: "a rotation arrives from an authenticated sender" };
    if (sender.canonical !== successor.canonical) return { status: "mismatch", because: `sub is ${successor.presented} but the sender is ${sender.presented}` };
    if (recipient.canonical === successor.canonical) return { status: "mismatch", because: "the recipient is the successor" };
    return { status: "bound", change: { kind: "rotate", recipient: recipient.canonical, issuer: proof.issuer.canonical, successor: successor.canonical } };
  }
  if (sender !== null) return { status: "mismatch", because: "an ending arrives without a sender" };
  if (proof.change.audience === null) return { status: "unbound", because: "the ending names no audience; this profile binds an ending only to the recipient it names" };
  if (proof.change.audience.canonical !== recipient.canonical) return { status: "mismatch", because: `aud is ${proof.change.audience.presented} but the recipient is ${recipient.presented}` };
  return { status: "bound", change: { kind: "end", recipient: recipient.canonical, issuer: proof.issuer.canonical } };
}

const encoder = new TextEncoder();

function segment(value: unknown): string {
  return base64urlnopad.encode(encoder.encode(JSON.stringify(value)));
}

/**
 * Create a proof of the requested change and verify it against the
 * issuer's long form before returning it: the signer's method must be an
 * authentication method of the issuer's document and its signature
 * must verify under that method's key. The result is what the host
 * saves with its decision; creating it decides and sends nothing.
 */
export async function createFromPrior(request: ProofRequest, signer: Signer): Promise<VerifiedFromPrior> {
  const issuer = canonicalDid(request.issuer, "the issuer");
  if (!Number.isSafeInteger(request.iat)) throw profile("iat is an integer");
  const claims: Record<string, unknown> = { iss: issuer.presented };
  if (request.change.kind === "rotate") {
    const successor = canonicalDid(request.change.successor, "the successor");
    if (successor.canonical === issuer.canonical) throw profile("the successor is another DID than the issuer");
    claims["sub"] = successor.presented;
  } else {
    const audience = canonicalDid(request.change.audience, "the audience");
    if (audience.canonical === issuer.canonical) throw profile("the audience is another DID than the issuer");
    claims["aud"] = audience.presented;
  }
  claims["iat"] = request.iat;
  const signingInput = `${segment({ alg: FROM_PRIOR_ALG, typ: "JWT", kid: signer.methodId })}.${segment(claims)}`;
  const signature = await signer.sign(encoder.encode(signingInput));
  if (!(signature instanceof Uint8Array)) throw new InvalidFromPrior("the signer returned no bytes", "signature");
  if (signature.length !== ED25519_SIGNATURE_BYTES) throw new InvalidFromPrior(`the signer returned ${signature.length} bytes, not an Ed25519 signature`, "signature");
  const token = `${signingInput}.${base64urlnopad.encode(signature)}`;
  const proof = await verifyFromPrior(token, request.issuerLongForm);
  const matches =
    proof.issuer.presented === request.issuer &&
    proof.iat === request.iat &&
    proof.method === signer.methodId &&
    (request.change.kind === "rotate" ? proof.change.kind === "rotate" && proof.change.successor.presented === request.change.successor : proof.change.kind === "end" && proof.change.audience?.presented === request.change.audience);
  if (!matches) throw new InvalidFromPrior("the created proof does not state the requested change", "profile");
  return proof;
}
