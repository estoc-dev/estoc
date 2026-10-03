import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Message } from "@estoc/didcomm-node";
import type { IMessage } from "@estoc/didcomm-node";
import canonicalize from "canonicalize";
import { v7 as uuidv7 } from "uuid";
import WebSocket from "ws";

import { DIDCommContext } from "../src/didcomm/didcomm.js";
import { resolveDIDCommDoc } from "../src/didcomm/did-resolver.js";
import { blobName } from "../src/blobs/hash.js";
import { mintIdentity } from "../src/identity-core.js";
import { RECIPIENT_PROOF_TYP, peer4Agent, signedBy, type Peer4Agent } from "../test/helpers.js";

/**
 * Drive a full client flow against a *running* mediator — the deploy
 * verification tool. Exercises, under coordinate-mediation: grant, keylist
 * binding, anonymous forward, the pickup loop, and WebSocket live delivery
 * (asserting text frames, the thing headless clients never catch). Then,
 * under replica-mediation, what the Estoc app does: register an account,
 * add a replica under the account's grant, add a recipient under its own
 * proof, and pick up, acknowledge and be pushed that recipient's mail under
 * the replica's DID. A mediator with replica-mediation off fails here, since
 * the app cannot enroll with it.
 *
 *   pnpm run smoke http://127.0.0.1:8787
 */

const base = process.argv[2];
if (base === undefined || !base.startsWith("http")) {
  console.error("usage: pnpm run smoke <mediator-url>");
  process.exit(1);
}

const ENCRYPTED = "application/didcomm-encrypted+json";

function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`FAILED: ${label}`);
  }
  console.log(`ok: ${label}`);
}

/** didcomm-rust re-serializes JSON with sorted keys, so compare unordered. */
const sameJson = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);

const { did: mediatorDid, invitationUrl, blobs: blobLimits } = (await (
  await fetch(base)
).json()) as { did: string; invitationUrl: string; blobs?: { maxBytes: number } };
console.log(`mediator: ${mediatorDid}`);

{
  const res = await fetch(`${base}/invitation`);
  const invitation = (await res.json()) as { type: string; from: string };
  check(
    res.ok &&
      invitation.type === "https://didcomm.org/out-of-band/2.0/invitation" &&
      invitation.from === mediatorDid,
    "OOB invitation served at /invitation"
  );

  const oob = new URL(invitationUrl).searchParams.get("_oob");
  check(
    oob !== null &&
      sameJson(JSON.parse(Buffer.from(oob, "base64url").toString("utf8")), invitation),
    "invitation URL _oob decodes to the same invitation"
  );
}

const alice = await mintIdentity("https://smoke-alice.test/didcomm");
const ctx = new DIDCommContext(alice.did, alice.didDoc, alice.secrets);

interface Speaker {
  did: string;
  ctx: DIDCommContext;
}

const asAlice: Speaker = { did: alice.did, ctx };

function plaintext(type: string, body: Record<string, unknown>, from: string = alice.did): IMessage {
  return {
    id: randomUUID(),
    typ: "application/didcomm-plain+json",
    type,
    from,
    to: [mediatorDid],
    created_time: Math.floor(Date.now() / 1000),
    // messagepickup 3.0: every request must declare the return route.
    return_route: "all",
    body,
  };
}

async function send(
  type: string,
  body: Record<string, unknown>,
  speaker: Speaker = asAlice
): Promise<IMessage> {
  const packed = await speaker.ctx.packEncrypted(plaintext(type, body, speaker.did), mediatorDid);
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": ENCRYPTED },
    body: packed,
  });
  check(res.ok, `POST ${type.split("/").pop()} → ${res.status}`);
  const { message } = await speaker.ctx.unpack(await res.text());
  return message;
}

const ANONYMOUS = {
  resolver: { resolve: resolveDIDCommDoc },
  secrets: { get_secret: async () => null, find_secrets: async () => [] },
};

