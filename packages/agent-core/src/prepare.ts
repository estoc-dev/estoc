/**
 * Preparing turns a queued intent into an exact envelope every
 * transport call of it carries. The intent fixed the channel;
 * preparing chooses nothing about it, only reads what the channel
 * needs on the wire: the sender under its long form until an admitted
 * receipt shows the peer has written to that address and under its
 * short form after, with the frozen proof of the rotation that made
 * it a successor while that address is unconfirmed; the recipient
 * under its short form, at a
 * key-agreement key its retained document authorizes and the sender's
 * key can agree with. The intent keeps the spelling it was given so
 * that a long form resolves offline; once resolved, the wire names the
 * canonical DID. Nothing is asked of the network: a numalgo-4 peer
 * resolves from its long form, and a short form whose long form is not
 * in evidence waits, which is not a key change.
 * Everything is decided under the writer lock over the fold read
 * there, and the envelope object, the resolution evidence and the
 * preparation are committed in that one lock; the fold holds the
 * preparation from then on, whatever rotates, confirms or resolves
 * later, and no second one of the message is made beside it. Which
 * preparation this runtime's calls carry is its own local record: the
 * one it commits here is selected right after the commit, and handed
 * on only once the selection is written; a message with none selected
 * and one valid preparation selects that one; one with several waits
 * for the user's choice; and a selection is checked before it is used
 * and replaced by nothing on its own. A
 * resolution committed here is evidence an observation may have
 * waited for — the document of the issuer of the proof it carried —
 * so what the vault owes is recorded under the same lock by every
 * preparation step of an open message, whether it made a preparation,
 * found one held already or found the message takes none now, before
 * any dispatch or other work reads the fold. That pass is owed by
 * every step, not only the one that committed the resolution: a commit
 * refused after the resolution was durable, the preparation's or the
 * pass's own, leaves the resolution in the fold and the work over it
 * undone, and the next preparation or dispatch of any message
 * completes it — the very evidence may show the message's own peer
 * replaced, and the preparation it made stands uncarried.
 */

import { isShortForm } from "@estoc/did-peer";
import { parseStrict, type Held } from "@estoc/event-store";
import {
  envelopeOf,
  intentOfOutbound,
  objectReader,
  plaintextCidOf,
  readStoredDocument,
  readVaultEvent,
  rotationIntent,
  sameChannel,
  vaultDraft,
  wirePlaintext,
  type Channel,
  type Cid,
  type Decision,
  type Did,
  type EventCid,
  type EventReference,
  type Keys,
  type LocalDidEntity,
  type MessageId,
  type MessageOut,
  type Outbound,
  type PeerResolution,
  type Preparation,
  type StoredMessageDocument,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import type { DidcommApi, IMessage } from "./protocol/didcomm.js";
import { outboundTurn } from "./acceptance.js";
import { addressingOf, recipientEndOf, seal, senderEndOf, type Ends } from "./ends.js";
import { UnknownEntity } from "./errors.js";
import { commitResolution } from "./evidence.js";
import { recordOwedUnderLock } from "./reconcile.js";
import { sealData } from "./link.js";
import { localRecordsOf, type LocalRecords } from "./local-records.js";
import { knownLongForms, resolve } from "./resolver.js";
import type { Locked, Session } from "./session.js";
import { noteAll, type AgentTrace, type Note } from "./trace.js";

/** The most bytes a message's body or one attachment payload may run to and still go on the wire. */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

export interface PrepareOptions {
  didcomm: DidcommApi;
  /** the seal of every preparation goes to the `envelope` stream */
  trace?: AgentTrace;
  /** the clock expiry is compared with, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
  /** where the runtime keeps the preparation it selected for each message and the acceptances it owes the vault: over its local options, for one; left out, they are kept in memory for as long as this process holds the runtime */
  local?: LocalRecords;
}

export type Prepared =
  /** made and committed here, and selected */
  | { outcome: "prepared"; messageId: MessageId; prepared: VaultEvent<"message.prepared">; resolved: VaultEvent<"peer.resolved"> }
  /** the preparation this runtime selected, or the one valid preparation the fold holds, selected now: none was written */
  | { outcome: "reused"; messageId: MessageId; preparation: Preparation }
  /** nothing is carried now: the message is closed, in conflict or not the sender's to prepare now, its several valid preparations wait for the user's choice, the selection names one that cannot be carried, or a selection could not be written */
  | { outcome: "none"; messageId: MessageId; because: string }
  /** the preparation cannot be made from what is here now, and what is missing may still arrive: the message stays queued */
  | { outcome: "pending"; messageId: MessageId; because: string }
  /** the expiry had come when the message was looked at, whether or not a preparation was made: the message is terminated */
  | { outcome: "expired"; messageId: MessageId; failed: VaultEvent<"delivery.failed"> };

export function hasExpired(intent: MessageOut, now: () => number): boolean {
  return intent.expiresTime !== null && now() >= intent.expiresTime * 1000;
}

/**
 * Why a message takes no more work whatever holds it up otherwise: its
 * intent is in conflict, it is submitted, or it is terminated. Null
 * while it is open. What makes the message wait — a blocked channel,
 * a preparation whose evidence is not here — comes after this, and after
 * its expiry: an expiry that has come terminates the intent itself,
 * without a preparation and whatever else the fold says.
 */
export function closedBecause(outbound: Outbound): string | null {
  if (outbound.intent.status === "conflict") return outbound.intent.because;
  if (outbound.submitted) return "submitted";
  if (outbound.terminal !== null) return `terminated: ${outbound.terminal.event.data.code}`;
  return null;
}

/** What the expiry of an open message came before, for the trace: the preparation it has none of, or the call of one it has. */
export function expiryPhase(outbound: Outbound): "preparation" | "dispatch" {
  return outbound.preparations.length === 0 ? "preparation" : "dispatch";
}

/** The preparation of one queued outbound: made here, or the one selected. */
export function prepare(session: Session, messageId: MessageId, options: PrepareOptions): Promise<Prepared> {
  return outboundTurn(session, messageId, localRecordsOf(session.runtime, options.local), async (local) => {
    const { result, notes } = await session.locked((locked) => prepareUnderLock(locked, messageId, options, local));
    await noteAll(options.trace ?? null, notes);
    return result;
  });
}

/** Every outbound the fold says needs a preparation, in message order. */
export async function prepareAll(session: Session, options: PrepareOptions): Promise<Prepared[]> {
  const fold = await session.fold();
  const results: Prepared[] = [];
  for (const outbound of [...fold.outbound.outbounds.values()].sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0))) {
    if (outbound.work.kind === "prepare") results.push(await prepare(session, outbound.messageId, options));
  }
  return results;
}

