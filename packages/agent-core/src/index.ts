/**
 * `@estoc/agent-core` — the DIDComm v2 agent over the vault. A
 * message is decided over the fold read under the vault's writer lock
 * and committed as an intent, then as a preparation, before its one
 * transport call, which goes under a live action once the lock is
 * released. The protocols themselves — message types and shapes — are
 * under `protocol/`; `unpack` opens an
 * inbound envelope there with its rotation proof left for the vault
 * to judge.
 */

export * from "./protocol/spec.js";
export * from "./protocol/mediation.js";
export * from "./protocol/replica-mediation.js";
export * from "./protocol/blob-store.js";
export * from "./protocol/replica-channel.js";
export { BASIC_MESSAGE } from "./protocol/basicmessage.js";
export { PROFILE, REQUEST_PROFILE, announcedName } from "./protocol/user-profile.js";
export {
  ENCRYPTED_MIME,
  EnvelopeRefused,
  PLAIN_TYP,
  endpointOf,
  plainMessage,
  secretsResolverFor,
  serviceUris,
  unpack,
  type DidcommApi,
  type IMessage,
  type Unpacked,
} from "./protocol/didcomm.js";
export { GOAL_CONNECT, invitationUrl, parseInvitation, type Invitation } from "./protocol/oob.js";

export { AmbiguousTarget, BlobMismatch, BlobTooLarge, BlobTransferFailed, BlobUnopened, EntityConflict, LinkClosed, MediatorRefused, NoTarget, NotAReplica, NotificationConflict, ReceiverClosed, ReceiverInUse, UnauthorizedKey, UnknownEntity, Unregistered, Unusable, UnverifiedReply, WrongAccount, WrongMediator } from "./errors.js";
export {
  createVault,
  inspectRuntime,
  inspectSnapshot,
  openVault,
  type CreateVaultOptions,
  type InspectSnapshotOptions,
  type InspectedRuntime,
  type InspectedSnapshot,
  type OpenedVault,
  type Unlock,
  type OpenVaultOptions,
  type VaultOptions,
} from "./identity.js";
export {
  AgentTrace,
  TRACE_LEVELS,
  TRACE_NORMAL,
  TRACE_OFF,
  TRACE_OPTION,
  TRACE_STREAMS,
  TRACE_VERBOSE,
  isTraceLevel,
  isTraceStream,
  streamOf,
  tracePolicy,
  type AgentTraceOptions,
  type TraceData,
  type TraceFilter,
  type TraceLevel,
  type TracePolicy,
  type TraceStream,
} from "./trace.js";
export { readBlob, type BlobLimits, type BlobPlacement, type BlobStore, type ReadBlobOptions } from "./blob-store.js";
export { SEAL_OVERHEAD, blobName, openBlob, sealBlob, type BlobKey, type BlobLink, type SealedBlob } from "./sealed-blob.js";
export type { Drained } from "./pickup.js";
export { decide, serially, type Decided } from "./procedure.js";
export { createMediation, selectMediation } from "./mediation.js";
export type { Arrangement } from "./arrangement.js";
export type { EnrollStep, Enrolled } from "./replica-enrollment.js";
export { LocalRecords, type LeftTo, type LocalStore } from "./local-records.js";
export type { RecipientsAdded } from "./replica-recipients.js";
export type { ListedReplica } from "./replica-list.js";
export { createDid, type CreatedDid, type Disclosed, type Disclosure, type RouteSpec } from "./dids.js";
export type { Content, EffectContent, SendOptions, Sent, Target } from "./send.js";
export { MAX_CONTENT_BYTES } from "./prepare.js";
export type { ActionKind, LiveAction, LiveInput } from "./action.js";
export { DISPATCH_TIMEOUT_MS, type Cancelled, type Dispatched, type Selected } from "./dispatch.js";
export { RETRY_POLICY, type PendingOutbound, type RetryPolicy, type Waiting } from "./dispatcher.js";
export { GLOBAL_TIMERS, type Timers } from "./lifetime.js";
export { MAX_HELD_BYTES, MAX_WAITING, type Discarded, type Ingress, type Received, type Source, type WaitingDelivery } from "./receive/receiver.js";
export type { ReplicaAddress, SnapshotLinkReceived } from "./replica-channel.js";
export type { Owed } from "./reconcile.js";
export type { AfterReceipt } from "./receive/after.js";
export type { Called, EffectOutcome, Reacted } from "./effects.js";
export type { Rotated } from "./rotate.js";
export type { ExecutionRegistration, Responder } from "./responder.js";
export type { PrivateAddress } from "./privacy.js";
export { BUILT_IN_HANDLERS, effectTypesOf, type Handler, type Input, type Response } from "./handlers/index.js";
export {
  recorder,
  type BodyRecord,
  type ChannelRecord,
  type ConflictingNotification,
  type ContactChannelRecord,
  type ContactRecord,
  type Diagnostic,
  type DiagnosticKind,
  type InvitationRecord,
  type ManualEntry,
  type MessageHeaders,
  type MessageRecord,
  type OpenRotation,
  type OwedNotification,
  type OwedResponse,
  type OpenOutbound,
  type WaitingProof,
  type PendingWork,
  type Recorder,
  type DispositionRecord,
  type ObservationRecord,
  type Unplaced,
  type UnplacedOutput,
  type ViewOptions,
} from "./records.js";
export type { Manual } from "./views.js";
export { Agent, UPKEEP, type Upkeep, type AgentLines, type AgentOptions, type Connection, type Inbound, type Submitted } from "./agent.js";