/** A real envelope for `to` (Alice unless said), as the JSON a forward carries: the mediator takes nothing else. */
async function sealedNote(content: string, to: string = alice.did): Promise<unknown> {
  const note = new Message({
    ...plaintext("https://example.test/note", { content }),
    from: undefined,
    to: [to],
    return_route: undefined,
  } as IMessage);
  const [packed] = await note.pack_encrypted(to, null, null, ANONYMOUS.resolver, ANONYMOUS.secrets, {
    forward: false,
  });
  return JSON.parse(packed);
}

const PICKUP = "https://didcomm.org/messagepickup/3.0";
const DELIVERY = `${PICKUP}/delivery`;

type Attached = { id: string; data: { base64: string } };

const decoded = (attachment: Attached): unknown => JSON.parse(Buffer.from(attachment.data.base64, "base64url").toString("utf8"));

async function forwardAnonymously(next: string, inner: unknown, id: string = randomUUID()): Promise<number> {
  const msg = new Message(
    plaintext("https://didcomm.org/routing/2.0/forward", { next })
  );
  // Anoncrypt with an attachment — how a stranger's mail arrives. A forward
  // is one-way, so it carries no return_route.
  const withAttachment = new Message({
    ...msg.as_value(),
    id,
    from: undefined,
    return_route: undefined,
    attachments: [{ id: randomUUID(), media_type: ENCRYPTED, data: { json: inner } }],
  } as IMessage);
  const [packed] = await withAttachment.pack_encrypted(
    mediatorDid,
    null,
    null,
    { resolve: resolveDIDCommDoc },
    { get_secret: async () => null, find_secrets: async () => [] },
    { forward: false }
  );
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": ENCRYPTED },
    body: packed,
  });
  return res.status;
}

// --- coordinate-mediation/3.0: mediation + pickup loop over HTTP --------

const grant = await send(
  "https://didcomm.org/coordinate-mediation/3.0/mediate-request",
  {}
);
check(
  grant.type === "https://didcomm.org/coordinate-mediation/3.0/mediate-grant",
  "mediation granted"
);

const alias = `did:example:smoke-${randomUUID().slice(0, 8)}`;
const updated = await send(
  "https://didcomm.org/coordinate-mediation/3.0/recipient-update",
  { updates: [{ recipient_did: alias, action: "add" }] }
);
check(
  (updated.body.updated as { result: string }[])[0].result === "success",
  "recipient bound"
);

const inner = await sealedNote("hello over http");
const forwardId = randomUUID();
check((await forwardAnonymously(alias, inner, forwardId)) === 202, "anonymous forward accepted");
check((await forwardAnonymously(alias, inner, forwardId)) === 202, "the same forward again is accepted, and queued once");
check(
  (await forwardAnonymously(alias, await sealedNote("other bytes"), forwardId)) === 422,
  "the forward's id with another envelope is refused"
);
check((await forwardAnonymously(alias, { not: "an envelope" })) === 400, "a forward carrying no envelope is refused");

const status = await send(
  "https://didcomm.org/messagepickup/3.0/status-request",
  {}
);
check(status.body.message_count === 1, "one message waiting");

const delivery = await send(
  "https://didcomm.org/messagepickup/3.0/delivery-request",
  { limit: 10 }
);
const attachments = delivery.attachments as { id: string; data: { base64: string } }[];
check(
  delivery.type === "https://didcomm.org/messagepickup/3.0/delivery" &&
    sameJson(
      JSON.parse(Buffer.from(attachments[0].data.base64, "base64url").toString("utf8")),
      inner
    ),
  "delivery carries the forwarded message, base64url"
);

const afterAck = await send(
  "https://didcomm.org/messagepickup/3.0/messages-received",
  { message_id_list: attachments.map((a) => a.id) }
);
check(afterAck.body.message_count === 0, "acknowledged messages deleted");

// --- Live delivery over WebSocket --------------------------------------

const wsUrl = base.replace(/^http/, "ws");

async function openSocket(): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function nextTextFrame(ws: WebSocket, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => {
      try {
        check(!isBinary, `${label} arrived as a text frame`);
      } catch (err) {
        reject(err);
        return;
      }
      resolve(data.toString());
    });
    setTimeout(() => reject(new Error(`FAILED: no frame for ${label}`)), 8000);
  });
}

