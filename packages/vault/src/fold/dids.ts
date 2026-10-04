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
 * seed has not confirmed is pending, never live. An entity's generation
 * is read back to the branch it belongs to, each entity resolved once:
 * what a successor of it is made from, and what a rotation away from it
 * must be anchored to.
 */

import { IdentityMismatch, InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { checkDidKeys, didDocumentOf, serviceTargetOf, type Keys, type RouteTarget } from "../identity.js";
import { GENERATION_PROFILE, channelOf, didKeyName } from "../ids.js";
import { authorizedMethodIds, canonicalDidOf, didcommServiceUris, type PeerResolution } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Channel, Did, DidGeneration, DidId, DidUrl, KeyName, MediationId, VaultData } from "../types.js";
import { foldMediations, verifyMediationKeys, type IdentityCheck, type KeyCheck, type MediationFold } from "./mediation.js";
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
  /** the usable arrangement routed through the document's routing DID; null for a direct entity, and while none is */
  readonly mediation: MediationId | null;
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


/**
 * The branch an entity's generation leads back to. An entry is an
 * address branches are made from; a branch is anchored at the pair its
 * start was bound to, the entry and the peer's address the relationship
 * first led back to, and every next under it keeps that anchor. Pending
 * while a predecessor's creation is not here; unsupported under a
 * profile this version does not make, whose rules are not applied;
 * invalid where the generations contradict each other, a start under a
 * branch, a next under an entry, a profile that changes along the way,
 * a predecessor in conflict or a chain that leads back to itself.
 */
export type Lineage =
  | { status: "entry" }
  | { status: "branch"; anchor: Channel; start: DidId }
  | { status: "pending"; because: string }
  | { status: "unsupported"; profile: string }
  | { status: "invalid"; because: string };

export interface DidFold {
  readonly entities: ReadonlyMap<DidId, LocalDidEntity>;
  /** the branch the entity's generation leads back to; invalid for an entity no creation here records */
  lineage(didId: DidId): Lineage;
  /** the entity a key name derives from, whatever its state, since one entity ID names each key; null for a name no entity here records */
  entityOfKey(name: KeyName): DidId | null;
  /** the entity a spelling belongs to, short or long form; null for a spelling no consistent entity records */
  entityOfDid(did: string): DidId | null;
  /**
   * May this entity's key-agreement key still receive? `terminal` for
   * an unknown or conflicted entity, whatever else is missing;
   * `eligible` while the entity is live, or retired with its
   * arrangement intact, since retirement ends new sending and
   * disclosure but not the draining of what was addressed here;
   * `pending` while the entity waits for something not its own: a
   * usable arrangement through its routing DID, the key check. The
   * creation or grant that makes its arrangement usable may not have
   * arrived here yet, so a missing one does not end receipt; nor does
   * the arrangement's retirement or conflict, which is the arrangement's
   * state and not the entity's.
   */
  receipt(didId: DidId): ReceiptEligibility;
}

export type ReceiptEligibility = "eligible" | "pending" | "terminal";

export type DidFoldOptions = { keyChecks?: ReadonlyMap<DidId, KeyCheck> };

export function foldDids(set: VaultEventSet, mediations: MediationFold, options: DidFoldOptions = {}): DidFold {
  const { dids, claimants } = foldDidTable(set, mediations, options.keyChecks);

  const byKey = new Map<KeyName, DidId>();
  const byDid = new Map<string, DidId>();
  for (const did of dids.values()) {
    byKey.set(did.keyNames.authentication, did.didId);
    byKey.set(did.keyNames.keyAgreement, did.didId);
    if (did.conflict || did.created === null) continue;
    byDid.set(did.created.did, did.didId);
    byDid.set(did.created.longFormDid, did.didId);
  }
  const lineages = new Map<DidId, Lineage>();

  return {
    entities: dids,
    lineage: (didId) => lineageOf(didId, { dids, byDid, claimants, lineages }),
    entityOfKey: (name) => byKey.get(name) ?? null,
    entityOfDid: (did) => byDid.get(did) ?? null,
    receipt(didId) {
      const did = dids.get(didId);
      if (did === undefined || did.conflict || did.created === null) return "terminal";
      return did.faults.length === 0 ? "eligible" : "pending";
    },
  };
}

