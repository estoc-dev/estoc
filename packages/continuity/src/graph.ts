/**
 * The continuity graph: channels as vertices, edges that replace exactly
 * one endpoint, and the joins two opposite-side edges leaving one pair
 * imply. Closure is a fixpoint, so the graph is the same whatever order
 * the edges came in. Nothing here knows what a fact is beyond its ID.
 */

import { channelKey, compareChannels, compareUtf8, sortedIds } from "./facts.js";
import type { Channel, Did, FactId } from "./types.js";

export type Replaces = "local" | "peer";

export interface Edge {
  readonly from: Channel;
  readonly to: Channel;
  readonly replaces: Replaces;
  readonly support: Set<FactId>;
  /** derived from other links, by a join or by one successor superseding another, rather than declared by a fact at `from` */
  derived: boolean;
}

export interface Link {
  readonly id: FactId;
  readonly from: Channel;
  readonly to: Channel;
}

/**
 * The channels a forward search reached from its start, each with the
 * edge it was first reached by. Paths are rebuilt from those parent
 * edges only when asked for, so a search costs one entry per channel
 * however long the history is.
 */
export class Reach {
  private readonly reached = new Map<string, { channel: Channel; via: Edge | null }>();

  constructor(start: Channel) {
    this.reached.set(channelKey(start), { channel: start, via: null });
  }

  /** whether `channel` was newly reached through `via` */
  arrive(channel: Channel, via: Edge): boolean {
    const key = channelKey(channel);
    if (this.reached.has(key)) return false;
    this.reached.set(key, { channel, via });
    return true;
  }

  has(channel: Channel): boolean {
    return this.reached.has(channelKey(channel));
  }

  /** every channel reached, the start first, in the order they were reached */
  *channels(): IterableIterator<Channel> {
    for (const { channel } of this.reached.values()) yield channel;
  }

  /** the edges of the path the search took to `channel`, empty for the start, undefined when not reached */
  pathTo(channel: Channel): readonly Edge[] | undefined {
    const end = this.reached.get(channelKey(channel));
    if (end === undefined) return undefined;
    const edges: Edge[] = [];
    for (let entry = end; entry.via !== null; entry = this.reached.get(channelKey(entry.via.from))!) edges.push(entry.via);
    return edges.reverse();
  }
}

export interface IdentityCollision {
  readonly channels: readonly Channel[];
  readonly support: readonly FactId[];
}

export class Graph {
  readonly vertices = new Map<string, Channel>();
  readonly identityCollisions = new Map<string, IdentityCollision>();
  private readonly out = new Map<string, Map<string, Edge>>();
  private readonly into = new Map<string, Map<string, Edge>>();
  private readonly queue: Edge[] = [];

  constructor(private readonly admits: (channel: Channel) => boolean) {}

  vertex(channel: Channel): void {
    const key = channelKey(channel);
    if (!this.vertices.has(key)) this.vertices.set(key, channel);
  }

  add(from: Channel, to: Channel, replaces: Replaces, support: Iterable<FactId>, derived = false): void {
    if (!this.admits(from) || !this.admits(to)) return;
    this.vertex(from);
    this.vertex(to);
    const fromKey = channelKey(from);
    const toKey = channelKey(to);
    let edges = this.out.get(fromKey);
    if (edges === undefined) this.out.set(fromKey, (edges = new Map()));
    const existing = edges.get(toKey);
    if (existing === undefined) {
      const edge: Edge = { from, to, replaces, support: new Set(support), derived };
      edges.set(toKey, edge);
      let inbound = this.into.get(toKey);
      if (inbound === undefined) this.into.set(toKey, (inbound = new Map()));
      inbound.set(fromKey, edge);
      this.queue.push(edge);
      return;
    }
    const before = existing.support.size;
    for (const id of support) existing.support.add(id);
    if (!derived) existing.derived = false;
    if (existing.support.size > before) this.queue.push(existing);
  }

  /** Every join the edges imply, to a fixpoint. */
  close(): void {
    while (this.queue.length > 0) {
      const edge = this.queue.pop()!;
      for (const partner of [...this.from(edge.from)]) {
        if (partner.replaces === edge.replaces) continue;
        const [local, peer] = edge.replaces === "local" ? [edge, partner] : [partner, edge];
        this.join(local, peer);
      }
    }
  }

  private join(local: Edge, peer: Edge): void {
    const localDid = local.to.localDid;
    const peerDid = peer.to.peerDid;
    const support = sortedIds([...local.support, ...peer.support]);
    if (localDid === peerDid) {
      const channels = [local.from, local.to, peer.to];
      this.identityCollisions.set(channels.map(channelKey).join("\u0001"), { channels, support });
      return;
    }
    const joined = { localDid, peerDid };
    this.add(local.to, joined, "peer", support, true);
    this.add(peer.to, joined, "local", support, true);
  }

