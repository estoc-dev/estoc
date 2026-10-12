/**
 * The two things a host does with a running vault besides sending and
 * receiving: read its records, and take the manual steps they name.
 * A read scans outside the writer lock, so it shows the vault as of
 * some commit and holds up none. The manual steps are the procedures
 * of the vault and of this package, every transport call of theirs
 * through one dispatcher; each still decides under the lock over the
 * fold it reads there, whatever record prompted it. The handlers given
 * here reach the read, the vault's own procedures and the completion
 * of a response.
 */

import type { Event } from "@estoc/event-store";
import { blockChannels, deleteContact, eraseMessage, objectReader, type Channel, type Committed, type ContactId, type DeleteContactOptions, type EventReference, type ExecutionId, type MessageId } from "@estoc/vault";

import type { LiveAction } from "./action.js";
import type { Cancelled, Dispatched, Selected } from "./dispatch.js";
import type { Dispatcher } from "./dispatcher.js";
import { completeResponse, type EffectOptions, type EffectOutcome } from "./effects.js";
import { MAX_CONTENT_BYTES } from "./prepare.js";
import { recorder, type ManualEntry, type Recorder, type ViewOptions } from "./records.js";
import { completeNotification, rotate, type Rotated, type RotationTarget } from "./rotate.js";
import type { Session } from "./session.js";

/** The records of the vault as it is now, the rotations it lists being those this runtime's replica could make. A body larger than a message may be is shown as missing. */
export async function readRecords(session: Session, options: ViewOptions = {}): Promise<Recorder> {
  const { runtime } = session;
  return recorder(await session.fold(), objectReader(runtime.vault.objects, MAX_CONTENT_BYTES), { ...options, author: runtime.author });
}

export type ManualOptions = Pick<EffectOptions, "handlers" | "acknowledge" | "now" | "trace">;

/** Each manual procedure under the name a record gives it. `rotate` here is the user's own: it names no source, and takes the successor the fold's recipe names. */
export interface Manual extends Record<ManualEntry, unknown> {
  eraseMessage(messageId: MessageId, because?: string): Promise<Committed>;
  deleteContact(contactId: ContactId, options?: DeleteContactOptions): Promise<Committed>;
  blockChannels(channels: readonly Channel[], includeSuccessors: boolean): Promise<Event[]>;
  cancel(messageId: MessageId): Promise<Cancelled>;
  retry(messageId: MessageId): Promise<Dispatched>;
  selectPreparation(messageId: MessageId, preparationEventCid: EventReference<"message.prepared">): Promise<Selected>;
  completeResponse(executionId: ExecutionId, effectType: string): Promise<EffectOutcome>;
  completeNotification(rotationEventCid: EventReference<"did.rotationSelected">): Promise<EffectOutcome>;
  rotate(target: Omit<RotationTarget, "sourceEventCid">): Promise<Rotated>;
}

export function manualProcedures(session: Session, dispatcher: Dispatcher, options: ManualOptions = {}): Manual {
  const { runtime, keys, scanOptions } = session;
  const dispatch = (action: LiveAction): Promise<Dispatched> => dispatcher.run(action);
  const { now, trace } = options;
  return {
    eraseMessage: (messageId, because) => eraseMessage(runtime, keys, messageId, because, scanOptions),
    deleteContact: (contactId, deletion) => deleteContact(runtime, keys, contactId, deletion, scanOptions),
    blockChannels: (channels, includeSuccessors) => blockChannels(runtime, keys, channels, includeSuccessors, scanOptions),
    cancel: (messageId) => dispatcher.cancel(messageId),
    retry: (messageId) => dispatcher.retry(messageId),
    selectPreparation: (messageId, preparationEventCid) => dispatcher.select(messageId, preparationEventCid),
    completeResponse: (executionId, effectType) => completeResponse(session, executionId, effectType, { ...options, dispatch }),
    completeNotification: (rotationEventCid) => completeNotification(session, rotationEventCid, { now, trace, dispatch }),
    rotate: ({ localDidId, peerDid }) => rotate(session, { localDidId, peerDid, sourceEventCid: null }, { now, trace, dispatch }),
  };
}
