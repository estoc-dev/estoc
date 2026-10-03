import { z } from "zod";

import { DISCLOSURE_AS } from "../protocol.js";
import { MANUAL_ENTRIES } from "../records.js";
import type {
  AttachmentDescriptor,
  BodyRecord,
  ChannelRecord,
  ContactRecord,
  ConversationRecord,
  DeliveryOutcome,
  Diagnostic,
  Disposition,
  ExecutionStatus,
  InvitationRecord,
  InvitationStatus,
  LocalDidRecord,
  ManualEntry,
  MediationRecord,
  MessageContent,
  MessageHeaders,
  MessageRecord,
  MissingNotification,
  MissingResponse,
  NotificationConflict,
  ObservationRecord,
  PendingOutbound,
  PendingProof,
  PendingWork,
  SendGate,
  Snapshot,
  Standing,
  UnplacedRecord,
  VerificationStatus,
} from "../records.js";
import { channelId, contactId, conversationId, didId, displayTime, eventCid, executionId, finite, jsonObject, mediationId, messageId, record } from "./values.js";

const because = z.object({ because: z.string() });
const strings = z.array(z.string());

export const mediationRecord: z.ZodType<MediationRecord> = z.object({
  mediationId,
  mediatorDid: z.string().nullable(),
  selected: z.boolean(),
  usable: z.boolean(),
  retired: z.string().nullable(),
  diagnostics: strings,
});

export const localDidRecord: z.ZodType<LocalDidRecord> = z.object({
  didId,
  did: z.string().nullable(),
  longFormDid: z.string().nullable(),
  live: z.boolean(),
  retired: z.string().nullable(),
  disclosures: z.array(z.object({ as: z.enum(DISCLOSURE_AS) })),
  diagnostics: strings,
});

export const contactRecord: z.ZodType<ContactRecord> = z.object({
  contactId,
  origin: z.enum(["user", "automatic"]).nullable(),
  flags: record(z.boolean()),
  preference: z.object({ didId, channelIds: z.array(channelId) }).nullable(),
});

export const sendGate: z.ZodType<SendGate> = z.discriminatedUnion("status", [z.object({ status: z.literal("open") }), z.object({ status: z.literal("closed"), ...because.shape })]);

const nameClaim = z.object({ name: z.string(), messageId });

export const channelRecord: z.ZodType<ChannelRecord> = z.object({
  channelId,
  localDid: z.string(),
  peerDid: z.string(),
  headChannelId: channelId.nullable(),
  superseded: z.boolean(),
  blocked: z.boolean(),
  conflicted: z.boolean(),
  send: sendGate,
  peerName: nameClaim.nullable(),
  profileSubmitted: messageId.nullable(),
  messageIds: z.array(messageId),
  observationIds: z.array(eventCid),
});

export const messageHeaders: z.ZodType<MessageHeaders> = z.object({
  type: z.string(),
  thid: z.string().nullable(),
  pthid: z.string().nullable(),
  createdTime: finite.nullable(),
  expiresTime: finite.nullable(),
});

export const attachmentDescriptor: z.ZodType<AttachmentDescriptor> = z.object({
  id: z.string().nullable(),
  description: z.string().nullable(),
  filename: z.string().nullable(),
  mediaType: z.string().nullable(),
  format: z.string().nullable(),
  lastModifiedTime: finite.nullable(),
  byteCount: finite.nullable(),
  content: z.discriminatedUnion("kind", [z.object({ kind: z.enum(["base64", "json"]), cid: z.string() }), z.object({ kind: z.literal("links"), links: strings })]),
  hash: z.string().nullable(),
  signed: z.boolean(),
});

export const bodyRecord: z.ZodType<BodyRecord> = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), body: jsonObject, attachments: z.array(attachmentDescriptor) }),
  z.object({ state: z.literal("erased") }),
  z.object({ state: z.literal("missing") }),
]);

export const executionStatus: z.ZodType<ExecutionStatus> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete") }),
  z.object({ status: z.literal("pending"), ...because.shape }),
  z.object({ status: z.literal("conflict"), ...because.shape }),
]);

export const deliveryOutcome: z.ZodType<DeliveryOutcome> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("prepared") }),
  z.object({ status: z.literal("submitted") }),
  z.object({ status: z.literal("terminal"), code: z.enum(["expired", "cancelled"]) }),
  z.object({ status: z.literal("conflict"), ...because.shape }),
]);

export const verificationStatus: z.ZodType<VerificationStatus> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-present") }),
  z.object({ status: z.literal("pending-proof") }),
  z.object({ status: z.literal("pending-history"), ...because.shape }),
  z.object({ status: z.literal("verified") }),
  z.object({ status: z.literal("unsupported"), ...because.shape }),
  z.object({ status: z.literal("invalid"), ...because.shape }),
  z.object({ status: z.literal("conflict"), ...because.shape }),
]);

export const diagnostic: z.ZodType<Diagnostic> = z.object({
  kind: z.enum(["input", "observations", "contradicting", "intent", "outcome", "effect", "work", "remote-error"]),
  because: z.string(),
  reportMessageId: messageId.nullable(),
});

