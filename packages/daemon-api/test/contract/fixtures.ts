import type { ChannelRecord, ContactId, ContactRecord, ConversationRecord, InvitationRecord, Lines, LinesState, LocalDidRecord, MediationRecord, MessageId, MessageRecord, ObservationRecord, PendingWork, Snapshot, State } from "../../src/contract/index.js";

/** Fixture IDs are spelled as the daemon would spell them; the brand is asserted, not derived. */
export const as = <Id extends string>(text: string): Id => text as Id;

export const LOCAL = "did:peer:4zQmLocal";
export const PEER = "did:peer:4zQmPeer";
export const PEER_HEAD = "did:peer:4zQmPeerHead";

export const channelId = (localDid: string, peerDid: string) => as<ChannelRecord["channelId"]>(JSON.stringify([localDid, peerDid]));
export const OLD_CHANNEL = channelId(LOCAL, PEER);
export const HEAD_CHANNEL = channelId(LOCAL, PEER_HEAD);

export const mediation: MediationRecord = { mediationId: as("med-1"), mediatorDid: "did:web:mediator.example", selected: true, usable: true, retired: null, diagnostics: [] };

export const localDid: LocalDidRecord = { didId: as("did-1"), did: LOCAL, longFormDid: `${LOCAL}:zLong`, live: true, retired: null, disclosures: [{ as: "oob" }], diagnostics: [] };

export const contact: ContactRecord = { contactId: as("c-1"), origin: "user", flags: { muted: false }, preference: { didId: as("did-1"), channelIds: [HEAD_CHANNEL] } };

export const inbound: MessageRecord = {
  messageId: as("m-in"),
  direction: "in",
  channelId: HEAD_CHANNEL,
  contactIds: [as("c-1")],
  at: as("2026-09-28T10:00:00.000Z"),
  headers: { type: "https://didcomm.org/basicmessage/2.0/message", thid: null, pthid: null, createdTime: 1_790_000_000, expiresTime: null },
  body: { state: "available", body: { content: "hello", "$weird key": [1, { nested: null }] }, attachments: [] },
  kind: "application",
  effectType: null,
  input: { status: "complete" },
  delivery: null,
  acknowledged: false,
  late: false,
  verification: { status: "verified" },
  manualAction: "complete",
  completes: ["https://didcomm.org/basicmessage/2.0/ack"],
  diagnostics: [],
  summary: "hello",
};

export const outbound: MessageRecord = {
  messageId: as("m-out"),
  direction: "out",
  channelId: HEAD_CHANNEL,
  contactIds: [as("c-1")],
  at: as("2026-09-28T10:01:00.000Z"),
  headers: { type: "https://didcomm.org/basicmessage/2.0/message", thid: null, pthid: null, createdTime: null, expiresTime: null },
  body: {
    state: "available",
    body: { content: "hi back" },
    attachments: [{ id: "a1", description: null, filename: "photo.jpg", mediaType: "image/jpeg", format: null, lastModifiedTime: null, byteCount: 1024, content: { kind: "base64", cid: "bafyphoto" }, hash: null, signed: false }],
  },
  kind: null,
  effectType: null,
  input: null,
  delivery: { status: "prepared" },
  acknowledged: false,
  late: false,
  verification: { status: "not-present" },
  manualAction: "retry",
  completes: [],
  diagnostics: [{ kind: "work", because: "the mediator refused the package", reportMessageId: null }],
  summary: "hi back",
};

export const adrift: MessageRecord = {
  ...outbound,
  messageId: as("m-adrift"),
  channelId: null,
  contactIds: [],
  at: as("2026-09-28T10:02:00.000Z"),
  body: { state: "available", body: { content: "which pair?" }, attachments: [] },
  diagnostics: [],
  summary: "which pair?",
};

export const observation: ObservationRecord = {
  sourceEventCid: as("bafyobs"),
  messageId: as("m-in"),
  channelId: HEAD_CHANNEL,
  at: as("2026-09-28T10:00:00.000Z"),
  standing: { status: "complete" },
  verification: { status: "verified" },
  disposition: { status: "admitted" },
  contradicting: false,
};

export const unadmitted: ObservationRecord = { ...observation, sourceEventCid: as("bafyobs2"), messageId: as("m-pending"), disposition: { status: "pending-admission", because: "its proof waits for history" }, verification: { status: "pending-history", because: "the predecessor is unknown" } };