/** What one locked step came to, and the trace entries it owes once the lock is released. */
export type Settled<T> = { result: T; notes: Note[] };

/** The expired failure of an unsubmitted intent, committed under the lock the caller holds; `phase` says what the expiry came before. */
export async function expireUnderLock(held: Held, messageId: MessageId, phase: "preparation" | "dispatch"): Promise<Settled<Extract<Prepared, { outcome: "expired" }>>> {
  const [event] = (await held.commit([], [vaultDraft("delivery.failed", { messageId, code: "expired" })])).map(readVaultEvent);
  const notes: Note[] = [{ stream: "diag", what: "delivery", data: { messageId, code: "expired", reason: `the expiry passed before ${phase}` } }];
  return { result: { outcome: "expired", messageId, failed: event as VaultEvent<"delivery.failed"> }, notes };
}

/** `prepare` for a caller that already holds the message's turn and the writer lock. */
export async function prepareUnderLock(locked: Locked, messageId: MessageId, options: PrepareOptions, local: LocalRecords): Promise<Settled<Prepared>> {
  const fold = await locked.fold();
  const outbound = fold.outbound.outbounds.get(messageId);
  if (outbound === undefined) throw new UnknownEntity("message", messageId);
  const closed = closedBecause(outbound);
  if (closed !== null) return { result: { outcome: "none", messageId, because: closed }, notes: [] };
  const intent = (outbound.intent as { data: MessageOut }).data;
  if (hasExpired(intent, options.now ?? Date.now)) return expireUnderLock(locked.held, messageId, expiryPhase(outbound));
  const settled = await preparationOf(locked, fold, outbound, intent, options, local);
  settled.notes.push(...(await owedRecorded(locked, messageId)));
  return settled;
}

/**
 * What this runtime's calls of an open message carry, as its selection
 * and the fold say. With none selected: a preparation still to be
 * made, the one valid preparation, or the user's choice among several.
 * With one selected: that preparation, while it is here, valid and its
 * envelope not erased, and nothing in its place otherwise, so that a
 * selection that cannot be carried neither reopens the preparation nor
 * falls to another preparation on its own.
 */
export type Carriage =
  | { kind: "prepare" }
  | { kind: "carry"; preparation: Preparation; selected: boolean }
  | { kind: "choose"; candidates: readonly Preparation[]; because: string }
  | { kind: "none"; because: string };

