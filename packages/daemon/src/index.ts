/**
 * `@estoc/daemon` — the daemon over the vault: one SQLite file the
 * host owns, the agent of `@estoc/agent-core` over it, and the vault
 * handed to a view as records, with the RPC and its text encoding.
 */

export type { ContactSummary, CreatedInvitation, Daemon, DaemonEvents, Hold, Lines, LocalDidSummary, MediationSummary, Merged, Outcome, Phase, SendResult, Snapshot } from "./api.js";
export { VAULT_FILE, type DaemonHost, type DaemonStorage } from "./host.js";
export { DAMAGE_RECOURSE, RESTORE_EXPLAINED, createDaemon, type DaemonCore, type Emit } from "./daemon.js";
export { InvalidArgument, Refused, RestoreUnexplained, StaleHold, TooLarge, Unmet, WrongPhase } from "./errors.js";
export { DEFAULT_MAX_BACKUP_BYTES, attachTo, limitsOf, methodsOf } from "./adapter.js";
export { Publisher, StateChanged, type BaselineOf, type LinesStateOf, type NonOpenValue, type Publishing, type Source, type StateOf, type StateValueOf, type Subscriber } from "./publisher.js";
export { connect, serve, type Port } from "./rpc.js";
export { decode, encode } from "./codec.js";
