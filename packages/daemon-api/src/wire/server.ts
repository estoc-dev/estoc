/**
 * One session of the daemon's side of a port: the bootstrap, then calls
 * answered from an explicit table and publications queued behind their
 * replies. The queue is bounded, and what a slow port cannot take is
 * replaced by a newer value, dropped when it is a log, or ends the
 * session when it is owed.
 */

import { API_VERSION, WIRE_VERSION, schemas, type ApiError, type Baseline, type CallId, type Incompatible, type Welcome, type EventName, type Events, type Limits, type MessageId, type MethodInput, type MethodName, type MethodResult } from "../contract/index.js";
import { readBootstrap, readFrame, readPayload, requestBudget, writeBootstrap, writeFrame, type RawFrame } from "./frames.js";
import type { Port } from "./port.js";
import { utf8Length } from "./values.js";

export type ServedMethod = Exclude<MethodName, "attach">;

/** A handler per method: it returns the result, throws a `Refusal` to answer with a code, and is `OperationFailed` for anything else it throws. */
export type MethodHandlers = { readonly [Name in ServedMethod]: (input: MethodInput<Name>, session: Session) => Promise<MethodResult<Name>> | MethodResult<Name> };

export class Refusal extends Error {
  readonly error: ApiError;

  constructor(error: Omit<ApiError, "messageId"> & { messageId?: MessageId | null }) {
    super(error.message);
    this.error = { code: error.code, message: error.message, effect: error.effect, messageId: error.messageId ?? null };
  }
}

export interface ServeOptions {
  methods: MethodHandlers;
  limits: Limits;
  /** the welcome's informational text */
  implementation: string;
  /**
   * Registers the session for publications and returns what it starts
   * from. It is called at most once per session and its result is
   * queued before the call returns to the event loop, so that a
   * publication to the session cannot come before its baseline.
   */
  attach(session: Session): Baseline;
  /** frames the queue holds for a slow port before it is closed; 64 unless set */
  maxQueuedFrames?: number;
  /** how long a port has to say hello; 10 seconds unless set */
  bootstrapTimeoutMs?: number;
  /** a handler's throw that was no refusal, or a value of the daemon's own that could not be sent; for the host's log */
  failed?(error: unknown): void;
}

export interface Session {
  readonly attached: boolean;
  readonly closed: boolean;
  event<Name extends EventName>(name: Name, value: Events[Name]): void;
  /** ends the session: the fault is the last frame, and the port closes behind it */
  fault(error: ApiError): void;
  close(): void;
  /** runs once, when the port is closed from either side */
  onClose(listener: () => void): void;
}

interface Queued {
  write(): unknown;
  /** a reply's call: what it is answered under when it cannot be written */
  id: CallId | null;
  /** an event a newer value of the same epoch takes the place of */
  replaces: { name: "state" | "lines"; epoch: string } | null;
  droppable: boolean;
  terminal: boolean;
}

const DEFAULT_QUEUE = 64;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;

const unexpected: ApiError = { code: "OperationFailed", message: "the daemon could not complete the call", effect: "possible", messageId: null };
const unpublishable: ApiError = { code: "StateUnavailable", message: "the daemon could not send its state", effect: "none", messageId: null };

class Served implements Session {
  attached = false;
  closed = false;
  private negotiated = false;
  private ending = false;
  private writing = false;
  private readonly queue: Queued[] = [];
  private readonly inFlight = new Set<CallId>();
  private readonly closeListeners: (() => void)[] = [];
  private readonly timer: unknown;

  constructor(
    private readonly port: Port,
    private readonly options: ServeOptions,
  ) {
    port.listen({ message: (data) => this.receive(data), close: () => this.finish() });
    this.timer = setTimeout(() => {
      if (!this.negotiated) this.close();
    }, options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS);
  }

  event<Name extends EventName>(name: Name, value: Events[Name]): void {
    if (!this.attached) return;
    const frame: RawFrame = { kind: "event", name, value };
    const replaces = name === "log" ? null : { name: name as "state" | "lines", epoch: (value as Events["state" | "lines"]).epoch };
    this.enqueue({ write: () => writeFrame(frame, this.port.transport), id: null, replaces, droppable: name === "log", terminal: false });
  }

  fault(error: ApiError): void {
    if (this.closed || this.ending) return;
    this.last(this.faultEntry(error));
  }

  close(): void {
    if (this.closed) return;
    this.finish();
    this.port.close();
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.queue.length = 0;
    for (const listener of this.closeListeners.splice(0)) listener();
  }

  private receive(data: unknown): void {
    if (this.closed || this.ending) return;
    if (!this.negotiated) {
      this.negotiate(data);
      return;
    }
    const { maxFrameBytes } = this.options.limits;
    // A text frame over the bound is not read for the call it might be: it is refused whole, uncorrelated, and the session ends.
    if (this.port.transport === "text" && maxFrameBytes !== null && typeof data === "string" && (data.length > maxFrameBytes || utf8Length(data) > maxFrameBytes)) {
      this.fault({ code: "ResourceLimit", message: `a frame is larger than ${maxFrameBytes} bytes`, effect: "none", messageId: null });
      return;
    }
    const frame = readFrame(data, this.port.transport);
    if (frame === null || frame.kind !== "call" || this.inFlight.has(frame.id)) {
      this.close();
      return;
    }
    this.inFlight.add(frame.id);
    this.serve(frame);
  }