export function carriage(outbound: Outbound, selected: EventCid | null): Carriage {
  const { work } = outbound;
  if (work.kind === "none") return { kind: "none", because: work.because };
  if (selected === null) {
    if (work.kind === "prepare") return { kind: "prepare" };
    const [only, ...others] = work.candidates;
    if (others.length === 0) return { kind: "carry", preparation: only!, selected: false };
    return { kind: "choose", candidates: work.candidates, because: `${work.candidates.length} valid preparations of the message are here, and which one to carry is to be chosen` };
  }
  const preparation = outbound.preparations.find((candidate) => candidate.event.cid === selected);
  const because =
    preparation === undefined
      ? "is not here"
      : preparation.erased
        ? "has its envelope erased"
        : preparation.status.status === "complete"
          ? null
          : preparation.status.status === "pending"
            ? `waits: ${preparation.status.because}`
            : `contradicts the intent: ${preparation.status.because}`;
  return because === null ? { kind: "carry", preparation: preparation!, selected: true } : { kind: "none", because: `the selected preparation ${selected} ${because}` };
}

/**
 * The preparation of an open message: the one selected, the one valid
 * preparation the fold holds, selected now, the one made, committed and
 * selected now, or why there is none yet or none at all. A selection
 * the local options refuse leaves the message uncarried, the
 * preparation made or found standing for the next step to select.
 */
async function preparationOf(locked: Locked, fold: VaultFold, outbound: Outbound, intent: MessageOut, options: PrepareOptions, local: LocalRecords): Promise<Settled<Prepared>> {
  const { held, keys } = locked;
  const { messageId } = outbound;
  const notes: Note[] = [];
  const none = (because: string): Settled<Prepared> => ({ result: { outcome: "none", messageId, because }, notes });
  const selecting = async (preparationEventCid: EventReference<"message.prepared">): Promise<string | null> => {
    try {
      await local.select(messageId, preparationEventCid);
      return null;
    } catch (err) {
      const because = `the preparation ${preparationEventCid} could not be selected: ${err instanceof Error ? err.message : String(err)}`;
      notes.push({ stream: "diag", what: "delivery", data: { messageId, preparationEventCid, reason: because } });
      return because;
    }
  };
  const carried = carriage(outbound, await local.selected(messageId));
  if (carried.kind === "none" || carried.kind === "choose") return none(carried.because);
  if (carried.kind === "carry") {
    const refused = carried.selected ? null : await selecting(carried.preparation.event.cid as EventReference<"message.prepared">);
    return refused === null ? { result: { outcome: "reused", messageId, preparation: carried.preparation }, notes } : none(refused);
  }
  const sender = outbound.sender as LocalDidEntity;
  const channel = outbound.channel as Channel;
  const ends = await endsOf(fold, keys, sender, channel, intent.recipientDid);
  if ("pending" in ends) return { result: { outcome: "pending", messageId, because: ends.pending }, notes };
  if ("because" in ends) return none(ends.because);
  const content = await readContent(held, intent);
  if ("pending" in content) return { result: { outcome: "pending", messageId, because: content.pending }, notes };
  const plaintext = wirePlaintext(intentOfOutbound(intent).value, messageId, content.document, addressingOf(ends), (root) => content.payloads.get(root) as Uint8Array);
  const packed = await seal(ends, plaintext, options.didcomm);
  const envelope = envelopeOf(packed);
  const resolved = await commitResolution(held, { resolution: ends.recipient.resolution, localKeyName: sender.keyNames.keyAgreement, peerPublicKey: ends.recipient.publicKey });
  const [prepared] = (
    await held.commit(
      [{ cid: envelope.cid, source: envelope.value }],
      [
        vaultDraft("message.prepared", {
          messageId,
          senderDidId: sender.didId,
          localKeyName: sender.keyNames.keyAgreement,
          recipientDid: ends.recipient.did,
          peerResolutionEventCid: resolved.cid as EventReference<"peer.resolved">,
          fromPrior: ends.fromPrior?.proof ?? null,
          intentCid: intent.intentCid,
          plaintextCid: plaintextCidOf(plaintext),
          envelopeCid: envelope.cid,
        }),
      ]
    )
  ).map(readVaultEvent);
  notes.push({ stream: "envelope", what: "seal", data: { ...sealData(packed, plaintext as unknown as IMessage), messageId, preparationEventCid: prepared!.cid } });
  const refused = await selecting(prepared!.cid as EventReference<"message.prepared">);
  if (refused !== null) return none(refused);
  return { result: { outcome: "prepared", messageId, prepared: prepared as VaultEvent<"message.prepared">, resolved }, notes };
}

/**
 * The pass over what the vault owes, under the preparation's lock.
 * What it decided stands whether it ran through or stopped; one that
 * stopped is noted, and left to the next pass.
 */
async function owedRecorded(locked: Locked, messageId: MessageId): Promise<Note[]> {
  try {
    await recordOwedUnderLock(locked);
    return [];
  } catch (err) {
    return [{ stream: "diag", what: "admission", data: { messageId, reason: `the pass the preparation runs stopped: ${err instanceof Error ? err.message : String(err)}` } }];
  }
}