  from(channel: Channel): Iterable<Edge> {
    return this.out.get(channelKey(channel))?.values() ?? [];
  }

  to(channel: Channel): Iterable<Edge> {
    return this.into.get(channelKey(channel))?.values() ?? [];
  }

  edge(from: Channel, to: Channel): Edge | undefined {
    return this.out.get(channelKey(from))?.get(channelKey(to));
  }

  hasOutgoing(channel: Channel): boolean {
    return (this.out.get(channelKey(channel))?.size ?? 0) > 0;
  }

  *edges(): IterableIterator<Edge> {
    for (const edges of this.out.values()) yield* edges.values();
  }

  /**
   * Every channel forward edges of the given kind reach from `start`,
   * `start` included, each by one shortest path: breadth first over
   * edges in canonical order, so the path chosen is the same whatever
   * order the edges were added. The search stops once it reaches
   * `until`, when one is given.
   */
  reach(start: Channel, replaces: Replaces | "any", until?: Channel): Reach {
    const reach = new Reach(start);
    const untilKey = until === undefined ? undefined : channelKey(until);
    if (untilKey === channelKey(start)) return reach;
    const frontier = [start];
    for (let next = 0; next < frontier.length; next++) {
      for (const edge of [...this.from(frontier[next]!)].sort((a, b) => compareChannels(a.to, b.to))) {
        if (replaces !== "any" && edge.replaces !== replaces) continue;
        if (!reach.arrive(edge.to, edge)) continue;
        if (channelKey(edge.to) === untilKey) return reach;
        frontier.push(edge.to);
      }
    }
    return reach;
  }

  /** The shortest forward path from `from` to `to` as its edges, empty for the same channel, null when none. */
  path(from: Channel, to: Channel): readonly Edge[] | null {
    return this.reach(from, "any", to).pathTo(to) ?? null;
  }

  /**
   * Every strongly connected set of more than one channel, in canonical
   * order: Tarjan's algorithm on an explicit stack, since a replacement
   * history is as deep as the peer made it and the call stack is not.
   */
  cycles(): Channel[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: Channel[] = [];
    const path: { key: string; edges: Iterator<Edge> }[] = [];
    const cycles: Channel[][] = [];
    let next = 0;
    const enter = (channel: Channel) => {
      const key = channelKey(channel);
      index.set(key, next);
      low.set(key, next);
      next++;
      stack.push(channel);
      onStack.add(key);
      path.push({ key, edges: this.from(channel)[Symbol.iterator]() });
    };
    for (const root of this.vertices.values()) {
      if (index.has(channelKey(root))) continue;
      enter(root);
      while (path.length > 0) {
        const frame = path[path.length - 1]!;
        const step = frame.edges.next();
        if (!step.done) {
          const toKey = channelKey(step.value.to);
          if (!index.has(toKey)) enter(step.value.to);
          else if (onStack.has(toKey)) low.set(frame.key, Math.min(low.get(frame.key)!, index.get(toKey)!));
          continue;
        }
        path.pop();
        if (low.get(frame.key) === index.get(frame.key)) {
          const component: Channel[] = [];
          for (;;) {
            const member = stack.pop()!;
            const memberKey = channelKey(member);
            onStack.delete(memberKey);
            component.push(member);
            if (memberKey === frame.key) break;
          }
          if (component.length > 1) cycles.push(component.sort(compareChannels));
        }
        const parent = path[path.length - 1];
        if (parent !== undefined) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      }
    }
    return cycles.sort((a, b) => compareChannels(a[0]!, b[0]!));
  }
}

/**
 * A change of one endpoint at a pair: its successor, or null for an
 * ending. A fact claims it there, or the fact's change supersedes the
 * endpoint there and the claim is implied.
 */
export interface Claim {
  readonly id: FactId;
  readonly at: Channel;
  readonly successor: Did | null;
}

export type Claims = Readonly<Record<Replaces, readonly Claim[]>>;

/** The claims of one side in one context, and the order of their successors when they have one. */
export interface Succession {
  readonly claims: readonly Claim[];
  /**
   * The successors from the first superseded to the one that stands,
   * null when the claims compete. A single change is its own order. An
   * ending is ordered with nothing.
   */
  readonly order: readonly Did[] | null;
}

const other = (side: Replaces): Replaces => (side === "local" ? "peer" : "local");

const moved = (channel: Channel, side: Replaces, successor: Did): Channel => (side === "local" ? { localDid: successor, peerDid: channel.peerDid } : { localDid: channel.localDid, peerDid: successor });

