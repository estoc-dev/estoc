import { isCallError } from "@estoc/daemon-api/client";

/**
 * What a call of the daemon's failed with, in words for the person. The
 * daemon's refusal is its own message; a call the daemon may have acted
 * on before the failure says so, since what the vault shows next is the
 * only account of it; and a reply lost with the connection is neither a
 * refusal nor a result: whether the call was done is unknown, and it is
 * not made again on its own.
 */
export function explained(error: unknown): Error {
  if (!isCallError(error)) return error instanceof Error ? error : new Error(String(error));
  if (error.origin === "client" && error.code === "TransportDisconnected" && error.effect === "possible") {
    return new Error("the connection to the daemon ended before it answered: whether this was done is unknown. Nothing is sent again on its own; what the vault shows is what stands.");
  }
  if (error.origin === "client" && error.code === "NotConnected") return new Error("no daemon is connected; nothing was done");
  return new Error(error.effect === "possible" ? `${error.message}; part of it may have gone through` : error.message);
}
