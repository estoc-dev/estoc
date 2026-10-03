/**
 * The decision a rotation away from a pair reuses: the one already
 * recorded from that local DID anywhere in its verified peer-only
 * context. Several that pass, or one the evidence contradicts, leave
 * no room for another; one still waiting for evidence defers the
 * rotation; one refused for good is ignored, as it never enters the
 * graph.
 */

import type { Decision } from "./fold/channels.js";
import type { VaultFold } from "./fold/vault.js";
import { channelOf } from "./ids.js";
import type { Did } from "./types.js";

export type ExistingDecision = { status: "none" } | { status: "reuse"; decision: Decision } | { status: "defer"; decision: Decision; because: string } | { status: "conflict"; decisions: readonly Decision[]; because: string };

export function decisionFor(fold: VaultFold, localDid: Did, peerDid: Did): ExistingDecision {
  const decisions = fold.continuity.decisionsIn(channelOf(localDid, peerDid)).filter(({ status }) => status.status !== "invalid");
  const conflict = (because: string): ExistingDecision => ({ status: "conflict", decisions, because });
  for (const decision of decisions) {
    if (decision.status.status === "conflict") return conflict(decision.status.because);
    const continuity = fold.continuity.status(decision.event.cid);
    if (continuity.status === "conflict") return conflict(continuity.because);
  }
  for (const decision of decisions) if (decision.status.status === "pending") return { status: "defer", decision, because: decision.status.because };
  if (decisions.length > 1) return conflict("several decisions rotate away from the local DID in this context");
  return decisions.length === 1 ? { status: "reuse", decision: decisions[0]! } : { status: "none" };
}
