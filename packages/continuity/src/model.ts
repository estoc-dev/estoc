/**
 * The continuity model over a set of facts, derived in the order the
 * evidence depends on itself. First the facts are accepted: each one
 * validated, and the facts that say the same thing kept once. Then the
 * positive closure: every peer rotation, every local rotation whose
 * predecessor address an observation confirms in the graph built
 * without it, and every join they imply, all branches kept. Then
 * contexts and conflicts over that whole graph: competing changes of
 * one endpoint in one context, cycles, joins that would pair a DID with
 * itself. Only then usable continuity: the same closure again,
 * admitting no channel a conflict reaches. The positive graph says what
 * replacements the evidence shows; the usable graph says which of them
 * an operation may rely on. Nothing here reads arrival order or time.
 */

import { changeKey, channelKey, channelOf, compareChannels, compareUtf8, factIdentity, identityOf, sameChannel, sortedChannels, validateFact, type FactIdentity } from "./facts.js";
import { closure, Contexts, Graph, type Edge, type Link, type Replaces } from "./graph.js";
import type { Change, Channel, ContinuityFact, Did, PeerObservation } from "./types.js";

/** Which endpoint a change replaces: `peer` for the peer's rotation or ending, `local` for ours. */
export type Side = Replaces;

/**
 * A contradiction in the evidence, with its scope: the channels it masks
 * directly, which no usable link enters or leaves. A query that depends
 * on them may answer `conflict` as well.
 */
export type Conflict =
  /** two different changes of one endpoint claimed in one context, a saved decision counted whether or not it is confirmed yet; the scope is the context and the successor pairs its claims name */
  | { kind: "competing-changes"; side: Side; context: readonly Channel[]; changes: readonly { change: Change; facts: readonly ContinuityFact[] }[]; scope: readonly Channel[] }
  /** links that lead back to a pair they left; the scope is those pairs */
  | { kind: "cycle"; channels: readonly Channel[]; facts: readonly ContinuityFact[]; scope: readonly Channel[] }
  /** a join that would pair a DID with itself; the scope is the pair and its two successor pairs */
  | { kind: "identity-collision"; channels: readonly Channel[]; facts: readonly ContinuityFact[]; scope: readonly Channel[] };

/**
 * The answer to `head`, in the order the variants take precedence: a
 * conflict reaching the pair outranks an ending, an ending outranks
 * choices still waiting, and only then is a unique usable forward pair
 * the head. A known forward change without usable continuation never
 * falls back to the old pair.
 */
export type HeadResult =
  /** the unique pair the usable forward links lead to, the queried pair itself when none leads away; `support` re-derives those links */
  | { status: "head"; channel: Channel; support: readonly ContinuityFact[] }
  /** an ending of either side applies to the pair through usable links */
  | { status: "ended"; endings: readonly ContinuityFact[] }
  /** saved rotations of the endpoint whose predecessor address is not confirmed yet */
  | { status: "unresolved"; waiting: readonly ContinuityFact[] }
  /** a conflict reaches the pair, or a claim reaches it only through history no usable link vouches for; `facts` are the claims involved */
  | { status: "conflict"; facts: readonly ContinuityFact[] }
  /** no fact mentions the pair, not even as a successor */
  | { status: "no-evidence" };

/** What a fact contributes to the facts derived over; a change record and an ending record carry it beside the fact. */
export type FactStatus =
  /** the fact is not among those derived over */
  | { status: "unknown" }
  /** a pair the fact is at, or rotates from or to, is in conflict */
  | { status: "conflict"; facts: readonly ContinuityFact[]; because: string }
  /** a local rotation whose predecessor address no usable observation confirms */
  | { status: "waiting"; because: string }
  /** it links or witnesses with authority; `support` is the fact and everything its authority rests on */
  | { status: "usable"; support: readonly ContinuityFact[] };

