/**
 * An arrangement's account at its mediator, bound to this runtime: the
 * vault session, the arrangement, what the mediator confirmed to
 * this runtime, and the link that speaks as the account. Every request
 * the account makes goes through it, so that none of these is paired by
 * a caller who could pair them wrong. Nothing in the vault tells two
 * runtimes apart here: the replicas of one seed at one mediator speak
 * as the same account, and each keeps confirmations of its own. So a
 * host is handed the bound account as an `Arrangement` and cannot make
 * one: only the agent binds one, to its own runtime and its own line to
 * the mediator.
 *
 * Binding is local and immediate; the link is not made until an
 * operation, its checks over the fold passed, has to reach the mediator,
 * and it is checked then, once, to speak as this account to this
 * mediator. An arrangement is bound for as long as its holder lives and
 * has no closing of its own: once the agent closes, an operation that
 * has to reach the mediator is refused with `LinkClosed`, and so is
 * taking the membership, which is there only to reach it; an enrollment
 * or a recipient-add whose every step is confirmed already answers as
 * it did.
 */

import { isJsonObject, type JsonObject, type LocalOptions } from "@estoc/event-store";
import type { Did, Mediation, MediationId } from "@estoc/vault";

import type { MediatorLink } from "./link.js";
import { toward } from "./mediation.js";
import type { Member, Membership } from "./membership.js";
import { enroll, type Enrolled } from "./replica-enrollment.js";
import { listReplicas, type ListedReplica } from "./replica-list.js";
import { addRecipients, type RecipientsAdded } from "./replica-recipients.js";
import type { Session } from "./session.js";
import { note, type AgentTrace, type TraceData } from "./trace.js";

/** What a host does with the account of one of its arrangements. */
export interface Arrangement {
  /**
   * This runtime enrolled in the arrangement, each step only when it is
   * not already known to be done: the account registered when the
   * arrangement has no grant, the runtime's replica created in the vault
   * when it has none, and added at the mediator when no confirmation of
   * it is kept. Needs an arrangement neither retired nor in conflict.
   */
  enroll(): Promise<Enrolled>;
  /** One recipient-add for each address the account is to hold that has no confirmation kept. Needs the account registered and this runtime's replica confirmed added. */
  addRecipients(): Promise<RecipientsAdded>;
  /** Every replica the account ever added, as its mediator lists them and the seed bears them out. Needs the account registered. */
  listReplicas(): Promise<ListedReplica[]>;
  /**
   * This runtime's replica as a member of the arrangement, bound once to
   * this runtime and reaching the mediator over the agent's line: what
   * the agent picks up as too. Handed out while the replica is enrolled
   * here, and each operation on it is let through while it still is:
   * `UnknownEntity` until this runtime has a replica, `EntityConflict`
   * while it is a member of another arrangement, which taking it here
   * does not change, and `Unusable` while a step of enrolling it is
   * wanting, which `enroll` does. Asks nothing of the mediator, and
   * once the agent is closed is `LinkClosed`, whatever the vault says.
   */
  membership(): Promise<Membership>;
}

/** The account's operations for a caller holding its turn: none of them waits for the turn again. */
export interface AccountTurn {
  addRecipients(): Promise<RecipientsAdded>;
}

/**
 * Where a runtime keeps what its mediator confirmed to it: its local
 * options, which outlive a reopen and every commit. The local cache
 * would not do, since it is emptied whenever the vault accepts an
 * event.
 */
export type Confirmations = Pick<LocalOptions, "get" | "set">;

export class Account implements Arrangement {
  private linked: MediatorLink | null = null;

  constructor(
    readonly session: Session,
    readonly mediationId: MediationId,
    private readonly confirmations: Confirmations,
    private readonly trace: AgentTrace,
    private readonly connect: () => Promise<MediatorLink>,
    private readonly member: () => Promise<Member>
  ) {}

  enroll(): Promise<Enrolled> {
    return this.turn(() => enroll(this));
  }

  addRecipients(): Promise<RecipientsAdded> {
    return this.turn((turn) => turn.addRecipients());
  }

  /** Not a turn: a listing writes nothing, and its pages are no reason to hold up an enrollment or a disclosure. */
  listReplicas(): Promise<ListedReplica[]> {
    return listReplicas(this);
  }

  /** Not a turn: taking the replica writes nothing and asks nothing of the mediator. */
  async membership(): Promise<Membership> {
    const member = await this.member();
    await member.admitted();
    return member;
  }

  /**
   * `work` as the account's one procedure at a time: after every turn
   * taken before it, of this binding or another of the same account,
   * and before every turn taken after it. A procedure whose requests
   * and commit have to stand together takes one turn for all of them,
   * and asks through `turn` what would otherwise take a turn of its own.
   */
  turn<T>(work: (turn: AccountTurn) => Promise<T>): Promise<T> {
    return this.session.turn(this.mediationId, () => work({ addRecipients: () => addRecipients(this) }));
  }

  /** The link that speaks as the account to `mediation`'s mediator: made on first need, and refused then when it is not the arrangement's own. */
  async link(mediation: Mediation): Promise<MediatorLink> {
    if (this.linked !== null) return this.linked;
    const link = await this.connect();
    toward(link, mediation);
    this.linked = link;
    return link;
  }

  /** Has the mediator confirmed to this runtime what `key` names, with `member` as `did`? */
  async confirmed(key: string, member: string, did: Did): Promise<boolean> {
    const kept = await this.confirmations.get(key);
    return isJsonObject(kept) && kept[member] === did;
  }

  confirm(key: string, confirmation: JsonObject): Promise<void> {
    return this.confirmations.set(key, confirmation);
  }

  async observe(what: string, data: TraceData): Promise<void> {
    await note(this.trace, { stream: "diag", what, data });
  }
}
