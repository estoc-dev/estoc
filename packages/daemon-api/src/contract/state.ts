import type { Epoch, Hold, Revision } from "./ids.js";
import type { Snapshot } from "./records.js";

/**
 * Which screen the vault dictates, with the vault file it is about.
 * `detail` explains the condition to a person and is not a branch key.
 *
 * `booting` covers taking the files and opening them: its hold is null
 * until one vault file is held, and names that file while opening it
 * is still in progress. `elsewhere`, `onboarding` and `foreign` hold
 * no file; `damaged`, `locked` and `open` always name one. `unreadable`
 * names one only when the failed open leaves the file in this daemon's
 * ownership, which is what makes its removal available.
 */
export type StateValue =
  | { phase: "booting" | "unreadable"; hold: Hold | null; detail: string | null }
  | { phase: "elsewhere" | "onboarding" | "foreign"; hold: null; detail: string | null }
  | { phase: "damaged" | "locked"; hold: Hold; detail: string | null }
  | { phase: "open"; hold: Hold; snapshot: Snapshot };

export type Phase = StateValue["phase"];

export const PHASES = ["booting", "elsewhere", "onboarding", "foreign", "unreadable", "damaged", "locked", "open"] as const satisfies readonly Phase[];

/**
 * The daemon's whole published value. A `state` event replaces the
 * previous one entirely: a non-open value carries no snapshot, and a
 * view drops every live record it derived when one arrives.
 */
export interface State {
  epoch: Epoch;
  revision: Revision;
  value: StateValue;
}

/** Where a publication stands: what `refresh` returns and what the SDK's barrier waits for. */
export interface RevisionMarker {
  epoch: Epoch;
  revision: Revision;
}