export type PathResult =
  /** one directed usable path, the queried pair first; `support` re-derives every link on it */
  | { status: "path"; channels: readonly Channel[]; support: readonly ContinuityFact[] }
  /** no usable path preserves the roles from one pair to the other */
  | { status: "none" }
  /** a conflict reaches either end */
  | { status: "conflict"; facts: readonly ContinuityFact[] };

/** One observation that confirms the address, with a complete witness: the observation and the usable peer path to the observer. */
export type Confirmation = { fact: PeerObservation; support: readonly ContinuityFact[] };

export type ConfirmationResult =
  /** the usable observations by which the peer, or a usable successor of it, wrote to exactly this local DID */
  | { status: "confirmed"; observations: readonly Confirmation[] }
  /** no such observation is usable; `unusable` lists the observations to this local DID a usable peer path reaches that are not usable themselves */
  | { status: "unconfirmed"; unusable: readonly PeerObservation[] }
  /** a conflict reaches the pair */
  | { status: "conflict"; facts: readonly ContinuityFact[] };

/**
 * A rotation or ending as a fact claims it: `at` the pair the change
 * leaves, `to` the successor pair it names or null for an ending. An
 * observation that carried a rotation claims it at the pair the peer
 * rotated from, which is not the pair the observation is at.
 */
export type ChangeRecord = { fact: ContinuityFact; at: Channel; change: Change; to: Channel | null; status: FactStatus };

/**
 * A link of the positive graph: every rotation the evidence shows, and
 * every join two rotations imply, whether or not an operation may rely
 * on it. `derived` marks a join; `usable` marks a link the usable graph
 * has too.
 */
export type PositiveLink = { from: Channel; to: Channel; replaces: Side; support: readonly ContinuityFact[]; derived: boolean; usable: boolean };

export type EndingRecord = { fact: ContinuityFact; side: Side; status: FactStatus };

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
 * neither establishes a peer observation or a rotation; the endings
 * an answer lists are assertions, not the context that scopes them. No
 * support proves the absence of a conflict outside the facts. Answers
 * name facts by their content alone: which piece of evidence stands for
 * one is the host's to say. Nothing here authorizes an operation:
 * whether a head may be written to, or a path admits a message, is the
 * host's decision under its own policy.
 */
export interface Continuity {
  /** the facts as derived over, each once, in the order of their identities */
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
  /** the status of the fact with the same content; throws `InvalidFact` for a value that is not a fact of the profile */
  status(fact: ContinuityFact): FactStatus;
}

/** Throws `InvalidFact` for a value the profile refuses. */
export function deriveContinuity(facts: readonly ContinuityFact[]): Continuity {
  return new Model(facts);
}

/**
 * The facts validated, each once, in the order of their identities. A
 * fact the host projected from more than one piece of evidence is still
 * one fact, so the result is the same whatever order and repetition the
 * facts came in.
 */
function accept(facts: readonly unknown[]): Map<FactIdentity, ContinuityFact> {
  const accepted = new Map<FactIdentity, ContinuityFact>();
  facts.forEach((value, index) => {
    const fact = validateFact(value, `facts[${index}]`);
    accepted.set(identityOf(fact), fact);
  });
  return new Map([...accepted].sort(([a], [b]) => compareUtf8(a, b)));
}

/**
 * The change a fact claims of one side's endpoint: `at` the pair it
 * leaves, `to` the successor pair a rotation names. An observation that
 * carried a rotation claims the peer's rotation at the pair the peer
 * rotated from; an observation that carried none claims no change.
 */
interface Claim {
  readonly side: Side;
  readonly at: Channel;
  readonly change: Change;
  readonly to: Channel | null;
}

function claimOf(fact: ContinuityFact): Claim | null {
  switch (fact.kind) {
    case "peer-observation":
      return fact.rotatedFrom === null ? null : { side: "peer", at: channelOf(fact.at.localDid, fact.rotatedFrom), change: { kind: "rotate", successor: fact.at.peerDid }, to: fact.at };
    case "peer-ending":
      return { side: "peer", at: fact.at, change: { kind: "end" }, to: null };
    case "local-decision":
      return { side: "local", at: fact.at, change: fact.change, to: fact.change.kind === "end" ? null : channelOf(fact.change.successor, fact.at.peerDid) };
  }
}