const ws = await openSocket();
const statusFrame = nextTextFrame(ws, "live-delivery-change status");
ws.send(
  await ctx.packEncrypted(
    plaintext("https://didcomm.org/messagepickup/3.0/live-delivery-change", {
      live_delivery: true,
    }),
    mediatorDid
  )
);
const liveStatus = (await ctx.unpack(await statusFrame)).message;
check(liveStatus.body.live_delivery === true, "live delivery enabled");

const pushFrame = nextTextFrame(ws, "live delivery push");
const liveInner = await sealedNote("hello live");
check(
  (await forwardAnonymously(alias, liveInner)) === 202,
  "anonymous forward while socket open"
);
const push = (await ctx.unpack(await pushFrame)).message;
const pushAttachments = push.attachments as { id: string; data: { base64: string } }[];
check(
  push.type === "https://didcomm.org/messagepickup/3.0/delivery" &&
    sameJson(
      JSON.parse(
        Buffer.from(pushAttachments[0].data.base64, "base64url").toString("utf8")
      ),
      liveInner
    ),
  "push carries the live message"
);

const afterLiveAck = await send(
  "https://didcomm.org/messagepickup/3.0/messages-received",
  { message_id_list: pushAttachments.map((a) => a.id) }
);
check(afterLiveAck.body.message_count === 0, "live message acknowledged over http");
ws.close();

// --- replica-mediation/1.0: what the Estoc app enrolls as ---------------

const REPLICA = "https://estoc.dev/replica-mediation/1.0";
const PROBLEM = "https://didcomm.org/report-problem/2.0/problem-report";

/** The short form, sealed with the long form's keys: how an account or a replica speaks once the mediator holds its long form. */
const known = (who: Peer4Agent): Speaker => ({ did: who.did, ctx: who.shortCtx });

const account = await peer4Agent(null);
const registered = await send(`${REPLICA}/account-register`, {}, { did: account.longForm, ctx: account.ctx });
if (registered.type === PROBLEM) {
  throw new Error(
    `FAILED: replica-mediation/1.0 is refused here (${String(registered.body.code)}); the Estoc app enrolls only as a replica-mediation account, so deploy with MEDIATOR_REPLICA_MEDIATION=true`
  );
}
check(
  registered.type === `${REPLICA}/account-registered` && registered.body.account === account.did && registered.body.routing_did === mediatorDid,
  "account registered, routed through the mediator"
);

const replica = await peer4Agent(mediatorDid);
const replicaGrant = await signedBy(account, {
  account: account.did,
  mediation_id: uuidv7(),
  mediator: mediatorDid,
  replica_id: uuidv7(),
  replica_did: replica.did,
  replica_long_form: replica.longForm,
});
const replicaAdded = await send(`${REPLICA}/replica-add`, { grant: replicaGrant }, known(account));
check(
  replicaAdded.type === `${REPLICA}/replica-added` && replicaAdded.body.replica_did === replica.did && replicaAdded.body.state === "active",
  "replica added under the account's grant"
);

const recipient = await peer4Agent(mediatorDid);
const proof = await signedBy(recipient, { account: account.did, aud: mediatorDid, recipient: recipient.did }, { typ: RECIPIENT_PROOF_TYP });
const recipientAdded = await send(
  `${REPLICA}/recipient-add`,
  { recipient_did: recipient.did, resolution_material: recipient.longForm, proof },
  known(account)
);
check(
  recipientAdded.type === `${REPLICA}/recipient-added` && recipientAdded.body.recipient_did === recipient.did,
  "recipient added under its own proof"
);

