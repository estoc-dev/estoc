/**
 * The vault's own communication DIDs. Where an entity sends is its
 * document's own word: the one DIDComm service of the long form names
 * a mediator's routing DID or a direct endpoint, and a mediated entity
 * is routed by the one usable arrangement whose grant names that DID.
 * An entity is live while its record is consistent, its document reads
 * and sends somewhere, that arrangement stands, and the seed has been
 * found to derive its keys. The fold keeps every entity, live or not,
 * so a key name met later still finds the entity it belongs to, in
 * conflict or not, and a consistent DID spelling its one entity;
 * liveness governs sending and recipient registration, not history.
 * The key check needs the seed and runs beside the fold; an entity the
 * seed has not confirmed is pending, never live.
 */

import { IdentityMismatch, InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { checkDidKeys, didDocumentOf, serviceTargetOf, type Keys, type RouteTarget } from "../identity.js";
import { didKeyName } from "../ids.js";
import { authorizedMethodIds, didcommServiceUris, type PeerResolution } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Did, DidId, DidUrl, KeyName, MediationId, VaultData } from "../types.js";
import { foldMediations, verifyMediationKeys, type IdentityCheck, type KeyCheck, type Mediation, type MediationFold } from "./mediation.js";
import { groupBy, samePayload, type VaultEventSet } from "./set.js";

export interface LocalDidEntity {
  readonly didId: DidId;
  /** the consistent creation, null while there is none or creations disagree */
  readonly created: VaultData["did.created"] | null;
  /** the long form's own document, null while it does not read */
  readonly resolution: PeerResolution | null;
  readonly keyNames: { authentication: KeyName; keyAgreement: KeyName };
  /** the document's methods for each use, for the exact `kid` a recipient or signer names */
  readonly methodIds: { authentication: readonly DidUrl[]; keyAgreement: readonly DidUrl[] };
  /** where the document sends, null while it does not read or names no one route */
  readonly routeTarget: RouteTarget | null;
  /** the usable arrangements routed through the document's routing DID, in ID order: one for a live mediated entity, none for a direct one */
  readonly mediations: readonly MediationId[];
  readonly disclosures: readonly VaultEvent<"did.disclosed">[];
  /** the reason of the first retirement in canonical order, null while not retired */
  readonly retired: string | null;
  /** everything that keeps the entity from being live, the conflicts first */
  readonly faults: readonly string[];
  /**
   * Disagreeing creations, an unreadable record, a spelling another
   * entity also claims, a document that names no one route or keys the
   * seed does not derive: the entity cannot be used for cryptography,
   * however its arrangement stands.
   */
  readonly conflict: boolean;
  readonly identity: IdentityCheck;
  /** consistent, verified, not retired, document and arrangement in order: may send, disclose and register */
  readonly live: boolean;
}

/** One pair the mediator is asked to deliver for: a live DID by its short form and the arrangement that routes it. */
export type DesiredRecipient = { did: Did; didId: DidId; mediationId: MediationId };

export interface RouteFold {
  readonly dids: ReadonlyMap<DidId, LocalDidEntity>;
  /** the live mediated DIDs, by short form */
  readonly desiredRecipients: readonly DesiredRecipient[];
  /** the entity a key name derives from, whatever its state, since one entity ID names each key; null for a name no entity here records */
  entityOfKey(name: KeyName): DidId | null;
  /** the entity a spelling belongs to, short or long form; null for a spelling no consistent entity records */
  entityOfDid(did: string): DidId | null;
  /**
   * May this entity's key-agreement key still receive? `terminal` for
   * an unknown or conflicted entity, or one whose every arrangement is
   * retired or in conflict, whatever else is missing; `eligible` while
   * the entity is live, or retired with its arrangement intact, since
   * retirement ends new sending and disclosure but not the draining of
   * what was addressed here; `pending` while only a recoverable
   * prerequisite is missing: an arrangement through the routing DID,
   * its grant, the key check.
   */
  receipt(didId: DidId): ReceiptEligibility;
}

export type ReceiptEligibility = "eligible" | "pending" | "terminal";

export type RouteFoldOptions = { keyChecks?: ReadonlyMap<DidId, KeyCheck> };

