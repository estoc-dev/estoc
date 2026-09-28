/**
 * One port's lifetime on the view's side: hello, the welcome's limits,
 * the attachment whose result is the first state, then calls answered
 * under their IDs and publications applied in the order they come. A
 * request is checked against the advertised bounds before the port
 * takes it; what the daemon sends is checked against the schemas only,
 * and a daemon that stops speaking the contract ends the session as a
 * `ProtocolError`. Once ended, the session hears nothing more: a later
 * connection is a new session, with a new baseline and none of the old
 * calls.
 */

import { API_VERSION, WIRE_VERSION, schemas, type Baseline, type CallError, type CallId, type Hello, type Limits, type LinesState, type LogLine, type MethodInput, type MethodName, type MethodResult, type RevisionMarker, type State } from "../contract/index.js";
import { readBootstrap, readFrame, readPayload, readValue, requestBudget, utf8Length, writeBootstrap, writeFrame, type Port, type RawFrame, type Reading } from "../wire/index.js";
import { daemonMethodsOf, isCalledMethod, type CalledMethod, type Client, type ConnectionState, type DaemonMethods } from "./client.js";
import { clientError } from "./errors.js";
import { Listeners } from "./listeners.js";

interface Pending {
  name: MethodName;
  resolve(value: unknown): void;
  reject(error: CallError): void;
}

interface Barrier {
  target: RevisionMarker;
  resolve(): void;
  reject(error: CallError): void;
}

interface Waiting {
  resolve(): void;
  reject(error: CallError): void;
}

/** What a lost reply means for the call: nothing for attachment and refresh, which only read, and possibly everything for any other call once handed over. */
const effectOf = (name: MethodName): "none" | "possible" => (name === "attach" || name === "refresh" ? "none" : "possible");

const lost = (name: MethodName, message: string): CallError => clientError("TransportDisconnected", message, effectOf(name));

const NOT_CONNECTED = "no attachment has completed on this connection";

export class Session implements Client {
  connection: ConnectionState = { state: "connecting" };
  state: State | null = null;
  lines: LinesState | null = null;
  readonly daemon: DaemonMethods;
  private limits: Limits | null = null;
  private nextId = 1;
  private ended = false;
  private closing = false;
  private readonly pending = new Map<CallId, Pending>();
  private barriers: Barrier[] = [];
  private readonly waiting: Waiting[] = [];
  private readonly connections = new Listeners<ConnectionState>();
  private readonly states = new Listeners<State>();
  private readonly linesUpdates = new Listeners<LinesState>();
  private readonly logs = new Listeners<LogLine>();

  constructor(private readonly port: Port) {
    this.daemon = daemonMethodsOf((name, input) => this.call(name, input));
  }

