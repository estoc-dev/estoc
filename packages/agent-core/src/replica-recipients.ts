/**
 * The communication DIDs a replica-mediation account holds at its
 * mediator. Each is added by a request of its own, carrying a proof the
 * DID itself signed, and is never taken off again here: retiring a DID
 * ends new sending and disclosure at it, not the delivery of what is
 * still addressed to it. That the mediator added one is kept beside the
 * vault, like the replica's own enrollment, so a connection asks only
 * for what has no confirmation yet; a confirmation lost costs one more
 * request, which the mediator answers as it did the first.
 *
 * Nothing is added before the mediator confirmed this runtime's own
 * replica. A mediator hands mail for a shared address to the replicas
 * the account has when the mail arrives, and to no replica added
 * later, so an address held before this replica is one whose mail this
 * runtime never sees.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { scanVault, signRecipientProof, type Did, type DidId, type Keys, type LocalDidEntity, type MediationId, type VaultData, type VaultFold } from "@estoc/vault";

import { RECIPIENT_ADD, RECIPIENT_ADDED } from "./protocol/replica-mediation.js";
import { MediatorRefused, Unusable } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { toward } from "./mediation.js";
import { serially } from "./procedure.js";
import { accountOf, confirmed, control, echoes, replicaAdded, type Confirmations } from "./replica-enrollment.js";

const recipientAddedKey = (mediationId: MediationId, didId: DidId): string => `replica-mediation/recipient-added/${mediationId}/${didId}`;

type SharedAddress = LocalDidEntity & { created: VaultData["did.created"] };

/**
 * The DIDs the account is to hold: every entity bound to a route over
 * the arrangement that may still receive, retired or not, whose keys
 * the seed derives. By short form, in order.
 */
function sharedAddresses(fold: VaultFold, mediationId: MediationId): SharedAddress[] {
  const addresses: SharedAddress[] = [];
  for (const entity of fold.routes.dids.values()) {
    if (entity.created === null || entity.identity !== "verified" || fold.routes.receipt(entity.didId) === "terminal") continue;
    const route = fold.routes.routes.get(entity.created.boundRouteId)?.configured;
    if (route?.kind === "mediated" && route.mediationId === mediationId) addresses.push(entity as SharedAddress);
  }
  return addresses.sort((a, b) => (a.created.did < b.created.did ? -1 : a.created.did > b.created.did ? 1 : 0));
}

export interface RecipientsAdded {
  mediationId: MediationId;
  /** the DIDs the account is to hold, by short form */
  wanted: Did[];
  /** those this run asked for and the mediator confirmed */
  added: Did[];
  /** those the mediator would not add, and what it said: each is asked for again by the next run */
  refused: { did: Did; because: string }[];
}

/** Does the mediator hold `did` for the account as of this run? */
export function holds(recipients: RecipientsAdded, did: Did): boolean {
  return recipients.wanted.includes(did) && !recipients.refused.some((refusal) => refusal.did === did);
}

/**
 * One recipient-add for each DID the account is to hold that has no
 * confirmation kept. Needs a replica-mediation arrangement toward the
 * link's mediator, its account registered and this runtime's replica
 * confirmed added. A DID the mediator refuses stops none of the others;
 * a request that gets no answer throws, and leaves what was confirmed
 * before it confirmed. Runs as the account's one procedure at a time.
 * `proceed` is called before each request is begun and stops the run
 * there by throwing.
 */
export function addRecipients(link: MediatorLink, runtime: VaultRuntime, keys: Keys, confirmations: Confirmations, mediationId: MediationId, proceed: () => void = () => {}): Promise<RecipientsAdded> {
  return serially(runtime, mediationId, () => addRecipientsNow(link, runtime, keys, confirmations, mediationId, proceed));
}

/** `addRecipients` for a caller that already holds the account's turn. */
export async function addRecipientsNow(link: MediatorLink, runtime: VaultRuntime, keys: Keys, confirmations: Confirmations, mediationId: MediationId, proceed: () => void = () => {}): Promise<RecipientsAdded> {
  const fold = await scanVault(runtime.vault, keys);
  const mediation = accountOf(fold, mediationId);
  toward(link, mediation);
  if (mediation.routingDid === null) throw new Unusable("mediation", mediationId, ["its account is not registered"]);
  const replica = fold.replicas.replicas.get(runtime.author);
  if (replica === undefined || replica.status !== "member" || replica.did === null || replica.mediationId !== mediationId || !(await replicaAdded(confirmations, mediationId, runtime.author, replica.did))) {
    throw new Unusable("replica", runtime.author, [`not confirmed added to mediation ${mediationId}`]);
  }

  const addresses = sharedAddresses(fold, mediationId);
  const added: Did[] = [];
  const refused: RecipientsAdded["refused"] = [];
  for (const { didId, created } of addresses) {
    const key = recipientAddedKey(mediationId, didId);
    if (await confirmed(confirmations, key, "recipientDid", created.did)) continue;
    proceed();
    try {
      const proof = await signRecipientProof(keys, created, mediation.me.did, mediation.mediatorDid);
      const answer = await control(link, RECIPIENT_ADD, { recipient_did: created.did, resolution_material: created.longFormDid, proof }, RECIPIENT_ADDED);
      if (!echoes(answer, "recipient_did", created.did)) throw new MediatorRefused("recipient-added names another recipient than the one asked for");
    } catch (err) {
      if (!(err instanceof MediatorRefused)) throw err;
      refused.push({ did: created.did, because: err.message });
      continue;
    }
    await confirmations.set(key, { recipientDid: created.did });
    added.push(created.did);
  }
  const recipients: RecipientsAdded = { mediationId, wanted: addresses.map(({ created }) => created.did), added, refused };
  await link.observe("diag", "recipients", { ...recipients });
  return recipients;
}