interface Entry {
  readonly fact: ContinuityFact;
  readonly identity: FactIdentity;
  readonly claim: Claim | null;
  /**
   * The pairs the fact sits at: its own, and the pair its claim leaves.
   * An observation that carried a rotation sits at two, the pair it
   * observes and the pair the peer rotated from, and is indexed at both.
   */
  readonly sites: readonly Channel[];
  /** the pairs it sits at and the successor pair it names: a conflict at any of them reaches the fact */
  readonly pairs: readonly Channel[];
}

function entryOf(identity: FactIdentity, fact: ContinuityFact): Entry {
  const claim = claimOf(fact);
  const sites = sortedChannels([fact.at, ...(claim === null ? [] : [claim.at])]);
  return { fact, identity, claim, sites, pairs: sortedChannels([...sites, ...(claim?.to == null ? [] : [claim.to])]) };
}

/** The entry of a fact that claims a change. */
type Claiming = Entry & { readonly claim: Claim };

const claims = (entry: Entry): entry is Claiming => entry.claim !== null;

type KnownStatus = Exclude<FactStatus, { status: "unknown" }>;

type Writers = Map<Did, Map<Did, Entry[]>>;

const EVERY_CHANNEL = () => true;
const EVERY_ENTRY = () => true;

class Model implements Continuity {
  readonly facts: readonly ContinuityFact[];
  /** by identity, in the order of identities */
  private readonly entries = new Map<FactIdentity, Entry>();
  /** the channel keys of every pair a fact sits at */
  private readonly sites = new Set<string>();
  private readonly endings: Claiming[] = [];
  private readonly positive: Graph;
  private readonly positiveWaiting: ReadonlySet<FactIdentity>;
  private readonly samePeer: Contexts;
  private readonly sameLocal: Contexts;
  /** the saved local rotations by the root of their positive same-local context: the onward choices a head in that context must answer for */
  private readonly rotationsByContext = new Map<string, { entry: Claiming; successor: Did }[]>();
  private readonly conflictList: readonly Conflict[];
  /** by channel key, the facts of every conflict whose scope reaches the channel */
  private readonly conflictsAt = new Map<string, FactIdentity[]>();
  private readonly usable: Graph;
  private readonly usableAdmitted: ReadonlyMap<FactIdentity, readonly FactIdentity[]>;
  private readonly usableSamePeer: Contexts;
  private readonly usableSameLocal: Contexts;
  /** the usable links by the side they replace and the successor DID, for finding the same change made at another pair of a context */
  private readonly usableChanges = new Map<string, Edge[]>();

