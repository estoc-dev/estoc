/**
 * The agent is a vault running: one receiver, one dispatcher and a
 * line to each mediator the vault must keep receiving on, over a
 * runtime the host opened and still owns. Opening one recovers and
 * sends nothing. The fold it reads has already judged every proof and
 * listed every piece of unfinished work; the open records what the
 * vault owes on its own over what a crash may have left behind — an
 * admission, a peer's acknowledgement, a transport acceptance this
 * runtime saw and had not recorded — and
 * mints no action: an outbound found waiting, a reply or a
 * notification an earlier input still earns, is listed for the user,
 * who retries, completes or cancels it. Connecting enrolls this
 * runtime in each arrangement — its account registered, the runtime's
 * own replica added — has the account hold every address the
 * arrangement routes, and picks up what waits for the replica. An
 * account holds no queue of its own: its mail waits for each replica,
 * and is picked up, acknowledged and pushed under this runtime's own
 * replica DID. An envelope naming that DID and no communication DID
 * of the vault is no application mail: it is the replica channel's,
 * from another replica of the seed, and what it carries goes to the
 * host, never to the vault; a host that takes none of it has it
 * acknowledged unopened.
 *
 * Only two things here authorize a transport call by themselves: the
 * user's send, and the first observation the vault holds of an input,
 * in the call that recorded it and had it admitted under the receipt's
 * lock as the witness its input speaks through, once this runtime is
 * found to be the one answering it. Such a live input has what the
 * vault owes recorded, then the private-address policy decided; then,
 * when the input is owed an output, who answers it is found, which for
 * mail picked up at a replica-mediation mediator is the replica the
 * mediator registered first under the input's execution; and only the
 * runtime answering it makes the rotation's notification and the
 * automatic effects, in that order, so that a reply to the input that
 * selected a successor goes from the successor under its proof, then
 * their calls. Each step stands alone, so that one that fails leaves
 * the others done and the observation recorded all the same. A first
 * observation the receipt left waiting for evidence is not live, and
 * stays so: the evidence, whenever and however it comes, admits the
 * observation, and what the input then earns is listed for the user.
 * Over a pickup, what the vault owes and the rotation's decision are
 * recorded in the turn the delivery came in, so that the successor is
 * held before the next delivery is opened; finding the responder, the
 * outputs and their calls run off it, one delivery after another:
 * neither they nor the acknowledgement to the mediator hold the
 * receipt of the delivery behind. An input the vault already held is
 * no live input when it is delivered again, whether this agent
 * recorded it or one before it, and whether or not what it earned was
 * ever sent: it is observed again, what the vault owes is recorded,
 * and a reply it still earns stays listed for the user. Evidence the
 * host recovered outside the agent — an import, a document — is told
 * to it, and what the vault owes over it is recorded then,
 * dispatching nothing.
 */

import type { DIDDoc } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store";
import { requiredReceivingSet, scanVault, type DidId, type Keys, type MediationId } from "@estoc/vault";

