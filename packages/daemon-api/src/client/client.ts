/**
 * What a view holds: the connection it is on, the last state and lines
 * it was shown, the daemon's methods typed from the method table, and
 * the refresh barrier. A connection is `connected` once negotiation and
 * attachment are complete, and a call is refused as `NotConnected`
 * before that; what the daemon answers afterwards is the view's to
 * show, and a lost connection leaves the last state in place, stale.
 */

import { schemas, type CallError, type Limits, type LinesState, type LogLine, type MethodInput, type MethodName, type MethodResult, type State } from "../contract/index.js";

export type ConnectionState =
  | { state: "connecting" }
  | { state: "connected"; implementation: string; limits: Limits }
  /** `because` is null when the view closed the connection; a daemon fault keeps its origin */
  | { state: "disconnected"; because: CallError | null }
  | { state: "incompatible"; supported: number[]; message: string };

/** The methods a view calls itself: attachment is the connection's, and `refresh` is the barrier. */
export type CalledMethod = Exclude<MethodName, "attach" | "refresh">;

export type DaemonMethods = { readonly [Name in CalledMethod]: (input: MethodInput<Name>) => Promise<MethodResult<Name>> };

export type Call = <Name extends CalledMethod>(name: Name, input: MethodInput<Name>) => Promise<MethodResult<Name>>;

export interface Client {
  readonly connection: ConnectionState;
  /** the last state consumed, kept through a disconnection; null before the first baseline */
  readonly state: State | null;
  readonly lines: LinesState | null;
  readonly daemon: DaemonMethods;
  call<Name extends CalledMethod>(name: Name, input: MethodInput<Name>): Promise<MethodResult<Name>>;
  /**
   * Resolves once a state is consumed that covers every change committed
   * before the daemon executed the request: the reply's revision or a
   * greater one of its epoch. Rejects with `StateChanged` when the epoch
   * moves first, and with `TransportDisconnected` when the connection
   * ends first; it has no effect on the daemon either way.
   */
  refresh(): Promise<void>;
  /** resolves when the connection is `connected`; rejects with the `CallError` it ended on, or `Incompatible`, when it never is */
  connected(): Promise<void>;
  onConnection(listener: (connection: ConnectionState) => void): () => void;
  onState(listener: (state: State) => void): () => void;
  onLines(listener: (lines: LinesState) => void): () => void;
  onLog(listener: (line: LogLine) => void): () => void;
  close(): void;
}

export const isCalledMethod = (name: string): name is CalledMethod => schemas.isMethodName(name) && name !== "attach" && name !== "refresh";

export function daemonMethodsOf(call: Call): DaemonMethods {
  const methods: Partial<Record<CalledMethod, (input: never) => Promise<unknown>>> = {};
  for (const name of schemas.METHOD_NAMES) {
    if (isCalledMethod(name)) methods[name] = (input: MethodInput<typeof name>) => call(name, input);
  }
  return Object.freeze(methods) as DaemonMethods;
}
