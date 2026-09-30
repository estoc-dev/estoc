/**
 * The invitations: each OOB disclosure of one of our DIDs, read with
 * whether the disclosed DID may still take a first message under it.
 * An invitation is an address handed out, not a token: whoever holds
 * it writes to the disclosed DID in a pair of their own, and no
 * receipt under it takes anything from the next one. The fold records
 * nothing of who used it; that is the channels' business. It is
 * available while the disclosed DID is live on a route that may
 * deliver, and unavailable once the DID or its route ended or while
 * one of them waits on something that may recover.
 */

import type { VaultEvent } from "../schema.js";
import type { Did, DidId, EventCid } from "../types.js";
import type { LocalDidEntity, RouteFold } from "./routes.js";
import type { VaultEventSet } from "./set.js";

export type InvitationStatus = { status: "available" } | { status: "unavailable"; because: string };

export interface Invitation {
  readonly disclosure: VaultEvent<"did.disclosed">;
  readonly oobId: string;
  readonly didId: DidId;
  /** the disclosed DID's short form, once its entity reads consistently */
  readonly localDid: Did | null;
  readonly status: InvitationStatus;
}

export interface InvitationFold {
  /** each OOB disclosure, by its event */
  readonly invitations: ReadonlyMap<EventCid, Invitation>;
}

export function foldInvitations(set: VaultEventSet, routes: RouteFold): InvitationFold {
  const invitations = new Map<EventCid, Invitation>();
  for (const disclosure of set.of("did.disclosed")) {
    if (disclosure.data.as !== "oob") continue;
    const entity = routes.dids.get(disclosure.data.didId);
    invitations.set(disclosure.cid, {
      disclosure,
      oobId: disclosure.data.oobId!,
      didId: disclosure.data.didId,
      localDid: entity?.created?.did ?? null,
      status: statusOf(entity, routes),
    });
  }
  return { invitations };
}

function statusOf(entity: LocalDidEntity | undefined, routes: RouteFold): InvitationStatus {
  const unavailable = (because: string): InvitationStatus => ({ status: "unavailable", because });
  if (entity === undefined || entity.created === null) return unavailable("the disclosed DID has no consistent creation here");
  if (entity.conflict) return unavailable(`the disclosed DID is in conflict: ${entity.faults[0]}`);
  if (entity.retired !== null) return unavailable("the disclosed DID is retired");
  const route = routes.routes.get(entity.created.boundRouteId);
  if (route?.terminal === true) {
    if (route.retired !== null) return unavailable("the bound route is retired");
    if (route.conflict) return unavailable("the bound route's configurations disagree");
    return unavailable("the bound route's mediation is terminal");
  }
  return entity.live ? { status: "available" } : unavailable(entity.faults[0]!);
}