/**
 * The arrangement a mediated document is routed by: the usable one
 * whose grant names its routing DID, under either spelling. A usable
 * arrangement is routed through its own mediator and the vault has one
 * arrangement per mediator, so at most one is. None yet, or one whose
 * creation or grant has not arrived, may become usable; a retired or
 * conflicted one does not, and no other arrangement with that mediator
 * follows it.
 */
function routedBy(mediations: MediationFold, routingDid: Did): { usable: MediationId | null; faults: string[] } {
  const through = mediations.through(routingDid);
  const usable = through.find((mediation) => mediation.status === "usable")?.mediationId ?? null;
  if (usable !== null) return { usable, faults: [] };
  if (through.length === 0) return { usable, faults: [`no mediation arrangement routes through ${routingDid}`] };
  return { usable, faults: through.map((mediation) => `mediation ${mediation.mediationId} is ${mediation.status}`) };
}

type DidTable = { dids: Map<DidId, LocalDidEntity>; claimants: Map<string, Set<DidId>> };

function foldDidTable(set: VaultEventSet, mediations: MediationFold, keyChecks: ReadonlyMap<DidId, KeyCheck> | undefined): DidTable {
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
        routeTarget = uris.length === 1 ? routeTargetOfService(uris[0]!) : null;
        if (routeTarget === null) conflicts.push("the document does not send to exactly one endpoint");
      } catch (err) {
        if (!isDocumentFault(err)) throw err;
        conflicts.push(err.message);
      }
    }
    const identity: IdentityCheck = keyChecks?.get(didId) ?? "unchecked";
    if (identity === "mismatch") conflicts.push("the seed does not derive the entity's keys");

    let mediation: MediationId | null = null;
    if (routeTarget?.kind === "mediated") {
      const routed = routedBy(mediations, routeTarget.routingDid);
      mediation = routed.usable;
      faults.push(...routed.faults);
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
      mediation,
      disclosures: disclosed.get(didId) ?? [],
      retired: retirement,
      faults: [...conflicts, ...faults],
      conflict: conflicts.length > 0,
      identity,
      live: conflicts.length === 0 && faults.length === 0 && retirement === null,
    });
  }
  return { dids, claimants };
}

type Lineages = DidTable & { byDid: ReadonlyMap<string, DidId>; lineages: Map<DidId, Lineage> };

/**
 * The generations followed back from the entity until one is resolved
 * already, is an entry, waits or fails, then read forward again, each
 * entity on the way given its answer once. A predecessor is found by
 * its DID among the consistent entities; a DID only an entity in
 * conflict claims fails the chain for good, one no entity claims leaves
 * it waiting.
 */
function lineageOf(didId: DidId, table: Lineages): Lineage {
  const chain: DidId[] = [];
  let current = didId;
  let result: Lineage | undefined;
  let own = true;
  for (;;) {
    const known = table.lineages.get(current);
    if (known !== undefined) {
      result = known;
      own = false;
      break;
    }
    if (chain.includes(current)) {
      result = { status: "invalid", because: `the generations of ${current} lead back to itself` };
      own = false;
      break;
    }
    chain.push(current);
    const entity = table.dids.get(current);
    if (entity === undefined) {
      result = { status: "invalid", because: `no entity ${current} is recorded here` };
      break;
    }
    if (entity.conflict) {
      result = { status: "invalid", because: `entity ${current} is in conflict: ${entity.faults[0]}` };
      break;
    }
    if (entity.created === null) {
      result = { status: "pending", because: `entity ${current} has no creation here` };
      break;
    }
    const { generation } = entity.created;
    if (generation.profile !== GENERATION_PROFILE) {
      result = { status: "unsupported", profile: generation.profile };
      break;
    }
    if (generation.kind === "entry") {
      result = { status: "entry" };
      break;
    }
    const predecessor = table.byDid.get(generation.predecessor);
    if (predecessor === undefined) {
      const claimed = table.claimants.get(generation.predecessor);
      result =
        claimed === undefined || claimed.size === 0
          ? { status: "pending", because: `the creation of its predecessor ${generation.predecessor} is not here` }
          : { status: "invalid", because: `its predecessor ${generation.predecessor} is entity ${[...claimed].sort()[0]}, which is in conflict` };
      break;
    }
    current = predecessor;
  }
  let i = chain.length - 1;
  if (own) table.lineages.set(chain[i--]!, result);
  for (; i >= 0; i--) {
    const entity = table.dids.get(chain[i]!)!;
    result = follows(chain[i]!, entity.created!.generation as Exclude<DidGeneration, { kind: "entry" }>, result);
    table.lineages.set(chain[i]!, result);
  }
  return result;
}

