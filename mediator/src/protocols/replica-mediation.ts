import {
  isLongForm,
  isPeerDID4,
  isShortForm,
  longToShort,
  resolveDIDCommDoc,
} from "@estoc/did-peer";
import type { DIDDoc } from "@estoc/did-peer";

import type { MediatorPolicy } from "../config.js";
import { isAuthcrypted } from "../didcomm/didcomm.js";
import type { Unpacked } from "../didcomm/didcomm.js";
import { isDecodable } from "../didcomm/did-resolver.js";
import type { Handler, HandlerContext, Reply } from "./types.js";
import { isMediatorOwnDid } from "./coordinate-mediation.js";
import { DELIVERY_PAGE_LIMIT } from "./pickup.js";
import { REPLICA_MEDIATION_PROTOCOL } from "./discover-features.js";
import { PROBLEM_REPORT } from "./problem-report.js";
import { verifyRecipientProof } from "./recipient-proof.js";
import { canonicalDid, provenDid, UUID_V7, verifyReplicaGrant } from "./replica-grant.js";

/**
 * replica-mediation/1.0 — https://estoc.dev/replica-mediation/1.0
 *
 * An account here is a vault's standalone mediation arrangement: the account
 * DID registers and manages it and never picks up mail, and each replica it
 * adds is a DID of its own that will. The communication DIDs it receives mail for are
 * added each by its own controller's proof, and the account alone takes one
 * back. A replica it removes stays in its roster as removed and is never
 * added again. These accounts share nothing with coordinate-mediation's: a
 * DID is one kind or the other, and neither protocol's controls reach the
 * other's state.
 *
 * A control is a request the account DID authcrypts to one mediator DID, with
 * a body of exactly the members its type lists below. Its answer is the
 * matching reply or a problem-report, sealed to the account, with the
 * request's `id` as `thid`. A reply names accounts, replicas and recipients
 * by their short forms; the mediator DID and a grant come back as they were
 * sent.
 */

export const ACCOUNT_REGISTER = `${REPLICA_MEDIATION_PROTOCOL}/account-register`;
export const ACCOUNT_REGISTERED = `${REPLICA_MEDIATION_PROTOCOL}/account-registered`;
export const REPLICA_ADD = `${REPLICA_MEDIATION_PROTOCOL}/replica-add`;
export const REPLICA_ADDED = `${REPLICA_MEDIATION_PROTOCOL}/replica-added`;
export const REPLICA_LIST = `${REPLICA_MEDIATION_PROTOCOL}/replica-list`;
export const REPLICAS = `${REPLICA_MEDIATION_PROTOCOL}/replicas`;
export const REPLICA_REMOVE = `${REPLICA_MEDIATION_PROTOCOL}/replica-remove`;
export const REPLICA_REMOVED = `${REPLICA_MEDIATION_PROTOCOL}/replica-removed`;
export const RECIPIENT_UPDATE = `${REPLICA_MEDIATION_PROTOCOL}/recipient-update`;
export const RECIPIENT_UPDATED = `${REPLICA_MEDIATION_PROTOCOL}/recipient-updated`;
export const RECIPIENT_QUERY = `${REPLICA_MEDIATION_PROTOCOL}/recipient-query`;
export const RECIPIENTS = `${REPLICA_MEDIATION_PROTOCOL}/recipients`;

export const RECIPIENT_UPDATE_LIMIT = 16;

/**
 * Creates the account of the sending DID, a did:peer:4 that names itself by
 * its long form here; the mediator keeps that form, and later controls may
 * name the account by the short one. The account starts with no replica and
 * no recipient.
 */
export interface AccountRegisterBody {
  /** A UUIDv7 the account keeps for as long as it lives here; its grants carry the same one. */
  mediation_id: string;
}

