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
import type { HandlerContext, Reply } from "./types.js";
import { isMediatorOwnDid } from "./coordinate-mediation.js";
import { DELIVERY_PAGE_LIMIT } from "./pickup.js";
import { REPLICA_MEDIATION_PROTOCOL } from "./discover-features.js";
import { PROBLEM_REPORT } from "./problem-report.js";
import { verifyRecipientProof } from "./recipient-proof.js";
import { canonicalDid, provenDid, verifyReplicaGrant } from "./replica-grant.js";

/**
 * replica-mediation/1.0 — https://estoc.dev/replica-mediation/1.0
 *
 * An account here is a vault's standalone mediation arrangement: the account
 * DID manages it and never picks up mail, and each replica it enrolls is a
 * DID of its own that will. The communication DIDs it receives mail for are
 * added one at a time, each by its own controller's proof. Enrollment and
 * recipients are append-only. These accounts share
 * nothing with coordinate-mediation's: a DID is one kind or the other, and
 * neither protocol's controls reach the other's state.
 *
 * A control is a request the account DID authcrypts to one mediator DID, with
 * a body of exactly the members its type lists below. Its answer is the
 * matching reply or a problem-report, sealed to the account, with the
 * request's `id` as `thid`. Every DID in a body that is a did:peer:4 is
 * answered in its short form.
 */

export const REGISTER = `${REPLICA_MEDIATION_PROTOCOL}/register`;
export const REGISTERED = `${REPLICA_MEDIATION_PROTOCOL}/registered`;
export const LIST = `${REPLICA_MEDIATION_PROTOCOL}/list`;
export const REPLICAS = `${REPLICA_MEDIATION_PROTOCOL}/replicas`;
export const RECIPIENT_ADD = `${REPLICA_MEDIATION_PROTOCOL}/recipient-add`;
export const RECIPIENT_ADDED = `${REPLICA_MEDIATION_PROTOCOL}/recipient-added`;

/** Enrolls the replica a grant names; the first one creates the account with it. */
export interface RegisterBody {
  /** The compact JWS `verifyReplicaGrant` accepts, signed by the sending account. */
  grant: string;
}

/** Also the answer to an exact repeat, which changes nothing and keeps the first time. */
export interface RegisteredBody {
  account: string;
  mediation_id: string;
  /** The mediator DID the request addressed: where senders forward the account's mail. */
  routing_did: string;
  replica_id: string;
  replica_did: string;
  state: "active";
  /** Seconds since the epoch, as are all times here. */
  registered_time: number;
  limits: Limits;
}

/** What the mediator holds the account to, as configured when the reply was written. */
export interface Limits {
  /** How long unclaimed mail waits; a forward's own `expires_time` can only shorten it. */
  message_retention_seconds: number;
  max_message_bytes: number;
  max_active_replicas: number;
  /** The largest `limit` a `list` may ask for. */
  max_membership_page: number;
  max_shared_recipients: number;
  /** Envelope bytes and envelopes waiting at once; one shared by several replicas counts once. */
  max_retained_bytes: number;
  max_retained_messages: number;
  max_deliveries_per_request: number;
}

/** Asks for the account's replicas, in the order they enrolled. */
export interface ListBody {
  /** Null to begin, then the `next_cursor` of the page before. */
  cursor: string | null;
  /** From 1 to `max_membership_page`. */
  limit: number;
}

export interface ReplicasBody {
  entries: { grant: string; state: "active"; registered_time: number }[];
  /**
   * Null on the last page. The pages of one listing are the replicas enrolled
   * when it began; a cursor is the account's alone and never expires.
   */
  next_cursor: string | null;
}

/** Routes one communication DID's mail to the account, for good. */
export interface RecipientAddBody {
  /** A did:peer:4, in either form. */
  recipient_did: string;
  /** Its long form; null once the mediator keeps one from an earlier add. */
  resolution_material: string | null;
  /** The compact JWS `verifyRecipientProof` accepts, signed by the recipient DID. */
  proof: string;
}

export interface RecipientAddedBody {
  recipient_did: string;
  /** `no_change`: the account already held it. */
  status: "added" | "no_change";
}

/** How a control is refused: a problem-report with code `e.estoc.replica-mediation.<this>`. */
type Problem =
  /** Not authcrypt by the DID it names to exactly one mediator DID, or not exactly the control's body. */
  | "invalid-message"
  /** The grant does not verify, or is for another account, mediator or sender. */
  | "invalid-grant"
  /** The recipient does not resolve, or its proof does not verify for this account and mediator. */
  | "invalid-recipient"
  /** The account does not exist and this mediator creates none. */
  | "account-refused"
  /** No account of the sender is bound to the mediator DID it addressed. */
  | "unknown-account"
  /** A DID or ID in the request is already bound otherwise, here or under ordinary mediation. */
  | "identity-conflict"
  /** Pickup asked by the account DID: only its replicas hold queues. */
  | "replica-required"
  /** The account is at its replica or recipient limit. */
  | "quota";