const shared = await sealedNote("hello replica", recipient.longForm);
check((await forwardAnonymously(recipient.did, shared)) === 202, "anonymous forward to the shared recipient accepted");
const replicaStatus = await send(`${PICKUP}/status-request`, {}, known(replica));
check(replicaStatus.body.message_count === 1, "one message waiting for the replica");
const replicaDelivery = await send(`${PICKUP}/delivery-request`, { limit: 10 }, known(replica));
const replicaAttachments = replicaDelivery.attachments as Attached[];
check(
  replicaDelivery.type === DELIVERY && replicaAttachments.length === 1 && sameJson(decoded(replicaAttachments[0]), shared),
  "the replica is handed the shared message under its own DID"
);
const replicaAcked = await send(
  `${PICKUP}/messages-received`,
  { message_id_list: replicaAttachments.map((attachment) => attachment.id) },
  known(replica)
);
check(replicaAcked.body.message_count === 0, "the replica's acknowledgement empties its queue");

const replicaWs = await openSocket();
const replicaStatusFrame = nextTextFrame(replicaWs, "replica live-delivery-change status");
replicaWs.send(
  await replica.shortCtx.packEncrypted(plaintext(`${PICKUP}/live-delivery-change`, { live_delivery: true }, replica.did), mediatorDid)
);
check((await replica.shortCtx.unpack(await replicaStatusFrame)).message.body.live_delivery === true, "live delivery enabled for the replica");
const replicaPushFrame = nextTextFrame(replicaWs, "replica live delivery push");
const sharedLive = await sealedNote("hello replica, live", recipient.longForm);
check((await forwardAnonymously(recipient.did, sharedLive)) === 202, "anonymous forward to the shared recipient while the replica's socket is open");
const replicaPush = (await replica.shortCtx.unpack(await replicaPushFrame)).message;
const pushedToReplica = replicaPush.attachments as Attached[];
check(replicaPush.type === DELIVERY && sameJson(decoded(pushedToReplica[0]), sharedLive), "the push to the replica carries the live message");
const replicaLiveAcked = await send(
  `${PICKUP}/messages-received`,
  { message_id_list: pushedToReplica.map((attachment) => attachment.id) },
  known(replica)
);
check(replicaLiveAcked.body.message_count === 0, "the replica's live message acknowledged over http");
replicaWs.close();

// --- Edges --------------------------------------------------------------

const problem = await send("https://didcomm.org/nonsense/1.0/x", {});
check(
  problem.type === "https://didcomm.org/report-problem/2.0/problem-report",
  "unsupported type answered with problem-report"
);

const garbage = await fetch(base, {
  method: "POST",
  headers: { "content-type": ENCRYPTED },
  body: "not an envelope",
});
check(garbage.status === 400, "garbage refused with 400");

// --- blob-store/1.0 (when the deployment keeps blobs) -------------------

if (blobLimits === undefined) {
  console.log("skip: blob-store not advertised");
} else {
  const bytes = randomBytes(Math.min(300_000, blobLimits.maxBytes));
  const hash = blobName(createHash("sha256").update(bytes).digest());
  const put = await send("https://estoc.dev/blob-store/1.0/put", { hash, size: bytes.length });
  const upload = put.body.upload as { url: string } | undefined;
  check(
    put.type === "https://estoc.dev/blob-store/1.0/put-result" && upload !== undefined,
    "blob put answered with an upload URL"
  );
  check(
    /\/b\/[a-z2-7]{32}$/.test(put.body.url as string) && !(put.body.url as string).includes(hash),
    "blob URL is a random id, not the hash"
  );
  const uploaded = await fetch(upload!.url, {
    method: "PUT",
    headers: { "content-length": String(bytes.length) },
    body: bytes,
  });
  check(uploaded.status === 204, `blob uploaded → ${uploaded.status}`);
  const got = await fetch(put.body.url as string, { headers: { range: "bytes=10-19" } });
  check(
    got.status === 206 && Buffer.from(await got.arrayBuffer()).equals(bytes.subarray(10, 20)),
    "blob served with Range"
  );
  const renewed = await send("https://estoc.dev/blob-store/1.0/put", { hash, size: bytes.length });
  check(renewed.body.upload === undefined, "second put is a renewal");
  const deleted = await send("https://estoc.dev/blob-store/1.0/delete", { hash });
  check(
    deleted.type === "https://estoc.dev/blob-store/1.0/delete-result" &&
      (await fetch(put.body.url as string)).status === 404,
    "blob deleted and gone"
  );
}

console.log("\nsmoke: all green");
