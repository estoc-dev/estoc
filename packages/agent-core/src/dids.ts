/**
 * Communication DIDs: an entry minted from a fresh ID and a route alone,
 * a mediation arrangement or a direct endpoint, so a committed ID reuses
 * its exact keys and document after a crash and is not recreated for
 * another route or another use; the disclosure that reveals an entry,
 * its mediated registration verified first, and never an address of a
 * private branch, which stays the one peer's; and the retirement that
 * ends new sending and disclosure at it. Where a DID sends is read back
 * from its document, never recorded beside it. Every decision is taken
 * over the fold under the lock.
 */

import { v7 as uuidv7 } from "uuid";

import { decodeLongForm, isShortForm } from "@estoc/did-peer";
import type { JsonObject, VaultRuntime } from "@estoc/event-store";
import {
  GENERATION_PROFILE,
  canonicalDid,
  mediationIdOf,
  mintDid,
  scanVault,
  serviceTargetOf,
  vaultDraft,
  type Did,
  type DidGeneration,
  type DidId,
  type DisclosureAs,
  type Keys,
  type LocalDidEntity,
  type MediationId,
  type MintedDid,
  type RouteTarget,
  type VaultData,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import { PLAIN_TYP } from "./protocol/didcomm.js";
import { GOAL_CONNECT, type Invitation } from "./protocol/oob.js";
import { OOB_INVITATION } from "./protocol/spec.js";
import { EntityConflict, UnknownEntity, Unregistered, Unusable, WrongMediator } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { mediationOf } from "./mediation.js";
import { decide, serially } from "./procedure.js";
import type { Confirmations } from "./replica-enrollment.js";
import { addRecipientsNow, holds } from "./replica-recipients.js";
import { knownLongForms } from "./resolver.js";

/** The route a DID is minted for: a mediation arrangement by its ID, or a direct HTTPS or WSS endpoint. */
export type RouteSpec = { kind: "mediated"; mediationId: MediationId } | { kind: "direct"; endpoint: string };

export function didOf(fold: VaultFold, didId: DidId): LocalDidEntity {
  const entity = fold.dids.entities.get(didId);
  if (entity === undefined) throw new UnknownEntity("DID", didId);
  return entity;
}

/** Whether a route carries a DID now: where it sends; waiting while evidence may still arrive; blocked where the arrangement has ended or is in conflict, or the endpoint is no URL a document names. */
export type RouteStanding = { status: "ready"; target: RouteTarget } | { status: "waiting"; because: string } | { status: "blocked"; because: string };

/**
 * Where a route sends, once it can carry a DID: the mediator of a
 * usable arrangement, or the endpoint itself. A did:peer:4 mediator is
 * named by its long form, validated against its hash, so that whoever
 * is given the address resolves the mediator from the address alone;
 * the spelling an arrangement is reported under changes with the
 * evidence merged here and names no document. An arrangement not
 * recorded here, not granted yet or whose mediator has no long form in
 * evidence waits for what a merge may bring.
 */
export function routeStanding(fold: VaultFold, route: RouteSpec): RouteStanding {
  if (route.kind === "direct") {
    const target = serviceTargetOf(route.endpoint);
    if (target === null || target.kind !== "direct") return { status: "blocked", because: "an endpoint is an absolute HTTPS or WSS URL" };
    return { status: "ready", target };
  }
  const mediation = fold.mediations.mediations.get(route.mediationId);
  if (mediation === undefined) return { status: "waiting", because: `no arrangement ${route.mediationId} is recorded here` };
  if (mediation.status === "pending") return { status: "waiting", because: `the arrangement ${route.mediationId} is ${mediation.mediatorDid === null ? "not created here" : mediation.routingDid === null ? "not granted" : "not checked against the seed"} yet` };
  if (mediation.status !== "usable" || mediation.mediatorDid === null) return { status: "blocked", because: `the arrangement ${route.mediationId} is ${mediation.retired !== null ? `retired: ${mediation.retired}` : `in conflict: ${mediation.faults.join("; ")}`}` };
  const mediator = canonicalDid(mediation.mediatorDid);
  const routingDid = isShortForm(mediator) ? knownLongForms(fold)(mediator) : mediator;
  if (routingDid === null) return { status: "waiting", because: `no long form of ${mediator} is in evidence` };
  return { status: "ready", target: { kind: "mediated", routingDid } };
}

/** The target of `routeStanding`; `UnknownEntity` for an arrangement not recorded here and `Unusable` while the route does not carry. */
export function routeTargetOf(fold: VaultFold, route: RouteSpec): RouteTarget {
  const standing = routeStanding(fold, route);
  if (standing.status === "ready") return standing.target;
  if (route.kind === "direct") throw new Unusable("endpoint", route.endpoint, [standing.because]);
  if (!fold.mediations.mediations.has(route.mediationId)) throw new UnknownEntity("mediation", route.mediationId);
  throw new Unusable("mediation", route.mediationId, [standing.because]);
}

/**
 * The route a recorded document names, as `RouteSpec` names it: the
 * arrangement its routing DID derives, whichever spelling the document
 * names, or its endpoint. Null while the document names no one route.
 */
export function namedRouteOf(entity: LocalDidEntity): RouteSpec | null {
  const target = entity.routeTarget;
  if (target === null) return null;
  return target.kind === "direct" ? { kind: "direct", endpoint: target.endpoint } : { kind: "mediated", mediationId: mediationIdOf(target.routingDid) };
}

/** The route that carries a recorded entity now: the one its document names, unless that is an arrangement which is not usable. */
export function routeOf(entity: LocalDidEntity): RouteSpec | null {
  const route = namedRouteOf(entity);
  return route?.kind === "mediated" && entity.mediation === null ? null : route;
}

export function sameRoute(a: RouteSpec | null, b: RouteSpec): boolean {
  if (a === null) return false;
  return a.kind === "direct" ? b.kind === "direct" && a.endpoint === b.endpoint : b.kind === "mediated" && a.mediationId === b.mediationId;
}

/**
 * A recorded entity read back as it was minted: the committed
 * spellings, and the input document its long form encodes. Nothing is
 * rebuilt from the evidence as it stands now, whose reported spellings
 * change as earlier events are merged in, so what is returned is what
 * was committed. Refused in conflict, and for a route its document
 * does not name.
 */
export function recordedDid(entity: LocalDidEntity, route: RouteSpec | null): MintedDid {
  if (entity.conflict || entity.created === null) throw new EntityConflict("DID", entity.didId, entity.faults.join("; "));
  if (route !== null && !sameRoute(namedRouteOf(entity), route)) throw new EntityConflict("DID", entity.didId, "another route");
  return { didId: entity.didId, did: entity.created.did, longFormDid: entity.created.longFormDid, inputDocument: decodeLongForm(entity.created.longFormDid) as JsonObject };
}

export interface CreatedDid {
  created: VaultEvent<"did.created">;
  minted: MintedDid;
  /** the entity was recorded already, with exactly this document: nothing was written */
  existed: boolean;
}

const ENTRY: DidGeneration = { kind: "entry", profile: GENERATION_PROFILE };

/**
 * `did.created` of an entry for a route: the fixed keys derived from
 * the entity ID, the numalgo-4 document built over them and the route's
 * target, the short form and long form committed. The same ID again
 * returns the entity as recorded, when its document names the route and
 * it is an entry, and writes nothing. A successor is not made here: the
 * rotation makes it, from the recipe the fold names.
 */
export async function createDid(runtime: VaultRuntime, keys: Keys, route: RouteSpec, didId = uuidv7() as DidId): Promise<CreatedDid> {
  let minted!: MintedDid;
  const { fold, events } = await decide(runtime, keys, async (fold) => {
    const existing = fold.dids.entities.get(didId);
    if (existing !== undefined) {
      minted = recordedDid(existing, route);
      if (existing.created!.generation.kind !== "entry") throw new EntityConflict("DID", didId, `a ${existing.created!.generation.kind}, not an entry`);
      return [];
    }
    minted = await mintDid(keys, didId, routeTargetOf(fold, route));
    return [vaultDraft("did.created", { didId, did: minted.did, longFormDid: minted.longFormDid, generation: ENTRY })];
  });
  const created = events[0] as VaultEvent<"did.created"> | undefined;
  return created === undefined
    ? { created: fold.set.of("did.created").find((event) => event.data.didId === didId) as VaultEvent<"did.created">, minted, existed: true }
    : { created, minted, existed: false };
}

export interface Disclosure {
  as: DisclosureAs;
  goal?: string | null;
  /**
   * The invitation's ID, for an `oob` disclosure; a fresh UUIDv7 when
   * left out. An ID names one disclosure in the whole vault: given
   * again with the same DID and goal it republishes that invitation,
   * given with anything else it is refused.
   */
  oobId?: string;
}

export interface Disclosed {
  disclosed: VaultEvent<"did.disclosed">;
  /** the entity's long form: what the disclosure exposes */
  longFormDid: Did;
  /** the out-of-band invitation an `oob` disclosure is carried by; null for the other kinds */
  invitation: Invitation | null;
}

/** The out-of-band invitation that discloses `longFormDid` under `oobId`. */
export function invitationOf(longFormDid: Did, oobId: string, goal: string | null): Invitation {
  return { type: OOB_INVITATION, id: oobId, typ: PLAIN_TYP, from: longFormDid, body: { goal_code: GOAL_CONNECT, ...(goal === null ? {} : { goal }), accept: ["didcomm/v2"] } };
}

function requireLive(entity: LocalDidEntity): void {
  if (!entity.live) throw new Unusable("DID", entity.didId, entity.retired !== null ? [`retired: ${entity.retired}`, ...entity.faults] : entity.faults);
}

/** An address of a private branch is the one peer's: disclosing it would hand the branch to anyone, so a new entry is disclosed instead. */
function requireEntry(fold: VaultFold, entity: LocalDidEntity): void {
  const lineage = fold.dids.lineage(entity.didId);
  if (lineage.status !== "entry") throw new Unusable("DID", entity.didId, [`only an entry is disclosed, and this address is ${lineage.status === "branch" ? "in a private branch" : `of ${lineage.status} generation`}: create an entry to disclose`]);
}

/**
 * `did.disclosed` for a live entry, and the invitation when it is an
 * `oob` one. A mediated address is added, over `link`, to the account
 * of the one arrangement that routes it, which needs the runtime's
 * `confirmations`, and refused unless the mediator holds it. A direct
 * address needs neither.
 * The addition and the commit run as the account's one procedure at a
 * time, the addition outside the writer lock and the entity's liveness
 * read again under it. An
 * invitation already recorded under the same `oobId` is republished:
 * its disclosure is returned and nothing written, so that a retry
 * after a lost result cannot record the one invitation twice.
 */
export async function disclose(link: MediatorLink | null, runtime: VaultRuntime, keys: Keys, didId: DidId, disclosure: Disclosure, confirmations: Confirmations | null = null): Promise<Disclosed> {
  const fold = await scanVault(runtime.vault, keys);
  const entity = didOf(fold, didId);
  requireLive(entity);
  requireEntry(fold, entity);
  const created = entity.created as VaultData["did.created"];
  const route = routeOf(entity);
  const goal = disclosure.goal ?? null;
  const oobId = disclosure.as === "oob" ? (disclosure.oobId ?? uuidv7()) : null;
  const data: VaultData["did.disclosed"] = { didId, as: disclosure.as, oobId, goal };
  const commit = async (): Promise<VaultEvent<"did.disclosed">> => {
    const { fold, events } = await decide(runtime, keys, (fold) => {
      requireLive(didOf(fold, didId));
      return oobId !== null && invitationDisclosureOf(fold, oobId, data) !== null ? [] : [vaultDraft("did.disclosed", data)];
    });
    return (events[0] as VaultEvent<"did.disclosed"> | undefined) ?? (invitationDisclosureOf(fold, oobId as string, data) as VaultEvent<"did.disclosed">);
  };
  let disclosed: VaultEvent<"did.disclosed">;
  if (route?.kind === "mediated") {
    const { mediationId } = route;
    if (link === null) throw new WrongMediator(mediationOf(fold, mediationId).mediatorDid ?? "unknown", "no link");
    disclosed = await serially(runtime, mediationId, async () => {
      const current = await scanVault(runtime.vault, keys);
      requireLive(didOf(current, didId));
      if (!(await heldByMediator(link, runtime, keys, mediationId, created.did, confirmations))) throw new Unregistered(created.did);
      return commit();
    });
  } else {
    disclosed = await commit();
  }
  return { disclosed, longFormDid: created.longFormDid, invitation: oobId === null ? null : invitationOf(created.longFormDid, oobId, goal) };
}

async function heldByMediator(link: MediatorLink, runtime: VaultRuntime, keys: Keys, mediationId: MediationId, did: Did, confirmations: Confirmations | null): Promise<boolean> {
  if (confirmations === null) throw new Unusable("mediation", mediationId, ["a mediated address is disclosed with the runtime's confirmations"]);
  return holds(await addRecipientsNow(link, runtime, keys, confirmations, mediationId), did);
}

function invitationDisclosureOf(fold: VaultFold, oobId: string, data: VaultData["did.disclosed"]): VaultEvent<"did.disclosed"> | null {
  const recorded = fold.set.of("did.disclosed").filter((event) => event.data.oobId === oobId);
  if (recorded.length === 0) return null;
  const existing = recorded[0] as VaultEvent<"did.disclosed">;
  if (recorded.length > 1) throw new EntityConflict("invitation", oobId, "disclosed more than once");
  if (existing.data.didId !== data.didId || existing.data.goal !== data.goal) {
    throw new EntityConflict("invitation", oobId, existing.data.didId !== data.didId ? `another DID, ${existing.data.didId}` : "another goal");
  }
  return existing;
}

/** `did.retired` for an entity, `because`: terminal for new sending and disclosure. Already retired, the first retirement is returned and nothing written. */
export async function retireDid(runtime: VaultRuntime, keys: Keys, didId: DidId, because: string): Promise<VaultEvent<"did.retired">> {
  const { fold, events } = await decide(runtime, keys, (fold) => (didOf(fold, didId).retired === null ? [vaultDraft("did.retired", { didId, because })] : []));
  return (events[0] as VaultEvent<"did.retired"> | undefined) ?? (fold.set.of("did.retired").find((event) => event.data.didId === didId) as VaultEvent<"did.retired">);
}
