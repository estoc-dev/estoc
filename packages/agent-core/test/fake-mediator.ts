import { Message } from "@estoc/didcomm-node";
import type { IMessage } from "@estoc/didcomm-node";
import { encodeLongForm, longToShort, resolveDIDCommDoc, resolveShortForm, toDIDCommDIDDoc } from "@estoc/did-peer";
import type { Secret } from "@estoc/did-peer";
import bs58 from "bs58";
import { base64urlToBytes } from "@estoc/did-peer";
import type { DerivedIdentity } from "@estoc/keystore";
import { RECIPIENT_PROOF_TYP, canonicalDid, decodePublicKey, methodPublicKey, peerResolution, readReplicaGrant, sameDid, splitDidUrl, type Did, type DidUrl } from "@estoc/vault";
import { base64url, compactVerify, decodeProtectedHeader, importJWK } from "jose";

import {
  ACCOUNT_REGISTER,
  ACCOUNT_REGISTERED,
  DELIVERY,
  DELIVERY_REQUEST,
  FORWARD,
  LIVE_DELIVERY_CHANGE,
  MESSAGES_RECEIVED,
  PLAIN_TYP,
  RECIPIENT_ADD,
  RECIPIENT_ADDED,
  REPLICA_ADD,
  REPLICA_ADDED,
  STATUS,
  STATUS_REQUEST,
  secretsResolverFor,
} from "../src/index.js";
import { didOf } from "../src/protocol/didcomm.js";

/**
 * A mediator that lives inside the test: messagepickup 3.0 (HTTP and a
 * fake WebSocket), routing 2.0 forward, and of replica-mediation the
 * account-register, replica-add and recipient-add controls, the fan-out
 * of a shared address's mail to the account's replicas and each
 * replica's own pickup.
 * It speaks the same wire shapes as mediator-ts's demo-interop test pins,
 * minus everything an in-process double does not need (auth, persistence,
 * problem reports).
 */

export const MEDIATOR_HTTP = "http://fake-mediator/";
const PROBLEM_REPORT = "https://didcomm.org/report-problem/2.0/problem-report";
export const MEDIATOR_WS = "ws://fake-mediator/ws";

const resolver = { resolve: resolveDIDCommDoc };

function multibase(prefix: number[], key: Uint8Array): string {
  const bytes = new Uint8Array(prefix.length + key.length);
  bytes.set(prefix);
  bytes.set(key, prefix.length);
  return `z${bs58.encode(bytes)}`;
}

/** A did:peer:4 with both an HTTP and a WebSocket service. */
export function mintMediatorIdentity(
  identity: DerivedIdentity,
  http = MEDIATOR_HTTP,
  ws = MEDIATOR_WS
): { did: string; secrets: Secret[] } {
  const jwks = identity.privateJwks();
  const did = encodeLongForm({
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    verificationMethod: [
      { id: "#key-1", type: "Multikey", publicKeyMultibase: multibase([0xed, 0x01], base64urlToBytes(jwks.ed25519.x as string)) },
      { id: "#key-2", type: "Multikey", publicKeyMultibase: multibase([0xec, 0x01], base64urlToBytes(jwks.x25519.x as string)) },
    ],
    authentication: ["#key-1"],
    keyAgreement: ["#key-2"],
    service: [
      { id: "#http", type: "DIDCommMessaging", serviceEndpoint: { uri: http, accept: ["didcomm/v2"] } },
      { id: "#ws", type: "DIDCommMessaging", serviceEndpoint: { uri: ws, accept: ["didcomm/v2"] } },
    ],
  });
  return {
    did,
    secrets: [
      { id: `${did}#key-1`, type: "JsonWebKey2020", privateKeyJwk: { ...jwks.ed25519 } },
      { id: `${did}#key-2`, type: "JsonWebKey2020", privateKeyJwk: { ...jwks.x25519 } },
    ],
  };
}

interface Queued {
  id: string;
  packed: string;
}

export class FakeSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(
    private readonly mediator: FakeMediator,
    readonly url: string
  ) {
    setTimeout(() => this.onopen?.({}), 0);
  }

  send(text: string): void {
    void this.mediator.handleWs(this, text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mediator.socketClosed(this);
    this.onclose?.({});
  }

  /** the mediator pushing a frame down */
  deliver(text: string): void {
    this.onmessage?.({ data: text });
  }
}