/** Also the answer to an exact repeat, which changes nothing and keeps the first time. */
export interface AccountRegisteredBody {
  account: string;
  mediation_id: string;
  /** The mediator DID the request addressed: where senders forward the account's mail. */
  routing_did: string;
  /** Seconds since the epoch, as are all times here. */
  registered_time: number;
  limits: Limits;
}

/** Enrolls the replica a grant names in the sending account. */
export interface ReplicaAddBody {
  /** The compact JWS `verifyReplicaGrant` accepts, signed by the sending account. */
  grant: string;
}

/** Also the answer to an exact repeat, which changes nothing and keeps the first time. */
export interface ReplicaAddedBody {
  replica_id: string;
  replica_did: string;
  state: "active";
  added_time: number;
}

/** What the mediator holds the account to, as configured when the reply was written. */
export interface Limits {
  /** How long unclaimed mail waits; a forward's own `expires_time` can only shorten it. */
  message_retention_seconds: number;
  max_message_bytes: number;
  /** Replicas enrolled and not removed. */
  max_active_replicas: number;
  /** The largest `limit` a `replica-list` or a `recipient-query` may ask for. */
  max_membership_page: number;
  max_shared_recipients: number;
  max_recipient_updates: number;
  /**
   * Envelope bytes and envelopes the account may have kept at once. A shared
   * envelope counts once however many replicas it waits for, and keeps
   * counting after all of them acknowledged it, until it lapses: it is kept
   * that long so a repeat of its forward is still recognized.
   */
  max_retained_bytes: number;
  max_retained_messages: number;
  max_deliveries_per_request: number;
}

/** Asks for the replicas the account ever added, in the order it added them. */
export interface ReplicaListBody {
  /** Null to begin, then the `next_cursor` of the page before. */
  cursor: string | null;
  /** From 1 to `max_membership_page`. */
  limit: number;
}

export interface ReplicasBody {
  entries: {
    grant: string;
    state: "active" | "removed";
    added_time: number;
    /** Null while the replica is active. */
    removed_time: number | null;
  }[];
  /**
   * Null on the last page. The pages of one listing are the replicas added
   * when it began, each as it is when its page is written; a cursor is the
   * account's alone and never expires.
   */
  next_cursor: string | null;
}

/**
 * Ends one replica's enrollment. What waited for that replica alone is
 * dropped, mail forwarded to its own DID included, and nothing is queued for
 * or read by that DID afterwards; a reply already on its way is not recalled.
 * Neither its ID nor its DID can be added again.
 */
export interface ReplicaRemoveBody {
  replica_id: string;
}

/** Also the answer to a repeat, which changes nothing and keeps the first time. */
export interface ReplicaRemovedBody {
  replica_id: string;
  state: "removed";
  removed_time: number;
}

/**
 * Changes which communication DIDs' mail the account receives. The updates
 * are applied one by one in the order given and each is answered at its own
 * place in the reply; one that fails undoes none of the others. The shape is
 * coordinate-mediation's recipient-update, an addition carrying what proves it.
 */
export interface RecipientUpdateBody {
  /** From 1 to `max_recipient_updates` of them, each exactly one of the two. */
  updates: (RecipientAddition | RecipientRemoval)[];
}

export interface RecipientAddition {
  /** A did:peer:4, in either form. */
  recipient_did: string;
  action: "add";
  /** Its long form; null while the mediator holds the recipient and so its long form. */
  resolution_material: string | null;
  /** The compact JWS `verifyRecipientProof` accepts, signed by the recipient DID. */
  proof: string;
}

/**
 * Stops routing the DID's mail to the account. Mail already kept for it stays
 * the account's and still waits for its replicas, and the DID is free to be
 * added again, to this account or any other, by a valid proof for that account
 * and this mediator and with its long form.
 */
export interface RecipientRemoval {
  recipient_did: string;
  action: "remove";
}