export const oldChannel: ChannelRecord = {
  channelId: OLD_CHANNEL,
  localDid: LOCAL,
  peerDid: PEER,
  headChannelId: HEAD_CHANNEL,
  superseded: true,
  blocked: false,
  conflicted: false,
  send: { status: "closed", because: "the peer rotated away" },
  peerName: null,
  profileSubmitted: null,
  messageIds: [],
  observationIds: [],
};

export const headChannel: ChannelRecord = {
  channelId: HEAD_CHANNEL,
  localDid: LOCAL,
  peerDid: PEER_HEAD,
  headChannelId: HEAD_CHANNEL,
  superseded: false,
  blocked: false,
  conflicted: false,
  send: { status: "open" },
  peerName: { name: "Ada", messageId: as("m-in") },
  profileSubmitted: as<MessageId>("m-out"),
  messageIds: [as("m-in"), as("m-out")],
  observationIds: [as("bafyobs"), as("bafyobs2")],
};

export const conversation: ConversationRecord = {
  id: as("contact:c-1"),
  contactId: as<ContactId>("c-1"),
  petname: "Ada",
  claimedName: { name: "Ada", messageId: as("m-in") },
  channels: [
    { channelId: HEAD_CHANNEL, selected: true },
    { channelId: OLD_CHANNEL, selected: false },
  ],
  writeTo: [HEAD_CHANNEL],
  defaultWriteTo: HEAD_CHANNEL,
  messageIds: [as("m-in"), as("m-out")],
  unadmittedObservationIds: [as("bafyobs2")],
  diagnostics: [],
};

export const invitation: InvitationRecord = { disclosureEventCid: as("bafydisc"), oobId: "oob-1", didId: as("did-1"), localDid: LOCAL, state: { status: "available" } };

export const pending: PendingWork = {
  pendingOutbounds: [{ messageId: as("m-out"), channelId: HEAD_CHANNEL, outcome: "prepared", because: null, entries: ["retry", "cancel"] }],
  missingResponses: [{ executionId: as("x-1"), messageId: as("m-in"), effectType: "https://didcomm.org/basicmessage/2.0/ack", channelId: HEAD_CHANNEL, entries: ["completeResponse"] }],
  missingNotifications: [{ rotationEventCid: as("bafyrot"), channelId: HEAD_CHANNEL, sourceEventCid: null, entries: ["completeNotification"] }],
  notificationConflicts: [{ rotationEventCid: as("bafyrot2"), messageIds: [as("m-n1"), as("m-n2")], entries: [] }],
  pendingProofs: [{ sourceEventCid: as("bafyobs2"), messageId: as("m-pending"), channelId: HEAD_CHANNEL, entries: [] }],
};

export const snapshot: Snapshot = {
  anchor: "did:key:z6MkAnchor",
  label: "Ada's vault",
  restoreUnexplained: false,
  mediations: [mediation],
  dids: [localDid],
  contacts: [contact],
  channels: [oldChannel, headChannel],
  messages: [adrift, inbound, outbound],
  observations: [observation, unadmitted],
  conversations: [conversation],
  invitations: [invitation],
  pending,
  unplaced: { observationIds: [], outputs: [{ messageId: as("m-adrift"), candidateChannelIds: [OLD_CHANNEL, HEAD_CHANNEL] }] },
};

export const openState: State = { epoch: as("epoch-1"), revision: 3, value: { phase: "open", hold: as("hold-1"), snapshot } };

export const lines: Lines = {
  connections: [{ mediationId: as("med-1"), unreachable: null, reconciled: { desired: [LOCAL], held: [LOCAL], added: [], removed: [], refused: [], unknown: [] }, unknownRegistrations: [], drained: { acked: 2, ended: "empty" }, live: true }],
  waiting: [{ key: "k-1", source: { kind: "pickup", mediationId: as("med-1"), deliveryId: "d-1" }, reason: "the sender's document is not resolved yet", held: true }],
  discarded: [{ source: { kind: "direct" }, reason: "not addressed to a DID of this vault" }],
};

export const linesState: LinesState = { epoch: as("epoch-1"), revision: 1, value: lines };

/** A deep copy with one path replaced, for stating what a single wrong member does to a whole record. */
export function withPath<T>(value: T, path: readonly (string | number)[], replacement: unknown): T {
  const copy = structuredClone(value) as unknown;
  let cursor = copy as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) cursor = cursor[step] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (replacement === undefined) delete cursor[last];
  else cursor[last] = replacement;
  return copy as T;
}