  /** Installs the port's handlers and says hello; after the listeners are in place, so that none misses the baseline. */
  open(): void {
    this.port.listen({
      message: (data) => this.receive(data),
      close: () => this.finish({ state: "disconnected", because: this.closing ? null : clientError("TransportDisconnected", "the port closed") }),
    });
    const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };
    this.transmit(writeBootstrap(hello, this.port.transport));
  }

  call<Name extends CalledMethod>(name: Name, input: MethodInput<Name>): Promise<MethodResult<Name>> {
    if (!isCalledMethod(name)) return Promise.reject(clientError("InvalidArgument", `${String(name)} is no method a view calls`));
    if (this.connection.state !== "connected") return Promise.reject(clientError("NotConnected", NOT_CONNECTED));
    return this.dispatch(name, input) as Promise<MethodResult<Name>>;
  }

  async refresh(): Promise<void> {
    if (this.connection.state !== "connected") throw clientError("NotConnected", NOT_CONNECTED);
    const target = (await this.dispatch("refresh", {})) as RevisionMarker;
    await new Promise<void>((resolve, reject) => {
      const barrier: Barrier = { target, resolve, reject };
      if (!this.settled(barrier)) this.barriers.push(barrier);
    });
  }

  connected(): Promise<void> {
    if (this.connection.state === "connected") return Promise.resolve();
    if (this.ended) return Promise.reject(this.endedWith());
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
    this.closing = true;
    this.finish({ state: "disconnected", because: null });
  }

  private dispatch(name: MethodName, input: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const refused = this.send(name, input, { name, resolve, reject });
      if (refused !== null) reject(refused);
    });
  }

  /** Hands the call to the port under a new ID, `answered` told its reply; or returns the local refusal, nothing sent. */
  private send(name: MethodName, input: unknown, answered: Pending): CallError | null {
    const limits = this.limits;
    if (limits === null) return clientError("NotConnected", NOT_CONNECTED);
    const schema = schemas.methods[name];
    const id = this.nextId++;
    const call: RawFrame = { kind: "call", id, method: name, input: null };
    const budget = requestBudget(limits, call);
    if (!budget.ok) return clientError(budget.code, budget.message);
    const read = readPayload(input, "clone", { bytesAt: schema.bytes.input, maxBytes: limits.maxBackupBytes, budget: budget.value });
    if (!read.ok) return clientError(read.code, read.message);
    const data = writeFrame({ ...call, input: read.value }, this.port.transport, schema.bytes.input);
    if (limits.maxFrameBytes !== null && typeof data === "string" && (data.length > limits.maxFrameBytes || utf8Length(data) > limits.maxFrameBytes)) {
      return clientError("ResourceLimit", `the frame is larger than ${limits.maxFrameBytes} bytes`);
    }
    this.pending.set(id, answered);
    this.transmit(data);
    return null;
  }

  private transmit(data: unknown): void {
    this.port.send(data).catch(() => this.finish({ state: "disconnected", because: clientError("TransportDisconnected", "the port refused a frame") }));
  }

  private receive(data: unknown): void {
    if (this.ended) return;
    if (this.limits === null) {
      this.negotiate(data);
      return;
    }
    const frame = readFrame(data, this.port.transport);
    if (frame === null) return this.protocolError("a frame the SDK cannot read");
    switch (frame.kind) {
      case "result":
      case "error":
        return this.answer(frame);
      case "event":
        return this.publish(frame);
      case "fault":
        return this.faulted(frame.error);
      case "call":
        return this.protocolError("a call in the daemon's direction");
    }
  }

  private negotiate(data: unknown): void {
    const record = readBootstrap(data, this.port.transport);
    if (record === null || record.kind === "hello") return this.protocolError("no welcome");
    if (record.kind === "incompatible") return this.finish({ state: "incompatible", supported: record.supported, message: record.message });
    if (record.api !== API_VERSION) return this.protocolError(`the daemon selected API ${record.api}, which the view did not offer`);
    this.limits = record.limits;
    const { implementation, limits } = record;
    const refused = this.send("attach", {}, {
      name: "attach",
      resolve: (baseline) => this.attached(baseline as Baseline, { state: "connected", implementation, limits }),
      reject: (error) => this.finish({ state: "disconnected", because: error }),
    });
    if (refused !== null) this.finish({ state: "disconnected", because: refused });
  }

  private attached(baseline: Baseline, connection: ConnectionState): void {
    if (baseline.state.epoch !== baseline.lines.epoch) return this.protocolError("a baseline whose state and lines are of different epochs");
    this.state = baseline.state;
    this.lines = baseline.lines;
    this.connection = connection;
    for (const waiting of this.waiting.splice(0)) waiting.resolve();
    this.connections.emit(connection);
    this.states.emit(baseline.state);
    this.linesUpdates.emit(baseline.lines);
  }

  private answer(frame: Extract<RawFrame, { kind: "result" | "error" }>): void {
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    this.pending.delete(frame.id);
    if (frame.kind === "error") {
      const error = this.accept(schemas.apiError, readValue(frame.error), "an error the SDK cannot read", pending);
      if (error === null) return;
      const { code, message, effect, messageId } = error.value;
      pending.reject({ origin: "daemon", code, message, effect, messageId });
      return;
    }
    const schema = schemas.methods[pending.name];
    const limits = this.limits as Limits;
    const result = this.accept<unknown>(schema.result, readPayload(frame.value, this.port.transport, { bytesAt: schema.bytes.result, maxBytes: limits.maxBackupBytes }), `a ${pending.name} result the SDK cannot read`, pending);
    if (result !== null) pending.resolve(result.value);
  }

  private publish(frame: Extract<RawFrame, { kind: "event" }>): void {
    if (this.state === null) return this.protocolError("a publication before the baseline");
    const read = readValue(frame.value);
    const what = `a ${frame.name} event the SDK cannot read`;
    switch (frame.name) {
      case "state": {
        const state = this.accept(schemas.state, read, what);
        if (state !== null) this.applyState(state.value);
        return;
      }
      case "lines": {
        const lines = this.accept(schemas.linesState, read, what);
        if (lines !== null) this.applyLines(lines.value);
        return;
      }
      case "log": {
        const line = this.accept(schemas.logLine, read, what);
        if (line !== null) this.applyLog(line.value);
        return;
      }
    }
  }

  private applyState(state: State): void {
    const current = this.state as State;
    if (state.epoch === current.epoch) {
      if (state.revision < current.revision) return this.protocolError("a state older than the one shown");
      if (state.revision === current.revision) return;
    }
    this.state = state;
    this.states.emit(state);
    this.barriers = this.barriers.filter((barrier) => !this.settled(barrier));
  }

  private applyLines(lines: LinesState): void {
    const state = this.state as State;
    if (lines.epoch !== state.epoch) return this.protocolError("lines of another epoch than the state shown");
    const current = this.lines as LinesState;
    if (lines.epoch === current.epoch) {
      if (lines.revision < current.revision) return this.protocolError("lines older than the ones shown");
      if (lines.revision === current.revision) return;
    }
    this.lines = lines;
    this.linesUpdates.emit(lines);
  }

  private applyLog(line: LogLine): void {
    if (line.epoch !== (this.state as State).epoch) return this.protocolError("a log line of another epoch than the state shown");
    this.logs.emit(line);
  }

  /** true when the barrier is done: met by the state shown, or lost with its epoch or the connection */
  private settled(barrier: Barrier): boolean {
    if (this.ended) {
      barrier.reject(lost("refresh", "the connection ended before the state arrived"));
      return true;
    }
    const state = this.state;
    if (state === null) return false;
    if (state.epoch !== barrier.target.epoch) {
      barrier.reject(clientError("StateChanged", "the state moved to another epoch before the barrier was met"));
      return true;
    }
    if (state.revision < barrier.target.revision) return false;
    barrier.resolve();
    return true;
  }

  private faulted(raw: unknown): void {
    const fault = this.accept(schemas.apiError, readValue(raw), "a fault the SDK cannot read");
    if (fault === null) return;
    const { code, message, effect, messageId } = fault.value;
    this.finish({ state: "disconnected", because: { origin: "daemon", code, message, effect, messageId } });
  }

  /** `reading` as `schema` says, or null after ending the session as a protocol error; `culprit` is the call the reading answered, refused as that error. */
  private accept<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, reading: Reading<unknown>, what: string, culprit?: Pending): { value: T } | null {
    const parsed = reading.ok ? schema.safeParse(reading.value) : null;
    if (parsed !== null && parsed.success) return { value: parsed.data };
    this.protocolError(reading.ok ? what : `${what}: ${reading.message}`, culprit);
    return null;
  }

  private protocolError(message: string, culprit?: Pending): void {
    const error = clientError("ProtocolError", message);
    culprit?.reject({ ...error, effect: effectOf(culprit.name) });
    this.finish({ state: "disconnected", because: error });
  }

  /** Ends the session, whoever ended it: every pending call and barrier is lost, the port is closed, and nothing is heard afterwards. */
  private finish(connection: Extract<ConnectionState, { state: "disconnected" | "incompatible" }>): void {
    if (this.ended) return;
    this.ended = true;
    this.connection = connection;
    const ending = this.endedWith();
    for (const [, pending] of this.pending) pending.reject(lost(pending.name, ending.message));
    this.pending.clear();
    for (const barrier of this.barriers.splice(0)) this.settled(barrier);
    for (const waiting of this.waiting.splice(0)) waiting.reject(ending);
    this.port.close();
    this.connections.emit(connection);
  }

  /** What the session ended on, as the error a wait for it is rejected with. */
  private endedWith(): CallError {
    const { connection } = this;
    if (connection.state === "incompatible") return clientError("Incompatible", connection.message);
    if (connection.state === "disconnected" && connection.because !== null) return connection.because;
    return clientError("TransportDisconnected", "the view closed the connection");
  }
}

/** A client on `port`, from hello on; it is `connected` once the attachment's baseline is in. */
export function connect(port: Port): Client {
  const session = new Session(port);
  session.open();
  return session;
}