export interface RecipientUpdatedBody {
  updated: {
    recipient_did: string;
    action: "add" | "remove";
    /** `no_change`: an addition of a recipient the account held, or a removal of one it did not. */
    result: "success" | "no_change" | "client_error";
    /** With `client_error` only: the code a problem-report would have carried. */
    problem?: string;
  }[];
}

/** Asks for the account's recipients, oldest first; the shape is coordinate-mediation's recipient-query. */
export interface RecipientQueryBody {
  paginate: {
    /** From 1 to `max_membership_page`. */
    limit: number;
    /** How many recipients to pass over; a removal in between moves the ones after it. */
    offset: number;
  };
}

export interface RecipientsBody {
  dids: { recipient_did: string }[];
  pagination: {
    /** How many `dids` holds. */
    count: number;
    offset: number;
    /** How many recipients come after this page. */
    remaining: number;
  };
}

/**
 * How a control is refused: a problem-report with code
 * `e.estoc.replica-mediation.<this>`. One update of a `recipient-update` is
 * refused with the same code, in its own answer.
 */
type Problem =
  /** Not authcrypt by the DID it names to exactly one mediator DID, or not exactly the control's body. */
  | "invalid-message"
  /** The grant does not verify, or is for another account, mediator or sender. */
  | "invalid-grant"
  /** The recipient does not resolve, or its proof does not verify for this account and mediator. */
  | "invalid-recipient"
  /** The sender is no did:peer:4, or has no account and this mediator creates none. */
  | "account-refused"
  /** No account of the sender is bound to the mediator DID it addressed. */
  | "unknown-account"
  /** The account added no replica under that ID. */
  | "unknown-replica"
  /** A DID or ID in the request is already bound otherwise, here or under ordinary mediation. */
  | "identity-conflict"
  /** Pickup asked by the account DID: only its replicas hold queues. */
  | "replica-required"
  /** Pickup asked by a replica its account removed. */
  | "replica-removed"
  /** The account is at its replica or recipient limit. */
  | "quota";

const problemCode = (problem: Problem) => `e.estoc.replica-mediation.${problem}`;

export function replicaProblem(problem: Problem): Reply {
  return { type: PROBLEM_REPORT, body: { code: problemCode(problem) } };
}

export function replicaLimits(policy: MediatorPolicy): Limits {
  return {
    message_retention_seconds: policy.messageTtlSeconds,
    max_message_bytes: policy.maxMessageBytes,
    max_active_replicas: policy.maxActiveReplicas,
    max_membership_page: policy.maxMembershipPage,
    max_shared_recipients: policy.maxSharedRecipients,
    max_recipient_updates: RECIPIENT_UPDATE_LIMIT,
    max_retained_bytes: policy.maxRetainedBytes,
    max_retained_messages: policy.maxMessagesPerAccount,
    max_deliveries_per_request: DELIVERY_PAGE_LIMIT,
  };
}

interface Control<Body> {
  /** The authenticated account DID, in its short form when it is a did:peer:4. */
  account: string;
  /** The one mediator DID the request named and was sealed to, as it spelled it. */
  addressed: string;
  /** That DID in its short form when it is a did:peer:4. */
  mediator: string;
  /** Exactly the control's members; what each holds is still unchecked. */
  body: Record<keyof Body, unknown>;
}

function holdsExactly(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...fields].sort().join()
  );
}

/**
 * A control request as what it proved: authcrypted by the DID its plaintext
 * names, to exactly one of this mediator's DIDs, with a body of exactly
 * `fields`. Null when it is not that.
 */
function controlOf<Body>(
  incoming: Unpacked,
  { ctx, sender }: HandlerContext,
  fields: (keyof Body & string)[]
): Control<Body> | null {
  const { message, addressedTo } = incoming;
  if (
    sender === null ||
    !isAuthcrypted(incoming) ||
    typeof message.from !== "string" ||
    (message.from !== sender && provenDid(message.from) !== canonicalDid(sender)) ||
    addressedTo === null ||
    !ctx.dids.includes(addressedTo) ||
    message.to?.length !== 1 ||
    message.to[0] !== addressedTo
  ) {
    return null;
  }

  if (!holdsExactly(message.body, fields)) {
    return null;
  }
  return {
    account: canonicalDid(sender),
    addressed: addressedTo,
    mediator: canonicalDid(addressedTo),
    body: message.body as Record<keyof Body, unknown>,
  };
}