  constructor(facts: readonly ContinuityFact[]) {
    for (const [identity, fact] of accept(facts)) {
      const entry = entryOf(identity, fact);
      this.entries.set(identity, entry);
      for (const site of entry.sites) this.sites.add(channelKey(site));
      if (claims(entry) && entry.claim.change.kind === "end") this.endings.push(entry);
    }
    this.facts = [...this.entries.values()].map((entry) => entry.fact);

    const positiveWriters = this.writersOf(EVERY_ENTRY);
    const positive = closure(this.peerLinks(EVERY_ENTRY), this.candidates(EVERY_ENTRY), EVERY_CHANNEL, (graph, link) => this.confirming(graph, link, positiveWriters));
    this.positive = positive.graph;
    this.positiveWaiting = new Set([...positive.waiting].map((link) => link.identity));
    for (const entry of this.entries.values()) for (const site of entry.sites) this.positive.vertex(site);
    this.samePeer = new Contexts(this.positive, "local");
    this.sameLocal = new Contexts(this.positive, "peer");
    for (const entry of this.entries.values()) {
      if (!claims(entry) || entry.claim.side !== "local" || entry.claim.change.kind !== "rotate") continue;
      const root = this.sameLocal.root(channelKey(entry.claim.at));
      let rotations = this.rotationsByContext.get(root);
      if (rotations === undefined) this.rotationsByContext.set(root, (rotations = []));
      rotations.push({ entry, successor: entry.claim.change.successor });
    }
    const found = this.findConflicts();
    this.conflictList = found.map(({ conflict }) => conflict);
    for (const { conflict, identities } of found) {
      for (const channel of conflict.scope) {
        const key = channelKey(channel);
        let list = this.conflictsAt.get(key);
        if (list === undefined) this.conflictsAt.set(key, (list = []));
        list.push(...identities);
      }
    }

    const clear = (entry: Entry) => this.clear(entry);
    const usableWriters = this.writersOf(clear);
    const usable = closure(this.peerLinks(clear), this.candidates(clear), (channel) => !this.affected(channel), (graph, link) => this.confirming(graph, link, usableWriters));
    this.usable = usable.graph;
    this.usableAdmitted = new Map([...usable.admitted].map(([link, support]) => [link.identity, support]));
    this.usableSamePeer = new Contexts(this.usable, "local");
    this.usableSameLocal = new Contexts(this.usable, "peer");
    for (const edge of this.usable.edges()) {
      const key = changeIndexKey(edge.replaces, edge.replaces === "local" ? edge.to.localDid : edge.to.peerDid);
      let edges = this.usableChanges.get(key);
      if (edges === undefined) this.usableChanges.set(key, (edges = []));
      edges.push(edge);
    }
  }

  private peerLinks(admits: (entry: Entry) => boolean): Link[] {
    const links: Link[] = [];
    for (const entry of this.entries.values()) {
      if (!claims(entry) || entry.claim.side !== "peer" || entry.claim.to === null || !admits(entry)) continue;
      links.push({ identity: entry.identity, from: entry.claim.at, to: entry.claim.to });
    }
    return links;
  }

  private candidates(admits: (entry: Entry) => boolean): Link[] {
    const links: Link[] = [];
    for (const entry of this.entries.values()) {
      if (!claims(entry) || entry.claim.side !== "local" || entry.claim.to === null || !admits(entry)) continue;
      links.push({ identity: entry.identity, from: entry.claim.at, to: entry.claim.to });
    }
    return links;
  }

