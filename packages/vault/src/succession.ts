/**
 * What a successor of one of our DIDs toward one peer is made from,
 * read off the fold alone so that every replica deciding the same
 * rotation arrives at the same entity. An entry takes a start, bound to
 * the peer's address the usable history leads back to from the pair;
 * an address in a branch takes a next, once the usable history leads
 * from the branch's anchor to the pair, since a branch address the pair
 * is not shown to belong to is given to no other relationship by an
 * ordinary rotation. Nothing here reads a preference, a trigger or the
 * runtime: the choice waits where evidence is missing and refuses where
 * evidence contradicts, and what a runtime can do with it is checked
 * beside.
 */

import type { FactKey } from "@estoc/continuity";

import { describeFacts } from "./fold/continuity.js";
import type { VaultFold } from "./fold/vault.js";
import { GENERATION_PROFILE, startDidId, successorDidId } from "./ids.js";
import type { Channel, Did, DidGeneration, DidId } from "./types.js";

/** The inputs of a successor under this version's profile: a start of an entry toward a peer, or a next of a branch address. */
export type SuccessorRecipe = { kind: "start"; predecessor: Did; binding: Did } | { kind: "next"; predecessor: Did };

export const recipeDidId = (recipe: SuccessorRecipe): DidId => (recipe.kind === "start" ? startDidId(recipe.predecessor, recipe.binding) : successorDidId(recipe.predecessor));

export const generationOf = (recipe: SuccessorRecipe): DidGeneration => ({ ...recipe, profile: GENERATION_PROFILE });

/**
 * Ready with the recipe and the facts the choice rests on; waiting
 * while evidence that may still arrive is missing, a predecessor's
 * creation or the path from the branch's anchor to the pair; blocked
 * where the evidence contradicts, a conflict in the history or
 * generations that do not read.
 */
export type SuccessorChoice = { status: "ready"; recipe: SuccessorRecipe; support: readonly FactKey[] } | { status: "waiting"; because: string } | { status: "blocked"; because: string };

export function successorRecipe(fold: Pick<VaultFold, "dids" | "continuity">, channel: Channel): SuccessorChoice {
  const didId = fold.dids.entityOfDid(channel.localDid);
  if (didId === null) return { status: "blocked", because: `${channel.localDid} is no consistent DID of ours` };
  const lineage = fold.dids.lineage(didId);
  switch (lineage.status) {
    case "pending":
      return { status: "waiting", because: `the generation of ${channel.localDid} waits: ${lineage.because}` };
    case "unsupported":
      return { status: "blocked", because: `${channel.localDid} was made under profile ${lineage.profile}, which this version does not continue` };
    case "invalid":
      return { status: "blocked", because: `the generation of ${channel.localDid} is invalid: ${lineage.because}` };
    case "entry": {
      const root = fold.continuity.peerRoot(channel);
      if (root.status === "conflict") return { status: "blocked", because: `the peer's start is not decidable: ${root.because}` };
      return { status: "ready", recipe: { kind: "start", predecessor: channel.localDid, binding: root.peerDid }, support: root.support };
    }
    case "branch": {
      const path = fold.continuity.model.path(lineage.anchor, channel);
      if (path.status === "conflict") return { status: "blocked", because: `the history from the branch's anchor to the pair is in conflict at ${describeFacts(path.facts)}` };
      if (path.status === "none") return { status: "waiting", because: `no usable history leads from the branch's anchor, ${lineage.anchor.localDid} toward ${lineage.anchor.peerDid}, to the pair` };
      return { status: "ready", recipe: { kind: "next", predecessor: channel.localDid }, support: path.support };
    }
  }
}
