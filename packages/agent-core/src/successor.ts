/**
 * The successor a rotation makes from its recipe, and whether this
 * runtime may make it. The recipe fixes the entity ID and the
 * generation; the route is the predecessor's own, read off its
 * document, so that two replicas rotating from one address arrive at
 * one document whatever arrangement either prefers. An entity recorded
 * already under that ID is reused only when it is exactly what would
 * be made now, document and generation alike; anything else under the
 * ID is refused, since a second creation would put the entity in
 * conflict and a successor minted under another ID would part the
 * replicas. A mediated predecessor is continued by a replica of the
 * arrangement that routes it: the successor inherits the route, so the
 * runtime committing the rotation must be the one picking up there,
 * and no other replica's membership stands in for its own.
 */

import { generationOf, mintDid, recipeDidId, samePayload, vaultDraft, type Keys, type LocalDidEntity, type MintedDid, type ReplicaId, type SuccessorRecipe, type VaultDraft, type VaultFold } from "@estoc/vault";

import { namedRouteOf, recordedDid, routeTargetOf } from "./dids.js";
import { EntityConflict, Unusable } from "./errors.js";

/** Why this runtime cannot commit a rotation away from the predecessor, null when it can. */
export function ineligibleHere(fold: VaultFold, author: ReplicaId, predecessor: LocalDidEntity): string | null {
  const route = namedRouteOf(predecessor);
  if (route === null || route.kind === "direct") return null;
  const replica = fold.replicas.replicas.get(author);
  if (replica === undefined) return `this runtime is not enrolled in the arrangement ${route.mediationId}, which routes the predecessor`;
  if (replica.mediationId !== route.mediationId) return `this runtime is a replica of the arrangement ${replica.mediationId}, not of ${route.mediationId}, which routes the predecessor`;
  if (replica.status !== "member") return `this runtime's replica in the arrangement ${route.mediationId} is ${replica.status}: ${replica.faults[0] ?? "not yet a member"}`;
  return null;
}

/**
 * The successor the recipe names, on the predecessor's route: minted
 * and drafted when no entity holds its ID, read back as recorded when
 * one holds it with exactly this document and generation and is live.
 */
export async function materializeSuccessor(fold: VaultFold, keys: Keys, predecessor: LocalDidEntity, recipe: SuccessorRecipe): Promise<{ drafts: VaultDraft[]; successor: MintedDid }> {
  const didId = recipeDidId(recipe);
  const generation = generationOf(recipe);
  const route = namedRouteOf(predecessor);
  if (route === null) throw new Unusable("DID", predecessor.didId, ["its document names no route a successor could inherit"]);
  const minted = await mintDid(keys, didId, routeTargetOf(fold, route));
  const existing = fold.dids.entities.get(didId);
  if (existing === undefined) return { drafts: [vaultDraft("did.created", { didId, did: minted.did, longFormDid: minted.longFormDid, generation })], successor: minted };
  if (existing.conflict || existing.created === null) throw new EntityConflict("DID", didId, existing.faults.join("; "));
  if (existing.created.longFormDid !== minted.longFormDid) throw new EntityConflict("DID", didId, "another document");
  if (!samePayload(existing.created.generation, generation)) throw new EntityConflict("DID", didId, "another generation");
  if (!existing.live) throw new Unusable("DID", didId, existing.retired !== null ? [`retired: ${existing.retired}`, ...existing.faults] : existing.faults);
  return { drafts: [], successor: recordedDid(existing, route) };
}