/** What a start or a next is, given what its predecessor is. */
function follows(didId: DidId, generation: Exclude<DidGeneration, { kind: "entry" }>, predecessor: Lineage): Lineage {
  const { predecessor: did } = generation;
  switch (predecessor.status) {
    case "pending":
      return { status: "pending", because: `its predecessor ${did} waits: ${predecessor.because}` };
    case "invalid":
      return { status: "invalid", because: `its predecessor ${did} is invalid: ${predecessor.because}` };
    case "unsupported":
      return { status: "invalid", because: `its predecessor ${did} is under profile ${predecessor.profile}, not ${generation.profile}` };
    case "entry":
      return generation.kind === "start" ? { status: "branch", anchor: channelOf(did, generation.binding), start: didId } : { status: "invalid", because: `a next follows a start or a next, and its predecessor ${did} is an entry` };
    case "branch":
      return generation.kind === "next" ? predecessor : { status: "invalid", because: `a start follows an entry, and its predecessor ${did} is in a branch` };
  }
}

/**
 * Where the document's one service sends. Reading the document checks
 * the URI as a string and no further, so a did:peer:4 long form named
 * there, a second document, is validated on its own: one that is not
 * the document its hash commits to, or does not read as a document,
 * routes nothing.
 */
function routeTargetOfService(uri: string): RouteTarget {
  const target = serviceTargetOf(uri);
  if (target === null) throw new InvalidDidDocument(`the document sends to ${uri}, neither a DID nor an HTTPS or WSS URL`);
  if (target.kind === "mediated") {
    try {
      canonicalDidOf(target.routingDid);
    } catch (err) {
      if (!(err instanceof InvalidDidDocument)) throw err;
      throw new InvalidDidDocument(`the document sends to ${uri}, a did:peer:4 long form that does not resolve: ${err.message}`);
    }
  }
  return target;
}

/** A fault the document itself carries, as opposed to a programming error: recorded against the entity, never thrown out of a fold. */
function isDocumentFault(err: unknown): err is Error {
  return err instanceof InvalidDidDocument || err instanceof IdentityMismatch || err instanceof InvalidPublicKey;
}

/** Each consistent, readable entity checked against the seed: does its document carry the two keys its ID derives? */
export async function verifyDidKeys(keys: Keys, fold: DidFold): Promise<Map<DidId, KeyCheck>> {
  const checks = new Map<DidId, KeyCheck>();
  for (const did of fold.entities.values()) {
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
export async function foldWithSeed(set: VaultEventSet, keys: Keys): Promise<{ mediations: MediationFold; dids: DidFold }> {
  const mediations = foldMediations(set, { keyChecks: await verifyMediationKeys(keys, foldMediations(set)) });
  const dids = foldDids(set, mediations, { keyChecks: await verifyDidKeys(keys, foldDids(set, mediations)) });
  return { mediations, dids };
}

/**
 * The mediations the runtime must keep receiving on: every usable one
 * that is preferred, or that routes some DID that may still receive,
 * retired or not. A DID whose receipt only waits — for the seed's
 * verdict on its keys — keeps the dependency: what is not yet
 * decidable is not decided against, and what was addressed to it must
 * not be left at the mediator meanwhile. Only a conflicted entity
 * releases it; an arrangement that is not usable is never required,
 * whatever depends on it. Disclosure policy plays no part.
 */
export function requiredReceivingSet(mediations: MediationFold, dids: DidFold): Set<MediationId> {
  const required = new Set<MediationId>();
  if (mediations.preferred !== null) required.add(mediations.preferred);
  for (const did of dids.entities.values()) {
    if (did.created === null || did.mediation === null || dids.receipt(did.didId) === "terminal") continue;
    if (mediations.usable(did.mediation)) required.add(did.mediation);
  }
  return required;
}