import { recordAcceptancesOwed } from "./acceptance.js";
import type { LiveAction, LiveInput } from "./action.js";
import { Account, type Arrangement, type Confirmations } from "./arrangement.js";
import { disclose, didOf, routeOf, type Disclosed, type Disclosure } from "./dids.js";
import type { Dispatched } from "./dispatch.js";
import { Dispatcher, type DispatcherOptions, type PendingOutbound } from "./dispatcher.js";
import { callEffects, decideEffects, messageOf, type Called, type EffectOptions, type Reacted } from "./effects.js";
import { EntityConflict, LinkClosed } from "./errors.js";
import { didcommDocumentOf } from "./evidence.js";
import { effectTypesOf, handlersOf } from "./handlers/index.js";
import { Keyring } from "./keyring.js";
import { Lifetime, type Fetch, type Timer, type Timers } from "./lifetime.js";
import { MediatorLink, type LinkOptions } from "./link.js";
import { LocalRecords, transientOptions, type LocalStore } from "./local-records.js";
import { createdOf } from "./mediation.js";
import { Member, bindingOf, type LinkAs } from "./membership.js";
import type { Delivered, Drained, Fate, Handle } from "./pickup.js";
import { decidePrivateAddress, notifyPrivateAddress, unannounced, type PrivateAddress, type PrivateAddressDecided } from "./privacy.js";
import type { Enrolled } from "./replica-enrollment.js";
import { replicaReceiptOf, type SnapshotLinkReceived } from "./replica-channel.js";
import type { RecipientsAdded } from "./replica-recipients.js";
import { afterReceipt, type AfterReceipt } from "./receive/after.js";
import { findResponder, type Found, type Responder } from "./responder.js";
import { recordOwed, type Owed } from "./reconcile.js";
import { receiptOf } from "./receive/receipt.js";
import { Receiver, type Discarded, type Received, type ReceiverOptions, type WaitingDelivery } from "./receive/receiver.js";
import type { PendingWork, Recorder } from "./records.js";
import { knownLongForms, resolve } from "./resolver.js";
import { send, type Content, type SendOptions, type Sent, type Target } from "./send.js";
import type { AgentTrace } from "./trace.js";
import { manualProcedures, readRecords, type Manual } from "./views.js";

export interface AgentOptions extends Omit<DispatcherOptions, "accounts" | "effectTypes" | "trace" | "local">, Pick<EffectOptions, "handlers" | "acknowledge">, Pick<ReceiverOptions, "admit" | "maxWaiting" | "maxHeldBytes"> {
  /** the socket live delivery comes down; the global one when left out */
  WebSocket?: typeof WebSocket;
  /** what every wait of the agent is kept by, for an outbound held up or a connection to try again; the global timers when left out */
  timers?: Timers;
  /** whether a connection opens the socket for live delivery, after its pickup; on by default */
  liveDelivery?: boolean;
  /**
   * How live delivery is kept up once a connection wanted it: how long
   * after it was lost, or not reached, the first connection is tried
   * again, and the longest a later one waits, each wait doubling the
   * one before.
   */
  upkeep?: Partial<Upkeep>;
  /** whether the first application input to a disclosed address selects a private successor toward its peer: local policy, on by default */
  privateAddresses?: boolean;
  /** the trace over the runtime's local state, which the host opens with the runtime */
  trace: AgentTrace;
  /**
   * The runtime's local options: where what a replica-mediation
   * mediator confirmed is kept, with this runtime's local records — the
   * inputs its replica left to another, the preparation it selected for
   * each message, the acceptances it owes the vault. Left out, they are
   * kept by this agent alone: the next one asks the mediator again,
   * lists what those inputs earn as the user's work, has the user choose
   * among several preparations, and knows nothing of an acceptance seen
   * before it.
   */
  localOptions?: LocalStore;
  /** told of every delivery once everything that follows it is done */
  onInbound?: (inbound: Inbound) => void;
  /**
   * Told of a snapshot link another replica of this vault's seed sent
   * this runtime's replica, inside the turn its delivery came in: the
   * delivery is acknowledged once this returns, so what the link is
   * then used for runs off it. Left out, mail to the replica is
   * acknowledged unopened.
   */
  onSnapshotLink?: (received: SnapshotLinkReceived) => void | Promise<void>;
  /** told the lines, whole, once they changed — a connection made or dropped, a pickup ended, a delivery come to wait or discarded — and once for every change of one turn */
  onLines?: (lines: AgentLines) => void;
}

/** The agent's transient records, whole: what `connections()`, `waitingDeliveries()` and `discardedDeliveries()` say. */
export interface AgentLines {
  connections: Connection[];
  waiting: WaitingDelivery[];
  discarded: Discarded[];
}

/** A delivery and what followed it: `after` for every delivery recorded, the others for a live input alone; each is null where it did not run, or threw. */
export interface Inbound {
  received: Received;
  after: AfterReceipt | null;
  /** who answers the input; null for one owed nothing */
  responder: Responder | null;
  /** the automatic effects, made by the runtime answering the input alone */
  reacted: Reacted | null;
  address: PrivateAddress | null;
}

/** What is left of a delivery once its local work is done: its transport calls, then the host told of it. */
type Finish = () => Promise<Inbound>;

