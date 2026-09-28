/**
 * How a call fails, apart from a procedure's own outcome. `code` is
 * protocol vocabulary, not an exception class name, and the vocabulary
 * is open: a code a view does not know is still a failure with the
 * effect it states.
 */

import type { MessageId } from "./ids.js";

export const DAEMON_ERROR_CODES = [
  "NotAttached",
  "AlreadyAttached",
  "NoSuchMethod",
  "InvalidArgument",
  "WrongPhase",
  "StaleHold",
  "RestoreUnexplained",
  "NoTarget",
  "SendClosed",
  "StateChanged",
  "ResourceLimit",
  "OperationFailed",
  "StateUnavailable",
] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export const CLIENT_ERROR_CODES = ["TransportDisconnected", "ProtocolError", "Incompatible", "NotConnected", "InvalidArgument", "ResourceLimit", "StateChanged"] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/**
 * `effect: "none"` is reported only when the daemon knows the operation
 * caused no domain mutation and no external side effect; otherwise
 * `possible`. `messageId` names one relevant message already recorded
 * in the vault, as diagnostic context: not proof of dispatch, not a
 * deduplication key and no permission to retry.
 */
export interface ApiError {
  code: string;
  message: string;
  effect: "none" | "possible";
  messageId: MessageId | null;
}

/**
 * What the SDK rejects a call with. A daemon's `error` frame becomes
 * `origin: "daemon"` with its validated fields; a failure the SDK
 * raised itself is `origin: "client"` with a null message ID. Origin
 * comes from where the failure arose, never from a field a peer sent.
 */
export type CallError =
  | ({ origin: "daemon" } & ApiError)
  | {
      origin: "client";
      code: ClientErrorCode;
      message: string;
      effect: "none" | "possible";
      messageId: null;
    };
