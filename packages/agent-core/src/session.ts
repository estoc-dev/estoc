/**
 * The vault as this runtime runs it: the runtime, the seed's keys and
 * the options every fold of it is read under, bound once when the
 * vault is opened and never paired again by a caller. The keys never
 * leave the binding: a host reads the fold, decides under the lock and
 * mints DIDs and arrangements through it, and every procedure of this
 * package takes the binding rather than a runtime and keys of its own
 * choosing. The fold options are the binding's too, so that one vault
 * has one reading: an intent whose operation the host's handlers
 * declared is this runtime's work in every fold, the one a receipt
 * re-reads after its admissions and the one a rotation rehearses over
 * as much as the one a host looks at. The options are copied at open:
 * what the host hands in may be a generator or a set it goes on
 * changing, and a fold read later must read as the first one did.
 */

import type { AuthorId, Held, HeldRoots, RetainedRoots, SqliteVault } from "@estoc/event-store";
import {
  VaultEventSet,
  admitReceipts,
  checkVault,
  foldVault,
  objectReader,
  scanVault,
  vaultHeldRoots,
  vaultRetention,
  type Admitted,
  type Did,
  type DidId,
  type Keys,
  type MediationId,
  type ScanOptions,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import { createDid, type CreatedDid, type RouteSpec } from "./dids.js";
import { createMediation, selectMediation } from "./mediation.js";
import { decide, serially, type Decided } from "./procedure.js";

/** The vault under the writer lock, as `VaultSession.locked` hands it to the work it runs. */
export interface LockedVault {
  /** the vault held: its events, its objects, and commits that share the lock */
  readonly held: Held;
  /** the fold as the vault stands under the lock, read with the session's keys and options */
  fold(): Promise<VaultFold>;
}

/** What a host does with the vault it opened, besides running an agent over it. */
export interface VaultSession {
  /** the storage: what the host closes, exports, merges into and keeps its local options in; nothing that needs the seed is read through it */
  readonly runtime: SqliteVault;
  /** one fold of the vault as it stands, outside the lock */
  fold(): Promise<VaultFold>;
  /** `work` under the writer lock, over the vault as it stands there */
  locked<T>(work: (vault: LockedVault) => Promise<T>): Promise<T>;
  /** one locked step: the fold read, `choose`'s drafts committed; none when it returns none */
  decide(choose: (fold: VaultFold) => VaultDraft[] | Promise<VaultDraft[]>): Promise<Decided>;
  /** `work` after every earlier turn under `key` of this runtime has settled, and before every later one; the vault is not locked for it */
  turn<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** `did.created` of an entry for a route; the same `didId` again returns the entity as recorded */
  createDid(route: RouteSpec, didId?: DidId): Promise<CreatedDid>;
  /** `mediation.created` for the arrangement with the mediator, or the creation already recorded */
  createMediation(mediatorDid: Did): Promise<VaultEvent<"mediation.created">>;
  /** `mediation.selected`: the arrangement new mediated routes are minted for; null when it is the selection already */
  selectMediation(mediationId: MediationId): Promise<VaultEvent<"mediation.selected"> | null>;
  /**
   * The roots the events of a vault hold, read with this session's
   * keys and options, for the event store's export and validation.
   * The callback folds whatever vault it is handed — the held view of
   * an export, a snapshot — as often as the store asks, never this
   * runtime's on its own.
   */
  heldRoots(): HeldRoots;
  /** The retention the events of a vault hold, edge by edge, read as `heldRoots` reads: for the event store's import, which hands it the snapshot, the target and their union in turn. */
  retainedRoots(): RetainedRoots;
}

/** The locked view as the procedures of this package use it: the keys and the options the fold is read with are here, for what a procedure re-reads or rehearses under the lock. */
export class Locked implements LockedVault {
  constructor(
    readonly held: Held,
    readonly keys: Keys,
    /** the local replica every commit here is authored as */
    readonly author: AuthorId,
    private readonly options: Readonly<ScanOptions>
  ) {}

  fold(): Promise<VaultFold> {
    return scanVault(this.held, this.keys, this.options);
  }

  /** The admissions the fold owes, recorded round by round, each round's fold read under the same options. */
  admitReceipts(fold: VaultFold): Promise<Admitted> {
    return admitReceipts(this.held, fold, this.options);
  }

  /** The fold of `set` — events the vault holds with events it might — read as this session reads one: the seed's checks, the objects here, the same options. */
  async foldOf(set: VaultEventSet): Promise<VaultFold> {
    return foldVault(set, await checkVault(set, this.keys, objectReader(this.held.objects, this.options.maxObjectBytes)), this.options);
  }
}

/** The binding itself: made by the entries of `identity.ts` alone, and the one shape `Agent.open` takes. */
export class Session implements VaultSession {
  /** the operations beyond the built-in ones whose intents this runtime produces, as the host declared them at open */
  readonly effectTypes: ReadonlySet<string>;
  readonly scanOptions: Readonly<ScanOptions>;

  constructor(
    readonly runtime: SqliteVault,
    readonly keys: Keys,
    options: ScanOptions
  ) {
    this.effectTypes = new Set(options.effectTypes ?? []);
    this.scanOptions = { effectTypes: this.effectTypes, ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }) };
  }

  fold(): Promise<VaultFold> {
    return scanVault(this.runtime.vault, this.keys, this.scanOptions);
  }

  locked<T>(work: (vault: Locked) => Promise<T>): Promise<T> {
    return this.runtime.locked((held) => work(new Locked(held, this.keys, this.runtime.author, this.scanOptions)));
  }

  decide(choose: (fold: VaultFold) => VaultDraft[] | Promise<VaultDraft[]>): Promise<Decided> {
    return decide(this, choose);
  }

  turn<T>(key: string, work: () => Promise<T>): Promise<T> {
    return serially(this.runtime, key, work);
  }

  createDid(route: RouteSpec, didId?: DidId): Promise<CreatedDid> {
    return createDid(this, route, didId);
  }

  createMediation(mediatorDid: Did): Promise<VaultEvent<"mediation.created">> {
    return createMediation(this, mediatorDid);
  }

  selectMediation(mediationId: MediationId): Promise<VaultEvent<"mediation.selected"> | null> {
    return selectMediation(this, mediationId);
  }

  heldRoots(): HeldRoots {
    return vaultHeldRoots(this.keys, this.scanOptions);
  }

  retainedRoots(): RetainedRoots {
    return vaultRetention(this.keys, this.scanOptions);
  }
}