/**
 * The two ends as the wire names them: the recipient under the
 * channel's spelling, at the key `recipientEndOf` picks from its
 * retained document; the sender under its long form until an admitted
 * receipt shows the peer has written to the address, with the proof of
 * the rotation that made it a successor here, and under its short form
 * after. A document authorizing no key the sender can seal to is not a
 * key change — the document is immutable — but no preparation to it
 * can be made, and none from a sender whose own document authorizes its
 * key under no method didcomm seals from.
 */
async function endsOf(fold: VaultFold, keys: Keys, sender: LocalDidEntity, channel: Channel, recipientDid: Did): Promise<Ends | { pending: string } | { because: string }> {
  const known = knownLongForms(fold);
  if (isShortForm(recipientDid) && known(recipientDid) === null) return { pending: `no long form of ${recipientDid} is in evidence` };
  const answer = await resolve(recipientDid, known);
  if (answer.outcome !== "resolved") return { because: answer.reason };
  const { keyAgreement: key } = await keys.didKeys(sender.didId);
  const recipient = recipientEndOf(channel.peerDid, answer.resolution, key);
  if (recipient === null) return { because: `${answer.resolution.presentedDid} authorizes no key-agreement key ${channel.localDid} can seal to` };
  const created = sender.created as NonNullable<LocalDidEntity["created"]>;
  const confirmed = fold.continuity.confirmedBy(channel.localDid, channel.peerDid) !== null;
  const from = senderEndOf(confirmed ? created.did : created.longFormDid, sender.resolution as PeerResolution, key);
  if (from === null) return { because: `${channel.localDid} authorizes no key-agreement method didcomm seals from with the key the seed derives` };
  if (confirmed) return { sender: from, recipient, fromPrior: null };
  const fromPrior = proofOf(fold, sender, channel);
  if (fromPrior !== null && !("proof" in fromPrior)) return fromPrior;
  return { sender: from, recipient, fromPrior };
}

/**
 * The frozen proof a sender carries as an unconfirmed successor: that
 * of the rotation intent which made it one toward this channel's peer,
 * at the pair itself or on a verified role-preserving path to it, with
 * the document of the predecessor that issued it. Null when no record
 * made the sender a successor here. The records are read off their own
 * fields, since one waiting for its predecessor's creation has no
 * channel in the fold yet; what they amount to, and which proof stands
 * for them, is the vault's reading of the intent.
 */
function proofOf(fold: VaultFold, sender: LocalDidEntity, channel: Channel): Ends["fromPrior"] | { pending: string } | { because: string } {
  const records = [...fold.channels.decisions.values()].filter((decision) => decision.event.data.toDidId === sender.didId && leadsTo(fold, decision, channel));
  const intent = rotationIntent(fold, records);
  switch (intent.status) {
    case "none":
      return null;
    case "conflict":
      return { because: intent.because };
    case "pending":
      return { pending: intent.because };
    case "candidate": {
      const { fromDidId, fromPrior } = intent.candidate.event.data;
      const issuer = fold.dids.entities.get(fromDidId)?.resolution ?? null;
      if (issuer === null) return { because: `the document of ${fromDidId}, which issued the proof, does not read` };
      return { proof: fromPrior, issuer };
    }
  }
}

/** Does the decision's rotation land in `channel`: its successor's pair with the same peer, or a pair a verified path from there preserves the roles into. */
function leadsTo(fold: VaultFold, decision: Decision, channel: Channel): boolean {
  const landed: Channel = { localDid: channel.localDid, peerDid: decision.event.data.peerDid };
  return sameChannel(landed, channel) || fold.continuity.ackPath(landed, channel);
}

type Content = { document: StoredMessageDocument; payloads: Map<Cid, Uint8Array> };

/** An object that is missing, damaged or too large for the wire is a reason the preparation cannot be made now, not a throw. */
async function readContent(held: Held, intent: MessageOut): Promise<Content | { pending: string }> {
  const read = objectReader(held.objects, MAX_CONTENT_BYTES);
  const bytes = await read(intent.bodyCid);
  if (bytes === null) return { pending: `the body ${intent.bodyCid} is not here` };
  const document = readStoredDocument(parseStrict(bytes));
  const payloads = new Map<Cid, Uint8Array>();
  for (const attachment of document.attachments) {
    if (attachment.data.kind === "links") continue;
    const payload = await read(attachment.data.root);
    if (payload === null) return { pending: `the attachment ${attachment.data.root} is not here` };
    payloads.set(attachment.data.root, payload);
  }
  return { document, payloads };
}
