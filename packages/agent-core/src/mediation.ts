/**
 * Mediation arrangements as the vault records them. An arrangement is
 * created in the vault before the mediator is asked, so a network
 * failure leaves a retryable intent and never a half identity; what
 * the mediator then confirms — the account registered, this runtime's
 * replica added, each address held — is the enrollment's to record;
 * and the selection of the arrangement new mediated DIDs are minted
 * for is the vault's to record. Every step reads the fold and is safe
 * to repeat: what the events already say is not asked for again.
 */

import { v7 as uuidv7 } from "uuid";

import type { VaultRuntime } from "@estoc/event-store";
import { mediationKeyName, mintMediationDid, vaultDraft, type Did, type Keys, type Mediation, type MediationId, type VaultEvent, type VaultFold } from "@estoc/vault";

import { EntityConflict, UnknownEntity, Unusable, WrongAccount, WrongMediator } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { decide } from "./procedure.js";
import { sameDid } from "./same-did.js";

/** The arrangement as the fold has it; `UnknownEntity` when it has none. */
export function mediationOf(fold: VaultFold, mediationId: MediationId): Mediation {
  const mediation = fold.mediations.mediations.get(mediationId);
  if (mediation === undefined) throw new UnknownEntity("mediation", mediationId);
  return mediation;
}

/**
 * The link must be the arrangement's own: to its mediator, speaking as
 * its identity. Two arrangements with one mediator are two accounts
 * there, and a ritual run as one and recorded against the other would
 * grant, register and disclose under the wrong one.
 */
export function toward(link: MediatorLink, mediation: Mediation): void {
  if (mediation.mediatorDid !== null && !sameDid(mediation.mediatorDid, link.mediatorDid)) throw new WrongMediator(mediation.mediatorDid, link.mediatorDid);
  if (mediation.me !== null && !sameDid(mediation.me.did, link.me)) throw new WrongAccount(mediation.me.did, link.me);
}

/**
 * `mediation.created` for a new arrangement with `mediatorDid`: the
 * vault-controlled identity toward the mediator, minted from the
 * arrangement's own key name. Committed before any network request.
 * The same ID again returns the creation already recorded when it
 * says the same, and refuses one that says otherwise. The arrangement
 * is an account of the replica-mediation protocol at the mediator, and
 * is `enroll`ed there.
 */
export async function createMediation(runtime: VaultRuntime, keys: Keys, mediatorDid: Did, mediationId = uuidv7() as MediationId): Promise<VaultEvent<"mediation.created">> {
  const me = await mintMediationDid(keys, mediationId);
  const data = { mediationId, mediatorDid, me: { keyName: mediationKeyName(mediationId), did: me.longFormDid } };
  const { fold, events } = await decide(runtime, keys, (fold) => {
    const existing = fold.mediations.mediations.get(mediationId);
    if (existing === undefined) return [vaultDraft("mediation.created", data)];
    if (existing.mediatorDid !== data.mediatorDid || existing.me?.did !== data.me.did) {
      throw new EntityConflict("mediation", mediationId, existing.faults.join("; ") || "another mediator or identity");
    }
    return [];
  });
  return (events[0] as VaultEvent<"mediation.created"> | undefined) ?? (fold.set.of("mediation.created").find((event) => event.data.mediationId === mediationId) as VaultEvent<"mediation.created">);
}

/** `mediation.selected`: the arrangement policy prefers for new mediated routes. Needs a usable one; already the latest selection, nothing is written. */
export async function selectMediation(runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<VaultEvent<"mediation.selected"> | null> {
  const { events } = await decide(runtime, keys, (fold) => {
    const mediation = mediationOf(fold, mediationId);
    if (mediation.status !== "usable") throw new Unusable("mediation", mediationId, mediation.faults.length > 0 ? mediation.faults : [mediation.status]);
    return fold.mediations.selected === mediationId ? [] : [vaultDraft("mediation.selected", { mediationId })];
  });
  return (events[0] as VaultEvent<"mediation.selected"> | undefined) ?? null;
}