export async function accountRegister(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { ctx, store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<AccountRegisterBody>(incoming, context, ["mediation_id"]);
  const mediationId = control?.body.mediation_id;
  if (control === null || typeof mediationId !== "string" || !UUID_V7.test(mediationId)) {
    return replicaProblem("invalid-message");
  }
  if (isMediatorOwnDid(control.account, ctx.dids)) {
    return replicaProblem("identity-conflict");
  }

  const accountLongForm =
    sender === control.account ? await store.resolutionMaterial(sender) : sender;
  if (!isPeerDID4(sender) || accountLongForm === null) {
    return replicaProblem("account-refused");
  }

  const registration = await store.registerReplicaAccount({
    accountDid: control.account,
    accountLongForm,
    mediationId,
    mediator: control.mediator,
    create: config.openRegistration,
  });

  switch (registration.outcome) {
    case "refused":
      return replicaProblem("account-refused");
    case "conflict":
      return replicaProblem("identity-conflict");
    case "registered":
      return {
        type: ACCOUNT_REGISTERED,
        body: {
          account: control.account,
          mediation_id: mediationId,
          routing_did: control.addressed,
          registered_time: registration.registeredTime,
          limits: replicaLimits(config),
        } satisfies AccountRegisteredBody,
      };
  }
}

export async function replicaAdd(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { ctx, store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<ReplicaAddBody>(incoming, context, ["grant"]);
  if (control === null) {
    return replicaProblem("invalid-message");
  }

  // The grant is checked against the document that opened the envelope.
  const accountDoc = isPeerDID4(sender) ? await ctx.resolve(sender) : null;
  const grant = accountDoc === null ? null : await verifyReplicaGrant(control.body.grant, accountDoc);
  if (
    grant === null ||
    grant.account !== control.account ||
    grant.mediator !== control.mediator ||
    isMediatorOwnDid(grant.replicaDid, ctx.dids)
  ) {
    return replicaProblem("invalid-grant");
  }

  const addition = await store.addReplica({
    accountDid: grant.account,
    mediationId: grant.mediationId,
    mediator: grant.mediator,
    replicaId: grant.replicaId,
    replicaDid: grant.replicaDid,
    replicaLongForm: grant.replicaLongForm,
    grant: control.body.grant as string,
    maxReplicas: config.maxActiveReplicas,
  });

  switch (addition.outcome) {
    case "unknown":
      return replicaProblem("unknown-account");
    case "conflict":
      return replicaProblem("identity-conflict");
    case "full":
      return replicaProblem("quota");
    case "added":
      return {
        type: REPLICA_ADDED,
        body: {
          replica_id: grant.replicaId,
          replica_did: grant.replicaDid,
          state: "active",
          added_time: addition.addedTime,
        } satisfies ReplicaAddedBody,
      };
  }
}

/**
 * Where a listing stands: the account it is of, how many replicas the roster
 * held when the listing began, and the last one already returned. Adding
 * only appends and a removed replica keeps its place, so the first `through`
 * replicas are the same roster for as long as the account lives and a listing
 * never expires.
 */
interface Cursor {
  account: string;
  through: number;
  after: number;
}

function writeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.account, cursor.through, cursor.after])).toString(
    "base64url"
  );
}

function readCursor(text: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    return null;
  }
  const [account, through, after] = parsed as unknown[];
  if (
    typeof account !== "string" ||
    !Number.isSafeInteger(through) ||
    !Number.isSafeInteger(after) ||
    (after as number) < 1 ||
    (after as number) >= (through as number)
  ) {
    return null;
  }
  return { account, through: through as number, after: after as number };
}