/**
 * The claims of `side` by context, each context with the order of its
 * successors. Two different successors of one endpoint are ordered when
 * the other party's own changes order the pairs they were claimed at:
 * every pair the later successor was claimed at is one the other party
 * reached from every pair of the earlier one, and never the other way
 * round.
 * The order comes from the links alone, so every replica holding the
 * same facts finds the same one. Claims at one pair, or at pairs no
 * link orders, compete.
 */
export function successions(graph: Graph, side: Replaces, claims: readonly Claim[]): Succession[] {
  const contexts = new Contexts(graph, other(side));
  const byContext = new Map<string, Claim[]>();
  for (const claim of claims) {
    const root = contexts.root(channelKey(claim.at));
    let group = byContext.get(root);
    if (group === undefined) byContext.set(root, (group = []));
    group.push(claim);
  }
  const reaches = new Map<string, Reach>();
  const later = (from: Channel, to: Channel): boolean => {
    const key = channelKey(from);
    if (key === channelKey(to)) return false;
    let reach = reaches.get(key);
    if (reach === undefined) reaches.set(key, (reach = graph.reach(from, other(side))));
    return reach.has(to);
  };
  return [...byContext.values()].map((group) => {
    const pairsOf = new Map<Did | null, Channel[]>();
    for (const claim of group) {
      const pairs = pairsOf.get(claim.successor);
      if (pairs === undefined) pairsOf.set(claim.successor, [claim.at]);
      else pairs.push(claim.at);
    }
    if (pairsOf.size === 1) return { claims: group, order: group[0]!.successor === null ? [] : [group[0]!.successor] };
    if (pairsOf.has(null)) return { claims: group, order: null };
    const successors = [...pairsOf.keys()] as Did[];
    const precedes = (a: Did, b: Did): boolean => {
      const before = pairsOf.get(a)!;
      const after = pairsOf.get(b)!;
      return before.every((from) => after.every((to) => later(from, to))) && !after.some((from) => before.some((to) => channelKey(from) === channelKey(to) || later(from, to)));
    };
    const rank = new Map<Did, number>(successors.map((successor) => [successor, 0]));
    for (const a of successors) {
      for (const b of successors) {
        if (a === b || compareUtf8(a, b) > 0) continue;
        if (precedes(a, b)) rank.set(b, rank.get(b)! + 1);
        else if (precedes(b, a)) rank.set(a, rank.get(a)! + 1);
        else return { claims: group, order: null };
      }
    }
    return { claims: group, order: successors.sort((a, b) => rank.get(a)! - rank.get(b)!) };
  });
}

export interface Superseding {
  readonly link: { readonly from: Channel; readonly to: Channel; readonly support: readonly FactId[] };
  readonly side: Replaces;
  /** the change of the superseded successor the link stands for, under the ID of the fact whose change supersedes it */
  readonly claim: Claim;
}

/**
 * The link from each superseded successor to the one that supersedes
 * it, at every pair the superseding change was made at: where one
 * endpoint went from P to X and, further along the other party's
 * changes, from P to Y, X leads to Y. Only changes the graph already
 * holds as links imply one, and the support of the implied link is
 * theirs and that of the path between them. Each is a change of the
 * superseded successor in its own right, made at that pair.
 */
function superseding(graph: Graph, claims: Claims): Superseding[] {
  const implied: Superseding[] = [];
  for (const side of ["local", "peer"] as const) {
    for (const { claims: group, order } of successions(graph, side, claims[side])) {
      if (order === null) continue;
      for (let next = 1; next < order.length; next++) {
        const before = order[next - 1]!;
        const after = order[next]!;
        const earlier = group.filter((claim) => claim.successor === before).sort((a, b) => compareChannels(a.at, b.at));
        for (const claim of group) {
          if (claim.successor !== after) continue;
          const made = graph.edge(claim.at, moved(claim.at, side, after));
          if (made === undefined) continue;
          for (const prior of earlier) {
            const superseded = graph.edge(prior.at, moved(prior.at, side, before));
            const between = superseded === undefined ? undefined : graph.reach(prior.at, other(side), claim.at).pathTo(claim.at);
            if (superseded === undefined || between === undefined) continue;
            const from = moved(claim.at, side, before);
            if (from.localDid === from.peerDid) break;
            const support = sortedIds([...superseded.support, ...made.support, ...between.flatMap((edge) => [...edge.support])]);
            implied.push({ link: { from, to: made.to, support }, side, claim: { id: claim.id, at: from, successor: after } });
            break;
          }
        }
      }
    }
  }
  return implied;
}

const claimKey = (side: Replaces, claim: Claim): string => [side, claim.id, channelKey(claim.at), claim.successor].join("\u0001");

type Implied = ReadonlyMap<string, Superseding>;

const entryKey = (key: string, { link }: Superseding): string => [key, ...link.support].join("\u0001");

