import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconnecting, type ConnectionState } from "../../src/client/index.js";
import type { CallError, State } from "../../src/contract/index.js";
import type { Port, PortHandlers } from "../../src/wire/index.js";
import { openState } from "../contract/fixtures.js";
import { settle } from "../wire/ports.js";
import { at, baseline, limits, linesAt, scripted, type Scripted } from "./daemons.js";

const outcome = <T>(promise: Promise<T>): Promise<T | CallError> => promise.then((value) => value, (error: CallError) => error);

const lost = (message = expect.any(String) as string): ConnectionState => ({ state: "disconnected", because: { origin: "client", code: "TransportDisconnected", message, effect: "none", messageId: null } });

/** A client over a series of scripted daemons, each handed out when the client opens a port. */
const series = (...daemons: (Scripted | (() => Port | Promise<Port>))[]) => {
  let opened = 0;
  const view = reconnecting(
    () => {
      const next = daemons[opened++];
      if (next === undefined) throw new Error("no daemon left");
      return typeof next === "function" ? next() : next.port;
    },
    { delayMs: 500 },
  );
  const states: State[] = [];
  const connections: ConnectionState[] = [];
  view.onState((state) => states.push(state));
  view.onConnection((connection) => connections.push(connection));
  return { view, states, connections, opened: () => opened };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a reconnecting client", () => {
  it("opens another connection after the delay when one ends, attaches afresh, and shows the new baseline in place of the old", async () => {
    const first = scripted("clone");
    const second = scripted("clone");
    const { view, states, connections, opened } = series(first, second);
    await first.greet();
    expect(view.connection.state).toBe("connected");
    expect(view.state).toEqual(openState);
    first.close();
    expect(view.connection).toEqual(lost());
    expect(view.state).toEqual(openState);
    await vi.advanceTimersByTimeAsync(499);
    expect(opened()).toBe(1);
    expect(view.connection.state).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(1);
    expect(opened()).toBe(2);
    expect(view.connection).toEqual({ state: "connecting" });
    const attached = view.connected();
    await second.welcome();
    expect(second.calls()).toEqual([{ kind: "call", id: 1, method: "attach", input: {} }]);
    await second.attach({ state: at(1, "epoch-2"), lines: linesAt(1, "epoch-2") });
    expect(await outcome(attached)).toBeUndefined();
    expect(view.connection).toEqual({ state: "connected", implementation: "scripted", limits });
    expect(view.state).toEqual(at(1, "epoch-2"));
    expect(view.lines).toEqual(linesAt(1, "epoch-2"));
    expect(states.map((state) => state.epoch)).toEqual(["epoch-1", "epoch-2"]);
    expect(connections.map((connection) => connection.state)).toEqual(["connected", "disconnected", "connecting", "connected"]);
  });

  it("never resends a call the old connection lost: it is rejected as lost, and the new connection carries only hello and attach", async () => {
    const first = scripted("text");
    const second = scripted("text");
    const { view } = series(first, second);
    await first.greet();
    const lock = view.daemon.lock({});
    const refresh = view.refresh();
    await settle();
    expect(first.calls().map((call) => call.method)).toEqual(["attach", "lock", "refresh"]);
    first.close();
    expect(await outcome(lock)).toEqual({ origin: "client", code: "TransportDisconnected", message: expect.any(String) as string, effect: "possible", messageId: null });
    expect(await outcome(refresh)).toEqual({ origin: "client", code: "TransportDisconnected", message: expect.any(String) as string, effect: "none", messageId: null });
    expect(await outcome(view.daemon.lock({}))).toMatchObject({ origin: "client", code: "NotConnected", effect: "none" });
    await vi.advanceTimersByTimeAsync(500);
    await second.greet();
    expect(second.received()).toEqual([{ kind: "hello", wire: 1, apis: [1] }, { kind: "call", id: 1, method: "attach", input: {} }]);
    expect(view.connection.state).toBe("connected");
  });

  it("ignores what an old connection says once it has ended", async () => {
    const stale: PortHandlers[] = [];
    const manual = (): Port => ({ transport: "clone", async send() {}, listen: (handlers) => stale.push(handlers), close() {} });
    const second = scripted("clone");
    const { view, states } = series(manual, second);
    await settle();
    const old = stale[0]!;
    old.message({ kind: "welcome", wire: 1, api: 1, implementation: "manual", limits });
    old.message({ kind: "result", id: 1, value: baseline });
    expect(view.state).toEqual(openState);
    old.close();
    await vi.advanceTimersByTimeAsync(500);
    await second.welcome();
    await second.attach({ state: at(1, "epoch-2"), lines: linesAt(1, "epoch-2") });
    expect(view.state?.epoch).toBe("epoch-2");
    old.message({ kind: "event", name: "state", value: at(9) });
    old.message({ kind: "result", id: 1, value: baseline });
    old.close();
    expect(view.state).toEqual(at(1, "epoch-2"));
    expect(view.connection.state).toBe("connected");
    expect(states.map((state) => [state.epoch, state.revision])).toEqual([
      ["epoch-1", 3],
      ["epoch-2", 1],
    ]);
  });

  it("stops at a daemon that cannot speak this API", async () => {
    const first = scripted("clone");
    const { view, opened } = series(first, scripted("clone"));
    const attached = view.connected();
    await first.say({ kind: "incompatible", wire: 1, supported: [2], message: "update the view" });
    expect(view.connection).toEqual({ state: "incompatible", supported: [2], message: "update the view" });
    expect(await outcome(attached)).toMatchObject({ origin: "client", code: "Incompatible", message: "update the view" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened()).toBe(1);
    expect(view.connection.state).toBe("incompatible");
    expect(await outcome(view.connected())).toMatchObject({ code: "Incompatible" });
    expect(await outcome(view.daemon.lock({}))).toMatchObject({ code: "NotConnected" });
  });

  it("tries again after the delay when no port could be opened", async () => {
    const daemon = scripted("clone");
    const { view, opened } = series(
      () => {
        throw new Error("no socket");
      },
      () => Promise.reject(new Error("no socket yet")),
      daemon,
    );
    await settle();
    expect(view.connection).toEqual(lost("no port could be opened"));
    await vi.advanceTimersByTimeAsync(500);
    expect(opened()).toBe(2);
    expect(view.connection).toEqual(lost("no port could be opened"));
    await vi.advanceTimersByTimeAsync(500);
    expect(opened()).toBe(3);
    await daemon.greet();
    expect(view.connection.state).toBe("connected");
  });

  it("closes the current connection and stops when the view closes, and closes a port opened after that", async () => {
    const first = scripted("clone");
    const { view, opened, connections } = series(first, scripted("clone"));
    await first.greet();
    const lock = view.daemon.lock({});
    await settle();
    view.close();
    expect(first.closed()).toBe(true);
    expect(view.connection).toEqual({ state: "disconnected", because: null });
    expect(await outcome(lock)).toMatchObject({ code: "TransportDisconnected", effect: "possible" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened()).toBe(1);
    expect(await outcome(view.connected())).toMatchObject({ code: "TransportDisconnected" });
    expect(await outcome(view.daemon.lock({}))).toMatchObject({ code: "NotConnected" });
    view.close();
    expect(connections.map((connection) => connection.state)).toEqual(["connected", "disconnected"]);

    let release: (port: Port) => void = () => {};
    const late = scripted("clone");
    const waiting = series(() => new Promise<Port>((resolve) => (release = resolve)));
    await settle();
    waiting.view.close();
    release(late.port);
    await settle();
    expect(late.closed()).toBe(true);
    expect(late.received()).toEqual([]);
  });

  it("forwards the lines and logs of the current connection", async () => {
    const first = scripted("clone");
    const { view } = series(first);
    const lines: number[] = [];
    const logs: string[] = [];
    view.onLines((update) => lines.push(update.revision));
    view.onLog((line) => logs.push(line.line));
    await first.greet();
    await first.frame({ kind: "event", name: "lines", value: linesAt(2) });
    await first.frame({ kind: "event", name: "log", value: { epoch: "epoch-1", line: "hello" } });
    expect(lines).toEqual([1, 2]);
    expect(logs).toEqual(["hello"]);
    expect(view.lines?.revision).toBe(2);
  });
});
