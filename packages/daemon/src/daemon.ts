import { v7 as uuidv7 } from "uuid";
import { DamagedHistory, DatabaseBusy, ForkedAuthor, SnapshotTooLarge, SqliteVault, exportVault, importVault, openPortable, restoreVault, type Held, type SqliteDriver } from "@estoc/event-store";
import type { Hold, Lines, Phase, Snapshot } from "@estoc/daemon-api/contract";
import { createSeedKeystore, unlockSeedKeystore, type SeedKey } from "@estoc/keystore";
import {
  Keys,
  PING_TYPE,
  canonicalDidOf,
  mediationIdOf,
  objectReader,
  scanVault,
  vaultDraft,
  vaultHeldRoots,
  vaultRetention,
  type Channel,
  type ContactId,
  type Did,
  type DidId,
  type MediationId,
  type VaultDraft,
  type VaultFold,
} from "@estoc/vault";
import {
  Agent,
  AgentTrace,
  BLOB_QUOTA,
  BLOB_REFUSED,
  BLOB_TOO_LARGE,
  BUILT_IN_HANDLERS,
  BlobMismatch,
  BlobTooLarge,
  BlobTransferFailed,
  BlobUnopened,
  LocalRecords,
  MAX_CONTENT_BYTES,
  MediatorRefused,
  SEAL_OVERHEAD,
  createDid,
  createMediation,
  createVault,
  decide,
  effectTypesOf,
  inspectRuntime,
  isTraceLevel,
  openBlob,
  openVault,
  readBlob,
  recorder,
  sameDid,
  sealBlob,
  selectMediation,
  serially,
  type AgentLines,
  type Called,
  type EffectOutcome,
  type InspectedRuntime,
  type RouteSpec,
} from "@estoc/agent-core";

import type { CompletionWord, Daemon, DispatchWord, Outcome, SendResult } from "./api.js";
import { InvalidArgument, Refused, RestoreUnexplained, StaleHold, TooLarge, Unmet, WrongPhase } from "./errors.js";
import { VAULT_FILE, type DaemonHost, type DaemonStorage } from "./host.js";
import { linesOf } from "./lines.js";
import { localDidRecords, mediationRecords, project } from "./projection.js";
import { Publisher, type NonOpenValue, type Publishing, type Source } from "./publisher.js";
import { SnapshotLinks, type Put } from "./snapshot-links.js";

/** The daemon as its host holds it: the domain's interface, and the publisher a view's session attaches to. */
export interface DaemonCore extends Daemon {
  /** Take the files and land on the screen they dictate, published; once, a later call doing nothing. */
  boot(): Promise<void>;
  /** whether `boot()` has run */
  readonly booted: boolean;
  readonly publisher: Publisher<Snapshot, Lines>;
  /**
   * The user's own rotation away from a pair: the one live DID of this
   * vault at the pair's local end is rotated toward its peer, a fresh
   * successor minted and its notification called. Refused when no DID
   * of the vault is at that end, or more than one is.
   */
  rotateChannel(channel: Channel): Promise<Outcome<CompletionWord> & { successor: Channel }>;
  /**
   * The agent closed and the files let go of, for the host that is
   * shutting down; the seed stays cached where the host keeps it. A wait
   * for files held elsewhere ends, the operation under way is waited
   * for, a request the agent has with a mediator is waited for as long
   * as the agent gives it and none follows it, and nothing is opened,
   * sent or said afterwards; every call answers with the one closing.
   */
  close(): Promise<void>;
}

/**
 * This runtime's own record that whoever runs it knows what a restore
 * cannot bring back: set when the vault is created here, and when the
 * person is told after a restore. It is absent from a runtime a
 * restore has just made — local state is never part of a snapshot —
 * so a restore interrupted anywhere leaves sending closed rather than
 * open.
 */
export const RESTORE_EXPLAINED = "daemon.restoreExplained";

/** What is left to someone whose vault's history is damaged, for a host with no words of its own for it. */
export const DAMAGE_RECOURSE =
  "The history comes back only by restoring a backup into a new vault: what that backup holds returns, what was recorded after it does not, and with no usable backup none of it does. The seed is in every backup, and the passphrase still unlocks it there.";

const RESTORE_SOURCE = "restore-source.sqlite";
const MERGE_SOURCE = "merge-source.sqlite";
const EXPORT_FILE = "export.sqlite";
const BUSY_RETRY_MS = 2000;
/** How long reading a snapshot a link names may take, whole: room for one as large as a mediator's blob over a slow line. */
const SNAPSHOT_READ_TIMEOUT_MS = 10 * 60_000;
/** The answers to a put by which the mediator says it holds nothing of the blob. */
const PUT_REFUSALS = new Set([BLOB_TOO_LARGE, BLOB_QUOTA, BLOB_REFUSED]);
/** The queue a runtime's snapshot puts and revocations wait their turns in: a revocation comes after a put under way has settled, so nothing that put writes lands after it. */
const SNAPSHOT_PUTS = "snapshot-puts";
const CLOSED = "the daemon is closed";
const DETACHED = "the agent is closed";

const SCAN = { effectTypes: effectTypesOf(BUILT_IN_HANDLERS) };

