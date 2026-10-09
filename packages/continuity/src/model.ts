/**
 * The continuity model over a set of facts, derived in the order the
 * evidence depends on itself. First the facts are accepted: each one
 * validated, an exact repeat kept once, a second value under one key
 * refused. Then every fact's reference is resolved: a missing one stays
 * unresolved. Then the positive closure: every peer rotation, every
 * local rotation whose predecessor address an observation confirms in
 * the graph built without it, and every join they imply, all branches
 * kept. Then contexts and conflicts over that whole graph: competing
 * changes of one endpoint in one context, cycles, joins that would pair
 * a DID with itself. Only then usable continuity: the same closure
 * again, admitting no channel a conflict reaches. The positive graph
 * says what replacements the evidence shows; the usable graph says
 * which of them an operation may rely on. Nothing here reads arrival
 * order or time.
 */

import { InvalidFact } from "./errors.js";
import { canonicalFact, changeKey, channelKey, channelOf, compareChannels, compareKeys, compareUtf8, factKey, keyText, referenceOf, sortedChannels, sortedKeys, successorChannel, validateFact, type KeyText } from "./facts.js";
import { closure, Contexts, Graph, type Edge, type Link, type Replaces } from "./graph.js";
import type { Change, Channel, ContinuityFact, Did, FactKey, PeerTransition, LocalDecision } from "./types.js";

/** Which endpoint a change replaces: `peer` for the peer's rotation or ending, `local` for ours. */
export type Side = Replaces;

/**
 * A contradiction in the evidence, with its scope: the channels it masks
 * directly, which no usable link enters or leaves. A query that depends
 * on them may answer `conflict` as well.
 */
export type Conflict =
  /** two different changes of one endpoint claimed in one context, a saved decision counted whether or not it is confirmed yet; the scope is the context and the successor pairs its claims name */
  | { kind: "competing-changes"; side: Side; context: readonly Channel[]; changes: readonly { change: Change; facts: readonly FactKey[] }[]; scope: readonly Channel[] }
  /** links that lead back to a pair they left; the scope is those pairs */
  | { kind: "cycle"; channels: readonly Channel[]; facts: readonly FactKey[]; scope: readonly Channel[] }
  /** a join that would pair a DID with itself; the scope is the pair and its two successor pairs */
  | { kind: "identity-collision"; channels: readonly Channel[]; facts: readonly FactKey[]; scope: readonly Channel[] };

/**
 * The answer to `head`, in the order the variants take precedence: a
 * conflict reaching the pair outranks an ending, an ending outranks
 * choices still waiting, and only then is a unique usable forward pair
 * the head. A known forward change without usable continuation never
 * falls back to the old pair.
 */
export type HeadResult =
  /** the unique pair the usable forward links lead to, the queried pair itself when none leads away; `support` re-derives those links */
  | { status: "head"; channel: Channel; support: readonly FactKey[] }
  /** an ending of either side applies to the pair through usable links */
  | { status: "ended"; endings: readonly FactKey[] }
  /** saved rotations of the endpoint are not established yet: `waiting` names them, `missing` the exact references they need that are not here */
  | { status: "unresolved"; waiting: readonly FactKey[]; missing: readonly FactKey[] }
  /** a conflict reaches the pair, or a claim reaches it only through history no usable link vouches for; `facts` are the claims involved */
  | { status: "conflict"; facts: readonly FactKey[] }
  /** no fact mentions the pair, not even as a successor */
  | { status: "no-evidence" };

/** What a fact contributes to the facts derived over; a change record and an ending record carry it beside the fact. */
export type FactStatus =
  /** no fact has this key */
  | { status: "unknown" }
  /** the exact reference it names is of the wrong pair, so it can never link */
  | { status: "invalid"; because: string }
  /** an exact reference it names is not here; another replica may supply it */
  | { status: "unresolved"; missing: readonly FactKey[] }
  /** its pair, its successor pair or a reference it names is in conflict */
  | { status: "conflict"; facts: readonly FactKey[]; because: string }
  /** a rotation whose required confirmation of the predecessor address is not established: no usable observation, or a named source that does not confirm it */
  | { status: "waiting"; because: string }
  /** it links or witnesses with authority; `support` is the fact and everything its authority rests on */
  | { status: "usable"; support: readonly FactKey[] };

export type PathResult =
  /** one directed usable path, the queried pair first; `support` re-derives every link on it */
  | { status: "path"; channels: readonly Channel[]; support: readonly FactKey[] }
  /** no usable path preserves the roles from one pair to the other */
  | { status: "none" }
  /** a conflict reaches either end */
  | { status: "conflict"; facts: readonly FactKey[] };

