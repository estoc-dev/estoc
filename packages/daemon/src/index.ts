/**
 * `@estoc/daemon` — the daemon over the vault, for a host to run: one
 * SQLite file the host owns, the agent of `@estoc/agent-core` over it,
 * the state a view is shown published as `@estoc/daemon-api` spells it,
 * and the method table a session of `serveApi` answers from.
 */

export type { CompletionWord, CreatedInvitation, Daemon, DispatchWord, Merged, Outcome, SendResult } from "./api.js";
export { VAULT_FILE, type DaemonHost, type DaemonStorage } from "./host.js";
export type { PublishedSnapshot, PutSnapshot, SnapshotLink } from "./snapshot-links.js";
export { DAMAGE_RECOURSE, RESTORE_EXPLAINED, createDaemon, type DaemonCore } from "./daemon.js";
export { InvalidArgument, Refused, RestoreUnexplained, StaleHold, TooLarge, Unmet, WrongPhase } from "./errors.js";
export { DEFAULT_MAX_BACKUP_BYTES, attachTo, limitsOf, methodsOf } from "./adapter.js";
export { Publisher, StateChanged, type BaselineOf, type LinesStateOf, type NonOpenValue, type Publishing, type Source, type StateOf, type StateValueOf, type Subscriber } from "./publisher.js";
