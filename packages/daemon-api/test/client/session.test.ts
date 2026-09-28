import { describe, expect, it, vi } from "vitest";

import { connect, type ConnectionState } from "../../src/client/index.js";
import { BASIC_MESSAGE, type CallError, type ClientErrorCode, type JsonObject, type LinesState, type LogLine, type State } from "../../src/contract/index.js";
import { requestBudget, writeFrame, type Port, type PortHandlers, type Transport } from "../../src/wire/index.js";
import { as, linesState, openState } from "../contract/fixtures.js";
import { settle } from "../wire/ports.js";
import { at, baseline, handlers, limits, linesAt, scripted, served, transports, type Scripted } from "./daemons.js";

/** What a promise came to: its value, or the error it was rejected with. */
const outcome = <T>(promise: Promise<T>): Promise<T | CallError> => promise.then((value) => value, (error: CallError) => error);

const client = (code: ClientErrorCode, effect: "none" | "possible" = "none"): CallError => ({ origin: "client", code, message: expect.any(String) as string, effect, messageId: null });

const disconnected = (because: CallError | null): ConnectionState => ({ state: "disconnected", because });

/** A view connected to a scripted daemon, the states, lines, logs and connections it was shown collected. */
const shown = async (transport: Transport = "clone", greet = true) => {
  const s = scripted(transport);
  const view = connect(s.port);
  const states: State[] = [];
  const lines: LinesState[] = [];
  const logs: LogLine[] = [];
  const connections: ConnectionState[] = [];
  view.onState((state) => states.push(state));
  view.onLines((update) => lines.push(update));
  view.onLog((line) => logs.push(line));
  view.onConnection((connection) => connections.push(connection));
  if (greet) await s.greet();
  else await settle();
  return { s, view, states, lines, logs, connections };
};

/** A call made and delivered, its ID in the scripted daemon's hands. */
const inFlight = async <T>(s: Scripted, promise: Promise<T>) => {
  await settle();
  const id = s.calls().at(-1)?.id;
  if (id === undefined) throw new Error("no call was sent");
  return { id, promise };
};