/** One observation that confirms the address, with a complete witness: the observation, the transition it carried and the usable peer path to the observer. */
export type Confirmation = { key: FactKey; at: Channel; support: readonly FactKey[] };

export type ConfirmationResult =
  /** the usable observations by which the peer, or a usable successor of it, wrote to exactly this local DID */
  | { status: "confirmed"; observations: readonly Confirmation[] }
  /** no such observation is usable; `unusable` lists the observations to this local DID a usable peer path reaches that are not usable themselves, whatever their status */
  | { status: "unconfirmed"; unusable: readonly FactKey[] }
  /** a conflict reaches the pair */
  | { status: "conflict"; facts: readonly FactKey[] };

/** A rotation or ending as it was claimed, `to` the successor pair it names or null for an ending. */
export type ChangeRecord = { key: FactKey; at: Channel; change: Change; to: Channel | null; status: FactStatus };

/**
 * A link of the positive graph: every rotation the evidence shows, and
 * every join two rotations imply, whether or not an operation may rely
 * on it. `derived` marks a join; `usable` marks a link the usable graph
 * has too.
 */
export type PositiveLink = { from: Channel; to: Channel; replaces: Side; support: readonly FactKey[]; derived: boolean; usable: boolean };

export type EndingRecord = { key: FactKey; at: Channel; side: Side; status: FactStatus };

/**
 * Everything the positive graph connects to a channel, and the two
 * contexts the channel is in: `samePeer`, the pairs local rotations
 * connect, across which a change of the peer applies; `sameLocal`, the
 * pairs peer rotations connect, across which a change of ours applies.
 */
export type History = { links: readonly PositiveLink[]; endings: readonly EndingRecord[]; samePeer: readonly Channel[]; sameLocal: readonly Channel[] };

/**
 * Deterministic queries over one set of facts. Every answer is relative
 * to the facts supplied: the model cannot say that unknown history does
 * not exist, and more facts may expose a conflict that removes an
 * answer given before. Answers preserve support rather than only a
 * verdict: the support re-derives the usable links asserted, or one
 * confirmation, under the same profile. It does not replay the whole
 * answer: an unchanged head or a zero-step path has empty support, and
 * neither establishes an address observation or a rotation; the endings
 * an answer lists are assertions, not the context that scopes them. No
 * support proves the absence of a conflict or a missing reference
 * outside the facts. Nothing here authorizes an operation: whether a
 * head may be written to, or a path admits a message, is the host's
 * decision under its own policy.
 */
export interface Continuity {
  /** the facts as derived over, each key once, by evidence and then by kind */
  readonly facts: readonly ContinuityFact[];
  /**
   * The unique usable pair the forward changes of `channel` lead to.
   * Saved rotations of the endpoint anywhere in the pair's positive
   * context are answered for: one the same usable change covers is
   * provenance, one at a pair usable links connect is `unresolved`, and
   * one only diagnostic history connects is `conflict`. A waiting claim,
   * or a link the usable graph lacks, of a change usable links make
   * anyway in that context does not block the head.
   */
  head(channel: Channel): HeadResult;
  /** the changes of that side's endpoint across the channel's context, whatever their status; a supersession check reads these */
  changes(channel: Channel, side: Side): readonly ChangeRecord[];
  /** one directed usable path from one pair to the other, preserving roles; alternative paths are not enumerated */
  path(from: Channel, to: Channel): PathResult;
  /**
   * Whether the peer, or a usable successor of it, has written to
   * exactly this local DID. Each observation comes with one complete
   * witness; alternative paths to the same observation are not
   * enumerated. Confirms nothing about any other local address.
   */
  confirmation(localDid: Did, peerDid: Did): ConfirmationResult;
  /** every positive link connected to the channel, the endings in its contexts and the contexts themselves; connectivity here is history, not current usability */
  history(channel: Channel): History;
  /**
   * Every saved decision rotating away from the channel's local DID, or
   * ending there, across its same-local context. Only decisions among
   * the facts: a saved choice the host has not projected yet is
   * invisible here, so an empty answer alone does not clear allocating a
   * successor.
   */
  localDecisions(channel: Channel): readonly ChangeRecord[];
  /** every conflict with its scope; none is resolved and no history is dropped */
  conflicts(): readonly Conflict[];
  status(key: FactKey): FactStatus;
}