export const messageRecord: z.ZodType<MessageRecord> = z.object({
  messageId,
  direction: z.enum(["in", "out"]),
  channelId: channelId.nullable(),
  contactIds: z.array(contactId),
  at: displayTime,
  headers: messageHeaders.nullable(),
  body: bodyRecord,
  kind: z.enum(["application", "pure-ack", "empty", "ping-response", "error"]).nullable(),
  effectType: z.string().nullable(),
  input: executionStatus.nullable(),
  delivery: deliveryOutcome.nullable(),
  acknowledged: z.boolean(),
  late: z.boolean(),
  verification: verificationStatus,
  manualAction: z.enum(["retry", "complete", "none"]),
  completes: strings,
  diagnostics: z.array(diagnostic),
  summary: z.string().nullable(),
});

export const standing: z.ZodType<Standing> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete") }),
  z.object({ status: z.literal("incomplete"), ...because.shape }),
  z.object({ status: z.literal("conflict"), ...because.shape }),
]);

export const disposition: z.ZodType<Disposition> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("admitted") }),
  z.object({ status: z.literal("refused"), ...because.shape }),
  z.object({ status: z.literal("ignored-superseded") }),
  z.object({ status: z.literal("pending-admission"), ...because.shape }),
]);

export const observationRecord: z.ZodType<ObservationRecord> = z.object({
  sourceEventCid: eventCid,
  messageId,
  channelId: channelId.nullable(),
  at: displayTime,
  standing,
  verification: verificationStatus,
  disposition,
  contradicting: z.boolean(),
});

export const invitationStatus: z.ZodType<InvitationStatus> = z.discriminatedUnion("status", [z.object({ status: z.literal("available") }), z.object({ status: z.literal("unavailable"), ...because.shape })]);

export const invitationRecord: z.ZodType<InvitationRecord> = z.object({
  disclosureEventCid: eventCid,
  oobId: z.string(),
  didId,
  localDid: z.string().nullable(),
  state: invitationStatus,
});

export const conversationRecord: z.ZodType<ConversationRecord> = z.object({
  id: conversationId,
  contactId: contactId.nullable(),
  petname: z.string().nullable(),
  claimedName: nameClaim.nullable(),
  channels: z.array(z.object({ channelId, selected: z.boolean() })),
  writeTo: z.array(channelId),
  defaultWriteTo: channelId.nullable(),
  messageIds: z.array(messageId),
  unadmittedObservationIds: z.array(eventCid),
  diagnostics: strings,
});

export const manualEntry: z.ZodType<ManualEntry> = z.enum(MANUAL_ENTRIES);
const entries = z.array(manualEntry);

export const pendingOutbound: z.ZodType<PendingOutbound> = z.object({
  messageId,
  channelId: channelId.nullable(),
  outcome: z.enum(["queued", "prepared"]),
  because: z.string().nullable(),
  entries,
});

export const missingResponse: z.ZodType<MissingResponse> = z.object({ executionId, messageId, effectType: z.string(), channelId, entries });

export const missingNotification: z.ZodType<MissingNotification> = z.object({ rotationEventCid: eventCid, channelId, sourceEventCid: eventCid.nullable(), entries });

export const notificationConflict: z.ZodType<NotificationConflict> = z.object({ rotationEventCid: eventCid, messageIds: z.array(messageId), entries });

export const pendingProof: z.ZodType<PendingProof> = z.object({ sourceEventCid: eventCid, messageId, channelId: channelId.nullable(), entries });

export const pendingWork: z.ZodType<PendingWork> = z.object({
  pendingOutbounds: z.array(pendingOutbound),
  missingResponses: z.array(missingResponse),
  missingNotifications: z.array(missingNotification),
  notificationConflicts: z.array(notificationConflict),
  pendingProofs: z.array(pendingProof),
});

export const unplacedRecord: z.ZodType<UnplacedRecord> = z.object({
  observationIds: z.array(eventCid),
  outputs: z.array(z.object({ messageId, candidateChannelIds: z.array(channelId) })),
});

export const snapshot: z.ZodType<Snapshot> = z.object({
  anchor: z.string(),
  label: z.string(),
  restoreUnexplained: z.boolean(),
  mediations: z.array(mediationRecord),
  dids: z.array(localDidRecord),
  contacts: z.array(contactRecord),
  channels: z.array(channelRecord),
  messages: z.array(messageRecord),
  observations: z.array(observationRecord),
  conversations: z.array(conversationRecord),
  invitations: z.array(invitationRecord),
  pending: pendingWork,
  unplaced: unplacedRecord,
});

export const messageContent: z.ZodType<MessageContent> = z.object({
  type: z.string(),
  body: jsonObject,
  attachments: z.array(jsonObject).optional(),
  thid: z.string().nullable().optional(),
  pthid: z.string().nullable().optional(),
  createdTime: finite.nullable().optional(),
  expiresTime: finite.nullable().optional(),
  pleaseAck: strings.nullable().optional(),
  headers: jsonObject.optional(),
});
