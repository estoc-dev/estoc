/**
 * What follows a receipt, once the observation is durably committed
 * and independently of the pickup acknowledgement, which the durable
 * receipt alone earns: the pass over what the vault owes, and then
 * what that pass made of the observation in hand — its proof and its
 * disposition, left as diagnostics in the trace when the one did not
 * verify or the other did not admit it. `admitted` and `acknowledged`
 * hold whatever the pass recorded, an earlier observation's included.
 */

import type { Disposition, EventReference, Status } from "@estoc/vault";

import { recordOwedUnderLock, type Owed } from "../reconcile.js";
import type { Session } from "../session.js";
import { note, type AgentTrace } from "../trace.js";

export interface AfterReceipt extends Owed {
  /** what continuity made of the proof the observation carried; `not-present` for one that carried none */
  proof: Status;
  /** what the observation is to the application once the pass is done */
  disposition: Disposition;
}

export interface AfterReceiptOptions {
  /** a proof that did not verify, or an observation the pass did not admit, goes to the `diag` stream */
  trace?: AgentTrace;
}

export async function afterReceipt(session: Session, cid: EventReference<"message.in">, options: AfterReceiptOptions = {}): Promise<AfterReceipt> {
  const { fold, ...owed } = await session.locked((locked) => recordOwedUnderLock(locked));
  const trace = options.trace ?? null;
  const proof = fold.continuity.status(cid);
  if (proof.status !== "verified" && proof.status !== "not-present") await note(trace, { stream: "diag", what: "proof", data: { cid, ...proof } });
  const disposition = fold.dispositions.disposition(cid);
  if (disposition.status !== "admitted") await note(trace, { stream: "diag", what: "admission", data: { cid, ...disposition } });
  return { proof, disposition, ...owed };
}
