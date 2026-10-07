/**
 * Who answers a live input: makes the outputs it earns on its own, its
 * receipt, its protocol's reply and the notification of a rotation it
 * selected. An input posted straight to this runtime came to it alone,
 * and this runtime answers it. One picked up at a replica-mediation
 * mediator came to every replica of the account, and each would answer
 * it; so each registers at the mediator under the input's execution,
 * an ID every replica derives alike and the mediator reads nothing
 * from, and the replica the registration lists first answers. Another
 * replica records that it left the input to that one, and lists none
 * of the input's outputs as its work. The mediator keeps a registration
 * for as long as, by default, it keeps the mail it fans out, so a
 * replica that picks the mail up late finds the order the others found.
 * A reply that cannot be read as listing this replica, first or not, a
 * refusal, or a request lost twice leaves the input answered by no
 * automatic step here and its outputs listed for the user: a second
 * answer cannot be taken back, and a missing one can be made by hand.
 * An input owed nothing is registered nowhere.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { isPeerDID4 } from "@estoc/did-peer";
import { InvalidDidDocument, canonicalDidOf, scanVault, vaultDraft, type Did, type ExecutionId, type Keys, type MediationId } from "@estoc/vault";

import { responding, type LiveInput, type Responding } from "./action.js";
import { owesEffects, messageOf, type EffectOptions } from "./effects.js";
import { MediatorRefused } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { decide } from "./procedure.js";
import type { IMessage } from "./protocol/didcomm.js";
import { EXECUTION_REGISTER, EXECUTION_REGISTERED } from "./protocol/replica-mediation.js";
import { control } from "./replica-enrollment.js";
import { note } from "./trace.js";

/** A mediator's registration of an execution, as one reply has it. */
export interface ExecutionRegistration {
  mediationId: MediationId;
  executionId: ExecutionId;
  registrationId: string;
  /** every replica registered, in the order each first did, by short form */
  replicas: readonly Did[];
}

export type Responder =
  /** this runtime answers: the input came to it alone, with no registration, or the registration lists it first */
  | { status: "self"; registration: ExecutionRegistration | null }
  /** the replica the registration lists first answers */
  | { status: "other"; registration: ExecutionRegistration }
  /** no registration could be read as listing this replica: no automatic step answers the input */
  | { status: "unknown"; because: string };

export interface ResponderOptions extends Pick<EffectOptions, "handlers" | "acknowledge" | "trace"> {
  /** the input selected a rotation the turn it came in recorded, whose notification is still to make */
  rotated: boolean;
  /** the link speaking as this runtime's replica at an arrangement's mediator, null while there is none */
  inbox: (mediationId: MediationId) => MediatorLink | null;
}

/** Who answers the input, with the authority to make its outputs when this runtime does; no responder for an input owed nothing. */
export type Found =
  | { responder: Extract<Responder, { status: "self" }>; answering: Responding }
  | { responder: Exclude<Responder, { status: "self" }>; answering: null }
  | { responder: null; answering: null };

/**
 * The responder of a live input, registered for at the mediator it was
 * picked up from. The registration that lists another replica first is
 * recorded as this runtime leaving the input to it, once.
 */
export async function findResponder(runtime: VaultRuntime, keys: Keys, live: LiveInput, options: ResponderOptions): Promise<Found> {
  const fold = await scanVault(runtime.vault, keys);
  if (!options.rotated && !owesEffects(fold, live, options)) return { responder: null, answering: null };
  const source = fold.channels.sources.get(live.cid);
  const execution = fold.inbound.ofSource(live.cid);
  if (source === undefined || execution === null) return { responder: null, answering: null };
  const { mediationId } = source.event.data.receivedVia;
  if (mediationId === null) return { responder: { status: "self", registration: null }, answering: responding(live) };

  const replica = fold.replicas.replicas.get(runtime.author);
  const link = options.inbox(mediationId);
  const responder: Responder =
    replica === undefined || replica.mediationId !== mediationId || replica.did === null
      ? { status: "unknown", because: `this runtime has no replica in the arrangement ${mediationId}` }
      : link === null
        ? { status: "unknown", because: `no line to the mediator of ${mediationId}` }
        : await registerExecution(link, mediationId, execution.id, replica.did);
  if (responder.status === "other") {
    const { registrationId, replicas } = responder.registration;
    await decide(runtime, keys, (fold) => {
      const current = fold.inbound.executions.get(execution.id);
      return current !== undefined && current.yielded === null ? [vaultDraft("execution.yielded", { executionId: execution.id, mediationId, registrationId, responderDid: replicas[0]! })] : [];
    });
  }
  await note(options.trace ?? null, {
    stream: "diag",
    what: "responder",
    data: { executionId: execution.id, mediationId, status: responder.status, ...(responder.status === "unknown" ? { because: responder.because } : { responderDid: responder.registration?.replicas[0] }) },
  });
  return responder.status === "self" ? { responder, answering: responding(live) } : { responder, answering: null };
}

/**
 * The registration of an execution at the link's mediator, as the
 * replica `replicaDid` the link speaks for. A request whose answer is
 * lost is made once more: the mediator answers a repeat as the
 * registration stands, this replica in the place it first took.
 */
export async function registerExecution(link: MediatorLink, mediationId: MediationId, executionId: ExecutionId, replicaDid: Did): Promise<Responder> {
  const register = () => control(link, EXECUTION_REGISTER, { execution_id: executionId }, EXECUTION_REGISTERED);
  let reply: IMessage;
  try {
    reply = await register().catch((err: unknown) => {
      if (err instanceof MediatorRefused) throw err;
      return register();
    });
  } catch (err) {
    return { status: "unknown", because: messageOf(err) };
  }
  return responderOf(reply, mediationId, executionId, replicaDid);
}

function responderOf(reply: IMessage, mediationId: MediationId, executionId: ExecutionId, replicaDid: Did): Responder {
  const unknown = (because: string): Responder => ({ status: "unknown", because: `execution-registered ${because}` });
  const { execution_id: echoed, registration_id: registrationId, replicas: listed } = reply.body as Record<string, unknown>;
  if (echoed !== executionId) return unknown("names another execution than the one registered");
  if (typeof registrationId !== "string" || registrationId === "") return unknown("names no registration");
  if (!Array.isArray(listed) || listed.length === 0) return unknown("lists no replica");
  const replicas = listed.map(peerDidOrNull);
  if (replicas.includes(null)) return unknown("lists a replica that is no did:peer:4");
  const me = canonicalDidOf(replicaDid);
  if (!replicas.includes(me)) return unknown("does not list this replica");
  const registration: ExecutionRegistration = { mediationId, executionId, registrationId, replicas: replicas as Did[] };
  return replicas[0] === me ? { status: "self", registration } : { status: "other", registration };
}

function peerDidOrNull(entry: unknown): Did | null {
  if (typeof entry !== "string" || !isPeerDID4(entry)) return null;
  try {
    return canonicalDidOf(entry);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return null;
    throw err;
  }
}