export function foldRoutes(set: VaultEventSet, mediations: MediationFold, options: RouteFoldOptions = {}): RouteFold {
  const { dids, terminal } = foldDidTable(set, mediations, options.keyChecks);

  const byKey = new Map<KeyName, DidId>();
  const byDid = new Map<string, DidId>();
  for (const did of dids.values()) {
    byKey.set(did.keyNames.authentication, did.didId);
    byKey.set(did.keyNames.keyAgreement, did.didId);
    if (did.conflict || did.created === null) continue;
    byDid.set(did.created.did, did.didId);
    byDid.set(did.created.longFormDid, did.didId);
  }

  const desiredRecipients: DesiredRecipient[] = [];
  for (const did of dids.values()) {
    const mediationId = did.mediations[0];
    if (!did.live || did.created === null || mediationId === undefined) continue;
    desiredRecipients.push({ did: did.created.did, didId: did.didId, mediationId });
  }
  desiredRecipients.sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));

  return {
    dids,
    desiredRecipients,
    entityOfKey: (name) => byKey.get(name) ?? null,
    entityOfDid: (did) => byDid.get(did) ?? null,
    receipt(didId) {
      const did = dids.get(didId);
      if (did === undefined || did.conflict || did.created === null || terminal.has(didId)) return "terminal";
      return did.faults.length === 0 ? "eligible" : "pending";
    },
  };
}

const isTerminal = (mediation: Mediation): boolean => mediation.status === "retired" || mediation.status === "conflict";

/**
 * The arrangements a mediated document is routed by: those whose
 * grant names its routing DID. None yet, or one not yet usable, may
 * recover; several usable ones leave undecidable which account holds
 * the address, until one is retired; every one retired or in conflict
 * is the end of receiving here.
 */
function routedBy(mediations: MediationFold, routingDid: Did): { usable: MediationId[]; faults: string[]; terminal: boolean } {
  const through = mediations.through(routingDid);
  const usable = through.filter((mediation) => mediation.status === "usable").map((mediation) => mediation.mediationId);
  if (through.length === 0) return { usable, faults: [`no mediation arrangement routes through ${routingDid}`], terminal: false };
  if (usable.length > 1) return { usable, faults: [`several arrangements route through ${routingDid}: ${usable.join(", ")}`], terminal: false };
  if (usable.length === 1) return { usable, faults: [], terminal: false };
  return { usable, faults: through.map((mediation) => `mediation ${mediation.mediationId} is ${mediation.status}`), terminal: through.every(isTerminal) };
}

