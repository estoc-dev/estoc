import { z } from "zod";

import type { DaemonErrorCode } from "../errors.js";
import { OUTCOMES, type Baseline, type CancelOutcome, type CompletionOutcome, type ContactReached, type DispatchOutcome, type MergeResult, type MethodInput, type MethodName, type MethodResult, type Outcome, type OutcomeTag, type RotateResult, type SendResult, type SendTarget } from "../methods.js";
import { DISCLOSURE_USES, OOB_INVITATION, PLAIN_TYP, TRACE_LEVELS, type Invitation } from "../protocol.js";
import { linesState } from "./lines.js";
import { messageContent } from "./records.js";
import { revisionMarker, state } from "./state.js";
import { bytes, channelId, contactId, didId, eventCid, executionId, hold, mediationId, messageId } from "./values.js";

/** The codes every method may return, before or instead of running: they are not repeated per method. */
export const COMMON_ERROR_CODES = ["NotAttached", "NoSuchMethod", "InvalidArgument", "OperationFailed"] as const satisfies readonly DaemonErrorCode[];

export interface MethodSchema<Name extends MethodName> {
  input: z.ZodType<MethodInput<Name>>;
  result: z.ZodType<MethodResult<Name>>;
  /** the codes this method returns beyond the common ones */
  errors: readonly DaemonErrorCode[];
  /** the top-level members of its input and result that carry bytes: the only places a byte array is wire data */
  bytes: { input: readonly string[]; result: readonly string[] };
}

const empty = z.object({});
const nothing = z.null();
const noBytes = { input: [], result: [] } as const;
const passphrase = z.string();
const petname = z.string();
const channelIds = z.array(channelId);

const outcome = <Tag extends OutcomeTag>(tags: readonly Tag[]): z.ZodType<Outcome<Tag>> => z.object({ outcome: z.enum(tags as [Tag, ...Tag[]]), because: z.string().nullable() });

export const DISPATCH_OUTCOMES = ["submitted", "pending", "failed", "uncertain", "expired", "spent", "none"] as const satisfies readonly DispatchOutcome[];
export const COMPLETION_OUTCOMES = [...DISPATCH_OUTCOMES, "existing", "refused"] as const satisfies readonly CompletionOutcome[];
export const CANCEL_OUTCOMES = ["cancelled", "none"] as const satisfies readonly CancelOutcome[];

export const outcomeTag: z.ZodType<OutcomeTag> = z.enum(OUTCOMES);
export const dispatchOutcome = outcome(DISPATCH_OUTCOMES);
export const completionOutcome = outcome(COMPLETION_OUTCOMES);
export const cancelOutcome = outcome(CANCEL_OUTCOMES);

const dispatched = z.object({ outcome: z.enum(DISPATCH_OUTCOMES), because: z.string().nullable() });
export const sendResult: z.ZodType<SendResult> = dispatched.extend({ messageId, channelId });
export const contactReached: z.ZodType<ContactReached> = dispatched.extend({ messageId, channelId, contactId });
export const rotateResult: z.ZodType<RotateResult> = z.object({ outcome: z.enum(COMPLETION_OUTCOMES), because: z.string().nullable(), channelId });

export const sendTarget: z.ZodType<SendTarget> = z.union([z.object({ channelId }), z.object({ contactId })]);

export const invitation: z.ZodType<Invitation> = z.object({
  type: z.literal(OOB_INVITATION),
  id: z.string().min(1),
  typ: z.literal(PLAIN_TYP),
  from: z.string().min(1),
  body: z.object({ goal_code: z.string().optional(), goal: z.string().optional(), accept: z.array(z.string()).optional() }),
});

export const baseline: z.ZodType<Baseline> = z.object({ state, lines: linesState });

export const mergeResult: z.ZodType<MergeResult> = z.object({
  added: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  objects: z.int().nonnegative(),
  repaired: z.int().nonnegative(),
  renewed: z.boolean(),
});

const traceLevel = z.enum(TRACE_LEVELS);
const level = z.object({ level: traceLevel });

const lifecycle = ["WrongPhase"] as const;
const dispatching = ["WrongPhase", "RestoreUnexplained", "NoTarget", "SendClosed"] as const;
const manual = ["WrongPhase", "RestoreUnexplained"] as const;

