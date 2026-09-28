/**
 * The daemon behind the API's method table. Each method's named input is
 * read into the domain's terms — a channel ID taken apart into its pair,
 * an ID handed back as the vault spells it — the domain is called, and
 * what it answered is spelled as the API does. A refusal the daemon can
 * tell apart keeps its code and its effect; anything else the domain
 * throws is a failure whose effect is unknown, left for the server to
 * answer as one.
 */

import { NoTarget, Unusable, type Content, type Invitation as DomainInvitation } from "@estoc/agent-core";
import type { ApiError, Baseline, CancelOutcome, ChannelId, CompletionOutcome, DispatchOutcome, Limits, Lines, MessageId, Snapshot } from "@estoc/daemon-api/contract";
import { Refusal, type MethodHandlers, type Session, type Transport } from "@estoc/daemon-api/wire";
import { DamagedHistory } from "@estoc/event-store";
import { canonicalDidOf, channelOf as pairOf, type Channel, type Did, type EventReference } from "@estoc/vault";

import type { Outcome, SendResult } from "./api.js";
import { InvalidChannelId, channelIdOf, channelOf } from "./channels.js";
import type { DaemonCore } from "./daemon.js";
import { Refused } from "./errors.js";
import { StateChanged, type Publisher, type Subscriber } from "./publisher.js";

export const DEFAULT_MAX_BACKUP_BYTES = 512 * 1024 * 1024;

/** Room beside a backup for its request's other members and the envelope. */
const HEADROOM = 64 * 1024;

/** The bounds a daemon advertises when it takes a backup of at most `maxBackupBytes`: room for one, for what a request carries beside it and, on a text port, for its base64 spelling. */
export function limitsOf(transport: Transport, maxBackupBytes = DEFAULT_MAX_BACKUP_BYTES): Limits {
  return {
    maxFrameBytes: transport === "text" ? Math.ceil((maxBackupBytes * 4) / 3) + HEADROOM : null,
    maxBackupBytes,
    maxValueBytes: maxBackupBytes + HEADROOM,
    maxDepth: 64,
  };
}

type Effect = ApiError["effect"];

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const invalid = (error: unknown): Refusal => new Refusal({ code: "InvalidArgument", message: failure(error), effect: "none" });

/**
 * The refusal `error` is, or null for a failure the server answers as
 * one. `resolution` is what a target the domain would not send to had
 * for effect: none where nothing precedes resolving the target, possible
 * where a step of the procedure did.
 */
function refusalOf(error: unknown, resolution: Effect, messageId: MessageId | null): Refusal | null {
  if (error instanceof Refusal) return error;
  if (error instanceof Refused) return new Refusal({ code: error.code, message: error.message, effect: error.effect, messageId });
  if (error instanceof InvalidChannelId) return invalid(error);
  if (error instanceof NoTarget) return new Refusal({ code: "NoTarget", message: error.message, effect: resolution, messageId });
  if (error instanceof Unusable && error.what === "channel") return new Refusal({ code: "SendClosed", message: error.message, effect: resolution, messageId });
  return null;
}

interface Guard<Input> {
  resolution?: Effect;
  /** the one message of the vault the call is about, when the state published shows it recorded */
  messageId?(input: Input): MessageId | null;
}

/** The IDs and outcomes as the API spells them are the vault's own text under another brand. */
const spelled = <T extends string>(id: string): T => id as T;

const dispatched = ({ outcome, because }: Outcome): { outcome: DispatchOutcome; because: string | null } => ({ outcome: outcome as DispatchOutcome, because });

const completed = ({ outcome, because }: Outcome): { outcome: CompletionOutcome; because: string | null } => ({ outcome: outcome as CompletionOutcome, because });

const sent = (result: SendResult) => ({ messageId: spelled<MessageId>(result.messageId), channelId: channelIdOf(result.channel), ...dispatched(result) });

function didOf(presented: string): Did {
  try {
    return canonicalDidOf(presented);
  } catch (error) {
    throw invalid(error);
  }
}

/** The pair two DIDs name, each canonical, for a channel ID of a pair no record has shown yet. */
function canonicalPair(localDid: string, peerDid: string): Channel {
  const local = didOf(localDid);
  const peer = didOf(peerDid);
  try {
    return pairOf(local, peer);
  } catch (error) {
    throw invalid(error);
  }
}