describe("connecting", () => {
  it.each(transports)("says hello, attaches after the welcome, and is connected with the baseline as its first state and lines, on a %s port", async (transport) => {
    const daemon = served(transport);
    const view = connect(daemon.port);
    const states: State[] = [];
    const connections: ConnectionState[] = [];
    view.onState((state) => states.push(state));
    view.onConnection((connection) => {
      connections.push(connection);
      expect(view.state).toEqual(openState);
      expect(view.lines).toEqual(linesState);
    });
    expect(view.connection).toEqual({ state: "connecting" });
    expect(view.state).toBeNull();
    await view.connected();
    expect(view.connection).toEqual({ state: "connected", implementation: "test daemon", limits });
    expect(view.state).toEqual(openState);
    expect(view.lines).toEqual(linesState);
    expect(states).toEqual([openState]);
    expect(connections).toEqual([{ state: "connected", implementation: "test daemon", limits }]);
    expect(daemon.session.attached).toBe(true);
  });

  it("offers the API it speaks, and attaches with the first call ID", async () => {
    const s = scripted("text");
    connect(s.port);
    await settle();
    expect(s.received()).toEqual([{ kind: "hello", wire: 1, apis: [1] }]);
    await s.welcome();
    expect(s.calls()).toEqual([{ kind: "call", id: 1, method: "attach", input: {} }]);
  });

  it("shows the baseline before any publication, one the daemon queued from inside the attachment included", async () => {
    const daemon = served("clone", {
      attach: (session) => {
        queueMicrotask(() => session.event("state", at(4)));
        return baseline;
      },
    });
    const view = connect(daemon.port);
    const states: State[] = [];
    view.onState((state) => states.push(state));
    await view.connected();
    await settle();
    expect(states.map((state) => state.revision)).toEqual([3, 4]);
  });

  it("stops at a daemon that cannot speak this API: the connection says which versions it has, and nothing is called", async () => {
    const { s, view, connections } = await shown("clone", false);
    await s.say({ kind: "incompatible", wire: 1, supported: [2, 3], message: "update the view" });
    expect(view.connection).toEqual({ state: "incompatible", supported: [2, 3], message: "update the view" });
    expect(connections).toEqual([view.connection]);
    expect(await outcome(view.connected())).toEqual({ ...client("Incompatible"), message: "update the view" });
    expect(await outcome(view.daemon.lock({}))).toEqual(client("NotConnected"));
    expect(s.closed()).toBe(true);
  });

  it("refuses a call before the attachment and after the connection ends, as NotConnected with no effect, and sends nothing for it", async () => {
    const { s, view } = await shown("clone", false);
    expect(await outcome(view.daemon.lock({}))).toEqual(client("NotConnected"));
    expect(await outcome(view.refresh())).toEqual(client("NotConnected"));
    expect(await outcome(view.call("lock", {}))).toEqual(client("NotConnected"));
    await s.greet();
    expect(s.calls().map((call) => call.method)).toEqual(["attach"]);
    view.close();
    expect(await outcome(view.daemon.lock({}))).toEqual(client("NotConnected"));
    expect(await outcome(view.refresh())).toEqual(client("NotConnected"));
    expect(s.calls().map((call) => call.method)).toEqual(["attach"]);
  });

  it("refuses a name that is no method a view calls, before anything is sent", async () => {
    const { s, view } = await shown();
    expect(await outcome(view.call("attach" as "lock", {}))).toEqual(client("InvalidArgument"));
    expect(await outcome(view.call("boot" as "lock", {}))).toEqual(client("InvalidArgument"));
    expect(s.calls()).toHaveLength(1);
  });

  it("ends as a protocol error when the first frame is no welcome", async () => {
    for (const first of [writeFrame({ kind: "call", id: 1, method: "attach", input: {} }, "text"), '{"kind":"hello","wire":1,"apis":[1]}', "junk"]) {
      const { s, view } = await shown("text", false);
      await s.say(first);
      expect(view.connection).toEqual(disconnected(client("ProtocolError")));
      expect(await outcome(view.connected())).toEqual(client("ProtocolError"));
      expect(s.closed()).toBe(true);
    }
  });

  it("ends as a protocol error when the daemon selects an API the view did not offer", async () => {
    const { s, view } = await shown("clone", false);
    await s.say({ kind: "welcome", wire: 1, api: 2, implementation: "", limits });
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
    expect(s.calls()).toHaveLength(0);
  });

  it("ends as a protocol error when the baseline's state and lines are of different epochs, or the baseline is no baseline", async () => {
    for (const value of [{ state: openState, lines: linesAt(1, "epoch-2") }, { state: openState }, null]) {
      const { s, view } = await shown("clone", false);
      await s.welcome();
      await s.attach(value);
      expect(view.connection).toEqual(disconnected(client("ProtocolError")));
      expect(view.state).toBeNull();
      expect(await outcome(view.connected())).toEqual(client("ProtocolError"));
    }
  });

  it("ends with the daemon's error as the reason when the attachment is refused", async () => {
    const { s, view, connections } = await shown("clone", false);
    await s.welcome();
    const error = { code: "OperationFailed", message: "could not attach", effect: "none", messageId: null };
    await s.frame({ kind: "error", id: 1, error });
    expect(view.connection).toEqual(disconnected({ origin: "daemon", ...error } as CallError));
    expect(await outcome(view.connected())).toEqual({ origin: "daemon", ...error });
    expect(connections).toEqual([view.connection]);
    expect(s.closed()).toBe(true);
  });

  it("ends once, and once ended hears nothing more from the port", async () => {
    let handlers: PortHandlers | null = null;
    const port: Port = { transport: "clone", async send() {}, listen: (installed) => (handlers = installed), close() {} };
    const view = connect(port);
    const connections: ConnectionState[] = [];
    view.onConnection((connection) => connections.push(connection));
    handlers!.message({ kind: "welcome", wire: 1, api: 1, implementation: "", limits });
    handlers!.message({ kind: "result", id: 1, value: baseline });
    expect(view.connection.state).toBe("connected");
    handlers!.close();
    expect(view.connection).toEqual(disconnected(client("TransportDisconnected")));
    handlers!.message({ kind: "event", name: "state", value: at(9) });
    handlers!.message({ kind: "fault", error: { code: "StateUnavailable", message: "", effect: "none", messageId: null } });
    handlers!.close();
    expect(view.state).toEqual(openState);
    expect(connections).toEqual([expect.objectContaining({ state: "connected" }), disconnected(client("TransportDisconnected"))]);
  });
});

