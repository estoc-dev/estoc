/**
 * One publisher orders the daemon's state for every view. The state is
 * one value under an epoch and a revision; the runtime's lines count
 * their own revisions in the same epoch; a log line carries the epoch
 * it was said in. A fresh epoch comes with every runtime opened and
 * every other change of phase or hold, and revisions count from 1
 * within it, so a view that follows one epoch's revisions upward, and
 * takes another epoch's first state whole, is never shown an older
 * read as a newer one.
 *
 * The open state is read off the runtime in one coherent cut, under
 * its writer lock, once per burst of commits: each commit counts, a
 * read notes the count as its cut begins, and what it covers is what
 * was counted by then. A read begun for one runtime or epoch is not
 * published for another, whenever it finishes.
 */

import type { Epoch, Hold, LogLine, Revision, RevisionMarker, StateValue } from "@estoc/daemon-api/contract";

export type NonOpenValue = Exclude<StateValue, { phase: "open" }>;

export type StateValueOf<S> = NonOpenValue | { phase: "open"; hold: Hold; snapshot: S };

export interface StateOf<S> {
  epoch: Epoch;
  revision: Revision;
  value: StateValueOf<S>;
}

export interface LinesStateOf<L> {
  epoch: Epoch;
  revision: Revision;
  value: L;
}

/** What a view starts from: the state and the lines as published, of one epoch. */
export interface BaselineOf<S, L> {
  state: StateOf<S>;
  lines: LinesStateOf<L>;
}

/** A view as the publisher tells it: each publication in the order made, after the baseline `attach` handed it. */
export interface Subscriber<S, L> {
  state(state: StateOf<S>): void;
  lines(lines: LinesStateOf<L>): void;
  log(line: LogLine): void;
}

/**
 * What the open runtime is read off. `capture` reads one coherent cut
 * and calls `cut` the moment the cut begins — under the writer lock,
 * once nothing else writes — so that what the read covers is what was
 * committed by then.
 */
export interface Source<S> {
  capture(cut: () => void): Promise<S>;
}

/** A runtime being published, for the daemon that opened it. */
export interface Publishing {
  /** resolves once the runtime's first read stands as the open state of a fresh epoch; rejects with the read's failure, the state as it was */
  readonly ready: Promise<void>;
  /** the runtime is gone: nothing more is read off it, and a read under way is not published */
  close(): void;
}

/** A refresh answered by a change of epoch instead of a revision: the state it asked about is no longer the one published. */
export class StateChanged extends Error {
  constructor() {
    super("the state moved to another epoch before the refresh was answered");
    this.name = "StateChanged";
  }
}

export interface PublisherOptions<L> {
  /** the lines of an epoch before its agent has said anything, and of every epoch that has no agent */
  noLines: L;
  /** a read of the open runtime, after its first, that failed: the state stays as it was until the next change */
  failed(error: unknown): void;
  /** the largest revision an epoch counts to before a fresh one takes its place; pinned low by tests */
  maxRevision?: number;
}

interface Opened<S> {
  hold: Hold;
  source: Source<S>;
  /** whether the first read stands published, as the epoch this runtime is shown in */
  installed: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

interface Waiter {
  /** the count of changes the answer must cover */
  target: number;
  resolve(marker: RevisionMarker): void;
  reject(error: unknown): void;
}

const freshEpoch = (): Epoch => crypto.randomUUID() as Epoch;

const markerOf = ({ epoch, revision }: StateOf<unknown>): RevisionMarker => ({ epoch, revision });

export class Publisher<S, L> {
  private state: StateOf<S>;
  private linesState: LinesStateOf<L>;
  /** how many changes the runtime has had */
  private changes = 0;
  /** how many of them the published open state covers */
  private covered = 0;
  /** the last read that failed, and how many changes it would have covered: not tried again until there are more */
  private failure: { covered: number; error: unknown } | null = null;
  private opened: Opened<S> | null = null;
  private building = false;
  private waiters: Waiter[] = [];
  private readonly subscribers = new Set<Subscriber<S, L>>();
  private readonly maxRevision: number;

  constructor(
    initial: NonOpenValue,
    private readonly options: PublisherOptions<L>
  ) {
    const epoch = freshEpoch();
    this.state = { epoch, revision: 1, value: initial };
    this.linesState = { epoch, revision: 1, value: options.noLines };
    this.maxRevision = options.maxRevision ?? Number.MAX_SAFE_INTEGER;
  }

  /** The state and the lines as they stand published. */
  get current(): BaselineOf<S, L> {
    return { state: this.state, lines: this.linesState };
  }

  /** `subscriber` told of every publication from here on; what it starts from is returned, and nothing published after it is missed. */
  attach(subscriber: Subscriber<S, L>): BaselineOf<S, L> {
    this.subscribers.add(subscriber);
    return this.current;
  }