/** Throws `InvalidFact` for a fact the profile refuses, or for two values under one key. */
export function deriveContinuity(facts: readonly ContinuityFact[]): Continuity {
  return new Model(facts);
}

/**
 * The facts validated and keyed, in canonical order. A repeat of the
 * same value is kept once, since projecting one piece of evidence again
 * is ordinary; a second value under a key is refused, since one receipt
 * or one saved decision says one thing. So the result is the same
 * whatever order and repetition the facts came in.
 */
function accept(facts: readonly unknown[]): Map<KeyText, ContinuityFact> {
  const accepted = new Map<KeyText, ContinuityFact>();
  facts.forEach((value, index) => {
    const where = `facts[${index}]`;
    const fact = validateFact(value, where);
    const key = keyText(fact);
    const held = accepted.get(key);
    if (held === undefined) accepted.set(key, fact);
    else if (canonicalFact(held) !== canonicalFact(fact)) throw new InvalidFact(`${where}: the ${fact.kind} of ${JSON.stringify(fact.evidence)} already has another value`);
  });
  return new Map([...accepted].sort(([, a], [, b]) => compareKeys(a, b)));
}

type Standing = { kind: "ok" } | { kind: "missing"; key: FactKey } | { kind: "invalid"; because: string };

interface Entry {
  readonly fact: ContinuityFact;
  standing: Standing;
}

type KnownStatus = Exclude<FactStatus, { status: "unknown" }>;

type Writers = Map<Did, Map<Did, Entry[]>>;

type Candidate = Link & { readonly entry: Entry };

const EVERY_CHANNEL = () => true;

class Model implements Continuity {
  readonly facts: readonly ContinuityFact[];
  /** in canonical order */
  private readonly entries = new Map<KeyText, Entry>();
  private readonly entriesAt = new Map<string, Entry[]>();
  private readonly endings: Entry[] = [];
  private readonly positive: Graph;
  private readonly positiveWaiting: ReadonlySet<KeyText>;
  private readonly samePeer: Contexts;
  private readonly sameLocal: Contexts;
  /** the saved local rotations by the root of their positive same-local context: the onward choices a head in that context must answer for */
  private readonly rotationsByContext = new Map<string, { entry: Entry; successor: Did }[]>();
  private readonly conflictList: readonly Conflict[];
  /** by channel key, the facts of every conflict whose scope reaches the channel */
  private readonly conflictsAt = new Map<string, KeyText[]>();
  private readonly usable: Graph;
  private readonly usableAdmitted: ReadonlyMap<KeyText, readonly KeyText[]>;
  private readonly usableWriters: Writers;
  private readonly usableSamePeer: Contexts;
  private readonly usableSameLocal: Contexts;
  /** the usable links by the side they replace and the successor DID, for finding the same change made at another pair of a context */
  private readonly usableChanges = new Map<string, Edge[]>();