export const methods: { readonly [Name in MethodName]: MethodSchema<Name> } = {
  attach: { input: empty, result: baseline, errors: ["AlreadyAttached"], bytes: noBytes },
  refresh: { input: empty, result: revisionMarker, errors: ["StateChanged"], bytes: noBytes },

  createIdentity: { input: z.object({ name: z.string(), passphrase }), result: nothing, errors: lifecycle, bytes: noBytes },
  restoreIdentity: { input: z.object({ backup: bytes, passphrase }), result: nothing, errors: ["WrongPhase", "ResourceLimit"], bytes: { input: ["backup"], result: [] } },
  unlock: { input: z.object({ passphrase }), result: nothing, errors: lifecycle, bytes: noBytes },
  lock: { input: empty, result: nothing, errors: lifecycle, bytes: noBytes },
  forgetIdentity: { input: z.object({ hold }), result: nothing, errors: ["WrongPhase", "StaleHold"], bytes: noBytes },
  exportBackup: { input: empty, result: z.object({ name: z.string(), bytes }), errors: ["WrongPhase", "ResourceLimit"], bytes: { input: [], result: ["bytes"] } },
  mergeBackup: { input: z.object({ backup: bytes }), result: mergeResult, errors: ["WrongPhase", "ResourceLimit"], bytes: { input: ["backup"], result: [] } },
  explainedRestore: { input: empty, result: nothing, errors: lifecycle, bytes: noBytes },

  setMediator: { input: z.object({ mediatorDid: z.string() }), result: z.object({ mediationId }), errors: lifecycle, bytes: noBytes },
  createInvitation: { input: z.object({ uses: z.enum(DISCLOSURE_USES), goal: z.string().optional() }), result: z.object({ didId, invitation }), errors: lifecycle, bytes: noBytes },
  acceptInvitation: { input: z.object({ invitation, petname }), result: contactReached, errors: dispatching, bytes: noBytes },
  addContactByDid: { input: z.object({ did: z.string(), petname }), result: contactReached, errors: dispatching, bytes: noBytes },
  publicDid: { input: empty, result: z.object({ didId, did: z.string() }), errors: lifecycle, bytes: noBytes },
  resolveChannel: { input: z.object({ localDid: z.string(), peerDid: z.string() }), result: z.object({ channelId }), errors: [], bytes: noBytes },

  createContact: { input: z.object({ petname, channelIds }), result: z.object({ contactId }), errors: lifecycle, bytes: noBytes },
  renameContact: { input: z.object({ contactId, petname }), result: nothing, errors: lifecycle, bytes: noBytes },
  setContactChannels: { input: z.object({ contactId, channelIds }), result: nothing, errors: lifecycle, bytes: noBytes },
  deleteContact: { input: z.object({ contactId, block: z.object({ includeSuccessors: z.boolean() }).nullable(), erase: z.string().nullable() }), result: nothing, errors: lifecycle, bytes: noBytes },
  blockChannels: { input: z.object({ channelIds, includeSuccessors: z.boolean() }), result: nothing, errors: lifecycle, bytes: noBytes },
  eraseMessage: { input: z.object({ messageId }), result: nothing, errors: lifecycle, bytes: noBytes },

  send: { input: z.object({ target: sendTarget, content: messageContent }), result: sendResult, errors: dispatching, bytes: noBytes },
  retry: { input: z.object({ messageId }), result: dispatchOutcome, errors: manual, bytes: noBytes },
  cancel: { input: z.object({ messageId }), result: cancelOutcome, errors: lifecycle, bytes: noBytes },
  completeResponse: { input: z.object({ executionId, effectType: z.string() }), result: completionOutcome, errors: manual, bytes: noBytes },
  completeNotification: { input: z.object({ rotationEventCid: eventCid }), result: completionOutcome, errors: manual, bytes: noBytes },
  rotate: { input: z.object({ channelId }), result: rotateResult, errors: manual, bytes: noBytes },

  reconnect: { input: empty, result: nothing, errors: lifecycle, bytes: noBytes },
  traceLevel: { input: empty, result: level, errors: lifecycle, bytes: noBytes },
  setTraceLevel: { input: level, result: level, errors: lifecycle, bytes: noBytes },
};

export const METHOD_NAMES = Object.keys(methods) as readonly MethodName[];

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