export function replicaProblem(problem: Problem): Reply {
  return {
    type: PROBLEM_REPORT,
    body: { code: `e.estoc.replica-mediation.${problem}` },
  };
}

export function replicaLimits(policy: MediatorPolicy): Limits {
  return {
    message_retention_seconds: policy.messageTtlSeconds,
    max_message_bytes: policy.maxMessageBytes,
    max_active_replicas: policy.maxActiveReplicas,
    max_membership_page: policy.maxMembershipPage,
    max_shared_recipients: policy.maxSharedRecipients,
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

  const names = Object.keys(message.body).sort();
  if (names.join() !== [...fields].sort().join()) {
    return null;
  }
  return {
    account: canonicalDid(sender),
    addressed: addressedTo,
    mediator: canonicalDid(addressedTo),
    body: message.body as Record<keyof Body, unknown>,
  };
}

export async function register(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { ctx, store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<RegisterBody>(incoming, context, ["grant"]);
  if (control === null) {
    return replicaProblem("invalid-message");
  }

  // The account's document is the one that opened the envelope: its long
  // form on first contact, or the one kept from that contact afterwards.
  const accountDoc = isPeerDID4(sender) ? await ctx.resolve(sender) : null;
  const grant = accountDoc === null ? null : await verifyReplicaGrant(control.body.grant, accountDoc);
  if (
    accountDoc === null ||
    grant === null ||
    grant.account !== control.account ||
    grant.mediator !== control.mediator ||
    isMediatorOwnDid(grant.account, ctx.dids) ||
    isMediatorOwnDid(grant.replicaDid, ctx.dids)
  ) {
    return replicaProblem("invalid-grant");
  }

  const accountLongForm =
    sender === control.account ? await store.resolutionMaterial(sender) : sender;
  if (accountLongForm === null) {
    return replicaProblem("invalid-grant");
  }

  const registration = await store.registerReplica({
    accountDid: grant.account,
    accountLongForm,
    mediationId: grant.mediationId,
    mediator: grant.mediator,
    replicaId: grant.replicaId,
    replicaDid: grant.replicaDid,
    replicaLongForm: grant.replicaLongForm,
    grant: control.body.grant as string,
    createAccount: config.openRegistration,
    maxReplicas: config.maxActiveReplicas,
  });

  switch (registration.outcome) {
    case "refused":
      return replicaProblem("account-refused");
    case "conflict":
      return replicaProblem("identity-conflict");
    case "full":
      return replicaProblem("quota");
    case "registered":
      return {
        type: REGISTERED,
        body: {
          account: grant.account,
          mediation_id: grant.mediationId,
          routing_did: control.addressed,
          replica_id: grant.replicaId,
          replica_did: grant.replicaDid,
          state: "active",
          registered_time: registration.registeredTime,
          limits: replicaLimits(config),
        } satisfies RegisteredBody,
      };
  }
}

/**
 * Where a listing stands: the account it is of, how many replicas the roster
 * held when the listing began, and the last one already returned. Enrollment
 * only appends, so the first `through` replicas are the same roster for as
 * long as the account lives and a listing never expires.
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

export async function list(incoming: Unpacked, context: HandlerContext): Promise<Reply | null> {
  const { store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<ListBody>(incoming, context, ["cursor", "limit"]);
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
        state: "active",
        registered_time: entry.registeredTime,
      })),
      next_cursor:
        last < through ? writeCursor({ account: control.account, through, after: last }) : null,
    } satisfies ReplicasBody,
  };
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

export async function recipientAdd(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const { ctx, store, config, sender } = context;
  if (sender === null) {
    return null;
  }
  const control = controlOf<RecipientAddBody>(incoming, context, [
    "proof",
    "recipient_did",
    "resolution_material",
  ]);
  if (control === null) {
    return replicaProblem("invalid-message");
  }
  const { recipient_did: named, resolution_material: supplied, proof } = control.body;
  if (
    typeof named !== "string" ||
    typeof proof !== "string" ||
    (supplied !== null && typeof supplied !== "string")
  ) {
    return replicaProblem("invalid-message");
  }

  // The proof is checked on every request, also for a binding already held.
  const recipient = await recipientDocument(named, supplied, context);
  const proven = recipient === null ? null : await verifyRecipientProof(proof, recipient.doc);
  if (
    recipient === null ||
    proven === null ||
    proven.account !== control.account ||
    proven.mediator !== control.mediator
  ) {
    return replicaProblem("invalid-recipient");
  }
  if (isMediatorOwnDid(recipient.did, ctx.dids)) {
    return replicaProblem("identity-conflict");
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
      return replicaProblem("unknown-account");
    case "conflict":
      return replicaProblem("identity-conflict");
    case "full":
      return replicaProblem("quota");
    case "added":
    case "no_change":
      return {
        type: RECIPIENT_ADDED,
        body: { recipient_did: recipient.did, status: outcome } satisfies RecipientAddedBody,
      };
  }
}
