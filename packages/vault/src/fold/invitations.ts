/**
 * The invitations: each OOB disclosure of one of our DIDs, read with
 * whether the disclosed DID may still take a first message under it.
 * An invitation is an address handed out, not a token: whoever holds
 * it writes to the disclosed DID in a pair of their own, and no
 * receipt under it takes anything from the next one. The fold records
 * nothing of who used it; that is the channels' business. It is
 * available while the disclosed DID is live through an arrangement
 * that may deliver, and unavailable once the DID or its arrangement
 * ended or while one of them waits on something that may recover. An ID that two
 * merged histories each disclosed names no one invitation to hand out
 * again: every disclosure under it is unavailable, none wins by order,
 * and the DIDs and whatever was received at them are as they were.
 */

import type { VaultEvent } from "../schema.js";
import type { Did, DidId, EventCid } from "../types.js";
import type { LocalDidEntity, DidFold } from "./dids.js";
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

export function foldInvitations(set: VaultEventSet, dids: DidFold): InvitationFold {
  const disclosures = set.of("did.disclosed").filter((disclosure) => disclosure.data.as === "oob");
  const disclosedUnder = new Map<string, number>();
  for (const { data } of disclosures) disclosedUnder.set(data.oobId!, (disclosedUnder.get(data.oobId!) ?? 0) + 1);
  const invitations = new Map<EventCid, Invitation>();
  for (const disclosure of disclosures) {
    const oobId = disclosure.data.oobId!;
    const entity = dids.entities.get(disclosure.data.didId);
    invitations.set(disclosure.cid, {
      disclosure,
      oobId,
      didId: disclosure.data.didId,
      localDid: entity?.created?.did ?? null,
      status: disclosedUnder.get(oobId)! > 1 ? { status: "unavailable", because: "the invitation's ID names more than one disclosure" } : statusOf(entity, dids),
    });
  }
  return { invitations };
}

function statusOf(entity: LocalDidEntity | undefined, dids: DidFold): InvitationStatus {
  const unavailable = (because: string): InvitationStatus => ({ status: "unavailable", because });
  if (entity === undefined || entity.created === null) return unavailable("the disclosed DID has no consistent creation here");
  if (entity.conflict) return unavailable(`the disclosed DID is in conflict: ${entity.faults[0]}`);
  if (entity.retired !== null) return unavailable("the disclosed DID is retired");
  if (dids.receipt(entity.didId) === "terminal") return unavailable("the disclosed DID's mediation is terminal");
  return entity.live ? { status: "available" } : unavailable(entity.faults[0]!);
}