  detach(subscriber: Subscriber<S, L>): void {
    this.subscribers.delete(subscriber);
  }

  /** A phase that shows no runtime: a fresh epoch when the phase or the hold differs from the one published, the next revision when only the detail does, nothing when neither does. */
  set(value: NonOpenValue): void {
    this.leave();
    const current = this.state.value;
    if (current.phase !== "open" && current.phase === value.phase && current.hold === value.hold) {
      if (current.detail !== value.detail) this.publishState(value);
      return;
    }
    this.renew(value);
  }

  /** A runtime to show: read now and on every change, its first read the open state of a fresh epoch. One runtime is shown at a time; the one before, if any, is left. */
  open(hold: Hold, source: Source<S>): Publishing {
    this.leave();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const opened: Opened<S> = { hold, source, installed: false, resolve, reject };
    this.opened = opened;
    this.schedule();
    return {
      ready,
      close: () => {
        if (this.opened !== opened) return;
        this.opened = null;
        if (!opened.installed) opened.reject(new Error("the runtime closed before its state was published"));
      },
    };
  }

  /** The runtime changed: what is published no longer covers it, and a read is due. */
  invalidate(): void {
    this.changes += 1;
    this.schedule();
  }

  /** The lines of the runtime shown, replaced whole; nothing while no runtime is shown, as an agent's word after its runtime was left is nothing. */
  lines(value: L): void {
    if (this.opened === null || !this.opened.installed) return;
    this.publishLines(value);
  }

  log(line: string): void {
    const said: LogLine = { epoch: this.state.epoch, line };
    for (const subscriber of this.subscribers) subscriber.log(said);
  }

  /**
   * Where a state covering every change so far stands: the one
   * published when it covers them already, else the first read to
   * cover them, once published. A read already under way answers
   * when its cut began late enough. The answer is by revision within
   * the epoch published now; an epoch that changes first answers
   * `StateChanged`, and a read that fails answers with its failure.
   */
  refresh(): Promise<RevisionMarker> {
    const opened = this.opened;
    if (opened === null || !opened.installed || this.covered >= this.changes) return Promise.resolve(markerOf(this.state));
    if (this.failure !== null && this.failure.covered >= this.changes) return Promise.reject(this.failure.error);
    return new Promise((resolve, reject) => {
      this.waiters.push({ target: this.changes, resolve, reject });
      this.schedule();
    });
  }

  private leave(): void {
    const opened = this.opened;
    if (opened === null) return;
    this.opened = null;
    if (!opened.installed) opened.reject(new Error("another state took the place of the runtime being opened"));
  }

  private schedule(): void {
    if (this.building) return;
    const opened = this.opened;
    if (opened === null) return;
    if (opened.installed && (this.covered >= this.changes || (this.failure !== null && this.failure.covered >= this.changes))) return;
    this.building = true;
    void this.build(opened).finally(() => {
      this.building = false;
      this.schedule();
    });
  }

  private async build(opened: Opened<S>): Promise<void> {
    let covering = this.changes;
    let snapshot: S;
    try {
      snapshot = await opened.source.capture(() => {
        covering = this.changes;
      });
    } catch (error) {
      if (this.opened !== opened) return;
      if (!opened.installed) {
        this.opened = null;
        opened.reject(error);
        return;
      }
      this.failure = { covered: covering, error };
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
      this.options.failed(error);
      return;
    }
    if (this.opened !== opened) return;
    const value: StateValueOf<S> = { phase: "open", hold: opened.hold, snapshot };
    if (opened.installed) this.publishState(value);
    else {
      opened.installed = true;
      this.renew(value);
      opened.resolve();
    }
    this.covered = covering;
    this.failure = null;
    this.answer();
  }

  private answer(): void {
    const marker = markerOf(this.state);
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.target > this.covered) return true;
      waiter.resolve(marker);
      return false;
    });
  }

  private renew(value: StateValueOf<S>): void {
    const epoch = freshEpoch();
    this.state = { epoch, revision: 1, value };
    this.linesState = { epoch, revision: 1, value: this.options.noLines };
    for (const waiter of this.waiters.splice(0)) waiter.reject(new StateChanged());
    for (const subscriber of this.subscribers) subscriber.state(this.state);
    for (const subscriber of this.subscribers) subscriber.lines(this.linesState);
  }

  private publishState(value: StateValueOf<S>): void {
    if (this.state.revision >= this.maxRevision) return this.renew(value);
    this.state = { epoch: this.state.epoch, revision: this.state.revision + 1, value };
    for (const subscriber of this.subscribers) subscriber.state(this.state);
  }

  private publishLines(value: L): void {
    if (this.linesState.revision >= this.maxRevision) this.renew(this.state.value);
    this.linesState = { epoch: this.state.epoch, revision: this.linesState.revision + 1, value };
    for (const subscriber of this.subscribers) subscriber.lines(this.linesState);
  }
}