describe("a call", () => {
  it.each(transports)("reaches the daemon with its input and resolves with the typed result, on a %s port", async (transport) => {
    const inputs: unknown[] = [];
    const daemon = served(transport, {
      methods: handlers({
        setMediator: (input) => {
          inputs.push(input);
          return { mediationId: as(`med-${input.mediatorDid}`) };
        },
      }),
    });
    const view = connect(daemon.port);
    await view.connected();
    expect(await view.daemon.setMediator({ mediatorDid: "did:web:m" })).toEqual({ mediationId: "med-did:web:m" });
    expect(await view.call("setMediator", { mediatorDid: "did:web:n" })).toEqual({ mediationId: "med-did:web:n" });
    expect(inputs).toEqual([{ mediatorDid: "did:web:m" }, { mediatorDid: "did:web:n" }]);
  });

  it("rejects with the daemon's error, its origin from where it came and not from what the daemon wrote", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.daemon.lock({}));
    await s.frame({ kind: "error", id, error: { code: "WrongPhase", message: "not now", effect: "none", messageId: "m-1", origin: "client", extra: true } });
    expect(await outcome(promise)).toEqual({ origin: "daemon", code: "WrongPhase", message: "not now", effect: "none", messageId: "m-1" });
    expect(view.connection.state).toBe("connected");
  });

  it("takes an error of a code it does not know as the failure it says it is", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.daemon.lock({}));
    await s.frame({ kind: "error", id, error: { code: "SomethingNewer", message: "later", effect: "possible", messageId: null } });
    expect(await outcome(promise)).toEqual({ origin: "daemon", code: "SomethingNewer", message: "later", effect: "possible", messageId: null });
  });

  it("refuses locally, sending nothing, an input that is not wire data or is over a bound, with no effect", async () => {
    const { s, view } = await shown();
    const petname = (value: unknown) => view.daemon.renameContact({ contactId: as("c-1"), petname: value as string });
    expect(await outcome(petname(NaN))).toEqual(client("InvalidArgument"));
    expect(await outcome(petname(new Date(0)))).toEqual(client("InvalidArgument"));
    expect(await outcome(petname("x".repeat(3000)))).toEqual(client("ResourceLimit"));
    expect(await outcome(petname({ a: { b: { c: { d: { e: { f: {} } } } } } }))).toEqual(client("ResourceLimit"));
    expect(await outcome(view.daemon.restoreIdentity({ backup: new Uint8Array(101), passphrase: "p" }))).toEqual(client("ResourceLimit"));
    expect(s.calls()).toHaveLength(1);
    expect(view.connection.state).toBe("connected");
  });

  it.each(transports)("refuses locally an input the method's schema does not take, a base64 record at a byte member included, alike on a %s port", async (transport) => {
    const backups: Uint8Array[] = [];
    const daemon = served(transport, {
      methods: handlers({
        restoreIdentity: (input) => {
          backups.push(input.backup);
          return null;
        },
      }),
    });
    const view = connect(daemon.port);
    await view.connected();
    const restore = (backup: unknown) => outcome(view.daemon.restoreIdentity({ backup: backup as Uint8Array, passphrase: "p" }));
    expect(await restore({ encoding: "base64", data: "AQID" })).toEqual(client("InvalidArgument"));
    expect(await restore("AQID")).toEqual(client("InvalidArgument"));
    expect(await restore([1, 2, 3])).toEqual(client("InvalidArgument"));
    expect(await outcome(view.daemon.setMediator({ mediatorDid: 7 as unknown as string }))).toEqual(client("InvalidArgument"));
    expect(daemon.link.toRight).toHaveLength(2);
    expect(await restore(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(backups).toEqual([new Uint8Array([1, 2, 3])]);
    expect(view.connection.state).toBe("connected");
  });

  it("charges the whole frame against the bounds, the envelope included, as the daemon does", async () => {
    const { s, view } = await shown();
    const envelope = requestBudget(limits, { kind: "call", id: 2, method: "renameContact", input: null });
    if (!envelope.ok) throw new Error(envelope.message);
    const room = envelope.value.maxValueBytes - (8 + (8 + 9) + (8 + 3) + (8 + 7) + 8);
    const petname = (length: number) => view.daemon.renameContact({ contactId: as("c-1"), petname: "x".repeat(length) });
    const fitting = petname(room);
    await settle();
    expect(s.calls()).toHaveLength(2);
    expect(await outcome(petname(room + 1))).toEqual(client("ResourceLimit"));
    expect(s.calls()).toHaveLength(2);
    s.close();
    await outcome(fitting);
  });

  it("refuses a text frame over the frame bound before the port takes it, where a structured-clone port has no such bound", async () => {
    for (const transport of transports) {
      const s = scripted(transport);
      const view = connect(s.port);
      await s.welcome({ maxFrameBytes: 200 });
      await s.attach();
      const call = view.daemon.renameContact({ contactId: as("c-1"), petname: "é".repeat(120) });
      await settle();
      if (transport === "text") {
        expect(await outcome(call)).toEqual(client("ResourceLimit"));
        expect(s.calls()).toHaveLength(1);
      } else {
        expect(s.calls()).toHaveLength(2);
        s.close();
        await outcome(call);
      }
    }
  });

  it.each(transports)("carries a backup in and an export out, byte for byte, on a %s port", async (transport) => {
    const backups: Uint8Array[] = [];
    const daemon = served(transport, {
      methods: handlers({
        restoreIdentity: (input) => {
          backups.push(input.backup);
          return null;
        },
        exportBackup: () => ({ name: "vault.estoc", bytes: new Uint8Array([0, 1, 254, 255]) }),
      }),
    });
    const view = connect(daemon.port);
    await view.connected();
    const buffer = new Uint8Array([9, 9, 7, 8, 9, 9]);
    expect(await view.daemon.restoreIdentity({ backup: buffer.subarray(2, 4), passphrase: "p" })).toBeNull();
    expect([...backups[0]!]).toEqual([7, 8]);
    const exported = await view.daemon.exportBackup({});
    expect(exported.name).toBe("vault.estoc");
    expect(exported.bytes).toBeInstanceOf(Uint8Array);
    expect([...exported.bytes]).toEqual([0, 1, 254, 255]);
  });

  it.each(transports)("rejects an export over the advertised backup bound as a protocol error, and ends the session, on a %s port", async (transport) => {
    const s = scripted(transport);
    const view = connect(s.port);
    await s.greet();
    const { id, promise } = await inFlight(s, view.daemon.exportBackup({}));
    await s.frame({ kind: "result", id, value: { name: "v", bytes: new Uint8Array(limits.maxBackupBytes + 1) } }, ["bytes"]);
    expect(await outcome(promise)).toEqual(client("ProtocolError", "possible"));
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
    expect(s.closed()).toBe(true);
  });

  it("rejects a result that does not fit the method's schema as a protocol error, with a possible effect since the call was handed over", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.daemon.publicDid({}));
    const other = view.daemon.lock({});
    await settle();
    await s.frame({ kind: "result", id, value: { didId: 5, did: "did:peer:x" } });
    expect(await outcome(promise)).toEqual(client("ProtocolError", "possible"));
    expect(await outcome(other)).toEqual(client("TransportDisconnected", "possible"));
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
  });

  it("rejects an error the SDK cannot read as a protocol error", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.daemon.lock({}));
    await s.frame({ kind: "error", id, error: { code: "WrongPhase", message: "not now", effect: "maybe", messageId: null } });
    expect(await outcome(promise)).toEqual(client("ProtocolError", "possible"));
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
  });

  it("ignores a reply for an ID it has settled or never issued, and goes on", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.daemon.lock({}));
    await s.frame({ kind: "result", id, value: null });
    expect(await promise).toBeNull();
    await s.frame({ kind: "result", id, value: "again" });
    await s.frame({ kind: "error", id: 99, error: { code: "WrongPhase", message: "", effect: "none", messageId: null } });
    expect(view.connection.state).toBe("connected");
    const later = await inFlight(s, view.daemon.publicDid({}));
    expect(later.id).toBe(id + 1);
    await s.frame({ kind: "result", id: later.id, value: { didId: "did-1", did: "did:peer:x" } });
    expect(await later.promise).toEqual({ didId: "did-1", did: "did:peer:x" });
  });

  it("keeps a message body's keys, __proto__ among them, all the way to the daemon", async () => {
    const { s, view } = await shown();
    const body = JSON.parse('{"__proto__": {"polluted": true}, "content": "hi"}') as JsonObject;
    const { id } = await inFlight(s, view.daemon.send({ target: { channelId: as("ch") }, content: { type: BASIC_MESSAGE, body } }));
    const sent = s.calls().find((call) => call.id === id)?.input as { content: { body: Record<string, unknown> } };
    expect(Object.keys(sent.content.body)).toEqual(["__proto__", "content"]);
    expect(Object.getPrototypeOf(sent.content.body)).toBe(Object.prototype);
  });
});