/** One string per set of implied changes, the same for the same changes with the same support however they were found. */
const impliedKey = (implied: Implied): string =>
  [...implied]
    .map(([key, change]) => entryKey(key, change))
    .sort()
    .join("\u0002");

/**
 * The graph over the given links, the candidates `confirms` admits and
 * the links superseded successors imply. An implied change is ordered
 * against the other changes of its endpoint as a claimed one is, so it
 * may supersede in turn or compete. The implied changes are the ones
 * the complete claims, declared and implied together, imply: each
 * derivation starts from what the previous one implied, until one
 * implies the set it was given. A change implied along the way that the
 * complete claims do not imply is dropped, and what it blocked is
 * implied after all. The derivations may instead alternate between
 * sets, when what one set implies undoes the order it came from: then
 * every change any set of the alternation holds is implied, so that no
 * branch hides, and the ones not every set holds are `unsettled` as
 * well. `implied` returns them all. A candidate is judged against the
 * graph built without it and every candidate still waiting, so nothing
 * it derives can confirm it; the graph is rebuilt until no candidate is
 * admitted any more, and one admitted stays admitted while the implied
 * changes settle around it. The confirming facts of each admitted
 * candidate are returned with it. Candidates are told apart as objects,
 * since two variants of one fact ID are two candidates.
 */
export function closure<L extends Link>(
  peerLinks: readonly Link[],
  candidates: readonly L[],
  claims: Claims,
  admits: (channel: Channel) => boolean,
  confirms: (graph: Graph, candidate: L) => readonly FactId[] | null
): { graph: Graph; implied: Claims; unsettled: Claims; admitted: Map<L, readonly FactId[]>; waiting: Set<L> } {
  const admitted = new Map<L, readonly FactId[]>();
  const waiting = new Set(candidates);
  const assemble = (implied: Implied): Graph => {
    const graph = new Graph(admits);
    for (const link of peerLinks) graph.add(link.from, link.to, "peer", [link.id]);
    for (const [link, support] of admitted) graph.add(link.from, link.to, "local", [link.id, ...support]);
    for (const { side, link } of implied.values()) graph.add(link.from, link.to, side, link.support, true);
    graph.close();
    return graph;
  };
  const derive = (graph: Graph, implied: Implied): Implied => {
    const all = { local: [...claims.local], peer: [...claims.peer] };
    for (const { side, claim } of implied.values()) all[side].push(claim);
    return new Map(superseding(graph, all).map((change) => [claimKey(change.side, change.claim), change]));
  };
  const asClaims = (implied: Implied): Claims => {
    const result: Record<Replaces, Claim[]> = { local: [], peer: [] };
    for (const { side, claim } of implied.values()) result[side].push(claim);
    return result;
  };
  const build = (): { graph: Graph; implied: Claims; unsettled: Claims } => {
    let implied: Implied = new Map();
    const seen = new Map<string, Implied>([[impliedKey(implied), implied]]);
    for (;;) {
      const graph = assemble(implied);
      const next = derive(graph, implied);
      const key = impliedKey(next);
      if (key === impliedKey(implied)) return { graph, implied: asClaims(implied), unsettled: { local: [], peer: [] } };
      if (seen.has(key)) {
        const alternation = [...seen.values()].slice([...seen.keys()].indexOf(key));
        const every = new Map<string, Superseding>();
        for (const set of alternation) for (const [k, change] of set) if (!every.has(k)) every.set(k, change);
        const unsettled = new Map([...every].filter(([k]) => !alternation.every((set) => set.has(k))));
        return { graph: assemble(every), implied: asClaims(every), unsettled: asClaims(unsettled) };
      }
      seen.set(key, next);
      implied = next;
    }
  };
  let built = build();
  for (;;) {
    let progressed = false;
    for (const link of waiting) {
      if (admitted.has(link)) continue;
      const support = confirms(built.graph, link);
      if (support === null) continue;
      admitted.set(link, support);
      progressed = true;
    }
    if (!progressed) break;
    built = build();
  }
  for (const link of admitted.keys()) waiting.delete(link);
  return { ...built, admitted, waiting };
}

/** Union-find over channel keys: the contexts one kind of edge connects. */
export class Contexts {
  private readonly parent = new Map<string, string>();

  constructor(graph: Graph, replaces: Replaces) {
    for (const edge of graph.edges()) if (edge.replaces === replaces) this.union(channelKey(edge.from), channelKey(edge.to));
  }

  private find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) root = this.parent.get(root)!;
    for (let node = key; node !== root; ) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  private union(a: string, b: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // the smaller key roots the context, so the root is the same whatever the union order
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  /** The root key of the context; the key itself for a channel no edge of this kind touches. */
  root(key: string): string {
    return this.parent.has(key) ? this.find(key) : key;
  }
}