export async function replicaList(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<ReplicaListBody>(incoming, context, ["cursor", "limit"]);
  if (control === null) {
    return replicaProblem("invalid-message");
  }

  const { cursor: written, limit } = control.body;
  const cursor = typeof written === "string" ? readCursor(written) : null;
  if (
    (written !== null && (cursor === null || cursor.account !== control.account)) ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > config.maxMembershipPage
  ) {
    return replicaProblem("invalid-message");
  }

  const roster = await store.replicaRoster(
    control.account,
    control.mediator,
    cursor?.after ?? 0,
    cursor?.through ?? null,
    limit as number
  );
  if (roster === null) {
    return replicaProblem("unknown-account");
  }
  const through = cursor?.through ?? roster.size;
  if (through > roster.size) {
    return replicaProblem("invalid-message");
  }

  const last = roster.entries.at(-1)?.ordinal ?? through;
  return {
    type: REPLICAS,
    body: {
      entries: roster.entries.map((entry) => ({
        grant: entry.grant,
        state: entry.removedTime === null ? "active" : "removed",
        added_time: entry.addedTime,
        removed_time: entry.removedTime,
      })),
      next_cursor:
        last < through ? writeCursor({ account: control.account, through, after: last }) : null,
    } satisfies ReplicasBody,
  };
}