describe("a lost reply", () => {
  it("is TransportDisconnected for every call in flight when the port closes: a possible effect, and none for a refresh", async () => {
    const { s, view, connections } = await shown();
    const lock = view.daemon.lock({});
    const refresh = view.refresh();
    await settle();
    expect(s.calls().map((call) => call.method)).toEqual(["attach", "lock", "refresh"]);
    s.close();
    expect(await outcome(lock)).toEqual(client("TransportDisconnected", "possible"));
    expect(await outcome(refresh)).toEqual(client("TransportDisconnected"));
    expect(view.connection).toEqual(disconnected(client("TransportDisconnected")));
    expect(connections.at(-1)).toEqual(view.connection);
    expect(view.state).toEqual(openState);
  });

  it("is the same when the view closes, the connection then ended for no reason of the daemon's", async () => {
    const { s, view } = await shown();
    const lock = view.daemon.lock({});
    await settle();
    view.close();
    expect(await outcome(lock)).toEqual(client("TransportDisconnected", "possible"));
    expect(view.connection).toEqual(disconnected(null));
    expect(await outcome(view.connected())).toEqual(client("TransportDisconnected"));
    expect(s.closed()).toBe(true);
    view.close();
    expect(view.connection).toEqual(disconnected(null));
  });

  it("is not answered by a fault: the fault ends the connection with the daemon's reason, and each call in flight is lost on its own terms", async () => {
    const { s, view } = await shown();
    const lock = view.daemon.lock({});
    const refresh = view.refresh();
    await settle();
    const error = { code: "StateUnavailable", message: "no state", effect: "none", messageId: null };
    await s.frame({ kind: "fault", error: { ...error, origin: "client" } });
    expect(await outcome(lock)).toEqual(client("TransportDisconnected", "possible"));
    expect(await outcome(refresh)).toEqual(client("TransportDisconnected"));
    expect(view.connection).toEqual(disconnected({ origin: "daemon", ...error } as CallError));
    expect(s.closed()).toBe(true);
  });

  it("is a protocol error when the fault cannot be read", async () => {
    const { s, view } = await shown();
    await s.frame({ kind: "fault", error: "gone" });
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
  });
});