  constructor(facts: readonly ContinuityFact[]) {
    for (const [key, fact] of accept(facts)) this.entries.set(key, { fact, standing: { kind: "ok" } });
    this.facts = [...this.entries.values()].map((entry) => entry.fact);
    for (const entry of this.entries.values()) {
      entry.standing = this.standingOf(entry.fact);
      const key = channelKey(entry.fact.at);
      let at = this.entriesAt.get(key);
      if (at === undefined) this.entriesAt.set(key, (at = []));
      at.push(entry);
      if (entry.fact.kind !== "address-observed" && entry.fact.change.kind === "end") this.endings.push(entry);
    }

    const positiveWriters = this.writersOf((entry) => this.positiveObservation(entry));
    const positive = closure(
      this.peerLinks(() => true),
      this.candidates((entry) => entry.standing.kind === "ok"),
      EVERY_CHANNEL,
      (graph, link) => this.confirming(graph, link, positiveWriters, (entry) => this.positiveObservation(entry))
    );
    this.positive = positive.graph;
    this.positiveWaiting = new Set([...positive.waiting].map((link) => link.key));
    for (const entry of this.entries.values()) this.positive.vertex(entry.fact.at);
    this.samePeer = new Contexts(this.positive, "local");
    this.sameLocal = new Contexts(this.positive, "peer");
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "local-decision" || entry.fact.change.kind !== "rotate") continue;
      const root = this.sameLocal.root(channelKey(entry.fact.at));
      let rotations = this.rotationsByContext.get(root);
      if (rotations === undefined) this.rotationsByContext.set(root, (rotations = []));
      rotations.push({ entry, successor: entry.fact.change.successor });
    }
    this.conflictList = this.findConflicts();
    for (const conflict of this.conflictList) {
      const facts = factsOf(conflict).map(keyText);
      for (const channel of conflict.scope) {
        const key = channelKey(channel);
        let list = this.conflictsAt.get(key);
        if (list === undefined) this.conflictsAt.set(key, (list = []));
        list.push(...facts);
      }
    }

    this.usableWriters = this.writersOf((entry) => this.usableObservation(entry));
    const usable = closure(
      this.peerLinks((entry) => this.usableTransition(entry)),
      this.candidates((entry) => this.usableCandidate(entry)),
      (channel) => !this.affected(channel),
      (graph, link) => this.confirming(graph, link, this.usableWriters, (entry) => this.usableObservation(entry))
    );
    this.usable = usable.graph;
    this.usableAdmitted = new Map([...usable.admitted].map(([link, support]) => [link.key, support]));
    this.usableSamePeer = new Contexts(this.usable, "local");
    this.usableSameLocal = new Contexts(this.usable, "peer");
    for (const edge of this.usable.edges()) {
      const key = changeIndexKey(edge.replaces, edge.replaces === "local" ? edge.to.localDid : edge.to.peerDid);
      let edges = this.usableChanges.get(key);
      if (edges === undefined) this.usableChanges.set(key, (edges = []));
      edges.push(edge);
    }
  }

  private standingOf(fact: ContinuityFact): Standing {
    const reference = referenceOf(fact);
    if (reference === null) return { kind: "ok" };
    const target = this.entries.get(keyText(reference))?.fact;
    if (target === undefined) return { kind: "missing", key: reference };
    const invalid = (because: string): Standing => ({ kind: "invalid", because });
    if (target.kind === "address-observed" && target.at.localDid !== fact.at.localDid) return invalid(`its source ${reference.evidence} is addressed to ${target.at.localDid}, not to ${fact.at.localDid}`);
    if (target.kind === "peer-transition") {
      if (target.change.kind !== "rotate") return invalid("the transition its receipt carried is an ending, which observes no address");
      if (target.at.localDid !== fact.at.localDid) return invalid(`the transition its receipt carried was received by ${target.at.localDid}, not by ${fact.at.localDid}`);
      if (target.change.successor !== fact.at.peerDid) return invalid(`the transition its receipt carried names the successor ${target.change.successor}, not ${fact.at.peerDid}`);
    }
    return { kind: "ok" };
  }

  /** The entry a fact's reference names; undefined when it names none, or names one that is not here. */
  private referenced(entry: Entry): Entry | undefined {
    const reference = referenceOf(entry.fact);
    return reference === null ? undefined : this.entries.get(keyText(reference));
  }

  private peerLinks(admits: (entry: Entry) => boolean): Link[] {
    const links: Link[] = [];
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "peer-transition" || entry.fact.change.kind !== "rotate" || !admits(entry)) continue;
      links.push({ key: keyText(entry.fact), from: entry.fact.at, to: successorChannel(entry.fact)! });
    }
    return links;
  }

  private candidates(admits: (entry: Entry) => boolean): Candidate[] {
    const links: Candidate[] = [];
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "local-decision" || entry.fact.change.kind !== "rotate" || !admits(entry)) continue;
      links.push({ key: keyText(entry.fact), from: entry.fact.at, to: successorChannel(entry.fact)!, entry });
    }
    return links;
  }

  /** By local DID, then by peer DID, the observations `admits` of the peer writing to exactly that local DID. */
  private writersOf(admits: (entry: Entry) => boolean): Writers {
    const writers: Writers = new Map();
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "address-observed" || !admits(entry)) continue;
      let peers = writers.get(entry.fact.at.localDid);
      if (peers === undefined) writers.set(entry.fact.at.localDid, (peers = new Map()));
      let observations = peers.get(entry.fact.at.peerDid);
      if (observations === undefined) peers.set(entry.fact.at.peerDid, (observations = []));
      observations.push(entry);
    }
    return writers;
  }

  /** An observation that stands on its own: its carried transition, when it has one, here and consistent with it. */
  private positiveObservation(entry: Entry): boolean {
    return entry.fact.kind === "address-observed" && entry.standing.kind === "ok";
  }

  private usableTransition(entry: Entry): boolean {
    if (entry.fact.kind !== "peer-transition") return false;
    const to = successorChannel(entry.fact);
    return !this.affected(entry.fact.at) && (to === null || !this.affected(to));
  }

  private usableObservation(entry: Entry): boolean {
    if (!this.positiveObservation(entry) || this.affected(entry.fact.at)) return false;
    const carried = this.referenced(entry);
    return carried === undefined || this.usableTransition(carried);
  }

  private usableCandidate(entry: Entry): boolean {
    if (entry.fact.kind !== "local-decision" || entry.standing.kind !== "ok") return false;
    const to = successorChannel(entry.fact);
    if (this.affected(entry.fact.at) || (to !== null && this.affected(to))) return false;
    const source = this.referenced(entry);
    return source === undefined || this.usableObservation(source);
  }

  /**
   * What confirms a candidate's predecessor address in the graph so far:
   * the exact source it names, when that observation is of the peer or
   * of a peer a path of peer rotations from the predecessor reaches;
   * otherwise any admitted observation addressed to the predecessor by
   * such a peer. The support names the observation, the transition it
   * carried and the path to its peer, so that the support alone
   * re-derives the confirmation.
   */
  private confirming(graph: Graph, link: Candidate, writers: Writers, admits: (entry: Entry) => boolean): readonly KeyText[] | null {
    const reach = graph.reach(link.from, "peer");
    const witness = (observation: Entry, via: readonly Edge[]) => {
      const carried = referenceOf(observation.fact);
      return [keyText(observation.fact), ...(carried === null ? [] : [keyText(carried)]), ...via.flatMap((edge) => [...edge.support])];
    };
    const source = this.referenced(link.entry);
    if (source !== undefined) {
      if (!admits(source)) return null;
      const via = reach.pathTo(source.fact.at);
      return via === undefined ? null : witness(source, via);
    }
    const peers = writers.get(link.from.localDid);
    if (peers === undefined) return null;
    const support: KeyText[] = [];
    for (const channel of reach.channels()) {
      const observations = peers.get(channel.peerDid);
      if (observations === undefined) continue;
      const via = reach.pathTo(channel)!;
      for (const observation of observations) support.push(...witness(observation, via));
    }
    return support.length === 0 ? null : support;
  }

  private affected(channel: Channel): boolean {
    return this.conflictsAt.has(channelKey(channel));
  }

  /** The positive contexts a change of `side` applies across: a peer change keeps the peer, a local one keeps the local DID. */
  private contextsOf(side: Side): Contexts {
    return side === "peer" ? this.samePeer : this.sameLocal;
  }

  /** The context of a change of `side` at `channel` as usable links connect it: the pairs the change applies to with authority. */
  private usableContextRoot(channel: Channel, side: Side): string {
    return (side === "peer" ? this.usableSamePeer : this.usableSameLocal).root(channelKey(channel));
  }

  private usablyEstablished(side: Side, at: Channel, successor: Did): boolean {
    const root = this.usableContextRoot(at, side);
    for (const edge of this.usableChanges.get(changeIndexKey(side, successor)) ?? []) if (this.usableContextRoot(edge.from, side) === root) return true;
    return false;
  }

  private contextOf(channel: Channel, side: Side): Channel[] {
    const contexts = this.contextsOf(side);
    const root = contexts.root(channelKey(channel));
    const members: Channel[] = [channel];
    for (const [key, vertex] of this.positive.vertices) if (contexts.root(key) === root) members.push(vertex);
    return sortedChannels(members);
  }

  /**
   * Competing changes of one endpoint in one context: the peer's across
   * the same-peer context, ours across the same-local one, every fact
   * counted whatever its status, since a saved decision not yet
   * confirmed is still a fork. Then cycles and refused joins.
   */
  private findConflicts(): Conflict[] {
    const found: Conflict[] = [];
    const competing = (side: Side) => {
      const kind = side === "peer" ? "peer-transition" : "local-decision";
      const contexts = this.contextsOf(side);
      const byContext = new Map<string, { channel: Channel; successors: Channel[]; changes: Map<string, { change: Change; facts: KeyText[] }> }>();
      for (const entry of this.entries.values()) {
        if (entry.fact.kind !== kind) continue;
        const root = contexts.root(channelKey(entry.fact.at));
        let group = byContext.get(root);
        if (group === undefined) byContext.set(root, (group = { channel: entry.fact.at, successors: [], changes: new Map() }));
        const key = changeKey(entry.fact.change);
        let change = group.changes.get(key);
        if (change === undefined) group.changes.set(key, (change = { change: entry.fact.change, facts: [] }));
        change.facts.push(keyText(entry.fact));
        const to = successorChannel(entry.fact);
        if (to !== null) group.successors.push(to);
      }
      for (const { channel, successors, changes } of byContext.values()) {
        if (changes.size < 2) continue;
        const listed = [...changes.values()].map(({ change, facts }) => ({ change, facts: sortedKeys(facts) })).sort((a, b) => compareUtf8(changeKey(a.change), changeKey(b.change)));
        const context = this.contextOf(channel, side);
        found.push({ kind: "competing-changes", side, context, changes: listed, scope: sortedChannels([...context, ...successors]) });
      }
    };
    competing("peer");
    competing("local");
    for (const channels of this.positive.cycles()) {
      const members = new Set(channels.map(channelKey));
      const facts: KeyText[] = [];
      for (const channel of channels) for (const edge of this.positive.from(channel)) if (members.has(channelKey(edge.to))) facts.push(...edge.support);
      found.push({ kind: "cycle", channels, facts: sortedKeys(facts), scope: channels });
    }
    for (const { channels, support } of this.positive.identityCollisions.values()) found.push({ kind: "identity-collision", channels, facts: sortedKeys(support), scope: sortedChannels(channels) });
    return found.sort((a, b) => compareUtf8(a.kind, b.kind) || compareChannels(firstChannelOf(a), firstChannelOf(b)));
  }

  private conflictFactsAt(channel: Channel): readonly KeyText[] {
    return this.conflictsAt.get(channelKey(channel)) ?? [];
  }

  private endingsAt(channel: Channel, side: Side): Entry[] {
    const kind = side === "peer" ? "peer-transition" : "local-decision";
    const contexts = this.contextsOf(side);
    const root = contexts.root(channelKey(channel));
    return this.endings.filter((entry) => entry.fact.kind === kind && contexts.root(channelKey(entry.fact.at)) === root);
  }

  private known(channel: Channel): boolean {
    return this.positive.vertices.has(channelKey(channel));
  }

  /**
   * A local rotation without usable continuation, diagnosed as the fact
   * query diagnoses it, so that a missing or conflicted reference
   * anywhere along the exact chain it names, an observation's carried
   * transition included, reaches the head the same way it reaches the
   * fact's status.
   */
  private pendingDecision(entry: Entry, conflict: Set<KeyText>, waiting: Set<KeyText>, missing: Set<KeyText>): void {
    const status = this.statusOf(entry);
    switch (status.status) {
      case "conflict":
        for (const key of status.facts) conflict.add(keyText(key));
        return;
      case "unresolved":
        waiting.add(keyText(entry.fact));
        for (const key of status.missing) missing.add(keyText(key));
        return;
      case "waiting":
      case "invalid":
        waiting.add(keyText(entry.fact));
        return;
      case "usable":
        return;
    }
  }

  /** A pair some fact is at, or a usable link leads to; one only conflicted links lead to rests on the conflict. */
  private established(channel: Channel): boolean {
    if (this.entriesAt.has(channelKey(channel))) return true;
    for (const _ of this.usable.to(channel)) return true;
    return false;
  }

  /**
   * A pair that only a conflicted link leads to is in that conflict. A
   * branch that only provenance leads to either rejoins the usable
   * history through the joins it implies, or is a branch of its own and
   * is reported as such.
   */
  head(channel: Channel): HeadResult {
    const conflict = new Set<KeyText>();
    const waiting = new Set<KeyText>();
    const missing = new Set<KeyText>();
    if (!this.known(channel)) {
      for (const key of this.conflictFactsAt(channel)) conflict.add(key);
      if (conflict.size > 0) return { status: "conflict", facts: sortedKeys(conflict) };
      for (const entry of this.entries.values()) {
        if (entry.fact.kind !== "local-decision" || entry.fact.change.kind !== "rotate") continue;
        if (channelKey(successorChannel(entry.fact)!) === channelKey(channel)) this.pendingDecision(entry, conflict, waiting, missing);
      }
      if (conflict.size > 0) return { status: "conflict", facts: sortedKeys(conflict) };
      if (waiting.size > 0) return { status: "unresolved", waiting: sortedKeys(waiting), missing: sortedKeys(missing) };
      return { status: "no-evidence" };
    }
    const reach = this.positive.reach(channel, "any");
    for (const current of reach.channels()) for (const key of this.conflictFactsAt(current)) conflict.add(key);
    if (!this.established(channel)) for (const edge of this.positive.to(channel)) for (const key of edge.support) conflict.add(key);
    if (conflict.size > 0) return { status: "conflict", facts: sortedKeys(conflict) };
    const endings = new Set<KeyText>();
    const support = new Set<KeyText>();
    const usableReach = this.usable.reach(channel, "any");
    for (const current of reach.channels()) {
      if (!usableReach.has(current)) {
        if (!this.positive.hasOutgoing(current)) for (const edge of this.positive.to(current)) for (const key of edge.support) conflict.add(key);
        continue;
      }
      for (const edge of this.positive.from(current)) {
        const usable = this.usable.edge(edge.from, edge.to);
        if (usable !== undefined) for (const key of usable.support) support.add(key);
        else if (!this.usablyEstablished(edge.replaces, current, edge.replaces === "local" ? edge.to.localDid : edge.to.peerDid)) for (const key of edge.support) conflict.add(key);
      }
      for (const side of ["peer", "local"] as const) {
        const found = this.endingsAt(current, side);
        const root = this.usableContextRoot(current, side);
        const affirmative = found.filter((entry) => this.usableContextRoot(entry.fact.at, side) === root);
        for (const entry of affirmative) endings.add(keyText(entry.fact));
        if (affirmative.length === 0) for (const entry of found) conflict.add(keyText(entry.fact));
      }
      const usableRoot = this.usableContextRoot(current, "local");
      for (const { entry, successor } of this.rotationsByContext.get(this.sameLocal.root(channelKey(current))) ?? []) {
        if (this.usablyEstablished("local", current, successor)) continue;
        if (this.usableContextRoot(entry.fact.at, "local") === usableRoot) this.pendingDecision(entry, conflict, waiting, missing);
        else conflict.add(keyText(entry.fact));
      }
    }
    if (conflict.size > 0) return { status: "conflict", facts: sortedKeys(conflict) };
    if (endings.size > 0) return { status: "ended", endings: sortedKeys(endings) };
    if (waiting.size > 0) return { status: "unresolved", waiting: sortedKeys(waiting), missing: sortedKeys(missing) };
    const ends = [...usableReach.channels()].filter((current) => !this.usable.hasOutgoing(current));
    if (ends.length !== 1) return { status: "conflict", facts: sortedKeys(support) };
    return { status: "head", channel: ends[0]!, support: sortedKeys(support) };
  }

  changes(channel: Channel, side: Side): readonly ChangeRecord[] {
    const kind = side === "peer" ? "peer-transition" : "local-decision";
    const contexts = this.contextsOf(side);
    const root = contexts.root(channelKey(channel));
    const records: ChangeRecord[] = [];
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== kind || contexts.root(channelKey(entry.fact.at)) !== root) continue;
      records.push(this.record(entry));
    }
    return records;
  }

  private record(entry: Entry): ChangeRecord {
    const fact = entry.fact as PeerTransition | LocalDecision;
    return { key: factKey(fact), at: fact.at, change: fact.change, to: successorChannel(fact), status: this.statusOf(entry) };
  }

  path(from: Channel, to: Channel): PathResult {
    const conflict = [...this.conflictFactsAt(from), ...this.conflictFactsAt(to)];
    if (conflict.length > 0) return { status: "conflict", facts: sortedKeys(conflict) };
    if (!this.known(from)) return { status: "none" };
    const edges = this.usable.path(from, to);
    if (edges === null) return { status: "none" };
    return { status: "path", channels: [from, ...edges.map((edge) => edge.to)], support: sortedKeys(edges.flatMap((edge) => [...edge.support])) };
  }

  confirmation(localDid: Did, peerDid: Did): ConfirmationResult {
    const channel = channelOf(localDid, peerDid);
    const conflict = this.conflictFactsAt(channel);
    if (conflict.length > 0) return { status: "conflict", facts: sortedKeys(conflict) };
    const observations: Confirmation[] = [];
    const unusable: KeyText[] = [];
    const reach = localDid === peerDid ? null : this.usable.reach(channel, "peer");
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "address-observed" || entry.fact.at.localDid !== localDid) continue;
      const via = reach?.pathTo(entry.fact.at);
      if (via === undefined) continue;
      if (!this.usableObservation(entry)) {
        unusable.push(keyText(entry.fact));
        continue;
      }
      const carried = referenceOf(entry.fact);
      observations.push({ key: factKey(entry.fact), at: entry.fact.at, support: sortedKeys([keyText(entry.fact), ...(carried === null ? [] : [keyText(carried)]), ...via.flatMap((edge) => [...edge.support])]) });
    }
    if (observations.length > 0) return { status: "confirmed", observations };
    return { status: "unconfirmed", unusable: sortedKeys(unusable) };
  }

  history(channel: Channel): History {
    const component = new Set<string>([channelKey(channel)]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const edge of this.positive.edges()) {
        const fromIn = component.has(channelKey(edge.from));
        const toIn = component.has(channelKey(edge.to));
        if (fromIn === toIn) continue;
        component.add(fromIn ? channelKey(edge.to) : channelKey(edge.from));
        grew = true;
      }
    }
    const links: PositiveLink[] = [];
    for (const edge of this.positive.edges()) {
      if (!component.has(channelKey(edge.from))) continue;
      links.push(this.link(edge));
    }
    const endings: EndingRecord[] = [];
    for (const side of ["peer", "local"] as const) for (const entry of this.endingsAt(channel, side)) endings.push({ key: factKey(entry.fact), at: entry.fact.at, side, status: this.statusOf(entry) });
    return {
      links: links.sort((a, b) => compareChannels(a.from, b.from) || compareChannels(a.to, b.to)),
      endings: endings.sort((a, b) => compareKeys(a.key, b.key)),
      samePeer: this.contextOf(channel, "peer"),
      sameLocal: this.contextOf(channel, "local"),
    };
  }

  private link(edge: Edge): PositiveLink {
    return { from: edge.from, to: edge.to, replaces: edge.replaces, support: sortedKeys(edge.support), derived: edge.derived, usable: this.usable.edge(edge.from, edge.to) !== undefined };
  }

  localDecisions(channel: Channel): readonly ChangeRecord[] {
    return this.changes(channel, "local").filter((record) => record.at.localDid === channel.localDid);
  }

  conflicts(): readonly Conflict[] {
    return this.conflictList;
  }

  status(key: FactKey): FactStatus {
    const entry = this.entries.get(keyText(key));
    return entry === undefined ? { status: "unknown" } : this.statusOf(entry);
  }

  private statusOf({ fact, standing }: Entry): KnownStatus {
    if (standing.kind === "invalid") return { status: "invalid", because: standing.because };
    if (standing.kind === "missing") return { status: "unresolved", missing: [standing.key] };
    const key = keyText(fact);
    const to = fact.kind === "address-observed" ? null : successorChannel(fact);
    const conflict = [...this.conflictFactsAt(fact.at), ...(to === null ? [] : this.conflictFactsAt(to))];
    if (conflict.length > 0) return { status: "conflict", facts: sortedKeys(conflict), because: "its context is in conflict" };
    const reference = referenceOf(fact);
    switch (fact.kind) {
      case "peer-transition":
        return { status: "usable", support: [factKey(fact)] };
      case "local-decision": {
        if (fact.change.kind === "end") return { status: "usable", support: [factKey(fact)] };
        const confirming = this.usableAdmitted.get(key);
        if (confirming !== undefined) return { status: "usable", support: sortedKeys([key, ...confirming]) };
        if (reference !== null) {
          const source = this.status(reference);
          if (source.status === "conflict") return { status: "conflict", facts: source.facts, because: `its source ${reference.evidence} is in conflict` };
          if (source.status === "unresolved") return { status: "unresolved", missing: source.missing };
          if (source.status !== "usable") return { status: "waiting", because: `its source ${reference.evidence} is not usable: ${source.status}` };
          return { status: "waiting", because: `its source ${reference.evidence} is not addressed to the predecessor by its peer or a usable successor of that peer` };
        }
        if (this.positiveWaiting.has(key)) return { status: "waiting", because: "no observation addressed to the predecessor by its peer or a successor of that peer" };
        return { status: "waiting", because: "the predecessor is confirmed only through continuity that is not usable" };
      }
      case "address-observed": {
        if (reference === null) return { status: "usable", support: [factKey(fact)] };
        const carried = this.status(reference);
        if (carried.status !== "usable") return { status: "conflict", facts: carried.status === "conflict" ? carried.facts : [reference], because: `the transition its receipt carried is ${carried.status}` };
        return { status: "usable", support: sortedKeys([key, keyText(reference)]) };
      }
    }
  }
}

function factsOf(conflict: Conflict): readonly FactKey[] {
  return conflict.kind === "competing-changes" ? conflict.changes.flatMap(({ facts }) => facts) : conflict.facts;
}

function changeIndexKey(side: Side, successor: Did): string {
  return `${side}\u0000${successor}`;
}

function firstChannelOf(conflict: Conflict): Channel {
  return conflict.kind === "competing-changes" ? conflict.context[0]! : conflict.channels[0]!;
}