  private negotiate(data: unknown): void {
    const hello = readBootstrap(data, this.port.transport);
    if (hello === null || hello.kind !== "hello") {
      this.close();
      return;
    }
    clearTimeout(this.timer);
    this.negotiated = true;
    if (!hello.apis.includes(API_VERSION)) {
      const refused: Incompatible = { kind: "incompatible", wire: WIRE_VERSION, supported: [API_VERSION], message: `this daemon speaks API ${API_VERSION}; update the view or the daemon` };
      this.last({ write: () => writeBootstrap(refused, this.port.transport), id: null, replaces: null, droppable: false, terminal: true });
      return;
    }
    const welcome: Welcome = { kind: "welcome", wire: WIRE_VERSION, api: API_VERSION, implementation: this.options.implementation, limits: this.options.limits };
    this.enqueue({ write: () => writeBootstrap(welcome, this.port.transport), id: null, replaces: null, droppable: false, terminal: false });
  }

  private serve(call: Extract<RawFrame, { kind: "call" }>): void {
    const { id, method } = call;
    const refuse = (code: string, message: string): void => this.reply({ kind: "error", id, error: { code, message, effect: "none", messageId: null } });
    if (!schemas.isMethodName(method)) return refuse("NoSuchMethod", `${method} is no method of this API`);
    if (method === "attach") {
      if (this.attached) return refuse("AlreadyAttached", "this port is attached");
      let baseline: Baseline;
      try {
        baseline = this.options.attach(this);
      } catch (error) {
        this.options.failed?.(error);
        return refuse("OperationFailed", "the daemon could not attach the port");
      }
      this.attached = true;
      return this.reply({ kind: "result", id, value: baseline });
    }
    if (!this.attached) return refuse("NotAttached", "attach first");
    const schema = schemas.methods[method];
    const read = readPayload(call.input, this.port.transport, { bytesAt: schema.bytes.input, maxBytes: this.options.limits.maxBackupBytes, budget: requestBudget(this.options.limits, id, method) });
    if (!read.ok) return refuse(read.code, read.message);
    const parsed = schema.input.safeParse(read.value);
    if (!parsed.success) return refuse("InvalidArgument", parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`).join("; "));
    void this.invoke(method, parsed.data, id, schema.bytes.result);
  }

  private async invoke(method: ServedMethod, input: unknown, id: CallId, bytesAt: readonly string[]): Promise<void> {
    const handler = this.options.methods[method] as (input: unknown, session: Session) => unknown;
    try {
      const value = await handler(input, this);
      this.reply({ kind: "result", id, value }, bytesAt);
    } catch (error) {
      if (error instanceof Refusal) {
        this.reply({ kind: "error", id, error: error.error });
      } else {
        this.options.failed?.(error);
        this.reply({ kind: "error", id, error: unexpected });
      }
    }
  }

  private reply(frame: Extract<RawFrame, { kind: "result" | "error" }>, bytesAt: readonly string[] = []): void {
    this.inFlight.delete(frame.id);
    this.enqueue({ write: () => writeFrame(frame, this.port.transport, bytesAt), id: frame.id, replaces: null, droppable: false, terminal: false });
  }

  private enqueue(entry: Queued): void {
    if (this.closed || this.ending) return;
    const replaced = entry.replaces === null ? -1 : this.queue.findIndex((queued) => queued.replaces?.name === entry.replaces?.name && queued.replaces?.epoch === entry.replaces?.epoch);
    if (replaced >= 0) this.queue[replaced] = entry;
    else this.queue.push(entry);
    const limit = this.options.maxQueuedFrames ?? DEFAULT_QUEUE;
    if (this.queue.length > limit) {
      const owed = this.queue.filter((queued) => !queued.droppable);
      if (owed.length > limit) {
        this.close();
        return;
      }
      this.queue.splice(0, this.queue.length, ...owed);
    }
    this.pump();
  }

  private pump(): void {
    if (this.writing || this.closed) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    let data: unknown;
    try {
      data = next.write();
    } catch (error) {
      this.options.failed?.(error);
      this.unwritable(next);
      return;
    }
    this.writing = true;
    this.port.send(data).then(
      () => {
        this.writing = false;
        if (next.terminal) this.close();
        else this.pump();
      },
      () => this.close(),
    );
  }

  /** A reply that cannot be written is answered as a failure; a publication that cannot be is the end of the session, ahead of anything else queued. */
  private unwritable(entry: Queued): void {
    if (entry.id !== null) {
      const frame: RawFrame = { kind: "error", id: entry.id, error: unexpected };
      this.queue.unshift({ write: () => writeFrame(frame, this.port.transport), id: null, replaces: null, droppable: false, terminal: false });
      this.pump();
    } else if (entry.terminal) {
      this.close();
    } else {
      this.queue.length = 0;
      this.last(this.faultEntry(unpublishable));
    }
  }

  private faultEntry(error: ApiError): Queued {
    const frame: RawFrame = { kind: "fault", error };
    return { write: () => writeFrame(frame, this.port.transport), id: null, replaces: null, droppable: false, terminal: true };
  }

  /** The last frame of the session: nothing is queued behind it, and the port closes once it is written. */
  private last(entry: Queued): void {
    this.ending = true;
    this.queue.push(entry);
    this.pump();
  }
}

/** Serves the API over `port` from the bootstrap on; the session it returns is what the daemon publishes to. */
export function serveApi(port: Port, options: ServeOptions): Session {
  return new Served(port, options);
}