/**
 * One agent as the daemon holds it. Closing an agent does not end a
 * flow of its own already under way, and such a flow goes on from what
 * it read before. So once `ended` the agent starts no request, and
 * `work` is waited for before the vault is closed or handed to another
 * agent: every call made over the agent, and every request the agent
 * has out, whoever began it — a call, a retry on its timer, a delivery
 * pushed down its socket. A request already out is left to be
 * answered: giving it up here would not undo it there, and what the
 * answer settles — a grant, a confirmation — is whoever comes next
 * to find recorded. One that outlasts the deadline its caller set is
 * past waiting for; it may still take effect at the other end later.
 */
interface Attached {
  agent: Promise<Agent>;
  ended: boolean;
  work: Set<Promise<void>>;
}

interface Open {
  runtime: SqliteVault;
  seedKey: SeedKey;
  keys: Keys;
  trace: AgentTrace;
  attached: Attached;
  publishing: Publishing;
}

const NO_LINES: Lines = { connections: [], waiting: [], discarded: [] };

/** A phase that shows no runtime, with the hold the phase allows: none where no file is held, the file's where one is. */
function nonOpen(phase: Exclude<Phase, "open">, hold: Hold | null, detail: string | null): NonOpenValue {
  switch (phase) {
    case "elsewhere":
    case "onboarding":
    case "foreign":
      if (hold !== null) throw new Error(`the ${phase} phase holds no vault file`);
      return { phase, hold: null, detail };
    case "damaged":
    case "locked":
      if (hold === null) throw new Error(`the ${phase} phase names the vault file held`);
      return { phase, hold, detail };
    default:
      return { phase, hold, detail };
  }
}

/**
 * `ask`'s response, kept in `work` until it is over: its body read to
 * the end or let go of by its reader, the request failed, or `deadline`
 * passed. The body goes through as it comes, so a reader's bound on it
 * still bounds what is read.
 */