/** The daemon's methods as the API's table, each answering in the API's terms; `limits` bounds the backup an export delivers. */
export function methodsOf(core: DaemonCore, limits: Pick<Limits, "maxBackupBytes">): MethodHandlers {
  const guarded =
    <Input, Result>(run: (input: Input) => Promise<Result>, guard: Guard<Input> = {}) =>
    async (input: Input): Promise<Result> => {
      try {
        return await run(input);
      } catch (error) {
        throw refusalOf(error, guard.resolution ?? "possible", guard.messageId?.(input) ?? null) ?? error;
      }
    };

  /** `messageId` when the state published shows the message recorded: known to be in the vault, not merely named by the input. */
  const known = ({ messageId }: { messageId: MessageId }): MessageId | null => {
    const { value } = core.publisher.current.state;
    return value.phase === "open" && value.snapshot.messages.some((message) => message.messageId === messageId) ? messageId : null;
  };

  const pairs = (channelIds: ChannelId[]): Channel[] => channelIds.map(channelOf);

  return {
    refresh: async () => {
      try {
        return await core.publisher.refresh();
      } catch (error) {
        if (error instanceof StateChanged) throw new Refusal({ code: "StateChanged", message: error.message, effect: "none" });
        throw new Refusal({ code: "OperationFailed", message: "a read of the vault failed; the state published stands, stale", effect: "none" });
      }
    },

    createIdentity: guarded(async ({ name, passphrase }) => {
      await core.createIdentity(name, passphrase);
      return null;
    }),
    restoreIdentity: guarded(async ({ backup, passphrase }) => {
      await core.restoreIdentity(backup, passphrase);
      return null;
    }),
    unlock: guarded(async ({ passphrase }) => {
      await core.unlock(passphrase);
      return null;
    }),
    lock: guarded(async () => {
      await core.lock();
      return null;
    }),
    forgetIdentity: guarded(async ({ hold }) => {
      await core.forgetIdentity(hold);
      return null;
    }),
    exportBackup: guarded(async () => {
      const { name, bytes } = await core.exportBackup();
      if (bytes.byteLength > limits.maxBackupBytes) throw new Refusal({ code: "ResourceLimit", message: `the backup is ${bytes.byteLength} bytes, over the ${limits.maxBackupBytes} this daemon delivers`, effect: "none" });
      return { name, bytes };
    }),
    mergeBackup: guarded(({ backup }) => core.mergeBackup(backup)),
    explainedRestore: guarded(async () => {
      await core.explainedRestore();
      return null;
    }),

    setMediator: guarded(async ({ mediatorDid }) => ({ mediationId: spelled(await core.setMediator(didOf(mediatorDid))) })),
    createInvitation: guarded(async ({ uses, goal }) => {
      const { didId, invitation } = await core.createInvitation(uses, goal);
      return { didId: spelled(didId), invitation };
    }),
    acceptInvitation: guarded(
      async ({ invitation, petname }) => {
        const reached = await core.acceptInvitation(invitation as DomainInvitation, petname);
        return { contactId: spelled(reached.contactId), ...sent(reached) };
      },
      { resolution: "possible" }
    ),
    addContactByDid: guarded(
      async ({ did, petname }) => {
        const reached = await core.addContactByDid(did, petname);
        return { contactId: spelled(reached.contactId), ...sent(reached) };
      },
      { resolution: "possible" }
    ),
    publicDid: guarded(async () => {
      const { didId, did } = await core.publicDid();
      return { didId: spelled(didId), did };
    }),
    resolveChannel: async ({ localDid, peerDid }) => ({ channelId: channelIdOf(canonicalPair(localDid, peerDid)) }),

    createContact: guarded(async ({ petname, channelIds }) => ({ contactId: spelled(await core.createContact(petname, pairs(channelIds))) })),
    renameContact: guarded(async ({ contactId, petname }) => {
      await core.renameContact(spelled(contactId), petname);
      return null;
    }),
    setContactChannels: guarded(async ({ contactId, channelIds }) => {
      await core.setContactChannels(spelled(contactId), pairs(channelIds));
      return null;
    }),
    deleteContact: guarded(async ({ contactId, block, erase }) => {
      await core.deleteContact(spelled(contactId), { block: block ?? undefined, erase: erase ?? undefined });
      return null;
    }),
    blockChannels: guarded(async ({ channelIds, includeSuccessors }) => {
      await core.blockChannels(pairs(channelIds), includeSuccessors);
      return null;
    }),
    eraseMessage: guarded(async ({ messageId }) => {
      await core.eraseMessage(spelled(messageId));
      return null;
    }),

    send: guarded(async ({ target, content }) => sent(await core.send(target.channelId !== undefined ? { channel: channelOf(target.channelId) } : { contactId: spelled(target.contactId) }, content as Content)), { resolution: "none" }),
    retry: guarded(async ({ messageId }) => dispatched(await core.retry(spelled(messageId))), { messageId: known }),
    cancel: guarded(
      async ({ messageId }) => {
        const { outcome, because } = await core.cancel(spelled(messageId));
        return { outcome: outcome as CancelOutcome, because };
      },
      { messageId: known }
    ),
    completeResponse: guarded(async ({ executionId, effectType }) => completed(await core.completeResponse(spelled(executionId), effectType))),
    completeNotification: guarded(async ({ rotationEventCid }) => completed(await core.completeNotification(rotationEventCid as string as EventReference<"did.rotationSelected">))),
    rotate: guarded(async ({ channelId }) => {
      const rotated = await core.rotateChannel(channelOf(channelId));
      return { channelId: channelIdOf(rotated.successor), ...completed(rotated) };
    }),

    reconnect: guarded(async () => {
      await core.reconnect();
      return null;
    }),
    traceLevel: guarded(async () => ({ level: await core.traceLevel() })),
    setTraceLevel: guarded(async ({ level }) => ({ level: await core.setTraceLevel(level) })),
  };
}

const unavailable: ApiError = { code: "StateUnavailable", message: "the daemon could not read its state; what it published last stands, stale", effect: "none", messageId: null };

/**
 * `session` told of every publication from the baseline it is handed on,
 * until it closes. A read that fails leaves the state stale and ends the
 * session as unavailable, except where the failure is damage to the
 * history: that is said as a phase, which follows. A session arriving
 * while the state is stale ends the same way, and asks for the read
 * that would make the state fit to attach to again.
 */
export function attachTo(publisher: Publisher<Snapshot, Lines>, session: Session): Baseline {
  const stale = publisher.unavailable;
  if (stale !== null) {
    void publisher.refresh().then(
      () => undefined,
      () => undefined
    );
    session.fault(unavailable);
    throw stale.error;
  }
  const subscriber: Subscriber<Snapshot, Lines> = {
    state: (state) => session.event("state", state),
    lines: (lines) => session.event("lines", lines),
    log: (line) => session.event("log", line),
    unavailable: (error) => {
      if (!(error instanceof DamagedHistory)) session.fault(unavailable);
    },
  };
  const baseline = publisher.attach(subscriber);
  session.onClose(() => publisher.detach(subscriber));
  return baseline;
}