/** How the line to one arrangement's mediator stands. */
export interface Connection {
  mediationId: MediationId;
  /** why the last connection stopped short; null when it ran through */
  unreachable: string | null;
  /** this runtime's enrollment in the arrangement, and what the last connection had to do for it */
  enrolled: Enrolled | null;
  /** the addresses the last connection had the account hold */
  recipients: RecipientsAdded | null;
  drained: Drained | null;
  /** whether the socket is open, or opening */
  live: boolean;
}

export interface Upkeep {
  retryMs: number;
  retryAtMostMs: number;
}

export const UPKEEP: Upkeep = { retryMs: 2_000, retryAtMostMs: 5 * 60_000 };

/** The connection to try again, and how long the next one after it waits. */
interface Retry {
  timer: Timer | null;
  nextMs: number;
}

/** The agent's options as it makes requests itself, its transport reached through its lifetime alone. */
type GatedOptions = AgentOptions & { fetch: Fetch };

/** What makes a line's links: each over the host's transports through a lifetime of its own, and none once the agent closed, so that every link there is one the agent closes. */
type LinkOf = (line: Pick<LinkOptions, "resolveDid" | "secrets" | "me" | "mediatorDid" | "mediatorDoc">) => MediatorLink;

export interface Submitted extends Sent {
  dispatched: Called;
}

interface Line {
  /** speaks as the arrangement's own DID: its account, which holds no queue of its own */
  link: MediatorLink;
  linkAs: LinkAs;
}

export class Agent {
  /** by arrangement, from the first attempt to connect it: one whose line could not even be made has a connection to say why */
  private readonly attempts = new Map<MediationId, Connection>();
  private readonly retries = new Map<MediationId, Retry>();
  private readonly connecting = new Map<MediationId, Promise<Connection>>();
  /** by arrangement, bound on first need: the line to the mediator is made only once one of the account's operations has to reach it */
  private readonly accounts = new Map<MediationId, Account>();
  /** this runtime's replica at its arrangement, bound on first need and kept, since a replica's binding never changes */
  private bound: Member | null = null;
  /** the calls of the pickup deliveries taken so far, run off their turns and one delivery after another, so the host is told of them in the order the mail came */
  private calling: Promise<void> = Promise.resolve();
  /** whether the host is yet to be told of the lines as they now stand */
  private linesDue = false;

  /** Every manual procedure, each transport call of theirs through this agent's dispatcher. */
  readonly manual: Manual;