/** Did `recipientDid`'s own authentication key sign `proof` for exactly this account and mediator? The key is read from `longForm`. */
async function provesRecipient(proof: string, recipientDid: string, longForm: string, account: string, mediator: string): Promise<boolean> {
  try {
    const recipient = peerResolution(longForm as Did);
    const { alg, typ, kid } = decodeProtectedHeader(proof);
    if (recipient.did !== recipientDid || alg !== "EdDSA" || typ !== RECIPIENT_PROOF_TYP || canonicalDid(splitDidUrl(kid as DidUrl)[0]) !== recipientDid) return false;
    const key = decodePublicKey(methodPublicKey(recipient.document, kid as DidUrl));
    const { payload } = await compactVerify(proof, await importJWK({ kty: "OKP", crv: "Ed25519", x: base64url.encode(key.bytes) }, "EdDSA"));
    const said = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    return Object.keys(said).sort().join() === "account,aud,recipient" && said["account"] === account && sameDid(said["aud"] as string, mediator) && said["recipient"] === recipientDid;
  } catch {
    return false;
  }
}

export class FakeMediator {
  readonly did: string;
  readonly secrets: Secret[];
  /** seal every reply and frame with the sender hidden under an anonymous outer layer, as DIDComm's sender protection does */
  protectSender = false;
  /** seal every reply and frame as the mediator's short form, the other spelling of the same DID */
  answerAsShortForm = false;
  /** replica-mediation accounts, by their short form */
  readonly replicaAccounts = new Set<string>();
  /** the replicas added, by replica DID: the account and the grant each was added with */
  readonly replicas = new Map<string, { account: string; replicaDid: string; grant: string }>();
  /** the communication DIDs replica-mediation accounts hold: recipient DID → account, both by short form */
  readonly sharedRecipients = new Map<string, string>();
  /** recipient DIDs every recipient-add of which is answered `quota` */
  readonly refuseShared = new Set<string>();
  readonly queues = new Map<string, Queued[]>();
  private readonly sockets = new Map<string, FakeSocket>();
  /** every plaintext type the mediator handled, in order — for assertions */
  readonly seenTypes: string[] = [];
  /** a test's hand on the dispatch: a reply of its own (null for none), or `undefined` to let the mediator answer as usual */
  intercept: ((msg: IMessage, from: string | null) => Promise<IMessage | null | undefined> | IMessage | null | undefined) | null = null;
  /** the fake `fetch`: the mediator's endpoint, or 404 */
  readonly fetch: typeof fetch;
  /** the fake `WebSocket` constructor bound to this mediator */
  readonly WebSocket: typeof WebSocket;