describe("the refresh barrier", () => {
  it("is met by the reply's revision, or a greater one of its epoch, received before the reply", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    expect(s.calls().at(-1)).toEqual({ kind: "call", id, method: "refresh", input: {} });
    await s.frame({ kind: "event", name: "state", value: at(8) });
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 7 } });
    expect(await outcome(promise)).toBeUndefined();
    expect(view.state?.revision).toBe(8);
  });

  it("is met at once when the daemon reuses the revision already shown, with no state event", async () => {
    const { s, view, states } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 3 } });
    expect(await outcome(promise)).toBeUndefined();
    expect(states).toEqual([openState]);
  });

  it("waits for a state at or beyond the reply's revision when the reply comes first, never for that exact revision", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    let done = false;
    void promise.then(() => (done = true));
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 9 } });
    await s.frame({ kind: "event", name: "state", value: at(8) });
    expect(done).toBe(false);
    await s.frame({ kind: "event", name: "state", value: at(10) });
    expect(done).toBe(true);
  });

  it("is lost as StateChanged, with no effect, when the epoch moves before it is met", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 9 } });
    await s.frame({ kind: "event", name: "state", value: at(1, "epoch-2") });
    expect(await outcome(promise)).toEqual(client("StateChanged"));
    expect(view.state?.epoch).toBe("epoch-2");
    expect(view.connection.state).toBe("connected");
  });

  it("is lost as StateChanged when the reply is of another epoch than the state shown", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "result", id, value: { epoch: "epoch-0", revision: 1 } });
    expect(await outcome(promise)).toEqual(client("StateChanged"));
  });

  it("is lost as TransportDisconnected, with no effect, when the connection ends before it is met", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 9 } });
    s.close();
    expect(await outcome(promise)).toEqual(client("TransportDisconnected"));
  });

  it("carries the daemon's StateChanged when the daemon lost the epoch first", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "error", id, error: { code: "StateChanged", message: "epoch moved", effect: "none", messageId: null } });
    expect(await outcome(promise)).toEqual({ origin: "daemon", code: "StateChanged", message: "epoch moved", effect: "none", messageId: null });
  });

  it("is not undone by a later epoch once met", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 3 } });
    await s.frame({ kind: "event", name: "state", value: at(1, "epoch-2") });
    expect(await outcome(promise)).toBeUndefined();
  });

  it.each(["a new epoch", "the port closing"])("is judged as the reply is read, so that %s in the same batch of frames does not undo a met barrier", async (next) => {
    let handlers: PortHandlers | null = null;
    const port: Port = { transport: "clone", async send() {}, listen: (installed) => (handlers = installed), close() {} };
    const view = connect(port);
    handlers!.message({ kind: "welcome", wire: 1, api: 1, implementation: "", limits });
    handlers!.message({ kind: "result", id: 1, value: baseline });
    const promise = outcome(view.refresh());
    handlers!.message({ kind: "result", id: 2, value: { epoch: "epoch-1", revision: 3 } });
    if (next === "a new epoch") {
      handlers!.message({ kind: "event", name: "state", value: at(1, "epoch-2") });
      handlers!.message({ kind: "event", name: "lines", value: linesAt(1, "epoch-2") });
    } else handlers!.close();
    expect(await promise).toBeUndefined();
    const waiting = outcome(view.refresh());
    if (next === "a new epoch") {
      handlers!.message({ kind: "result", id: 3, value: { epoch: "epoch-2", revision: 5 } });
      handlers!.message({ kind: "event", name: "state", value: at(1, "epoch-3") });
      expect(await waiting).toEqual(client("StateChanged"));
    } else expect(await waiting).toEqual(client("NotConnected"));
  });

  it("is met before the state is shown, so that a listener closing the connection on that state does not undo it", async () => {
    const { s, view } = await shown();
    const { id, promise } = await inFlight(s, view.refresh());
    await s.frame({ kind: "result", id, value: { epoch: "epoch-1", revision: 9 } });
    view.onState((state) => {
      if (state.revision === 9) view.close();
    });
    await s.frame({ kind: "event", name: "state", value: at(9) });
    expect(await outcome(promise)).toBeUndefined();
    expect(view.connection).toEqual(disconnected(null));
  });
});