export async function replicaRemove(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { store, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<ReplicaRemoveBody>(incoming, context, ["replica_id"]);
  if (control === null || typeof control.body.replica_id !== "string") {
    return replicaProblem("invalid-message");
  }

  const { replica_id } = control.body;
  const removal = await store.removeReplica(control.account, control.mediator, replica_id);
  switch (removal.outcome) {
    case "unknown":
      return replicaProblem("unknown-account");
    case "not-enrolled":
      return replicaProblem("unknown-replica");
    case "removed":
      return {
        type: REPLICA_REMOVED,
        body: {
          replica_id,
          state: "removed",
          removed_time: removal.removedTime,
        } satisfies ReplicaRemovedBody,
      };
  }
}

async function recipientDocument(
  named: string,
  supplied: string | null,
  { store }: HandlerContext
): Promise<{ did: string; longForm: string; doc: DIDDoc } | null> {
  const did = provenDid(named);
  if (did === null || !isShortForm(did)) {
    return null;
  }
  const longForm = supplied ?? (await store.sharedRecipientMaterial(did));
  if (
    longForm === null ||
    !isLongForm(longForm) ||
    !isDecodable(longForm) ||
    longToShort(longForm) !== did
  ) {
    return null;
  }
  const doc = await resolveDIDCommDoc(longForm);
  return doc === null ? null : { did, longForm, doc };
}

type Updated = RecipientUpdatedBody["updated"][number];

function updatesOf(listed: unknown): (RecipientAddition | RecipientRemoval)[] | null {
  if (!Array.isArray(listed) || listed.length < 1 || listed.length > RECIPIENT_UPDATE_LIMIT) {
    return null;
  }
  const isUpdate = (update: unknown): boolean => {
    if (holdsExactly(update, ["action", "recipient_did"])) {
      return update.action === "remove" && typeof update.recipient_did === "string";
    }
    return (
      holdsExactly(update, ["action", "proof", "recipient_did", "resolution_material"]) &&
      update.action === "add" &&
      typeof update.recipient_did === "string" &&
      typeof update.proof === "string" &&
      (update.resolution_material === null || typeof update.resolution_material === "string")
    );
  };
  return listed.every(isUpdate) ? (listed as (RecipientAddition | RecipientRemoval)[]) : null;
}

/** Null when the control's account is not one bound to the mediator it addressed. */
async function addRecipient(
  { recipient_did: named, resolution_material: supplied, proof }: RecipientAddition,
  control: Control<RecipientUpdateBody>,
  context: HandlerContext
): Promise<Updated | null> {
  const { ctx, store, config } = context;
  const answer = { recipient_did: canonicalDid(named), action: "add" as const };
  const refused = (problem: Problem): Updated => ({
    ...answer,
    result: "client_error",
    problem: problemCode(problem),
  });

  // The proof is checked on every request, also for a binding already held.
  const recipient = await recipientDocument(named, supplied, context);
  const proven = recipient === null ? null : await verifyRecipientProof(proof, recipient.doc);
  if (
    recipient === null ||
    proven === null ||
    proven.account !== control.account ||
    proven.mediator !== control.mediator
  ) {
    return refused("invalid-recipient");
  }
  if (isMediatorOwnDid(recipient.did, ctx.dids)) {
    return refused("identity-conflict");
  }

  const outcome = await store.addSharedRecipient({
    accountDid: control.account,
    mediator: control.mediator,
    recipientDid: recipient.did,
    recipientLongForm: recipient.longForm,
    maxRecipients: config.maxSharedRecipients,
  });

  switch (outcome) {
    case "unknown":
      return null;
    case "conflict":
      return refused("identity-conflict");
    case "full":
      return refused("quota");
    case "added":
      return { ...answer, result: "success" };
    case "no_change":
      return { ...answer, result: "no_change" };
  }
}

/** Null when the control's account is not one bound to the mediator it addressed. */
async function removeRecipient(
  { recipient_did: named }: RecipientRemoval,
  control: Control<RecipientUpdateBody>,
  { store }: HandlerContext
): Promise<Updated | null> {
  const did = canonicalDid(named);
  const outcome = await store.removeSharedRecipient(control.account, control.mediator, did);
  if (outcome === "unknown") {
    return null;
  }
  return {
    recipient_did: did,
    action: "remove",
    result: outcome === "removed" ? "success" : "no_change",
  };
}

export async function recipientUpdate(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  if (context.sender === null) {
    return null;
  }
  const control = controlOf<RecipientUpdateBody>(incoming, context, ["updates"]);
  const updates = control === null ? null : updatesOf(control.body.updates);
  if (control === null || updates === null) {
    return replicaProblem("invalid-message");
  }

  const updated: Updated[] = [];
  for (const update of updates) {
    const answer =
      update.action === "add"
        ? await addRecipient(update, control, context)
        : await removeRecipient(update, control, context);
    if (answer === null) {
      return replicaProblem("unknown-account");
    }
    updated.push(answer);
  }
  return { type: RECIPIENT_UPDATED, body: { updated } satisfies RecipientUpdatedBody };
}

export async function recipientQuery(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<RecipientQueryBody>(incoming, context, ["paginate"]);
  const paginate = control?.body.paginate;
  if (control === null || !holdsExactly(paginate, ["limit", "offset"])) {
    return replicaProblem("invalid-message");
  }
  const { limit, offset } = paginate;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > config.maxMembershipPage ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0
  ) {
    return replicaProblem("invalid-message");
  }

  const page = await store.listSharedRecipients(
    control.account,
    control.mediator,
    offset as number,
    limit as number
  );
  if (page === null) {
    return replicaProblem("unknown-account");
  }
  return {
    type: RECIPIENTS,
    body: {
      dids: page.recipients.map((recipient_did) => ({ recipient_did })),
      pagination: {
        count: page.recipients.length,
        offset: offset as number,
        remaining: page.remaining,
      },
    } satisfies RecipientsBody,
  };
}

export const REPLICA_CONTROLS: Record<string, Handler> = {
  [ACCOUNT_REGISTER]: accountRegister,
  [REPLICA_ADD]: replicaAdd,
  [REPLICA_LIST]: replicaList,
  [REPLICA_REMOVE]: replicaRemove,
  [RECIPIENT_UPDATE]: recipientUpdate,
  [RECIPIENT_QUERY]: recipientQuery,
};
