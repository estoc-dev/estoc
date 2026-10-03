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

import { isLongForm } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store";
import { canonicalDidOf, mediationIdOf, mediationKeyName, mintMediationDid, sameDid, vaultDraft, type Did, type Keys, type Mediation, type MediationId, type VaultEvent, type VaultFold } from "@estoc/vault";

import { EntityConflict, UnknownEntity, Unusable, WrongAccount, WrongMediator } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { decide } from "./procedure.js";
import { knownLongForms } from "./resolver.js";

/** The arrangement as the fold has it; `UnknownEntity` when it has none. */
export function mediationOf(fold: VaultFold, mediationId: MediationId): Mediation {
  const mediation = fold.mediations.mediations.get(mediationId);
  if (mediation === undefined) throw new UnknownEntity("mediation", mediationId);
  return mediation;
}

/**
 * The link must be the arrangement's own: to its mediator, speaking as
 * its identity. A ritual run over another account's link and recorded
 * against this arrangement would grant, register and disclose under
 * the wrong one.
 */
export function toward(link: MediatorLink, mediation: Mediation): void {
  if (mediation.mediatorDid !== null && !sameDid(mediation.mediatorDid, link.mediatorDid)) throw new WrongMediator(mediation.mediatorDid, link.mediatorDid);
  if (mediation.me !== null && !sameDid(mediation.me.did, link.me)) throw new WrongAccount(mediation.me.did, link.me);
}

/**
 * `mediation.created` for the arrangement with `mediatorDid`, under the
 * ID the mediator's DID derives: the vault-controlled identity toward
 * the mediator, minted from the arrangement's own key name. Committed
 * before any network request. The same mediator again, under either
 * spelling of its DID, returns the creation already recorded, since
 * every replica derives the same one; an arrangement whose grant
 * arrived before any creation takes this one; and a recorded
 * arrangement that is in conflict is refused. A did:peer:4 long form
 * is validated against its hash, and when it is the first long form
 * of a mediator so far in evidence by its short form alone it is
 * recorded as one more creation of the same arrangement, so that the
 * mediator resolves from here on. The arrangement is an account of
 * the replica-mediation protocol at the mediator, and is `enroll`ed
 * there.
 */
export async function createMediation(runtime: VaultRuntime, keys: Keys, mediatorDid: Did): Promise<VaultEvent<"mediation.created">> {
  const mediationId = mediationIdOf(mediatorDid);
  const mediator = canonicalDidOf(mediatorDid);
  const me = await mintMediationDid(keys, mediationId);
  const data = { mediationId, mediatorDid, me: { keyName: mediationKeyName(mediationId), did: me.longFormDid } };
  const { fold, events } = await decide(runtime, keys, (fold) => {
    const existing = fold.mediations.mediations.get(mediationId);
    if (existing === undefined || (existing.me === null && existing.faults.length === 0)) return [vaultDraft("mediation.created", data)];
    if (existing.mediatorDid === null || !sameDid(existing.mediatorDid, data.mediatorDid) || existing.me?.did !== data.me.did) {
      throw new EntityConflict("mediation", mediationId, existing.faults.join("; ") || "another mediator or identity");
    }
    return isLongForm(mediatorDid) && knownLongForms(fold)(mediator) === null ? [vaultDraft("mediation.created", data)] : [];
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
