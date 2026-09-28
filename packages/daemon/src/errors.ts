/**
 * How the daemon refuses a call it could tell apart from a failure: a
 * guard that found the operation impossible where things stand, with
 * nothing of the operation done. Each carries the code a view branches
 * on and what the refusal had for effect; whatever else a call throws
 * is a failure whose effect is unknown.
 */

import type { DaemonErrorCode } from "@estoc/daemon-api/contract";

export abstract class Refused extends Error {
  abstract readonly code: DaemonErrorCode;
  readonly effect: "none" | "possible" = "none";
}

/** The vault is not in a phase the operation works in: no vault is open, none stands here to unlock or remove, one stands where another would be made, or the files are another daemon's. */
export class WrongPhase extends Refused {
  readonly code = "WrongPhase";

  constructor(message: string) {
    super(message);
    this.name = "WrongPhase";
  }
}

/** The removal names a vault this daemon no longer holds: what stands here now is another, and it is left as it is. */
export class StaleHold extends Refused {
  readonly code = "StaleHold";

  constructor() {
    super("that vault is gone already; what stands here now is another, and it is left as it is");
    this.name = "StaleHold";
  }
}

/** A send of the user's, or a manual dispatch, before the person was told what a restore cannot bring back. */
export class RestoreUnexplained extends Refused {
  readonly code = "RestoreUnexplained";

  constructor() {
    super("this vault was restored from a snapshot: sending opens once what a restore cannot bring back has been explained");
    this.name = "RestoreUnexplained";
  }
}

/** An input the schema admits but the domain does not: a DID that is none, a channel ID that is not the canonical text of a pair, a contact with no channel, an address of this vault's own as a peer. */
export class InvalidArgument extends Refused {
  readonly code = "InvalidArgument";

  constructor(message: string) {
    super(message);
    this.name = "InvalidArgument";
  }
}

/** A condition the operation needs and found unmet before it changed anything: a passphrase that does not open the seed, no mediator set, no such contact. */
export class Unmet extends Refused {
  readonly code = "OperationFailed";

  constructor(message: string) {
    super(message);
    this.name = "Unmet";
  }
}
