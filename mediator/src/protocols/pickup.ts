import { randomUUID } from "node:crypto";

import { isAuthcrypted } from "../didcomm/didcomm.js";
import type { DIDCommContext, Unpacked } from "../didcomm/didcomm.js";
import type { StoredMessage } from "../store/types.js";
import type { HandlerContext, LiveSink, Reply } from "./types.js";
import { PROBLEM_REPORT } from "./problem-report.js";
import { canonicalDid } from "./replica-grant.js";
import { replicaProblem } from "./replica-mediation.js";

/**
 * Pickup always reads the sender's own queue, and which queue that is follows
 * from who the sender proved to be. An ordinary account has one inbox: every
 * message forwarded to any recipient DID it has bound lands there, and
 * `recipient_did` is echoed without narrowing anything — the DIF demo sends
 * only `{limit}`. A replica has the deliveries queued for it alone, of mail
 * forwarded to itself or to its account's shared recipients, and there
 * `recipient_did` narrows to what was forwarded to that DID. Neither can name
 * its way into another's queue.
 *
 * A connection that stays open belongs to the DID that first proved itself
 * on it: that is who its live mode is kept for and whose mail is pushed down
 * it. Pickup from any other DID is refused there, so that no one is told
 * about, or changes, a live mode that is not theirs.
 */

export const STATUS_REQUEST =
  "https://didcomm.org/messagepickup/3.0/status-request";
export const STATUS = "https://didcomm.org/messagepickup/3.0/status";
export const DELIVERY_REQUEST =
  "https://didcomm.org/messagepickup/3.0/delivery-request";
export const DELIVERY = "https://didcomm.org/messagepickup/3.0/delivery";
export const MESSAGES_RECEIVED =
  "https://didcomm.org/messagepickup/3.0/messages-received";
export const LIVE_DELIVERY_CHANGE =
  "https://didcomm.org/messagepickup/3.0/live-delivery-change";

export const DELIVERY_PAGE_LIMIT = 10;

interface Inbox {
  count(recipientDid: unknown): Promise<number>;
  waiting(limit: number, recipientDid: unknown): Promise<StoredMessage[]>;
  acknowledge(ids: string[]): Promise<void>;
}

const forwardedTo = (recipientDid: unknown): string | null =>
  typeof recipientDid === "string" ? canonicalDid(recipientDid) : null;

const ANOTHERS_CONNECTION: Reply = {
  type: PROBLEM_REPORT,
  body: {
    code: "e.p.msg.connection-bound",
    comment: "This connection belongs to another DID",
  },
};

/**
 * The sender's queue; a refusal on a connection another DID holds, for a
 * replica-mediation account, which manages its replicas and holds no queue
 * of its own, and for a replica its account removed; null for anyone else,
 * and for a replica that proved itself by signature alone: its queue opens
 * to the key that mail is sealed to.
 */
async function inboxOf(
  incoming: Unpacked,
  { store, sender, session }: HandlerContext
): Promise<Inbox | Reply | null> {
  if (sender === null) {
    return null;
  }
  const did = canonicalDid(sender);
  if (session !== null && session.did !== null && canonicalDid(session.did) !== did) {
    return ANOTHERS_CONNECTION;
  }
  if (await store.isReplicaAccount(did)) {
    return replicaProblem("replica-required");
  }
  const replica = await store.replicaState(did);
  if (replica !== null) {
    if (!isAuthcrypted(incoming)) {
      return null;
    }
    if (replica === "removed") {
      return replicaProblem("replica-removed");
    }
    return {
      count: (recipientDid) => store.deliveryCount(did, forwardedTo(recipientDid)),
      waiting: (limit, recipientDid) => store.deliveriesFor(did, limit, forwardedTo(recipientDid)),
      acknowledge: (ids) => store.acknowledgeDeliveries(did, ids),
    };
  }
  if (await store.isMediated(sender)) {
    return {
      count: () => store.messageCount(sender),
      waiting: (limit) => store.messagesFor(sender, limit),
      acknowledge: async (ids) => void (await store.deleteMessages(sender, ids)),
    };
  }
  return null;
}

const isInbox = (found: Inbox | Reply | null): found is Inbox => found !== null && "count" in found;

async function status(
  inbox: Inbox,
  { session }: HandlerContext,
  recipientDid: unknown
): Promise<Reply> {
  return {
    type: STATUS,
    body: {
      message_count: await inbox.count(recipientDid),
      live_delivery: session?.liveDelivery ?? false,
      ...(typeof recipientDid === "string" ? { recipient_did: recipientDid } : {}),
    },
  };
}

export async function statusRequest(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const inbox = await inboxOf(incoming, context);
  return isInbox(inbox) ? status(inbox, context, incoming.message.body.recipient_did) : inbox;
}

/** DIDComm attachments carry base64url, not standard base64. */
function toAttachment(message: StoredMessage) {
  return {
    id: message.id,
    data: { base64: Buffer.from(message.packed).toString("base64url") },
  };
}

export async function deliveryRequest(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const inbox = await inboxOf(incoming, context);
  if (!isInbox(inbox)) {
    return inbox;
  }

  const { limit: rawLimit, recipient_did: recipientDid } = incoming.message.body;
  const limit =
    typeof rawLimit === "number" && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), DELIVERY_PAGE_LIMIT)
      : DELIVERY_PAGE_LIMIT;

  const messages = await inbox.waiting(limit, recipientDid);
  if (messages.length === 0) {
    return status(inbox, context, recipientDid);
  }
  return {
    type: DELIVERY,
    body: typeof recipientDid === "string" ? { recipient_did: recipientDid } : {},
    attachments: messages.map(toAttachment),
  };
}

export async function messagesReceived(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const inbox = await inboxOf(incoming, context);
  if (!isInbox(inbox)) {
    return inbox;
  }

  const list = incoming.message.body.message_id_list;
  await inbox.acknowledge(
    Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []
  );
  return status(inbox, context, undefined);
}

export async function liveDeliveryChange(
  incoming: Unpacked,
  context: HandlerContext
): Promise<Reply | null> {
  const inbox = await inboxOf(incoming, context);
  if (!isInbox(inbox)) {
    return inbox;
  }

  // Live delivery is a property of a connection that stays open; an HTTP
  // request is not one, and the spec names the problem code for saying so.
  if (context.session === null) {
    return {
      type: PROBLEM_REPORT,
      body: {
        code: "e.m.live-mode-not-supported",
        comment: "Live delivery requires a WebSocket connection",
      },
    };
  }

  context.session.liveDelivery = incoming.message.body.live_delivery === true;
  return status(inbox, context, undefined);
}

/**
 * Push freshly stored messages to every live session the owner holds open —
 * the WebSocket half of pickup, called from the forward handler. Messages
 * stay queued until messages-received acknowledges them, so a push that
 * races a disconnect loses nothing.
 */
export async function pushLiveDelivery(
  ctx: DIDCommContext,
  sessions: LiveSink,
  ownerDid: string,
  messages: StoredMessage[],
  asDid: string = ctx.did
): Promise<void> {
  if (messages.length === 0 || !(await sessions.wantsPush(ownerDid))) {
    return;
  }

  const packed = await ctx.packEncrypted(
    {
      id: randomUUID(),
      typ: "application/didcomm-plain+json",
      type: DELIVERY,
      from: asDid,
      to: [ownerDid],
      created_time: Math.floor(Date.now() / 1000),
      body: {},
      attachments: messages.map(toAttachment),
    },
    ownerDid,
    asDid
  );

  await sessions.push(ownerDid, packed);
}
