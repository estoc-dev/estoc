/**
 * The event store as a map in memory: the reference for the interface's
 * semantics, what the vault folds are tested on, and the store `eventStoreSuite` is
 * first run against. Nothing persists, so the process-durable half of the store's
 * promise is vacuous here; `damaged()` is empty by construction, as a sound
 * database's is. Every event held — appended or ingested — is kept in the form
 * its canonical bytes parse to, under the CID those bytes hash to, and frozen, so
 * what is handed out is what was accepted, the same from every store.
 */

import { v7 } from "uuid";

import { BadToken, ForkedAuthor } from "./errors.js";
import {
  canonicalEnvelope,
  checkFilter,
  compareEvents,
  matches,
  readIngestInput,
  sampleAt,
  validateDraft,
  type AuthorId,
  type CanonicalEvent,
  type ChangeToken,
  type Damaged,
  type Draft,
  type Event,
  type EventCid,
  type EventStore,
  type EventTally,
  type Filter,
  type Ingested,
} from "./event.js";
import { deepFreeze, type JsonObject } from "./json.js";

export interface MemoryEventStoreOptions {
  /** the author this store appends as; a fresh UUIDv7 when left out */
  author?: AuthorId;
  /** the wall clock in Unix milliseconds; default `Date.now`, pinned by tests */
  now?: () => number;
}

export class MemoryEventStore implements EventStore {
  readonly author: AuthorId;
  /** the store generation its tokens name: this instance, and no other, so minted here and never given */
  readonly generation: string;
  private readonly now: () => number;
  /** every event held, by CID */
  private readonly held = new Map<EventCid, Event>();
  /** the same events in the order they were accepted; an index into it is what a token names */
  private readonly accepted: Event[] = [];
  /** the length of every held canonical byte string, summed as each is accepted: what `tally` reports without encoding one */
  private bytes = 0;
  /** writes run one at a time: the vault's writer lock, as far as one store in memory needs it */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryEventStoreOptions = {}) {
    this.author = options.author ?? (v7() as AuthorId);
    this.generation = v7();
    this.now = options.now ?? Date.now;
  }

  private serialise<T>(work: () => T): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async append<D extends JsonObject>(draft: Draft<D>): Promise<Event<D>> {
    const [event] = await this.appendAll([draft]);
    return event as Event<D>;
  }

  /**
   * `drafts` appended as one batch; `publish`, when given, runs in the
   * same synchronous step, after the batch is hashed and classified and
   * before any of it is accepted, with how many events are new: what it
   * lands and the events land together. A throw from the clock, the
   * hashing or `publish` accepts no event, and undoes nothing `publish`
   * did before throwing — so `publish` must finish synchronously and
   * leave nothing visible when it throws. How the vault in memory
   * publishes a commit's objects with its events.
   */
  async appendAll<D extends JsonObject>(drafts: Draft<D>[], publish?: (adding: number) => void): Promise<Event<D>[]> {
    const clean = Array.from(drafts, (draft) => validateDraft(draft)); // every index visited, a hole refused as a draft that is not an object
    if (clean.length === 0 && publish === undefined) return [];
    return this.serialise(() => {
      const { at } = sampleAt(this.now);
      const staged = new Map<EventCid, { event: Event; bytes: number }>();
      const out = clean.map((draft) => {
        const { event, bytes } = canonicalEnvelope({ at, author: this.author, type: draft.type, roots: draft.roots, data: draft.data });
        const have = this.held.get(event.cid) ?? staged.get(event.cid)?.event;
        if (have !== undefined) return have;
        staged.set(event.cid, { event, bytes: bytes.length });
        return event;
      });
      publish?.(staged.size);
      for (const { event, bytes } of staged.values()) this.accept(event, bytes);
      return out as Event<D>[];
    });
  }

  /** Add an event this store does not hold: it is frozen and, from here on, what `scan` hands out. */
  private accept(event: Event, bytes: number): void {
    deepFreeze(event);
    this.held.set(event.cid, event);
    this.accepted.push(event);
    this.bytes += bytes;
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    // Validation, canonical form and the CID check are the input's own and need no lock.
    const input = await readIngestInput(events);
    return { ...(await this.ingestCanonical(input.events)), rejected: input.rejected };
  }

  /**
   * Events already in canonical form, ingested: under the writer lock,
   * each is classified against what is held — duplicate or new — in
   * input order, the fork check made, and only then the new accepted; so
   * the outcome names what was actually held when the decision was made,
   * and a write that landed while the input was still being read is
   * seen. `publish`, when given, runs once the input is classified and
   * the fork check has passed, in the same synchronous step that accepts
   * the new events, with how many there are: what it publishes lands
   * with them, and a throw from it accepts none. How the vault in memory
   * publishes an ingest's objects with its events.
   */
  async ingestCanonical(events: readonly CanonicalEvent[], publish?: (adding: number) => void): Promise<Ingested> {
    return this.serialise(() => {
      const outcome: Ingested = { added: 0, duplicates: 0, rejected: [] };
      const staged = new Map<EventCid, CanonicalEvent>();
      const forked: Event[] = [];
      for (const incoming of events) {
        if (this.held.has(incoming.event.cid) || staged.has(incoming.event.cid)) {
          outcome.duplicates += 1;
          continue;
        }
        if (incoming.event.author === this.author) {
          forked.push(incoming.event);
          continue;
        }
        staged.set(incoming.event.cid, incoming);
      }
      if (forked.length > 0) throw new ForkedAuthor(this.author, forked);
      publish?.(staged.size);
      for (const { event, bytes } of staged.values()) {
        this.accept(event, bytes.length);
        outcome.added += 1;
      }
      return outcome;
    });
  }

  async *scan(filter?: Filter): AsyncIterable<Event> {
    checkFilter(filter);
    // The store sorts, over a snapshot: a write during the walk is not yielded.
    const events = [...this.held.values()].sort(compareEvents);
    for (const event of events) {
      if (matches(event, filter)) yield event;
    }
  }

  async changes(filter?: Filter, since?: ChangeToken): Promise<{ token: ChangeToken; events: AsyncIterable<Event> }> {
    checkFilter(filter);
    const to = this.accepted.length;
    const from = since === undefined ? 0 : this.place(since);
    const events = this.accepted.slice(from, to).filter((event) => matches(event, filter));
    return { token: this.token(to), events: iterate(events) };
  }

  /** The frontier at `seq`: this generation, the position, and the CID accepted last before it, which names the event set. */
  private token(seq: number): ChangeToken {
    return JSON.stringify({ generation: this.generation, seq, last: seq === 0 ? null : this.accepted[seq - 1]?.cid });
  }

  /** The position a token names, or a throw: another generation's, malformed, past what is held, or of another event set. */
  private place(token: ChangeToken): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(token);
    } catch {
      throw new BadToken("not a token of this store");
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { generation?: unknown }).generation !== this.generation) {
      throw new BadToken("not a token of this store generation");
    }
    const seq = (parsed as { seq?: unknown }).seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > this.accepted.length) {
      throw new BadToken("token names a position this store does not hold");
    }
    const last = (parsed as { last?: unknown }).last;
    if (last !== (seq === 0 ? null : this.accepted[seq - 1]?.cid)) {
      throw new BadToken("token names an event set this store does not hold");
    }
    return seq;
  }

  async damaged(): Promise<Damaged[]> {
    return [];
  }

  async tally(): Promise<EventTally> {
    return { events: this.held.size, bytes: this.bytes, lastSeq: this.accepted.length };
  }
}

async function* iterate<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
