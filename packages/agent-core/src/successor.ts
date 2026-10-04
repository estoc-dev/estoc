/**
 * The successor a rotation makes from its recipe, and whether this
 * runtime can make it now. The recipe fixes the entity ID and the
 * generation; the route is the predecessor's own, read off its
 * document, so that two replicas rotating from one address arrive at
 * one document whatever arrangement either prefers. A mediated
 * predecessor is continued by a replica of the arrangement that routes
 * it: the successor inherits the route, so the runtime committing the
 * rotation must be the one picking up there, and no other replica's
 * membership stands in for its own; and the route must carry, since a
 * document is minted over where it sends. An entity recorded already
 * under the successor's ID is reused only when it is exactly what would
 * be made now, generation, route and document alike, and live; anything
 * else under the ID stops the rotation, since a second creation would
 * put the entity in conflict and a successor minted under another ID
 * would part the replicas. The standing is read off the fold alone, so
 * that what is offered by hand is a rotation that commits, and read
 * again under the lock before it does.
 */

import { generationOf, mintDid, recipeDidId, samePayload, vaultDraft, type Keys, type LocalDidEntity, type MediationId, type MintedDid, type ReplicaId, type RouteTarget, type SuccessorRecipe, type VaultDraft, type VaultFold } from "@estoc/vault";

import { namedRouteOf, routeStanding, sameRoute, type RouteSpec } from "./dids.js";
import { EntityConflict, Unusable } from "./errors.js";

/** Ready with the route the successor inherits and where it sends; waiting while evidence may still arrive; blocked where this runtime cannot make the successor at all. */
export type SuccessorStanding = { status: "ready"; route: RouteSpec; target: RouteTarget } | { status: "waiting"; because: string } | { status: "blocked"; because: string };

export function successorStanding(fold: VaultFold, author: ReplicaId, predecessor: LocalDidEntity, recipe: SuccessorRecipe): SuccessorStanding {
  const blocked = (because: string): SuccessorStanding => ({ status: "blocked", because });
  const route = namedRouteOf(predecessor);
  if (route === null) return blocked(`the document of ${predecessor.didId} names no route a successor could inherit`);
  const ineligible = route.kind === "mediated" ? ineligibleHere(fold, author, route.mediationId) : null;
  if (ineligible !== null) return blocked(ineligible);
  const carried = routeStanding(fold, route);
  if (carried.status !== "ready") return { status: carried.status, because: `the predecessor's route does not carry: ${carried.because}` };
  const didId = recipeDidId(recipe);
  const existing = fold.dids.entities.get(didId);
  if (existing === undefined) return { status: "ready", route, target: carried.target };
  if (existing.conflict || existing.created === null) return blocked(`the successor's ID ${didId} is held by an entity in conflict: ${existing.faults.join("; ")}`);
  if (!samePayload(existing.created.generation, generationOf(recipe))) return blocked(`the successor's ID ${didId} is held by an entity of another generation`);
  if (!sameRoute(namedRouteOf(existing), route)) return blocked(`the successor's ID ${didId} is held by an entity on another route`);
  if (!existing.live) return blocked(`the successor ${didId} is recorded already and is not live: ${existing.retired !== null ? `retired: ${existing.retired}` : existing.faults.join("; ")}`);
  return { status: "ready", route, target: carried.target };
}

function ineligibleHere(fold: VaultFold, author: ReplicaId, mediationId: MediationId): string | null {
  const replica = fold.replicas.replicas.get(author);
  if (replica === undefined) return `this runtime is not enrolled in the arrangement ${mediationId}, which routes the predecessor`;
  if (replica.mediationId !== mediationId) return `this runtime is a replica of the arrangement ${replica.mediationId}, not of ${mediationId}, which routes the predecessor`;
  if (replica.status !== "member") return `this runtime's replica in the arrangement ${mediationId} is ${replica.status}: ${replica.faults[0] ?? "not yet a member"}`;
  return null;
}

/**
 * The successor the recipe names, on the predecessor's route: minted
 * and drafted when no entity holds its ID, the one recorded when an
 * entity holds it with exactly this document. `Unusable` while the
 * standing is not ready.
 */
export async function materializeSuccessor(fold: VaultFold, keys: Keys, author: ReplicaId, predecessor: LocalDidEntity, recipe: SuccessorRecipe): Promise<{ drafts: VaultDraft[]; successor: MintedDid }> {
  const standing = successorStanding(fold, author, predecessor, recipe);
  if (standing.status !== "ready") throw new Unusable("DID", predecessor.didId, [standing.because]);
  const minted = await mintDid(keys, recipeDidId(recipe), standing.target);
  const existing = fold.dids.entities.get(minted.didId)?.created ?? null;
  if (existing !== null && existing.longFormDid !== minted.longFormDid) throw new EntityConflict("DID", minted.didId, "another document");
  return { drafts: existing === null ? [vaultDraft("did.created", { didId: minted.didId, did: minted.did, longFormDid: minted.longFormDid, generation: generationOf(recipe) })] : [], successor: minted };
}