  /** Two mediators in one test tell apart by their endpoints; see `network`. */
  constructor(
    identity: DerivedIdentity,
    readonly http = MEDIATOR_HTTP,
    readonly wsUrl = MEDIATOR_WS
  ) {
    const minted = mintMediatorIdentity(identity, http, wsUrl);
    this.did = minted.did;
    this.secrets = minted.secrets;
    this.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== this.http) {
        return new Response("not found", { status: 404 });
      }
      const reply = await this.handleHttp(String(init?.body));
      return reply === null
        ? new Response(null, { status: 202 })
        : new Response(reply, { status: 200, headers: { "content-type": "application/didcomm-encrypted+json" } });
    }) as typeof fetch;
    const mediator = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(mediator, url);
      }
    } as unknown as typeof WebSocket;
  }

  private async unpack(text: string): Promise<{ msg: IMessage; from: string | null }> {
    const [msg, meta] = await Message.unpack(text, resolver, secretsResolverFor(this.secrets), {});
    return { msg: msg.as_value(), from: didOf(meta.encrypted_from_kid) };
  }

  private async pack(msg: IMessage, to: string): Promise<string> {
    if (this.answerAsShortForm) return this.packAsShortForm(msg, to);
    const [packed] = await new Message(msg).pack_encrypted(
      to,
      this.did,
      null,
      resolver,
      secretsResolverFor(this.secrets),
      { forward: false, protect_sender: this.protectSender }
    );
    return packed;
  }

  private async packAsShortForm(msg: IMessage, to: string): Promise<string> {
    const short = longToShort(this.did);
    const respelled = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(this.did, short)) as T;
    const document = respelled(await resolveDIDCommDoc(this.did));
    const [packed] = await new Message({ ...msg, from: short }).pack_encrypted(
      to,
      short,
      null,
      { resolve: async (did: string) => (did === short ? document : resolveDIDCommDoc(did)) },
      secretsResolverFor(respelled(this.secrets)),
      { forward: false, protect_sender: this.protectSender }
    );
    return packed;
  }

  reply(type: string, to: string, body: Record<string, unknown>, thid?: string): IMessage {
    return {
      id: crypto.randomUUID(),
      typ: PLAIN_TYP,
      type,
      from: this.did,
      to: [to],
      created_time: Math.floor(Date.now() / 1000),
      ...(thid === undefined ? {} : { thid }),
      body,
    } as IMessage;
  }

  private refused(to: string, code: string, thid: string): IMessage {
    return this.reply(PROBLEM_REPORT, to, { code: `e.estoc.replica-mediation.${code}` }, thid);
  }

  /** The queue a pickup sender reads: a replica's own under its short form, whichever spelling it sealed with; any other sender's under the DID it sealed as. */
  private inboxOf(from: string): string {
    const canonical = canonicalDid(from);
    return this.replicas.has(canonical) ? canonical : from;
  }

  /** A frame for a replica is sealed to its short form, which resolves from the long form its grant carried. */
  private async push(inbox: string, msg: IMessage): Promise<void> {
    const socket = this.sockets.get(inbox);
    if (socket === undefined) return;
    const replica = this.replicas.get(inbox);
    if (replica === undefined) return socket.deliver(await this.pack(msg, inbox));
    const longForm = readReplicaGrant(replica.grant).replicaLongForm;
    const document = toDIDCommDIDDoc(resolveShortForm(longForm));
    const [packed] = await new Message(msg).pack_encrypted(inbox, this.did, null, { resolve: async (did: string) => (did === inbox ? document : resolveDIDCommDoc(did)) }, secretsResolverFor(this.secrets), { forward: false });
    socket.deliver(packed);
  }

  private queue(account: string): Queued[] {
    let q = this.queues.get(account);
    if (q === undefined) {
      q = [];
      this.queues.set(account, q);
    }
    return q;
  }

  /** Where mail forwarded to `next` waits: a replica's own queue, or one copy under an ID of its own for every replica the shared address's account has now. */
  private inboxesFor(next: string): string[] {
    const canonical = canonicalDid(next);
    if (this.replicas.has(canonical)) return [canonical];
    const account = this.sharedRecipients.get(canonical);
    return account === undefined ? [] : [...this.replicas.values()].filter((replica) => replica.account === account).map((replica) => replica.replicaDid);
  }

  private deliveryFor(account: string, items: Queued[]): IMessage {
    return {
      ...this.reply(DELIVERY, account, { recipient_did: account }),
      attachments: items.map((item) => ({ id: item.id, data: { json: JSON.parse(item.packed) } })),
    } as IMessage;
  }

  /** Handle one plaintext from `from`; the reply plaintext, or null for none. */
  private async dispatch(msg: IMessage, from: string | null): Promise<IMessage | null> {
    this.seenTypes.push(msg.type);
    const intercepted = await this.intercept?.(msg, from);
    if (intercepted !== undefined) return intercepted;
    switch (msg.type) {
      case FORWARD: {
        const next = (msg.body as { next?: string }).next;
        const inboxes = next === undefined ? [] : this.inboxesFor(next);
        if (inboxes.length === 0 && !this.sharedRecipients.has(canonicalDid(next ?? ""))) {
          throw new Error(`forward for unknown recipient ${next}`);
        }
        const attachments = (msg.attachments ?? []) as { data: { json?: unknown } }[];
        for (const inbox of inboxes) {
          const items: Queued[] = attachments.map((a) => ({
            id: crypto.randomUUID(),
            packed: JSON.stringify(a.data.json),
          }));
          this.queue(inbox).push(...items);
          await this.push(inbox, this.deliveryFor(inbox, items));
        }
        return null;
      }
      case ACCOUNT_REGISTER: {
        const account = canonicalDid(from as string);
        this.replicaAccounts.add(account);
        return this.reply(ACCOUNT_REGISTERED, from as string, { account, routing_did: this.did, registered_time: 1, limits: {} }, msg.id);
      }
      case REPLICA_ADD: {
        const account = canonicalDid(from as string);
        if (!this.replicaAccounts.has(account)) return this.refused(from as string, "unknown-account", msg.id);
        const jws = (msg.body as { grant: string }).grant;
        const grant = readReplicaGrant(jws);
        if (grant.account !== account || !sameDid(grant.mediator, this.did)) return this.refused(from as string, "invalid-grant", msg.id);
        const added = this.replicas.get(grant.replicaDid);
        if (added !== undefined && added.account !== account) return this.refused(from as string, "identity-conflict", msg.id);
        this.replicas.set(grant.replicaDid, { account, replicaDid: grant.replicaDid, grant: jws });
        return this.reply(REPLICA_ADDED, from as string, { replica_did: grant.replicaDid, state: "active", added_time: 1 }, msg.id);
      }
      case RECIPIENT_ADD: {
        const account = canonicalDid(from as string);
        if (!this.replicaAccounts.has(account)) return this.refused(from as string, "unknown-account", msg.id);
        const { recipient_did: recipient, resolution_material: longForm, proof } = msg.body as { recipient_did: string; resolution_material: string; proof: string };
        if (!(await provesRecipient(proof, recipient, longForm, account, this.did))) return this.refused(from as string, "invalid-recipient", msg.id);
        if (this.refuseShared.has(recipient)) return this.refused(from as string, "quota", msg.id);
        if ((this.sharedRecipients.get(recipient) ?? account) !== account) return this.refused(from as string, "identity-conflict", msg.id);
        this.sharedRecipients.set(recipient, account);
        return this.reply(RECIPIENT_ADDED, from as string, { recipient_did: recipient, added_time: 1 }, msg.id);
      }
      case STATUS_REQUEST:
      case DELIVERY_REQUEST:
      case MESSAGES_RECEIVED: {
        if (this.replicaAccounts.has(canonicalDid(from as string))) return this.refused(from as string, "replica-required", msg.id);
        const inbox = this.inboxOf(from as string);
        if (msg.type === MESSAGES_RECEIVED) {
          const ids = new Set((msg.body as { message_id_list: string[] }).message_id_list);
          this.queues.set(inbox, this.queue(inbox).filter((item) => !ids.has(item.id)));
        }
        if (msg.type === DELIVERY_REQUEST) {
          const items = this.queue(inbox).slice(0, (msg.body as { limit?: number }).limit ?? 10);
          if (items.length > 0) return { ...this.deliveryFor(from as string, items), thid: msg.id } as IMessage;
        }
        return this.reply(STATUS, from as string, { message_count: this.queue(inbox).length }, msg.id);
      }
      case LIVE_DELIVERY_CHANGE:
        return this.reply(STATUS, from as string, { live_delivery: (msg.body as { live_delivery: boolean }).live_delivery }, msg.id);
      default:
        throw new Error(`fake mediator cannot handle ${msg.type}`);
    }
  }

  /** The type of the plaintext sealed to this mediator in `text`, read without handling it: what a transport may ask of its own request. */
  async typeOf(text: string): Promise<string> {
    return (await this.unpack(text)).msg.type;
  }

  async handleHttp(text: string): Promise<string | null> {
    const { msg, from } = await this.unpack(text);
    const reply = await this.dispatch(msg, from);
    return reply === null ? null : this.pack(reply, from as string);
  }

  async handleWs(socket: FakeSocket, text: string): Promise<void> {
    const { msg, from } = await this.unpack(text);
    if (msg.type === LIVE_DELIVERY_CHANGE && from !== null) {
      this.sockets.set(this.inboxOf(from), socket);
    }
    const reply = await this.dispatch(msg, from);
    if (reply !== null) {
      socket.deliver(await this.pack(reply, from as string));
    }
  }

  /** The socket an account switched live delivery on over, for a test to push a frame down. */
  socketOf(account: string): FakeSocket | undefined {
    return this.sockets.get(account);
  }

  /** The mediator dropping an account's socket — an outage seen from the client. */
  dropSocket(account: string): void {
    this.sockets.get(account)?.close();
  }

  /** The accounts with live delivery switched on. */
  liveAccounts(): string[] {
    return [...this.sockets.keys()];
  }

  socketClosed(socket: FakeSocket): void {
    for (const [account, s] of this.sockets) {
      if (s === socket) {
        this.sockets.delete(account);
      }
    }
  }
}

/**
 * Several mediators reachable from one agent: a `fetch` and a `WebSocket`
 * that route by URL to whichever mediator owns the endpoint.
 */
export function network(...mediators: FakeMediator[]): Pick<FakeMediator, "fetch" | "WebSocket"> {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const owner = mediators.find((m) => m.http === url);
    return owner === undefined ? new Response("not found", { status: 404 }) : owner.fetch(input, init);
  }) as typeof fetch;
  const WebSocketCtor = class {
    constructor(url: string) {
      const owner = mediators.find((m) => m.wsUrl === url);
      if (owner === undefined) {
        throw new Error(`no mediator listens at ${url}`);
      }
      return new owner.WebSocket(url);
    }
  } as unknown as typeof WebSocket;
  return { fetch: fetchFn, WebSocket: WebSocketCtor };
}