function foldDidTable(set: VaultEventSet, mediations: MediationFold, keyChecks: ReadonlyMap<DidId, KeyCheck> | undefined): { dids: Map<DidId, LocalDidEntity>; terminal: Set<DidId> } {
  const created = groupBy(set.of("did.created"), (event) => event.data.didId);
  const disclosed = groupBy(set.of("did.disclosed"), (event) => event.data.didId);
  const retired = groupBy(set.of("did.retired"), (event) => event.data.didId);
  const ids = [...new Set([...created.keys(), ...disclosed.keys(), ...retired.keys()])].sort();

  const claimants = new Map<string, Set<DidId>>();
  for (const didId of ids) {
    for (const event of created.get(didId) ?? []) {
      for (const spelling of [event.data.did, event.data.longFormDid]) {
        const owners = claimants.get(spelling);
        if (owners === undefined) claimants.set(spelling, new Set([didId]));
        else owners.add(didId);
      }
    }
  }

  const dids = new Map<DidId, LocalDidEntity>();
  const terminal = new Set<DidId>();
  for (const didId of ids) {
    const conflicts: string[] = [];
    const faults: string[] = [];
    const creations = created.get(didId) ?? [];
    const first = creations[0]?.data ?? null;
    if (first === null) faults.push("no creation");
    else if (creations.some((event) => !samePayload(event.data, first))) conflicts.push("creations disagree");
    const creation = conflicts.length === 0 ? first : null;

    let resolution: PeerResolution | null = null;
    let routeTarget: RouteTarget | null = null;
    let methodIds: LocalDidEntity["methodIds"] = { authentication: [], keyAgreement: [] };
    if (creation !== null) {
      for (const spelling of [creation.did, creation.longFormDid]) {
        for (const other of claimants.get(spelling) ?? []) if (other !== didId) conflicts.push(`${spelling} is also entity ${other}`);
      }
      try {
        const read = didDocumentOf(creation);
        const uris = didcommServiceUris(read.document);
        methodIds = { authentication: authorizedMethodIds(read.document, "authentication"), keyAgreement: authorizedMethodIds(read.document, "keyAgreement") };
        resolution = read;
        routeTarget = uris.length === 1 ? serviceTargetOf(uris[0]!) : null;
        if (routeTarget === null) conflicts.push(uris.length === 1 ? `the document sends to ${uris[0]}, neither a DID nor an HTTPS or WSS URL` : "the document does not send to exactly one endpoint");
      } catch (err) {
        if (!isDocumentFault(err)) throw err;
        conflicts.push(err.message);
      }
    }
    const identity: IdentityCheck = keyChecks?.get(didId) ?? "unchecked";
    if (identity === "mismatch") conflicts.push("the seed does not derive the entity's keys");

    let usableMediations: MediationId[] = [];
    if (routeTarget?.kind === "mediated") {
      const routed = routedBy(mediations, routeTarget.routingDid);
      usableMediations = routed.usable;
      faults.push(...routed.faults);
      if (routed.terminal) terminal.add(didId);
    }
    if (identity === "unchecked" && resolution !== null) faults.push("the keys are not yet checked against the seed");

    const retirement = retired.get(didId)?.[0]?.data.because ?? null;
    dids.set(didId, {
      didId,
      created: creation,
      resolution,
      keyNames: { authentication: didKeyName(didId, "authentication"), keyAgreement: didKeyName(didId, "key-agreement") },
      methodIds,
      routeTarget,
      mediations: usableMediations,
      disclosures: disclosed.get(didId) ?? [],
      retired: retirement,
      faults: [...conflicts, ...faults],
      conflict: conflicts.length > 0,
      identity,
      live: conflicts.length === 0 && faults.length === 0 && retirement === null,
    });
  }
  return { dids, terminal };
}

/** A fault the document itself carries, as opposed to a programming error: recorded against the entity, never thrown out of a fold. */
function isDocumentFault(err: unknown): err is Error {
  return err instanceof InvalidDidDocument || err instanceof IdentityMismatch || err instanceof InvalidPublicKey;
}

/** Each consistent, readable entity checked against the seed: does its document carry the two keys its ID derives? */
export async function verifyDidKeys(keys: Keys, fold: RouteFold): Promise<Map<DidId, KeyCheck>> {
  const checks = new Map<DidId, KeyCheck>();
  for (const did of fold.dids.values()) {
    if (did.resolution === null) continue;
    try {
      await checkDidKeys(keys, did.didId, did.resolution);
      checks.set(did.didId, "verified");
    } catch (err) {
      if (!isDocumentFault(err)) throw err;
      checks.set(did.didId, "mismatch");
    }
  }
  return checks;
}

/** The mediation and DID folds with every key check done: the seed consulted once per entity, the verdicts folded back in. */
export async function foldWithSeed(set: VaultEventSet, keys: Keys): Promise<{ mediations: MediationFold; routes: RouteFold }> {
  const mediations = foldMediations(set, { keyChecks: await verifyMediationKeys(keys, foldMediations(set)) });
  const routes = foldRoutes(set, mediations, { keyChecks: await verifyDidKeys(keys, foldRoutes(set, mediations)) });
  return { mediations, routes };
}

/**
 * The mediations the runtime must keep receiving on: every usable one
 * that is preferred, or that routes some DID that may still receive,
 * retired or not. A DID whose receipt only waits — for the seed's
 * verdict on its keys — keeps the dependency: what is not yet
 * decidable is not decided against, and what was addressed to it must
 * not be left at the mediator meanwhile. Only a terminal entity
 * releases it; while several usable arrangements route one DID, each
 * is kept. Disclosure policy plays no part.
 */
export function requiredReceivingSet(mediations: MediationFold, routes: RouteFold): Set<MediationId> {
  const required = new Set<MediationId>();
  if (mediations.preferred !== null) required.add(mediations.preferred);
  for (const did of routes.dids.values()) {
    if (did.created === null || routes.receipt(did.didId) === "terminal") continue;
    for (const mediationId of did.mediations) if (mediations.usable(mediationId)) required.add(mediationId);
  }
  return required;
}