  private constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly options: GatedOptions,
    private readonly lifetime: Lifetime,
    private readonly ring: Keyring,
    private readonly dispatcher: Dispatcher,
    private readonly receiver: Receiver,
    private readonly wires: Map<MediationId, Line>,
    private readonly linkOf: LinkOf,
    private readonly confirmations: Confirmations,
    private readonly local: LocalRecords,
    /** what the open recorded of what the vault owed */
    readonly recovered: Owed
  ) {
    this.manual = manualProcedures(runtime, keys, dispatcher, options);
  }

  /** The agent over an open runtime, with networking off; throws `ReceiverInUse` while another agent of the runtime is open. */
  static async open(vault: { runtime: VaultRuntime; keys: Keys }, agentOptions: AgentOptions): Promise<Agent> {
    const { runtime, keys } = vault;
    const lifetime = new Lifetime(agentOptions.timers);
    const options: GatedOptions = { ...agentOptions, fetch: lifetime.fetch(agentOptions.fetch) };
    const confirmations = options.localOptions ?? transientOptions();
    const local = new LocalRecords(confirmations, runtime.author);
    const recovered = await recordOwed(runtime, keys);
    await recordAcceptancesOwed(runtime, keys, local);
    const ring = await Keyring.load(keys, await scanVault(runtime.vault, keys));
    const lines = new Map<MediationId, Line>();
    const dispatcher = new Dispatcher(runtime, keys, { ...agentOptions, local, effectTypes: effectTypesOf(handlersOf(options.handlers)), accounts: (mediationId): Account => agent.account(mediationId) });
    const { didcomm, admit, maxWaiting, maxHeldBytes, trace, log, onSnapshotLink } = options;
    const { fetch, WebSocket, timeoutMs } = agentOptions;
    const linkOf: LinkOf = (line) => {
      if (lifetime.closed) throw new LinkClosed();
      return new MediatorLink({ didcomm, fetch, WebSocket, trace, timeoutMs, log, ...line });
    };
    let linesChanged = (): void => undefined;
    const mediatorEndpoint = (mediationId: MediationId): string => {
      const line = lines.get(mediationId);
      if (line === undefined) throw new Error(`no line to the mediator of ${mediationId}`);
      return line.link.http();
    };
    const receiver = new Receiver(runtime, keys, ring, {
      didcomm,
      receipt: receiptOf(runtime, keys),
      replicaReceipt: onSnapshotLink === undefined ? undefined : replicaReceiptOf(keys, { mediatorEndpoint, onSnapshotLink }),
      acknowledge: async ({ mediationId, deliveryId }) => {
        await (await agent.memberAt(mediationId)).acknowledge([deliveryId]);
      },
      admit,
      maxWaiting,
      maxHeldBytes,
      trace,
      log,
      changed: () => linesChanged(),
    });
    const agent = new Agent(runtime, keys, options, lifetime, ring, dispatcher, receiver, lines, linkOf, confirmations, local, recovered);
    linesChanged = () => agent.linesChanged();
    return agent;
  }

  /** An agent that fails to connect at all is closed before the failure is thrown: nobody else could close it, and the runtime could have no other. */
  static async start(vault: { runtime: VaultRuntime; keys: Keys }, options: AgentOptions): Promise<Agent> {
    const agent = await Agent.open(vault, options);
    try {
      await agent.connect();
    } catch (err) {
      agent.close();
      throw err;
    }
    return agent;
  }

  /**
   * Every arrangement the vault must keep receiving on, connected:
   * this runtime enrolled, every address held by the account, what
   * waits for the replica picked up, the socket opened. One that
   * cannot be reached stops none of the others and throws nothing: its
   * connection says why, and connecting again tries it again. An
   * arrangement whose connection is under way is shared, not begun
   * again, and the wait before its next automatic try is dropped: a
   * failure after this is waited out from the first wait again.
   */
  async connect(): Promise<Connection[]> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const required = [...requiredReceivingSet(fold.mediations, fold.dids)].sort();
    return Promise.all(
      required.map((mediationId) => {
        this.forgetRetry(mediationId);
        return this.connectTo(mediationId);
      })
    );
  }

  /**
   * The account of an arrangement, bound to this runtime and reaching
   * its mediator over this agent's line: what `enroll` and `connect` use
   * too. Nothing is asked of the mediator, nor is its DID resolved,
   * until an operation has to reach it, and none is begun once the agent
   * is closed. Needs the arrangement's creation.
   */
  async arrangement(mediationId: MediationId): Promise<Arrangement> {
    this.refuseClosed();
    createdOf(await scanVault(this.runtime.vault, this.keys), mediationId);
    return this.account(mediationId);
  }

  /**
   * This runtime enrolled in an arrangement: its
   * account registered when the fold has no grant, its own replica
   * added when no confirmation is kept; then the arrangement's
   * connection, shared with one under way and taking over its wait as
   * `connect` does. Throws what `Arrangement.enroll` throws, and begins
   * no request once the agent is closed.
   */
  async enroll(mediationId: MediationId): Promise<Enrolled> {
    this.refuseClosed();
    const enrolled = await this.account(mediationId).enroll();
    this.connectionOf(mediationId).enrolled = enrolled;
    await this.localStateChanged();
    this.forgetRetry(mediationId);
    await this.connectTo(mediationId);
    return enrolled;
  }

  /** `disclose` with the account of the arrangement that routes the DID. */
  async disclose(didId: DidId, disclosure: Disclosure): Promise<Disclosed> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const route = routeOf(didOf(fold, didId));
    return disclose(route?.kind === "mediated" ? this.account(route.mediationId) : null, this.runtime, this.keys, didId, disclosure);
  }

  connections(): Connection[] {
    return [...this.attempts.values()].map((connection) => this.shown(connection));
  }

  /** The intent committed, then its one transport call under the action the send minted. */
  async send(target: Target, content: Content, options: SendOptions = {}): Promise<Submitted> {
    this.refuseClosed();
    const sent = await send(this.runtime, this.keys, target, content, { now: this.options.now, ...options });
    return { ...sent, dispatched: await this.call(sent.action) };
  }

  /** An envelope posted straight to this runtime. */
  async receive(packed: string): Promise<Inbound> {
    return this.follow(await this.receiver.receive({ packed, source: { kind: "direct" } }));
  }

  /**
   * The vault's local state changed outside this agent — a DID
   * created, an arrangement granted, evidence imported or a document
   * resolved. What the vault owes over it is
   * recorded first, an admission a proof waited for included, and
   * dispatched by nothing; then each waiting delivery whose wait ended
   * is retried, and followed like any other.
   */
  async localStateChanged(): Promise<Inbound[]> {
    await recordOwed(this.runtime, this.keys);
    const inbounds: Inbound[] = [];
    for (const received of await this.receiver.localStateChanged()) inbounds.push(await this.follow(received));
    return inbounds;
  }

  /** Resolves once the calls of every pickup delivery taken so far are made, or given up on, and the host told; at once when none is running. */
  async settled(): Promise<void> {
    for (let tail = this.calling; ; tail = this.calling) {
      await tail;
      if (tail === this.calling) return;
    }
  }

  records(): Promise<Recorder> {
    return readRecords(this.runtime, this.keys, { handlers: this.options.handlers, privateAddresses: this.options.privateAddresses, local: this.local });
  }

  /** The work an open leaves to the user. */
  async pending(): Promise<PendingWork> {
    return (await this.records()).pending();
  }

  /** Every outbound open to manual action, with the live action this agent still holds for it. */
  outbounds(): Promise<PendingOutbound[]> {
    return this.dispatcher.pending();
  }

  waitingDeliveries(): WaitingDelivery[] {
    return this.receiver.waiting();
  }

  discardedDeliveries(): Discarded[] {
    return this.receiver.discarded();
  }

  lines(): AgentLines {
    return { connections: this.connections(), waiting: this.waitingDeliveries(), discarded: this.discardedDeliveries() };
  }

  /**
   * Nothing is sent or called after this, and nothing waits: the
   * agent's own requests and waits are refused through its lifetime,
   * and it closes every part it holds, each line's links with their
   * sockets, the dispatcher and the receiver, each then refusing its
   * own. A connection under way stops there, and so does answering a
   * delivery already taken: no output is begun, and what the input
   * still earns is listed for the user. A request already made is still
   * answered, but an answer that comes after this may be lost, as one
   * lost on the wire is: a reply from a did:web mediator is checked
   * against the mediator resolved again, which is a request too. The
   * runtime stays open: it is its opener's to close.
   */
  close(): void {
    this.lifetime.close();
    for (const { link } of this.wires.values()) link.close();
    this.bound?.close();
    for (const mediationId of [...this.retries.keys()]) this.forgetRetry(mediationId);
    this.dispatcher.close();
    this.receiver.close();
  }

  private refuseClosed(): void {
    if (this.lifetime.closed) throw new Error("the agent is closed");
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** The host told of the lines once this turn is over, whatever else changes them meanwhile. */
  private linesChanged(): void {
    if (this.linesDue || this.lifetime.closed || this.options.onLines === undefined) return;
    this.linesDue = true;
    queueMicrotask(() => {
      this.linesDue = false;
      if (this.lifetime.closed) return;
      try {
        this.options.onLines?.(this.lines());
      } catch (err) {
        this.log(`the host's lines listener threw: ${messageOf(err)}`);
      }
    });
  }

  private async call(action: LiveAction): Promise<Called> {
    try {
      return await this.dispatcher.run(action);
    } catch (err) {
      const reason = messageOf(err);
      this.log(`the call of ${action.messageId} threw: ${reason}`);
      return { outcome: "threw", messageId: action.messageId, reason };
    }
  }

  private shown(connection: Connection): Connection {
    return { ...connection, live: this.bound !== null && this.bound.mediationId === connection.mediationId && this.bound.live };
  }

  private connectionOf(mediationId: MediationId): Connection {
    const connection: Connection = this.attempts.get(mediationId) ?? { mediationId, unreachable: null, enrolled: null, recipients: null, drained: null, live: false };
    this.attempts.set(mediationId, connection);
    return connection;
  }

  /** The arrangement's connection under way, or a new one: whoever asks while one runs shares its result. */
  private connectTo(mediationId: MediationId): Promise<Connection> {
    const underWay = this.connecting.get(mediationId);
    if (underWay !== undefined) return underWay;
    const connecting = this.connectOnce(mediationId).finally(() => this.connecting.delete(mediationId));
    this.connecting.set(mediationId, connecting);
    return connecting;
  }

  /** One connection of the arrangement, with the wait before its next automatic try cancelled but not forgotten: a failure after this waits the next, longer wait. */
  private async connectOnce(mediationId: MediationId): Promise<Connection> {
    const connection = this.connectionOf(mediationId);
    this.linesChanged();
    this.cancelRetry(mediationId);
    try {
      // The mediator resolves before this runtime enrolls, so that a connection to a mediator not even found binds no replica to it.
      await this.lineOf(mediationId);
      const account = this.account(mediationId);
      connection.enrolled = await account.enroll();
      connection.recipients = await account.addRecipients();
      const member = await this.memberAt(mediationId);
      connection.drained = await member.drain();
      if (this.keepsLive() && !member.live) await this.openSocket(mediationId, member);
      connection.unreachable = null;
    } catch (err) {
      if (this.lifetime.closed) return this.shown(connection);
      connection.unreachable = messageOf(err);
      this.log(`the mediator of ${mediationId} was not reached: ${connection.unreachable}`);
      this.retryLater(mediationId);
    }
    this.linesChanged();
    return this.shown(connection);
  }

  /**
   * What reached the mediator between the pickup and live delivery
   * coming on was queued without being pushed: it is picked up once the
   * mediator says live delivery is on. The link hands down the frames
   * of the socket it has now alone, so the status is that socket's.
   */
  private openSocket(mediationId: MediationId, member: Member): Promise<void> {
    return member.openSocket(
      () => void this.pickUpOnceLive(mediationId, member),
      () => {
        this.linesChanged();
        this.log(`live delivery was lost for ${mediationId}`);
        this.retryLater(mediationId);
      }
    );
  }

  private keepsLive(): boolean {
    return this.options.liveDelivery ?? true;
  }

  private upkeep(): Upkeep {
    return { ...UPKEEP, ...this.options.upkeep };
  }

  private cancelRetry(mediationId: MediationId): void {
    const retry = this.retries.get(mediationId);
    if (retry === undefined) return;
    retry.timer?.cancel();
    retry.timer = null;
  }

  private forgetRetry(mediationId: MediationId): void {
    this.cancelRetry(mediationId);
    this.retries.delete(mediationId);
  }

  /**
   * The connection tried again after a wait, each wait twice the one
   * before until live delivery comes on. The wait is shortened by up to
   * half, at random, so that the accounts a mediator dropped together
   * do not come back together.
   */
  private retryLater(mediationId: MediationId): void {
    if (!this.keepsLive()) return;
    const { retryMs, retryAtMostMs } = this.upkeep();
    const retry = this.retries.get(mediationId) ?? { timer: null, nextMs: retryMs };
    this.retries.set(mediationId, retry);
    if (retry.timer !== null) return;
    const wait = retry.nextMs * (0.5 + Math.random() / 2);
    retry.nextMs = Math.min(retry.nextMs * 2, retryAtMostMs);
    retry.timer = this.lifetime.setTimer(() => {
      retry.timer = null;
      void this.retry(mediationId, retry);
    }, wait);
  }

  /** A wait dropped while the vault was being read — live delivery come on, a connection made by hand, the agent closed — leaves this try nothing to do. */
  private async retry(mediationId: MediationId, retry: Retry): Promise<void> {
    if (!this.keepsLive()) return;
    const stands = (): boolean => this.retries.get(mediationId) === retry;
    try {
      const fold = await scanVault(this.runtime.vault, this.keys);
      if (!stands()) return;
      if (!requiredReceivingSet(fold.mediations, fold.dids).has(mediationId)) return;
    } catch (err) {
      if (!stands()) return;
      this.log(`the connection of ${mediationId} was not tried again: ${messageOf(err)}`);
      this.retryLater(mediationId);
      return;
    }
    await this.connectTo(mediationId);
  }

  private async pickUpOnceLive(mediationId: MediationId, member: Member): Promise<void> {
    this.forgetRetry(mediationId);
    try {
      const drained = await member.drain();
      const connection = this.attempts.get(mediationId);
      if (connection !== undefined) connection.drained = drained;
      this.linesChanged();
    } catch (err) {
      this.log(`the pickup once live delivery came on failed for ${mediationId}: ${messageOf(err)}`);
    }
  }

  private account(mediationId: MediationId): Account {
    const existing = this.accounts.get(mediationId);
    if (existing !== undefined) return existing;
    const account = new Account(this.runtime, this.keys, mediationId, this.confirmations, this.options.trace, async () => (await this.lineOf(mediationId)).link, () => this.memberAt(mediationId));
    this.accounts.set(mediationId, account);
    return account;
  }

  /** The one line of an arrangement for as long as the agent lives: a link speaks as one account to one mediator. None is made once the agent closed, and the mediator is not resolved for one. */
  private async lineOf(mediationId: MediationId): Promise<Line> {
    const existing = this.wires.get(mediationId);
    if (existing !== undefined) return existing;
    if (this.lifetime.closed) throw new LinkClosed();
    const fold = await scanVault(this.runtime.vault, this.keys);
    const mediation = createdOf(fold, mediationId);
    await this.ring.reload(fold);
    // The mediator may answer under its short form: the long form it was arranged under is in the fold, and an arrangement's creation never changes.
    const known = knownLongForms(fold);
    const resolveDid = async (did: string): Promise<DIDDoc | null> => {
      const answer = await resolve(did, known, this.options);
      return answer.outcome === "resolved" ? didcommDocumentOf(answer.resolution) : null;
    };
    const mediatorDoc = await resolveDid(mediation.mediatorDid);
    if (mediatorDoc === null) throw new Error(`the mediator ${mediation.mediatorDid} does not resolve`);
    const { mediatorDid } = mediation;
    const linkAs: LinkAs = (me, secrets) => this.linkOf({ resolveDid, secrets, me, mediatorDid, mediatorDoc });
    const link = linkAs(mediation.me.did, () => this.ring.secrets());
    const line: Line = { link, linkAs };
    const raced = this.wires.get(mediationId);
    if (raced !== undefined) return raced;
    this.wires.set(mediationId, line);
    return line;
  }

  /** This runtime's replica, bound once to the arrangement its creation names: its account is the one this agent holds there, and its link is made over that arrangement's line. Whether it is enrolled is for its gate to find, request by request. */
  private async member(): Promise<Member> {
    const binding = bindingOf(await scanVault(this.runtime.vault, this.keys), this.runtime.author);
    const { mediationId } = binding;
    this.bound ??= new Member(this.runtime, this.keys, binding, this.account(mediationId), this.lifetime, async () => (await this.lineOf(mediationId)).linkAs, this.handleOf(mediationId), this.options);
    return this.bound;
  }

  /** This runtime's replica as a member of `mediationId`: `LinkClosed` once the agent closed, whatever the vault says; else `UnknownEntity` until the runtime has one, `EntityConflict` when it is a member of another arrangement. */
  private async memberAt(mediationId: MediationId): Promise<Member> {
    if (this.lifetime.closed) throw new LinkClosed();
    const member = this.bound ?? (await this.member());
    if (member.mediationId !== mediationId) throw new EntityConflict("replica", member.replicaId, `a member of the arrangement with ${member.mediatorDid}`);
    return member;
  }

  /** The receiver's pickup handle: a delivery's local work done in its turn, before the mediator is told of it, and its calls run off the turn. */
  private handleOf(mediationId: MediationId): Handle {
    const handle = this.receiver.pickupHandle(mediationId);
    const take = async (delivered: Delivered): Promise<Fate> => {
      if ("unreadable" in delivered) return handle(delivered);
      const received = await this.receiver.receive({ packed: delivered.packed, source: { kind: "pickup", mediationId, deliveryId: delivered.attachmentId }, parent: delivered.parent });
      this.detach(await this.decide(received));
      return received.outcome === "deferred" ? "skip" : "acked";
    };
    return Object.assign(take, { acknowledged: handle.acknowledged });
  }

  private async follow(received: Received): Promise<Inbound> {
    return (await this.decide(received))();
  }

  /** What follows the local work comes back as a closure so that a pickup can finish its turn without waiting on the network. */
  private async decide(received: Received): Promise<Finish> {
    const inbound: Inbound = { received, after: null, responder: null, reacted: null, address: null };
    if (received.outcome !== "received") return async () => this.tell(inbound);
    const { trace, now } = this.options;
    inbound.after = await this.step("what the vault owes", () => afterReceipt(this.runtime, this.keys, received.cid, { trace }));
    const { live } = received;
    if (live === null) return async () => this.tell(inbound);
    const address = (this.options.privateAddresses ?? true) ? await this.step("the private address", () => decidePrivateAddress(this.runtime, this.keys, live, { now, trace })) : null;
    return async () => this.tell(await this.answer(inbound, live, address));
  }

  /** The live input answered, when this runtime is found to answer it and is still open: the rotation's notification, then the automatic effects, each decided and called, and neither begun once the agent closed. */
  private async answer(inbound: Inbound, live: LiveInput, address: PrivateAddressDecided | null): Promise<Inbound> {
    const { handlers, acknowledge, now, trace } = this.options;
    const found: Found = (await this.step("who answers", () => findResponder(this.runtime, this.keys, live, { handlers, acknowledge, trace, rotated: address?.outcome === "rotated", member: this.bound, local: this.local }))) ?? { responder: null, answering: null };
    inbound.responder = found.responder;
    const unanswered = (because: string): Inbound => {
      if (address !== null) inbound.address = unannounced(address, because);
      return inbound;
    };
    if (found.answering === null) return unanswered(found.responder === null ? "who answers the input was not found" : found.responder.status === "other" ? "another replica answers the input" : `no replica is known to answer the input: ${found.responder.because}`);
    if (this.lifetime.closed) return unanswered("the agent closed before the input was answered");
    const { answering } = found;
    const dispatch = (action: LiveAction): Promise<Dispatched> => this.dispatcher.run(action);
    if (address !== null) inbound.address = await this.step("the notification of the private address", () => notifyPrivateAddress(this.runtime, this.keys, address, answering, { now, dispatch, trace }));
    if (this.lifetime.closed) return inbound;
    const effects = await this.step("the automatic effects", () => decideEffects(this.runtime, this.keys, answering, { handlers, acknowledge, now, trace }));
    if (effects !== null) inbound.reacted = await this.step("the calls of the automatic effects", () => callEffects(effects, { dispatch, trace }));
    return inbound;
  }

  /** The calls of a pickup delivery, run off its turn after those of the delivery before; what they throw is logged, since nothing waits for them. */
  private detach(finish: Finish): void {
    this.calling = this.calling.then(finish).then(
      () => undefined,
      (err: unknown) => this.log(`the calls of a received message failed: ${messageOf(err)}`)
    );
  }

  private tell(inbound: Inbound): Inbound {
    try {
      this.options.onInbound?.(inbound);
    } catch (err) {
      this.log(`the host's inbound listener threw: ${messageOf(err)}`);
    }
    return inbound;
  }

  private async step<T>(what: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (err) {
      this.log(`${what} of a received message failed and is left for manual completion: ${messageOf(err)}`);
      return null;
    }
  }
}
