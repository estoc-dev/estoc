/**
 * Who answers a live input: makes the outputs it earns on its own, its
 * receipt, its protocol's reply and the notification of a rotation it
 * selected. An input posted straight to this runtime came to it alone,
 * and this runtime answers it. One picked up at a replica-mediation
 * mediator came to every replica of the account, and each would answer
 * it; so each registers at the mediator under the input's execution,
 * an ID every replica derives alike and the mediator reads nothing
 * from, and the replica the registration lists first answers. The
 * mediator keeps a registration for as long as, by default, it keeps
 * the mail it fans out, so a replica that picks the mail up late finds
 * the order the others found. A reply that cannot be read as listing
 * this replica, first or not, a refusal, or a request lost twice
 * leaves the input answered by no automatic step here and its outputs
 * listed for the user: a second answer cannot be taken back, and a
 * missing one can be made by hand. An input owed nothing is registered
 * nowhere.
 *
 * Another replica answering is this runtime's own knowledge, kept
 * where what its mediator confirms is: the local options, which
 * outlive a reopen and every commit and go with no snapshot, so that
 * the vault holds what was received and sent alone, and the outputs
 * one replica left to another stay listed on the one answering until
 * it makes them. It is kept under the replica's ID: a runtime restored
 * elsewhere, or past an identity reset, finds none and lists the
 * input's outputs again, and finding none never answers an input,
 * which only its live receipt may.
 */

import { isJsonObject, type VaultRuntime } from "@estoc/event-store";
import { isPeerDID4 } from "@estoc/did-peer";
import { InvalidDidDocument, canonicalDidOf, scanVault, type Did, type ExecutionId, type Keys, type MediationId, type Replica, type ReplicaId } from "@estoc/vault";

import { responding, type LiveInput, type Responding } from "./action.js";
import { owesEffects, messageOf, type EffectOptions } from "./effects.js";
import { LinkClosed, MediatorRefused } from "./errors.js";
import type { MediatorLink } from "./link.js";
import type { IMessage } from "./protocol/didcomm.js";
import { EXECUTION_REGISTER, EXECUTION_REGISTERED } from "./protocol/replica-mediation.js";
import { control, type Confirmations } from "./replica-enrollment.js";
import { note } from "./trace.js";

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
  /** where the runtime keeps what its mediator confirmed, and the inputs its replica left to another with it */
  confirmations: Confirmations;
}

/** Who answers the input, with the authority to make its outputs when this runtime does; no responder for an input owed nothing. */
export type Found =
  | { responder: Extract<Responder, { status: "self" }>; answering: Responding }
  | { responder: Exclude<Responder, { status: "self" }>; answering: null }
  | { responder: null; answering: null };

/**
 * The responder of a live input, registered for at the mediator it was
 * picked up from. The registration that lists another replica first is
 * kept as this runtime's replica leaving the input to it.
 */
export async function findResponder(runtime: VaultRuntime, keys: Keys, live: LiveInput, options: ResponderOptions): Promise<Found> {
  const fold = await scanVault(runtime.vault, keys);
  if (!options.rotated && !owesEffects(fold, live, options)) return { responder: null, answering: null };
  const source = fold.channels.sources.get(live.cid);
  const execution = fold.inbound.ofSource(live.cid);
  if (source === undefined || execution === null) return { responder: null, answering: null };
  const { mediationId } = source.event.data.receivedVia;
  const responder = mediationId === null ? ({ status: "self", registration: null } as const) : await registered(runtime, fold.replicas.replicas.get(runtime.author), mediationId, execution.id, options);
  if (responder.status !== "self") return { responder, answering: null };
  return { responder, answering: responding(live) };
}

async function registered(runtime: VaultRuntime, replica: Replica | undefined, mediationId: MediationId, executionId: ExecutionId, options: ResponderOptions): Promise<Responder> {
  const link = options.inbox(mediationId);
  const responder: Responder =
    replica === undefined || replica.mediationId !== mediationId || replica.did === null
      ? { status: "unknown", because: `this runtime has no replica in the arrangement ${mediationId}` }
      : link === null
        ? { status: "unknown", because: `no line to the mediator of ${mediationId}` }
        : await registerExecution(link, mediationId, executionId, replica.did);
  if (responder.status === "other") await leave(options.confirmations, runtime.author, responder.registration);
  await note(options.trace ?? null, {
    stream: "diag",
    what: "responder",
    data: { executionId, mediationId, status: responder.status, ...(responder.status === "unknown" ? { because: responder.because } : { responderDid: responder.registration?.replicas[0] }) },
  });
  return responder;
}

const leftKey = (replicaId: ReplicaId, executionId: ExecutionId): string => `replica-mediation/execution-left/${replicaId}/${executionId}`;

function leave(confirmations: Confirmations, replicaId: ReplicaId, { mediationId, executionId, registrationId, replicas }: ExecutionRegistration): Promise<void> {
  return confirmations.set(leftKey(replicaId, executionId), { mediationId, registrationId, responderDid: replicas[0]! });
}

/** The replica `replicaId` left the execution to, as this runtime kept it; null where it left it to none. */
export async function leftTo(confirmations: Pick<Confirmations, "get">, replicaId: ReplicaId, executionId: ExecutionId): Promise<Did | null> {
  const kept = await confirmations.get(leftKey(replicaId, executionId));
  return isJsonObject(kept) && typeof kept["responderDid"] === "string" ? (kept["responderDid"] as Did) : null;
}

/**
 * The registration of an execution at the link's mediator, as the
 * replica `replicaDid` the link speaks for. A request whose answer is
 * lost is made once more: the mediator answers a repeat as the
 * registration stands, this replica in the place it first took. A
 * refusal, and a link whose holder closed, are not asked again.
 */
export async function registerExecution(link: MediatorLink, mediationId: MediationId, executionId: ExecutionId, replicaDid: Did): Promise<Responder> {
  const register = (): Promise<IMessage | Error> => control(link, EXECUTION_REGISTER, { execution_id: executionId }, EXECUTION_REGISTERED).catch((err: unknown) => (err instanceof Error ? err : new Error(messageOf(err))));
  let reply = await register();
  if (reply instanceof Error && !(reply instanceof MediatorRefused || reply instanceof LinkClosed)) reply = await register();
  return reply instanceof Error ? { status: "unknown", because: reply.message } : responderOf(reply, mediationId, executionId, replicaDid);
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
