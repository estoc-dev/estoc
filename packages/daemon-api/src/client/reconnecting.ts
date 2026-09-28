/**
 * A client that outlives its connections: when one ends, another is
 * opened after a delay, negotiated and attached afresh, and its
 * baseline replaces what the view was shown. Nothing carries over: a
 * call the old connection lost stays lost, since the daemon may have
 * done it, and only the view decides on a new one. A daemon that
 * cannot speak this API ends the retrying, as does the view closing.
 */

import type { CallError, LinesState, LogLine, MethodInput, MethodResult, State } from "../contract/index.js";
import type { Port } from "../wire/index.js";
import { daemonMethodsOf, type CalledMethod, type Client, type ConnectionState, type DaemonMethods } from "./client.js";
import { clientError } from "./errors.js";
import { Listeners } from "./listeners.js";
import { Session } from "./session.js";

export interface ReconnectOptions {
  /** how long after a connection ends the next one is opened; 1 second unless set */
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 1000;

const NOT_CONNECTED = clientError("NotConnected", "no attachment has completed on the current connection");

interface Waiting {
  resolve(): void;
  reject(error: CallError): void;
}

class Reconnecting implements Client {
  connection: ConnectionState = { state: "connecting" };
  state: State | null = null;
  lines: LinesState | null = null;
  readonly daemon: DaemonMethods;
  private current: Session | null = null;
  private stopped = false;
  private timer: unknown = null;
  private readonly waiting: Waiting[] = [];
  private readonly connections = new Listeners<ConnectionState>();
  private readonly states = new Listeners<State>();
  private readonly linesUpdates = new Listeners<LinesState>();
  private readonly logs = new Listeners<LogLine>();

  constructor(
    private readonly openPort: () => Port | Promise<Port>,
    private readonly delayMs: number,
  ) {
    this.daemon = daemonMethodsOf((name, input) => this.call(name, input));
    void this.open();
  }

  call<Name extends CalledMethod>(name: Name, input: MethodInput<Name>): Promise<MethodResult<Name>> {
    return this.current === null ? Promise.reject(NOT_CONNECTED) : this.current.call(name, input);
  }

  refresh(): Promise<void> {
    return this.current === null ? Promise.reject(NOT_CONNECTED) : this.current.refresh();
  }

  connected(): Promise<void> {
    if (this.connection.state === "connected") return Promise.resolve();
    if (this.stopped) return Promise.reject(this.stoppedWith());
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  onConnection(listener: (connection: ConnectionState) => void): () => void {
    return this.connections.add(listener);
  }

  onState(listener: (state: State) => void): () => void {
    return this.states.add(listener);
  }

  onLines(listener: (lines: LinesState) => void): () => void {
    return this.linesUpdates.add(listener);
  }

  onLog(listener: (line: LogLine) => void): () => void {
    return this.logs.add(listener);
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    const current = this.current;
    this.current = null;
    current?.close();
    this.set({ state: "disconnected", because: null });
    for (const waiting of this.waiting.splice(0)) waiting.reject(this.stoppedWith());
  }

  private async open(): Promise<void> {
    let port: Port;
    try {
      port = await this.openPort();
    } catch {
      this.lost(clientError("TransportDisconnected", "no port could be opened"));
      return;
    }
    if (this.stopped) {
      port.close();
      return;
    }
    const session = new Session(port);
    this.current = session;
    const own = (act: () => void) => () => {
      if (session === this.current) act();
    };
    session.onConnection((connection) => own(() => this.follow(session, connection))());
    session.onState((state) => own(() => this.show(state))());
    session.onLines((lines) => own(() => this.showLines(lines))());
    session.onLog((line) => own(() => this.logs.emit(line))());
    session.open();
  }

  /** The session's baseline is taken before its connection is announced, so that a listener acting on `connected` reads and calls with the new one. */
  private follow(session: Session, connection: ConnectionState): void {
    switch (connection.state) {
      case "connecting":
        this.set(connection);
        return;
      case "connected":
        this.state = session.state;
        this.lines = session.lines;
        this.set(connection);
        for (const waiting of this.waiting.splice(0)) waiting.resolve();
        return;
      case "incompatible":
        this.stopped = true;
        this.current = null;
        this.set(connection);
        for (const waiting of this.waiting.splice(0)) waiting.reject(this.stoppedWith());
        return;
      case "disconnected":
        this.current = null;
        this.lost(connection.because);
        return;
    }
  }

  private lost(because: CallError | null): void {
    this.set({ state: "disconnected", because });
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.set({ state: "connecting" });
      void this.open();
    }, this.delayMs);
  }

  private show(state: State): void {
    this.state = state;
    this.states.emit(state);
  }

  private showLines(lines: LinesState): void {
    this.lines = lines;
    this.linesUpdates.emit(lines);
  }

  private set(connection: ConnectionState): void {
    this.connection = connection;
    this.connections.emit(connection);
  }

  private stoppedWith(): CallError {
    const { connection } = this;
    return connection.state === "incompatible" ? clientError("Incompatible", connection.message) : clientError("TransportDisconnected", "the view closed the client");
  }
}

/** A client over the ports `openPort` gives, one after another, each negotiated and attached afresh. */
export function reconnecting(openPort: () => Port | Promise<Port>, options: ReconnectOptions = {}): Client {
  return new Reconnecting(openPort, options.delayMs ?? DEFAULT_DELAY_MS);
}