describe("a publication", () => {
  it("of the current epoch is applied in order and handed to its listeners: states, lines, logs, and a new epoch's state before its lines", async () => {
    const { s, view, states, lines, logs } = await shown();
    await s.frame({ kind: "event", name: "state", value: at(4) });
    await s.frame({ kind: "event", name: "lines", value: linesAt(2) });
    await s.frame({ kind: "event", name: "log", value: { epoch: "epoch-1", line: "hello" } });
    await s.frame({ kind: "event", name: "state", value: at(1, "epoch-2") });
    await s.frame({ kind: "event", name: "lines", value: linesAt(1, "epoch-2") });
    await s.frame({ kind: "event", name: "log", value: { epoch: "epoch-2", line: "again" } });
    expect(states.map((state) => [state.epoch, state.revision])).toEqual([
      ["epoch-1", 3],
      ["epoch-1", 4],
      ["epoch-2", 1],
    ]);
    expect(lines.map((update) => [update.epoch, update.revision])).toEqual([
      ["epoch-1", 1],
      ["epoch-1", 2],
      ["epoch-2", 1],
    ]);
    expect(logs.map((line) => line.line)).toEqual(["hello", "again"]);
    expect(view.state).toEqual(at(1, "epoch-2"));
    expect(view.lines).toEqual(linesAt(1, "epoch-2"));
    expect(view.connection.state).toBe("connected");
  });

  it("already shown is ignored, and one older than shown ends the session as a protocol error", async () => {
    const { s, view, states, lines } = await shown();
    await s.frame({ kind: "event", name: "state", value: at(3) });
    await s.frame({ kind: "event", name: "lines", value: linesAt(1) });
    expect(states).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(view.connection.state).toBe("connected");
    await s.frame({ kind: "event", name: "state", value: at(2) });
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
    expect(view.state).toEqual(openState);
    const other = await shown();
    await other.s.frame({ kind: "event", name: "lines", value: linesAt(0 + 1) });
    await other.s.frame({ kind: "event", name: "lines", value: linesAt(2) });
    await other.s.frame({ kind: "event", name: "lines", value: linesAt(1) });
    expect(other.view.connection).toEqual(disconnected(client("ProtocolError")));
    expect(other.view.lines?.revision).toBe(2);
  });

  it("of another epoch than the state shown, lines or a log, ends the session as a protocol error", async () => {
    const { s, view } = await shown();
    await s.frame({ kind: "event", name: "lines", value: linesAt(5, "epoch-2") });
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
    const other = await shown();
    await other.s.frame({ kind: "event", name: "log", value: { epoch: "epoch-2", line: "late" } });
    expect(other.view.connection).toEqual(disconnected(client("ProtocolError")));
  });

  it("the SDK cannot read ends the session as a protocol error, as does one before the baseline, a call in the daemon's direction, or no frame at all", async () => {
    const { s, view } = await shown();
    await s.frame({ kind: "event", name: "state", value: { epoch: "epoch-1", revision: 4, value: { phase: "elsewhere" } } });
    expect(view.connection).toEqual(disconnected(client("ProtocolError")));
    const early = await shown("clone", false);
    await early.s.welcome();
    await early.s.frame({ kind: "event", name: "state", value: at(4) });
    expect(early.view.connection).toEqual(disconnected(client("ProtocolError")));
    expect(await outcome(early.view.connected())).toEqual(client("ProtocolError"));
    const wrong = await shown();
    await wrong.s.frame({ kind: "call", id: 7, method: "lock", input: {} });
    expect(wrong.view.connection).toEqual(disconnected(client("ProtocolError")));
    const junk = await shown("text");
    await junk.s.say("junk");
    expect(junk.view.connection).toEqual(disconnected(client("ProtocolError")));
  });
});

describe("a listener", () => {
  it("is dropped by what its subscription returns, and its throw stops neither the session nor the others", async () => {
    const { s, view } = await shown();
    const seen: number[] = [];
    const drop = view.onState((state) => seen.push(state.revision));
    view.onState(() => {
      throw new Error("a view's bug");
    });
    view.onState((state) => seen.push(state.revision * 10));
    const reported: (() => void)[] = [];
    const microtasks = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => reported.push(callback));
    try {
      await s.frame({ kind: "event", name: "state", value: at(4) });
      expect(seen).toEqual([4, 40]);
      drop();
      await s.frame({ kind: "event", name: "state", value: at(5) });
      expect(seen).toEqual([4, 40, 50]);
    } finally {
      microtasks.mockRestore();
    }
    expect(reported).toHaveLength(2);
    for (const raise of reported) expect(raise).toThrow("a view's bug");
    expect(view.connection.state).toBe("connected");
  });
});