async function answered(work: Set<Promise<void>>, deadline: AbortSignal | null, ask: () => Promise<Response>): Promise<Response> {
  let over = (): void => undefined;
  const pending = new Promise<void>((resolve) => (over = resolve));
  work.add(pending);
  void pending.then(() => work.delete(pending));
  deadline?.addEventListener("abort", over, { once: true });
  let response: Response;
  try {
    response = await ask();
  } catch (err) {
    over();
    throw err;
  }
  if (response.body === null) {
    over();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
      over();
    },
    async cancel(reason) {
      over();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** The damage to its history a runtime has met, in the survey it makes once or in a read since; null while it has met none. */
function damageOf(runtime: SqliteVault): DamagedHistory | null {
  const { stopped } = runtime;
  return stopped instanceof DamagedHistory ? stopped : null;
}

const failure = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const outcomeOf = (called: Called): Outcome<DispatchWord> => ({ outcome: called.outcome, because: "because" in called ? called.because : "reason" in called ? called.reason : null, messageId: called.messageId });

function effectOutcomeOf(effect: EffectOutcome): Outcome<CompletionWord> {
  if (effect.outcome === "none" || effect.outcome === "refused") return { outcome: effect.outcome, because: effect.because, messageId: null };
  if (effect.outcome === "skipped") return { outcome: "skipped", because: effect.code, messageId: null };
  if (effect.outcome === "created") return outcomeOf(effect.dispatched);
  return effect.dispatched === null ? { outcome: "existing", because: null, messageId: effect.messageId } : outcomeOf(effect.dispatched);
}

/** Why a link's snapshot did not come to plaintext of at most `maxBytes`, refused: nothing is written before it does. */
function unread(err: unknown, maxBytes: number): Refused {
  if (err instanceof BlobTooLarge) return new TooLarge(`the snapshot is over the ${maxBytes} bytes this daemon restores`);
  if (err instanceof BlobTransferFailed) return new Unmet(err.status === 404 ? "no snapshot is at that link any more: it was revoked, or the mediator has let it go" : `the snapshot could not be read: its store answered ${err.status}`);
  if (err instanceof BlobMismatch) return new Unmet("the bytes at that link are not the snapshot it names");
  if (err instanceof BlobUnopened) return new Unmet("the link's key does not open the snapshot");
  return new Unmet(`the snapshot could not be read: ${failure(err)}`);
}

/**
 * The daemon itself, wherever it runs: the vault among the host's
 * files, owned for as long as the daemon looks at it or runs it, the
 * seed unlocked from the vault's own wrapper and cached where the host
 * keeps such things, and the agent over it. The host boots it, a view
 * reads what the publisher says and asks for things through the
 * `Daemon` methods.
 */
export function createDaemon(host: DaemonHost): DaemonCore {
  let storage: DaemonStorage | null = null;
  /** the locked phase's hold on the vault: the file owned, nothing written, the wrapped seed for `unlock` */
  let inspected: InspectedRuntime | null = null;
  let open: Open | null = null;
  let booted = false;
  let current: Phase = "booting";
  /** the vault file's name for as long as it stands, whatever phase it stands in */
  let held: Hold | null = null;

  let closed: Promise<void> | null = null;
  const closing = () => closed !== null;
  const waits = new Set<() => void>();

  const publisher = new Publisher<Snapshot, Lines>(nonOpen("booting", null, null), {
    noLines: NO_LINES,
    failed: (err) => {
      if (err instanceof DamagedHistory) void giveUpDamaged(err);
    },
  });

  const phase = (p: Exclude<Phase, "open">, why: string | null = null) => {
    if (closing()) return;
    current = p;
    publisher.set(nonOpen(p, held, why));
  };
  const log = (line: string) => publisher.log(line);
  const changed = () => publisher.invalidate();

  let turn: Promise<void> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = turn.then(work);
    turn = done.then(
      () => undefined,
      () => undefined
    );
    return done;
  }

  /**
   * Whatever makes, opens, closes or removes one of the daemon's files
   * runs one at a time, in the order asked: what an operation found
   * when it checked still holds when it acts, and no file is closed or
   * removed under another still using it. A daemon waiting for files
   * held elsewhere refuses it rather than leave it waiting behind that.
   */
  async function exclusively<T>(work: () => Promise<T>): Promise<T> {
    if (closing()) throw new Error(CLOSED);
    if (current === "elsewhere") throw new WrongPhase("the vault is held elsewhere");
    return inTurn(() => {
      if (closing()) throw new Error(CLOSED);
      return work();
    });
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const over = () => {
        clearTimeout(timer);
        waits.delete(over);
        resolve();
      };
      const timer = setTimeout(over, ms);
      waits.add(over);
    });
  }

  /** `take`, tried again for as long as somebody else holds what it opens; a daemon that closes meanwhile stops asking, and gives back with `release` what it was handed too late. */
  async function owned<T>(take: () => Promise<T>, release: (taken: T) => unknown): Promise<T> {
    for (;;) {
      if (closing()) throw new Error(CLOSED);
      try {
        const taken = await take();
        if (!closing()) return taken;
        await release(taken);
      } catch (err) {
        if (!(err instanceof DatabaseBusy)) throw err;
        if (current !== "elsewhere") phase("elsewhere");
        await pause(BUSY_RETRY_MS);
      }
    }
  }

  function files(): DaemonStorage {
    if (storage === null) throw new WrongPhase("the daemon holds no files here");
    return storage;
  }

  /** A vault is made only where the daemon found none: not beside one it holds, and not over what it could not read. */
  async function refuseOccupied(): Promise<DaemonStorage> {
    const store = files();
    if (current !== "onboarding" || (await store.has(VAULT_FILE))) throw new WrongPhase("a vault already exists here");
    return store;
  }

  function vault(): Open {
    if (open === null) throw new WrongPhase("no open vault");
    return open;
  }

  const takeVault = (mode: "create" | "readwrite"): Promise<SqliteDriver> =>
    owned(
      () => files().open(VAULT_FILE, mode, "runtime"),
      async (driver) => {
        driver.close();
        if (mode === "create") await files().remove(VAULT_FILE);
      }
    );

  /** The records as of one cut: the fold, the content and the local options read under the writer lock, with nothing committed between them. */
  async function recordsOf(vault: Held, { runtime, keys }: Pick<Open, "runtime" | "keys">): Promise<Snapshot> {
    const fold = await scanVault(vault, keys, SCAN);
    const records = await recorder(fold, objectReader(vault.objects, MAX_CONTENT_BYTES), { author: runtime.author, local: new LocalRecords(runtime.local.options, runtime.author) });
    return project(records, {
      anchor: runtime.metadata.anchor,
      label: fold.label ?? "",
      restoreUnexplained: !(await explained(runtime)),
      mediations: mediationRecords(fold.mediations),
      dids: localDidRecords(fold.dids),
    });
  }

  /**
   * One coherent read of the runtime, for the publisher: a read leaves
   * a damaged event out rather than fail, so the damage it met is
   * looked for afterwards and thrown, and records short of it are shown
   * to nobody.
   */
  function sourceOf(running: Pick<Open, "runtime" | "keys">): Source<Snapshot> {
    return {
      capture: (cut) =>
        running.runtime.locked(async (vault) => {
          cut();
          const read = await recordsOf(vault, running);
          const damage = damageOf(running.runtime);
          if (damage !== null) throw damage;
          return read;
        }),
    };
  }

  const explained = async (runtime: SqliteVault): Promise<boolean> => (await runtime.local.options.get(RESTORE_EXPLAINED)) === true;

  /** A send of the user's and every manual dispatch wait for the restore to be explained; nothing the vault does on its own does. */
  async function refuseUnexplained({ runtime }: Open): Promise<void> {
    if (!(await explained(runtime))) throw new RestoreUnexplained();
  }

  /** Every change so far published before a call answers; a read that fails, or an epoch that ends, is the publisher's to tell of. */
  const settle = (): Promise<void> => publisher.refresh().then(() => undefined, () => undefined);

  const hostFetch = host.agentOptions?.fetch ?? globalThis.fetch;

  function attach(runtime: SqliteVault, keys: Keys, trace: AgentTrace): Attached {
    const attached = { ended: false, work: new Set<Promise<void>>() };
    const whileAttached =
      <A extends unknown[]>(say: (...args: A) => void) =>
      (...args: A) => {
        if (!attached.ended) say(...args);
      };
    const tellLines = whileAttached((lines: AgentLines) => publisher.lines(linesOf(lines)));
    // The agent's lines take the place of whatever agent's were shown before, empty or not: it says them again only once they change.
    const opening = async (): Promise<Agent> => {
      const agent = await Agent.open(
        { runtime, keys },
        {
          ...host.agentOptions,
          fetch: async (input, init) => {
            if (attached.ended) throw new Error(DETACHED);
            return answered(attached.work, init?.signal ?? null, () => hostFetch(input, init));
          },
          didcomm: await host.didcomm(),
          trace,
          // The records read what the agent keeps here, the inputs its replica left to another and the preparations it selected among it, so a write is a change to show.
          localOptions: {
            get: (key) => runtime.local.options.get(key),
            set: async (key, value) => {
              await runtime.local.options.set(key, value);
              changed();
            },
            delete: async (key) => {
              await runtime.local.options.delete(key);
              changed();
            },
          },
          log: whileAttached(log),
          onLines: tellLines,
        }
      );
      tellLines(agent.lines());
      return agent;
    };
    const agent = opening();
    agent.catch(() => undefined);
    return Object.assign(attached, { agent });
  }

  /** `work` over the agent, refused once the agent is detached and waited for by whoever detaches it. */
  function during<T>(attached: Attached, work: (agent: Agent) => Promise<T>): Promise<T> {
    const done = attached.agent.then((agent) => {
      if (attached.ended) throw new Error(DETACHED);
      return work(agent);
    });
    const settled = done.then(
      () => undefined,
      () => undefined
    );
    attached.work.add(settled);
    void settled.then(() => attached.work.delete(settled));
    return done;
  }

  async function detach(attached: Attached): Promise<void> {
    attached.ended = true;
    while (attached.work.size > 0) await Promise.all(attached.work);
    await attached.agent.then(
      (agent) => agent.close(),
      () => undefined
    );
  }

  /** The agent's lines connected, in the background: a mediator out of reach keeps no screen waiting. */
  function connect(running: Open): void {
    const { attached } = running;
    during(attached, async (agent) => {
      await agent.connect();
    }).catch((err) => {
      if (!attached.ended) log(`the agent did not come up: ${failure(err)}`);
    });
  }

  /**
   * A vault whose history turned out damaged while it ran is run no
   * further: it would accept no write, and what it still reads is not
   * the whole of what it held. The person is told what that leaves them.
   */
  function giveUpDamaged(damage: DamagedHistory): Promise<void> {
    const running = open;
    return inTurn(async () => {
      if (closing() || running === null || open !== running) return;
      await stop();
      phase("damaged", damage.message);
    });
  }

  /** The agent over an open runtime, and the vault shown once its first read is published; one whose first read meets damage is let go of and said to be damaged instead. */
  async function start(runtime: SqliteVault, keys: Keys, seedKey: SeedKey): Promise<void> {
    let running: Open;
    try {
      if (closing()) throw new Error(CLOSED);
      if (held === null) throw new Error("no vault file is held");
      const trace = await AgentTrace.open(runtime.local);
      running = { runtime, seedKey, keys, trace, attached: attach(runtime, keys, trace), publishing: publisher.open(held, sourceOf({ runtime, keys })) };
    } catch (err) {
      await runtime.close();
      throw err;
    }
    open = running;
    try {
      await running.publishing.ready;
    } catch (err) {
      await stop();
      if (!(err instanceof DamagedHistory)) throw err;
      phase("damaged", err.message);
      return;
    }
    current = "open";
    connect(running);
  }

  async function stop(): Promise<void> {
    const running = open;
    open = null;
    if (running === null) return;
    running.publishing.close();
    await detach(running.attached);
    await running.runtime.close();
  }

  /** The vault's runtime opened under its seed, with no agent over it yet; one whose history is damaged is closed again and the damage thrown. */
  async function unlocked(seedKey: SeedKey, options: { resetIdentity?: boolean } = {}): Promise<Pick<Open, "runtime" | "keys">> {
    const opened = await openVault(await takeVault("readwrite"), seedKey, { ...SCAN, changed, ...options });
    const damage = damageOf(opened.runtime);
    if (damage !== null) {
      await opened.runtime.close();
      throw damage;
    }
    return opened;
  }

  async function run(seedKey: SeedKey): Promise<void> {
    const { runtime, keys } = await unlocked(seedKey);
    await start(runtime, keys, seedKey);
  }

  const unopened = (err: unknown) => phase(err instanceof DamagedHistory ? "damaged" : "unreadable", failure(err));

  /** The vault owned and looked at without its seed, for `unlock`; one that does not open is let go of, its bytes left alone. */
  async function look(): Promise<void> {
    try {
      const looked = await inspectRuntime(await takeVault("readwrite"), SCAN);
      const damage = damageOf(looked.runtime);
      if (damage !== null) {
        await looked.runtime.close();
        throw damage;
      }
      inspected = looked;
      phase("locked");
    } catch (err) {
      unopened(err);
    }
  }

  async function letGo(): Promise<void> {
    const held = inspected;
    inspected = null;
    await held?.runtime.close();
  }

  /** `work` over the running agent, and the vault told again afterwards whether or not it threw: a call that failed may have committed. */
  async function act<T>(work: (agent: Agent, running: Open) => Promise<T>): Promise<T> {
    const running = vault();
    const { attached } = running;
    return during(attached, async (agent) => {
      try {
        return await work(agent, running);
      } catch (err) {
        if (err instanceof DamagedHistory) void giveUpDamaged(err);
        throw err;
      } finally {
        if (open === running) await settle();
      }
    });
  }

  const commit = ({ runtime, keys }: Open, choose: (fold: VaultFold) => VaultDraft[]) => decide(runtime, keys, choose);

  const handingOut = new WeakMap<Open, Promise<{ didId: DidId; did: Did }>>();

  function contactOf(fold: VaultFold, contactId: ContactId): void {
    const contact = fold.contacts.contacts.get(contactId);
    if (contact === undefined || contact.origin === null || contact.deleted) throw new Unmet(`no contact ${contactId}`);
  }

  async function preferredMediation({ runtime, keys }: Open): Promise<MediationId> {
    const preferred = (await scanVault(runtime.vault, keys, SCAN)).mediations.preferred;
    if (preferred === null) throw new Unmet("no mediator is set");
    return preferred;
  }

  const preferredRoute = async (running: Open): Promise<RouteSpec> => ({ kind: "mediated", mediationId: await preferredMediation(running) });

  /** `presented` as a peer's DID: canonical, and none of this vault's own. */
  async function peerDidOf(running: Open, presented: string): Promise<Did> {
    let peerDid: Did;
    try {
      peerDid = canonicalDidOf(presented);
    } catch (err) {
      throw new InvalidArgument(failure(err));
    }
    const fold = await scanVault(running.runtime.vault, running.keys, SCAN);
    if ([...fold.dids.entities.values()].some((entity) => entity.created !== null && sameDid(entity.created.did, peerDid))) throw new InvalidArgument("that is an address of your own");
    return peerDid;
  }

  async function reach(agent: Agent, running: Open, recipientDid: string, pthid: string | null, petname: string): Promise<SendResult & { contactId: ContactId }> {
    await refuseUnexplained(running);
    const peerDid = await peerDidOf(running, recipientDid);
    const { minted } = await createDid(running.runtime, running.keys, await preferredRoute(running));
    const channel: Channel = { localDid: minted.did, peerDid };
    const contactId = uuidv7() as ContactId;
    await commit(running, () => [vaultDraft("contact.created", { contactId, because: "user" }), vaultDraft("contact.petname", { contactId, name: petname }), vaultDraft("contact.channelsSet", { contactId, channels: [channel] })]);
    const sent = await agent.send({ channel, recipientDid }, { type: PING_TYPE, body: { response_requested: true }, pthid, pleaseAck: [""] });
    return { contactId, ...outcomeOf(sent.dispatched), messageId: sent.messageId, channel: sent.channel };
  }

  /**
   * A portable snapshot's bytes as a file of the host's for the length
   * of `use`, opened read-only. Whatever stands under `name` beforehand
   * is what a run cut short left behind: the files are this daemon's
   * alone, and the operations that put one there take turns.
   */
  async function withSnapshot<T>(name: string, bytes: Uint8Array, use: (driver: SqliteDriver) => Promise<T>): Promise<T> {
    const store = files();
    await store.remove(name);
    await store.importFile(name, bytes);
    try {
      return await use(await store.open(name, "readonly", "portable"));
    } finally {
      await store.remove(name);
    }
  }

  /**
   * The running vault's portable snapshot, read off the file it is
   * exported to and refused whole when its events and objects, or that
   * file, come to more than `maxBytes`: `bound` is whose bound that is,
   * for the refusal to say. Runs in the files' turn.
   */
  async function exported({ runtime, keys }: Open, what: string, maxBytes: number | undefined, bound: string): Promise<Uint8Array> {
    const store = files();
    await store.remove(EXPORT_FILE);
    try {
      await exportVault(runtime, (mode) => store.open(EXPORT_FILE, mode, "portable"), { heldRoots: vaultHeldRoots(keys, SCAN), maxBytes }).catch((err: unknown) => {
        if (err instanceof SnapshotTooLarge) throw new TooLarge(`the ${what}'s events and objects come to ${err.bytes} bytes, over the ${err.maxBytes} ${bound}`);
        throw err;
      });
      const bytes = await store.exportFile(EXPORT_FILE, maxBytes);
      // A host that reads the file without minding the bound is still held to it.
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new TooLarge(`the ${what} file is ${bytes.byteLength} bytes, over the ${maxBytes} ${bound}`);
      return bytes;
    } finally {
      await store.remove(EXPORT_FILE);
    }
  }

  /** A portable snapshot's bytes restored as this daemon's vault, under the passphrase that opens the snapshot's own wrapped seed. */
  const restore = (bytes: Uint8Array, passphrase: string): Promise<void> =>
    exclusively(async () => {
      const store = await refuseOccupied();
      const unlocked: { seedKey: SeedKey | null } = { seedKey: null };
      let made = false;
      let runtime: SqliteVault;
      let keys: Keys;
      try {
        runtime = await withSnapshot(RESTORE_SOURCE, bytes, async (driver) => {
          const source = openPortable(driver);
          try {
            const restored = await restoreVault(
              source,
              async (mode) => {
                const destination = await store.open(VAULT_FILE, mode, "runtime");
                made = true;
                held = uuidv7() as Hold;
                return destination;
              },
              {
                heldRoots: vaultHeldRoots(null, SCAN),
                anchor: async (wrapped) => {
                  try {
                    unlocked.seedKey = await unlockSeedKeystore({ version: 3, seedJwe: wrapped.seedJwe }, passphrase);
                  } catch {
                    throw new Unmet("that passphrase does not open this backup");
                  }
                  return Keys.anchorOf(unlocked.seedKey);
                },
              }
            );
            return new SqliteVault(restored.runtime, { changed });
          } finally {
            source.close();
          }
        });
      } catch (err) {
        // A destination the restore made and failed on is closed and unready: it opens as nothing, and the next try starts from no file.
        if (made) {
          held = null;
          await store.remove(VAULT_FILE);
        }
        throw err;
      }
      const { seedKey } = unlocked;
      try {
        if (seedKey === null) throw new Error("the restore did not ask for the passphrase");
        keys = await Keys.open(seedKey, runtime.metadata.anchor);
      } catch (err) {
        await runtime.close();
        held = null;
        await store.remove(VAULT_FILE);
        throw err;
      }
      await host.cacheSeedKey(seedKey);
      await start(runtime, keys, seedKey);
    });

  host.onOnline?.(() => {
    const running = open;
    if (running === null) return;
    connect(running);
  });

  return {
    get booted() {
      return booted;
    },
    publisher,
    close() {
      closed ??= inTurn(async () => {
        try {
          await stop();
          await letGo();
        } finally {
          const held = storage;
          storage = null;
          await held?.close();
        }
      });
      for (const over of [...waits]) over();
      return closed;
    },

    async boot() {
      if (booted) return;
      booted = true;
      await inTurn(async () => {
        const foreign = (await host.foreign?.()) ?? null;
        if (foreign !== null) {
          phase("foreign", foreign);
          return;
        }
        try {
          storage = await owned(
            () => host.storage(),
            (taken) => taken.close()
          );
        } catch (err) {
          phase("unreadable", failure(err));
          return;
        }
        if (!(await storage.has(VAULT_FILE))) {
          phase("onboarding");
          return;
        }
        held = uuidv7() as Hold;
        const seedKey = await host.cachedSeedKey();
        if (seedKey === null) {
          await look();
          return;
        }
        try {
          await run(seedKey);
        } catch (err) {
          unopened(err);
        }
      });
    },

    createIdentity: (name, passphrase) =>
      exclusively(async () => {
        const store = await refuseOccupied();
        const { doc, seedKey } = await createSeedKeystore(passphrase);
        const driver = await takeVault("create");
        held = uuidv7() as Hold;
        let created: Awaited<ReturnType<typeof createVault>>;
        try {
          created = await createVault(driver, { seedKey, wrapped: { version: 3, seedJwe: doc.seedJwe }, label: name, ...SCAN, changed });
          await created.runtime.local.options.set(RESTORE_EXPLAINED, true);
        } catch (err) {
          // The file is this call's own to remove only past the open that made it, and only once its connection is closed.
          driver.close();
          held = null;
          await store.remove(VAULT_FILE);
          throw err;
        }
        await host.cacheSeedKey(seedKey);
        await start(created.runtime, created.keys, seedKey);
      }),

    restoreIdentity: restore,

    async restoreFromLink(link, passphrase, maxBytes) {
      // Nothing is read for a daemon that could not restore it; the restore looks again once the snapshot is in.
      await exclusively(refuseOccupied);
      let snapshot: Uint8Array;
      try {
        // The link's URL is the word of whoever handed it over: no redirect is followed, so the host's fetch checks the one address it reaches.
        const sealed = await readBlob(link.url, { maxBytes: maxBytes + SEAL_OVERHEAD, timeoutMs: SNAPSHOT_READ_TIMEOUT_MS, fetch: (input, init) => hostFetch(input, { ...init, redirect: "error" }) });
        snapshot = await openBlob(sealed, link);
      } catch (err) {
        throw unread(err, maxBytes);
      }
      await restore(snapshot, passphrase);
    },

    async explainedRestore() {
      const { runtime } = vault();
      // Written under the writer lock, as every change a snapshot is read from is, so no cut reads the option before the event it stands beside.
      await runtime.locked(() => runtime.local.options.set(RESTORE_EXPLAINED, true));
      changed();
      await settle();
    },

    unlock: (passphrase) =>
      exclusively(async () => {
        if (inspected === null) throw new WrongPhase("nothing to unlock");
        let seedKey: SeedKey;
        try {
          seedKey = await unlockSeedKeystore({ version: 3, seedJwe: inspected.wrapped.seedJwe }, passphrase);
        } catch {
          throw new Unmet("wrong passphrase");
        }
        await letGo();
        try {
          await run(seedKey);
        } catch (err) {
          await look();
          throw err;
        }
        await host.cacheSeedKey(seedKey);
      }),

    lock: () =>
      exclusively(async () => {
        await host.forgetSeedKey();
        // Locked already, the vault stays in the hold it is in: a second look would wait on this daemon's own.
        if (inspected !== null) return;
        await stop();
        if (await files().has(VAULT_FILE)) await look();
        else {
          held = null;
          phase("onboarding");
        }
      }),

    forgetIdentity: (hold) =>
      exclusively(async () => {
        const store = files();
        if (typeof hold !== "string") throw new InvalidArgument("the removal names no vault: it was asked by an app of an earlier version, and nothing is removed until the app is updated");
        if (held === null) throw new WrongPhase("there is no vault here to remove");
        if (hold !== held) throw new StaleHold();
        await stop();
        await letGo();
        await host.forgetSeedKey();
        await store.remove(VAULT_FILE);
        held = null;
        phase("onboarding");
      }),

    exportBackup: (maxBytes) =>
      exclusively(async () => {
        const running = vault();
        const bytes = await exported(running, "backup", maxBytes, "this daemon delivers");
        const label = (await scanVault(running.runtime.vault, running.keys, SCAN)).label ?? "";
        const stem = label.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "vault";
        return { name: `${stem}-${new Date().toISOString().slice(0, 10)}.estoc.sqlite`, bytes };
      }),

    async publishSnapshotLink() {
      const running = vault();
      const { attached, runtime } = running;
      const { store, mediationId, maxBytes } = await during(attached, async (agent) => {
        const mediationId = await preferredMediation(running);
        const store = await agent.blobStore(mediationId);
        const limits = await store.limits();
        if (limits === null) throw new Unmet("the mediator keeps no blobs");
        return { store, mediationId, maxBytes: limits.maxBytes - SEAL_OVERHEAD };
      });
      // Only the export takes the files' turn: a lock or a removal in the turn waits for every call over the agent, so a call over it made from within the turn would wait on itself.
      const snapshot = await exclusively(() => {
        if (open !== running) throw new WrongPhase("the vault was let go of while its snapshot was asked for");
        return exported(running, "snapshot", maxBytes, "a blob at the mediator holds once sealed");
      });
      const sealed = await sealBlob(snapshot);
      return during(attached, () =>
        serially(runtime, SNAPSHOT_PUTS, async () => {
          const links = new SnapshotLinks(runtime.local.options, runtime.author);
          const placedAt = Date.now();
          await links.prune(placedAt);
          const asked: Put = { stage: "asked", hash: sealed.hash, key: sealed.key, owner: { author: runtime.author, mediationId }, placedAt };
          await links.keep(asked);
          let placement: Awaited<ReturnType<typeof store.put>>;
          try {
            placement = await store.put(sealed.hash, sealed.bytes.length);
          } catch (err) {
            if (!(err instanceof MediatorRefused) || err.code === null || !PUT_REFUSALS.has(err.code)) throw err;
            await links.forget(sealed.hash);
            throw new Unmet(`the mediator refused the snapshot: ${err.message}`);
          }
          const placed = { ...asked, stage: "placed" as const, url: placement.url, retainUntil: placement.retainUntil };
          await links.keep(placed);
          await store.upload(placement, sealed.bytes);
          const uploaded = { ...placed, stage: "uploaded" as const };
          await links.keep(uploaded);
          return links.published(uploaded);
        })
      );
    },

    revokeSnapshotLink(hash) {
      const { attached, runtime } = vault();
      return during(attached, (agent) =>
        serially(runtime, SNAPSHOT_PUTS, async () => {
          const links = new SnapshotLinks(runtime.local.options, runtime.author);
          const put = await links.get(hash);
          if (put === null) throw new Unmet(`no snapshot ${hash} was put from here`);
          if (!links.owns(put)) {
            const kept = put.stage === "asked" ? "" : `, which keeps it until ${new Date(put.retainUntil).toISOString()}`;
            throw new Unmet(`snapshot ${hash} was put under a replica ID this runtime has given up since, and only that replica may delete it at the mediator${kept}`);
          }
          await (await agent.blobStore(put.owner.mediationId)).delete(hash);
          await links.forget(hash);
        })
      );
    },

    async snapshotLinks() {
      const { runtime } = vault();
      return new SnapshotLinks(runtime.local.options, runtime.author).list(Date.now());
    },

    mergeBackup: (bytes) =>
      exclusively(async () => {
        const merge = ({ runtime, keys }: Pick<Open, "runtime" | "keys">) =>
          withSnapshot(MERGE_SOURCE, bytes, async (driver) => {
            const source = openPortable(driver);
            try {
              return await importVault(runtime, source, { retainedRoots: vaultRetention(keys, SCAN) });
            } finally {
              source.close();
            }
          });
        const counted = ({ added, duplicates, objects, repaired }: Awaited<ReturnType<typeof merge>>, renewed: boolean) => ({ added, duplicates, objects, repaired, renewed });
        const running = vault();
        const imported = await merge(running).catch((err: unknown) => {
          if (err instanceof ForkedAuthor) return null;
          throw err;
        });
        if (imported !== null) {
          // The agent read its keys and its lines before the merge: another over the merged vault takes its place.
          await detach(running.attached);
          running.attached = attach(running.runtime, running.keys, running.trace);
          await settle();
          connect(running);
          return counted(imported, false);
        }
        // The backup went on from a copy of this very runtime, or this one from a copy of the backup's: both wrote under one replica ID. Nothing was merged. This runtime takes a fresh one, its history as it is, and the backup's events then come in under the ID they were written with.
        const { seedKey } = running;
        await stop();
        let renewed: Pick<Open, "runtime" | "keys">;
        try {
          renewed = await unlocked(seedKey, { resetIdentity: true });
        } catch (failed) {
          await look();
          throw failed;
        }
        // No agent runs until the merge is over: one over the history as it stood would receive against keys the backup is still bringing, and acknowledge as discarded what was for them.
        try {
          return counted(await merge(renewed), true);
        } finally {
          await start(renewed.runtime, renewed.keys, seedKey).catch(async (failed: unknown) => {
            await look();
            throw failed;
          });
        }
      }),

    setMediator: (mediatorDid) =>
      act((agent, { runtime, keys }) =>
        // Two calls at once would each enroll in and select the arrangement: the later one looks only once the earlier is done.
        serially(runtime, "set-mediator", async () => {
          const mediationId = mediationIdOf(mediatorDid as Did);
          const fold = await scanVault(runtime.vault, keys, SCAN);
          const own = fold.replicas.replicas.get(runtime.author);
          if (own !== undefined && own.mediationId !== null && own.mediationId !== mediationId) {
            throw new Unmet(`this runtime is a replica of the arrangement with ${fold.mediations.mediations.get(own.mediationId)?.mediatorDid ?? "another mediator"}; moving it to another mediator is not provided`);
          }
          await createMediation(runtime, keys, mediatorDid as Did);
          await agent.enroll(mediationId);
          await selectMediation(runtime, keys, mediationId);
          return mediationId;
        })
      ),

    createInvitation: (goal) =>
      act(async (agent, running) => {
        const { created } = await createDid(running.runtime, running.keys, await preferredRoute(running));
        const { invitation } = await agent.disclose(created.data.didId, { as: "oob", goal: goal ?? null });
        if (invitation === null) throw new Error("the disclosure made no invitation");
        return { didId: created.data.didId, invitation };
      }),

    acceptInvitation: (invitation, petname) => act((agent, running) => reach(agent, running, invitation.from, invitation.id, petname)),

    addContactByDid: (did, petname) => act((agent, running) => reach(agent, running, did, null, petname)),

    publicDid: () =>
      act((agent, running) => {
        // two callers before any disclosure is written would each mint one: the first call's outcome is every concurrent caller's
        const pending = handingOut.get(running);
        if (pending !== undefined) return pending;
        const minting = (async () => {
          const fold = await scanVault(running.runtime.vault, running.keys, SCAN);
          const handedOut = [...fold.dids.entities.values()].find((entity) => entity.live && entity.disclosures.some(({ data }) => data.as === "direct"));
          if (handedOut?.created) return { didId: handedOut.didId, did: handedOut.created.longFormDid };
          const { created } = await createDid(running.runtime, running.keys, await preferredRoute(running));
          const { longFormDid } = await agent.disclose(created.data.didId, { as: "direct" });
          return { didId: created.data.didId, did: longFormDid };
        })().finally(() => handingOut.delete(running));
        handingOut.set(running, minting);
        return minting;
      }),

    createContact: (petname, channels) =>
      act(async (_agent, running) => {
        if (channels.length === 0) throw new InvalidArgument("a contact is created with at least one channel");
        const contactId = uuidv7() as ContactId;
        await commit(running, () => [vaultDraft("contact.created", { contactId, because: "user" }), vaultDraft("contact.petname", { contactId, name: petname }), vaultDraft("contact.channelsSet", { contactId, channels })]);
        return contactId;
      }),

    renameContact: (contactId, petname) =>
      act(async (_agent, running) => {
        await commit(running, (fold) => {
          contactOf(fold, contactId);
          return [vaultDraft("contact.petname", { contactId, name: petname })];
        });
      }),

    setContactChannels: (contactId, channels) =>
      act(async (_agent, running) => {
        await commit(running, (fold) => {
          contactOf(fold, contactId);
          return [vaultDraft("contact.channelsSet", { contactId, channels })];
        });
      }),

    deleteContact: (contactId, options) =>
      act(async (agent) => {
        await agent.manual.deleteContact(contactId, options);
      }),

    blockChannels: (channels, includeSuccessors) =>
      act(async (agent) => {
        await agent.manual.blockChannels(channels, includeSuccessors);
      }),

    eraseMessage: (messageId) =>
      act(async (agent) => {
        await agent.manual.eraseMessage(messageId);
      }),

    send: (target, content) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        const sent = await agent.send(target, content);
        return { ...outcomeOf(sent.dispatched), messageId: sent.messageId, channel: sent.channel };
      }),

    retry: (messageId) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        return outcomeOf(await agent.manual.retry(messageId));
      }),

    cancel: (messageId) =>
      act(async (agent) => {
        const cancelled = await agent.manual.cancel(messageId);
        return { outcome: cancelled.outcome, because: cancelled.outcome === "none" ? cancelled.because : null, messageId: cancelled.messageId };
      }),

    selectPreparation: (messageId, preparationEventCid) =>
      act(async (agent) => {
        const selected = await agent.manual.selectPreparation(messageId, preparationEventCid);
        return { outcome: selected.outcome, because: selected.outcome === "none" ? selected.because : null, messageId: selected.messageId };
      }),

    completeResponse: (executionId, effectType) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        return effectOutcomeOf(await agent.manual.completeResponse(executionId, effectType));
      }),

    completeNotification: (rotationEventCid) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        return effectOutcomeOf(await agent.manual.completeNotification(rotationEventCid));
      }),

    rotate: (localDidId, peerDid) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        const rotated = await agent.manual.rotate({ localDidId, peerDid });
        return { successor: rotated.successor, existed: rotated.existed, ...effectOutcomeOf(rotated.notification) };
      }),

    rotateChannel: (channel) =>
      act(async (agent, running) => {
        await refuseUnexplained(running);
        const entities = [...(await scanVault(running.runtime.vault, running.keys, SCAN)).dids.entities.values()].filter((entity) => entity.created !== null && sameDid(entity.created.did, channel.localDid));
        const live = entities.filter((entity) => entity.live);
        const candidates = live.length > 0 ? live : entities;
        if (candidates.length === 0) throw new Unmet(`no DID of this vault is ${channel.localDid}`);
        if (candidates.length > 1) throw new Unmet(`${candidates.length} DIDs of this vault are ${channel.localDid}: which of them to rotate is not decidable`);
        const rotated = await agent.manual.rotate({ localDidId: candidates[0]!.didId, peerDid: channel.peerDid });
        const successor = (await scanVault(running.runtime.vault, running.keys, SCAN)).dids.entities.get(rotated.successor)?.created?.did;
        if (successor === undefined) throw new Error(`the successor ${rotated.successor} has no DID`);
        return { successor: { localDid: successor, peerDid: rotated.channel.peerDid }, ...effectOutcomeOf(rotated.notification) };
      }),

    refresh: () => publisher.refresh(),

    async reconnect() {
      await during(vault().attached, async (agent) => {
        await agent.connect();
      });
    },

    traceLevel: async () => vault().trace.level,

    async setTraceLevel(level) {
      if (!isTraceLevel(level)) throw new InvalidArgument(`no such trace level: ${String(level)}`);
      await vault().trace.setLevel(level);
      return level;
    },
  };
}
