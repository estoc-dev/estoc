/**
 * A live action is the authority to call transport once for one
 * message: the fold says what a message still needs and never whether
 * to make the call. An action is minted by the live event that decided
 * the message — the user's send, the input a live receipt answered —
 * or by an explicit manual step: a retry, a completion. Opening a
 * vault, importing, restoring or rebuilding views mints none; a message
 * such a runtime finds waiting is shown for manual action. An action
 * carries exactly one invocation, consumed in the same step that calls
 * transport, so that a crash before or after the call, or a call whose
 * outcome is unknown, leaves the message where a fresh manual action is
 * needed and nothing repeats the call on its own.
 *
 * The constructors are private and each class has a private field, so
 * that an authority is minted and never assembled: `LiveAction.manual`
 * is a host's one entry, and the two functions below are the package's
 * own.
 */

import type { EventReference, MessageId } from "@estoc/vault";

/** `initial`: minted with the intent by the live event that decided it. `manual`: minted by an explicit later step for a message already recorded. */
export type ActionKind = "initial" | "manual";

let mintInitial: (messageId: MessageId) => LiveAction;
let mintInput: (cid: EventReference<"message.in">) => LiveInput;

export class LiveAction {
  static {
    mintInitial = (messageId) => new LiveAction(messageId, "initial");
  }

  #spent = false;

  private constructor(
    readonly messageId: MessageId,
    readonly kind: ActionKind
  ) {}

  /** The explicit manual step for a message already recorded: the user's retry, a completion. */
  static manual(messageId: MessageId): LiveAction {
    return new LiveAction(messageId, "manual");
  }

  /** The one invocation is used up: no transport call is made under this action again. */
  get spent(): boolean {
    return this.#spent;
  }

  /** Use up the one invocation; false when it was used already. */
  consume(): boolean {
    if (this.#spent) return false;
    this.#spent = true;
    return true;
  }
}

/**
 * A live input is the authority to decide an input's automatic
 * effects: the receipt that recorded the observation, in the same
 * call chain, still running. Each intent the input decides gets its
 * initial action, and nothing else mints one for them: an observation
 * found by an open, brought by an import or delivered again is not
 * live, and what such an input still earns is listed for manual
 * completion.
 */
export class LiveInput {
  static {
    mintInput = (cid) => new LiveInput(cid);
  }

  readonly #cid: EventReference<"message.in">;

  private constructor(cid: EventReference<"message.in">) {
    this.#cid = cid;
  }

  get cid(): EventReference<"message.in"> {
    return this.#cid;
  }
}

/** The initial action of an intent, for the step that decided it under the lock: a send, a rotation's notification, the effects of a live input. */
export function initialAction(messageId: MessageId): LiveAction {
  return mintInitial(messageId);
}

/** The authority of a receipt over the observation it recorded and had admitted as its input's witness, minted under the receipt's lock. */
export function liveInput(cid: EventReference<"message.in">): LiveInput {
  return mintInput(cid);
}