  /** By local DID, then by peer DID, the observations `admits` of the peer writing to exactly that local DID. */
  private writersOf(admits: (entry: Entry) => boolean): Writers {
    const writers: Writers = new Map();
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "peer-observation" || !admits(entry)) continue;
      let peers = writers.get(entry.fact.at.localDid);
      if (peers === undefined) writers.set(entry.fact.at.localDid, (peers = new Map()));
      let observations = peers.get(entry.fact.at.peerDid);
      if (observations === undefined) peers.set(entry.fact.at.peerDid, (observations = []));
      observations.push(entry);
    }
    return writers;
  }

  /** No conflict reaches a pair the fact sits at or names: what a usable link, observation or candidate needs of its own fact. */
  private clear(entry: Entry): boolean {
    return entry.pairs.every((pair) => !this.affected(pair));
  }

  private conflictingWith(entry: Entry): FactIdentity[] {
    return entry.pairs.flatMap((pair) => this.conflictFactsAt(pair));
  }

  /**
   * What confirms a candidate's predecessor address in the graph so far:
   * every admitted observation addressed to the predecessor by its peer,
   * or by a peer a path of peer rotations from the predecessor reaches.
   * The support names each observation and the path to its peer, so that
   * the support alone re-derives the confirmation; an observation that
   * carried a rotation is its own transition.
   */
  private confirming(graph: Graph, link: Link, writers: Writers): readonly FactIdentity[] | null {
    const peers = writers.get(link.from.localDid);
    if (peers === undefined) return null;
    const reach = graph.reach(link.from, "peer");
    const support: FactIdentity[] = [];
    for (const channel of reach.channels()) {
      const observations = peers.get(channel.peerDid);
      if (observations === undefined) continue;
      const via = reach.pathTo(channel)!;
      for (const observation of observations) support.push(observation.identity, ...via.flatMap((edge) => [...edge.support]));
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

  /** The facts that claim a change of `side` in the context of `channel`, in the order of their identities. */
  private claimsIn(channel: Channel, side: Side): Claiming[] {
    const contexts = this.contextsOf(side);
    const root = contexts.root(channelKey(channel));
    const found: Claiming[] = [];
    for (const entry of this.entries.values()) if (claims(entry) && entry.claim.side === side && contexts.root(channelKey(entry.claim.at)) === root) found.push(entry);
    return found;
  }

  /**
   * Competing changes of one endpoint in one context: the peer's across
   * the same-peer context, ours across the same-local one, every fact
   * counted whatever its status, since a saved decision not yet
   * confirmed is still a fork. Then cycles and refused joins.
   */
  private findConflicts(): { conflict: Conflict; identities: readonly FactIdentity[] }[] {
    const found: { conflict: Conflict; identities: readonly FactIdentity[] }[] = [];
    const competing = (side: Side) => {
      const contexts = this.contextsOf(side);
      const byContext = new Map<string, { channel: Channel; successors: Channel[]; changes: Map<string, { change: Change; identities: FactIdentity[] }> }>();
      for (const entry of this.entries.values()) {
        if (!claims(entry) || entry.claim.side !== side) continue;
        const root = contexts.root(channelKey(entry.claim.at));
        let group = byContext.get(root);
        if (group === undefined) byContext.set(root, (group = { channel: entry.claim.at, successors: [], changes: new Map() }));
        const key = changeKey(entry.claim.change);
        let change = group.changes.get(key);
        if (change === undefined) group.changes.set(key, (change = { change: entry.claim.change, identities: [] }));
        change.identities.push(entry.identity);
        if (entry.claim.to !== null) group.successors.push(entry.claim.to);
      }
      for (const { channel, successors, changes } of byContext.values()) {
        if (changes.size < 2) continue;
        const listed = [...changes.values()].sort((a, b) => compareUtf8(changeKey(a.change), changeKey(b.change)));
        const context = this.contextOf(channel, side);
        found.push({
          conflict: { kind: "competing-changes", side, context, changes: listed.map(({ change, identities }) => ({ change, facts: this.factsOf(identities) })), scope: sortedChannels([...context, ...successors]) },
          identities: listed.flatMap(({ identities }) => identities),
        });
      }
    };
    competing("peer");
    competing("local");
    for (const channels of this.positive.cycles()) {
      const members = new Set(channels.map(channelKey));
      const identities: FactIdentity[] = [];
      for (const channel of channels) for (const edge of this.positive.from(channel)) if (members.has(channelKey(edge.to))) identities.push(...edge.support);
      found.push({ conflict: { kind: "cycle", channels, facts: this.factsOf(identities), scope: channels }, identities });
    }
    for (const { channels, support } of this.positive.identityCollisions.values()) found.push({ conflict: { kind: "identity-collision", channels, facts: this.factsOf(support), scope: sortedChannels(channels) }, identities: [...support] });
    return found.sort((a, b) => compareUtf8(a.conflict.kind, b.conflict.kind) || compareChannels(firstChannelOf(a.conflict), firstChannelOf(b.conflict)));
  }

  private conflictFactsAt(channel: Channel): readonly FactIdentity[] {
    return this.conflictsAt.get(channelKey(channel)) ?? [];
  }

  private endingsAt(channel: Channel, side: Side): Claiming[] {
    const contexts = this.contextsOf(side);
    const root = contexts.root(channelKey(channel));
    return this.endings.filter((entry) => entry.claim.side === side && contexts.root(channelKey(entry.claim.at)) === root);
  }

  private known(channel: Channel): boolean {
    return this.positive.vertices.has(channelKey(channel));
  }

  /** A local rotation without usable continuation, diagnosed as the fact query diagnoses it. */
  private pendingDecision(entry: Entry, conflict: Set<FactIdentity>, waiting: Set<FactIdentity>): void {
    const conflicting = this.conflictingWith(entry);
    for (const identity of conflicting) conflict.add(identity);
    if (conflicting.length === 0 && !this.usableAdmitted.has(entry.identity)) waiting.add(entry.identity);
  }

  /** A pair some fact sits at, or a usable link leads to; one only conflicted links lead to rests on the conflict. */
  private established(channel: Channel): boolean {
    if (this.sites.has(channelKey(channel))) return true;
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
    const conflict = new Set<FactIdentity>();
    const waiting = new Set<FactIdentity>();
    if (!this.known(channel)) {
      for (const identity of this.conflictFactsAt(channel)) conflict.add(identity);
      if (conflict.size > 0) return { status: "conflict", facts: this.factsOf(conflict) };
      for (const entry of this.entries.values()) if (claims(entry) && entry.claim.side === "local" && entry.claim.to !== null && sameChannel(entry.claim.to, channel)) this.pendingDecision(entry, conflict, waiting);
      if (conflict.size > 0) return { status: "conflict", facts: this.factsOf(conflict) };
      if (waiting.size > 0) return { status: "unresolved", waiting: this.factsOf(waiting) };
      return { status: "no-evidence" };
    }
    const reach = this.positive.reach(channel, "any");
    for (const current of reach.channels()) for (const identity of this.conflictFactsAt(current)) conflict.add(identity);
    if (!this.established(channel)) for (const edge of this.positive.to(channel)) for (const identity of edge.support) conflict.add(identity);
    if (conflict.size > 0) return { status: "conflict", facts: this.factsOf(conflict) };
    const endings = new Set<FactIdentity>();
    const support = new Set<FactIdentity>();
    const usableReach = this.usable.reach(channel, "any");
    for (const current of reach.channels()) {
      if (!usableReach.has(current)) {
        if (!this.positive.hasOutgoing(current)) for (const edge of this.positive.to(current)) for (const identity of edge.support) conflict.add(identity);
        continue;
      }
      for (const edge of this.positive.from(current)) {
        const usable = this.usable.edge(edge.from, edge.to);
        if (usable !== undefined) for (const identity of usable.support) support.add(identity);
        else if (!this.usablyEstablished(edge.replaces, current, edge.replaces === "local" ? edge.to.localDid : edge.to.peerDid)) for (const identity of edge.support) conflict.add(identity);
      }
      for (const side of ["peer", "local"] as const) {
        const found = this.endingsAt(current, side);
        const root = this.usableContextRoot(current, side);
        const affirmative = found.filter((entry) => this.usableContextRoot(entry.claim.at, side) === root);
        for (const entry of affirmative) endings.add(entry.identity);
        if (affirmative.length === 0) for (const entry of found) conflict.add(entry.identity);
      }
      const usableRoot = this.usableContextRoot(current, "local");
      for (const { entry, successor } of this.rotationsByContext.get(this.sameLocal.root(channelKey(current))) ?? []) {
        if (this.usablyEstablished("local", current, successor)) continue;
        if (this.usableContextRoot(entry.claim.at, "local") === usableRoot) this.pendingDecision(entry, conflict, waiting);
        else conflict.add(entry.identity);
      }
    }
    if (conflict.size > 0) return { status: "conflict", facts: this.factsOf(conflict) };
    if (endings.size > 0) return { status: "ended", endings: this.factsOf(endings) };
    if (waiting.size > 0) return { status: "unresolved", waiting: this.factsOf(waiting) };
    const ends = [...usableReach.channels()].filter((current) => !this.usable.hasOutgoing(current));
    if (ends.length !== 1) return { status: "conflict", facts: this.factsOf(support) };
    return { status: "head", channel: ends[0]!, support: this.factsOf(support) };
  }

  changes(channel: Channel, side: Side): readonly ChangeRecord[] {
    return this.claimsIn(channel, side).map((entry) => ({ fact: entry.fact, at: entry.claim.at, change: entry.claim.change, to: entry.claim.to, status: this.statusOf(entry) }));
  }

  path(from: Channel, to: Channel): PathResult {
    const conflict = [...this.conflictFactsAt(from), ...this.conflictFactsAt(to)];
    if (conflict.length > 0) return { status: "conflict", facts: this.factsOf(conflict) };
    if (!this.known(from)) return { status: "none" };
    const edges = this.usable.path(from, to);
    if (edges === null) return { status: "none" };
    return { status: "path", channels: [from, ...edges.map((edge) => edge.to)], support: this.factsOf(edges.flatMap((edge) => [...edge.support])) };
  }

  confirmation(localDid: Did, peerDid: Did): ConfirmationResult {
    const channel = channelOf(localDid, peerDid);
    const conflict = this.conflictFactsAt(channel);
    if (conflict.length > 0) return { status: "conflict", facts: this.factsOf(conflict) };
    const observations: Confirmation[] = [];
    const unusable: PeerObservation[] = [];
    const reach = localDid === peerDid ? null : this.usable.reach(channel, "peer");
    for (const entry of this.entries.values()) {
      if (entry.fact.kind !== "peer-observation" || entry.fact.at.localDid !== localDid) continue;
      const via = reach?.pathTo(entry.fact.at);
      if (via === undefined) continue;
      if (!this.clear(entry)) unusable.push(entry.fact);
      else observations.push({ fact: entry.fact, support: this.factsOf([entry.identity, ...via.flatMap((edge) => [...edge.support])]) });
    }
    if (observations.length > 0) return { status: "confirmed", observations };
    return { status: "unconfirmed", unusable };
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
    const endings = [...this.endingsAt(channel, "peer"), ...this.endingsAt(channel, "local")].sort((a, b) => compareUtf8(a.identity, b.identity));
    return {
      links: links.sort((a, b) => compareChannels(a.from, b.from) || compareChannels(a.to, b.to)),
      endings: endings.map((entry) => ({ fact: entry.fact, side: entry.claim.side, status: this.statusOf(entry) })),
      samePeer: this.contextOf(channel, "peer"),
      sameLocal: this.contextOf(channel, "local"),
    };
  }

  private link(edge: Edge): PositiveLink {
    return { from: edge.from, to: edge.to, replaces: edge.replaces, support: this.factsOf(edge.support), derived: edge.derived, usable: this.usable.edge(edge.from, edge.to) !== undefined };
  }

  /** A same-local context is connected by peer links alone, which keep the local DID, so every local claim in it leaves that local DID. */
  localDecisions(channel: Channel): readonly ChangeRecord[] {
    return this.changes(channel, "local");
  }

  conflicts(): readonly Conflict[] {
    return this.conflictList;
  }

  status(fact: ContinuityFact): FactStatus {
    const entry = this.entries.get(factIdentity(fact));
    return entry === undefined ? { status: "unknown" } : this.statusOf(entry);
  }

  private statusOf(entry: Entry): KnownStatus {
    const conflict = this.conflictingWith(entry);
    if (conflict.length > 0) return { status: "conflict", facts: this.factsOf(conflict), because: "its context is in conflict" };
    if (entry.fact.kind !== "local-decision" || entry.fact.change.kind === "end") return { status: "usable", support: [entry.fact] };
    const confirming = this.usableAdmitted.get(entry.identity);
    if (confirming !== undefined) return { status: "usable", support: this.factsOf([entry.identity, ...confirming]) };
    if (this.positiveWaiting.has(entry.identity)) return { status: "waiting", because: "no observation addressed to the predecessor by its peer or a successor of that peer" };
    return { status: "waiting", because: "the predecessor is confirmed only through continuity that is not usable" };
  }

  private factsOf(identities: Iterable<FactIdentity>): ContinuityFact[] {
    return [...new Set(identities)].sort(compareUtf8).map((identity) => this.entries.get(identity)!.fact);
  }
}

function changeIndexKey(side: Side, successor: Did): string {
  return `${side}\u0000${successor}`;
}

function firstChannelOf(conflict: Conflict): Channel {
  return conflict.kind === "competing-changes" ? conflict.context[0]! : conflict.channels[0]!;
}
