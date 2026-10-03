/**
 * Communication DIDs: an entity minted from its ID and a route alone, a
 * mediation arrangement or a direct endpoint, so a committed ID reuses
 * its exact keys and document after a crash and is not recreated for
 * another route; the disclosure that reveals an address, its mediated
 * registration verified first; and the retirement that ends new sending
 * and disclosure at it. Where a DID sends is read back from its
 * document, never recorded beside it. Every decision is taken over the
 * fold under the lock.
 */

import { v7 as uuidv7 } from "uuid";

import type { VaultRuntime } from "@estoc/event-store";
import {
  mintDid,
  scanVault,
  serviceTargetOf,
  vaultDraft,
  type Did,
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

/** The route a DID is minted for: a mediation arrangement by its ID, or a direct HTTPS or WSS endpoint. */
export type RouteSpec = { kind: "mediated"; mediationId: MediationId } | { kind: "direct"; endpoint: string };

export function didOf(fold: VaultFold, didId: DidId): LocalDidEntity {
  const entity = fold.dids.entities.get(didId);
  if (entity === undefined) throw new UnknownEntity("DID", didId);
  return entity;
}

/**
 * Where a route sends, once it can carry a DID: the routing DID of a
 * usable arrangement that no other usable arrangement shares, since a
 * document names the routing DID alone and two accounts behind it
 * would leave undecidable which one holds the address; or the endpoint
 * itself. `Unusable` otherwise.
 */
export function routeTargetOf(fold: VaultFold, route: RouteSpec): RouteTarget {
  if (route.kind === "direct") {
    const target = serviceTargetOf(route.endpoint);
    if (target === null || target.kind !== "direct") throw new Unusable("endpoint", route.endpoint, ["an endpoint is an absolute HTTPS or WSS URL"]);
    return target;
  }
  const mediation = mediationOf(fold, route.mediationId);
  if (mediation.status !== "usable" || mediation.routingDid === null) throw new Unusable("mediation", route.mediationId, mediation.faults.length > 0 ? mediation.faults : [mediation.status]);
  return usableTarget(fold, { kind: "mediated", routingDid: mediation.routingDid });
}

/** A target a DID may be minted for now: a direct endpoint, or a routing DID exactly one usable arrangement routes through. */
export function usableTarget(fold: VaultFold, target: RouteTarget): RouteTarget {
  if (target.kind === "direct") return target;
  const usable = fold.mediations.through(target.routingDid).filter((mediation) => mediation.status === "usable");
  if (usable.length === 1) return target;
  throw new Unusable("routing DID", target.routingDid, [usable.length === 0 ? "no usable arrangement routes through it" : `several arrangements route through it: ${usable.map((mediation) => mediation.mediationId).join(", ")}`]);
}

/** The route of a recorded entity, as `RouteSpec` names it: its one arrangement, or its endpoint. Null while the document names no one route or no one usable arrangement carries it. */
export function routeOf(entity: LocalDidEntity): RouteSpec | null {
  if (entity.routeTarget === null) return null;
  if (entity.routeTarget.kind === "direct") return { kind: "direct", endpoint: entity.routeTarget.endpoint };
  const mediationId = entity.mediations[0];
  return entity.mediations.length === 1 && mediationId !== undefined ? { kind: "mediated", mediationId } : null;
}

export interface CreatedDid {
  created: VaultEvent<"did.created">;
  minted: MintedDid;
  /** the entity was recorded already, with exactly this document: nothing was written */
  existed: boolean;
}

/**
 * `did.created` for a route: the fixed keys derived from the entity
 * ID, the numalgo-4 document built over them and the route's target,
 * the short form and long form committed. The same ID again returns
 * what was recorded when the seed and route give the same document; an
 * entity that would differ, or one in conflict, is refused rather than
 * replaced.
 */
export async function createDid(runtime: VaultRuntime, keys: Keys, route: RouteSpec, didId = uuidv7() as DidId): Promise<CreatedDid> {
  let minted!: MintedDid;
  const { fold, events } = await decide(runtime, keys, async (fold) => {
    minted = await mintDid(keys, didId, routeTargetOf(fold, route));
    const existing = fold.dids.entities.get(didId);
    if (existing !== undefined) {
      if (!sameDocument(existing, minted)) throw new EntityConflict("DID", didId, existing.conflict ? existing.faults.join("; ") : "another document or route");
      return [];
    }
    return [vaultDraft("did.created", { didId, did: minted.did, longFormDid: minted.longFormDid })];
  });
  const created = events[0] as VaultEvent<"did.created"> | undefined;
  return created === undefined
    ? { created: fold.set.of("did.created").find((event) => event.data.didId === didId) as VaultEvent<"did.created">, minted, existed: true }
    : { created, minted, existed: false };
}

/** Does the recorded entity carry exactly this document? The long form encodes the keys and the route, so equal spellings are the same entity on the same route. */
export function sameDocument(existing: LocalDidEntity, minted: MintedDid): boolean {
  return existing.created !== null && existing.created.did === minted.did && existing.created.longFormDid === minted.longFormDid;
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

/**
 * `did.disclosed` for a live entity, and the invitation when it is an
 * `oob` one. A mediated address is reconciled with the mediator of the
 * one arrangement that routes it, over `link`, and refused unless the
 * mediator holds it; one of a replica-mediation arrangement is added to
 * its account instead, which needs the runtime's `confirmations`. A
 * direct address needs neither.
 * The reconciliation and the commit run as the
 * account's one procedure at a time, the reconciliation outside the
 * writer lock and the entity's liveness read again under it. An
 * invitation already recorded under the same `oobId` is republished:
 * its disclosure is returned and nothing written, so that a retry
 * after a lost result cannot record the one invitation twice.
 */
export async function disclose(link: MediatorLink | null, runtime: VaultRuntime, keys: Keys, didId: DidId, disclosure: Disclosure, confirmations: Confirmations | null = null): Promise<Disclosed> {
  const fold = await scanVault(runtime.vault, keys);
  const entity = didOf(fold, didId);
  requireLive(entity);
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
