import { describe, expect, expectTypeOf, it, test, vi } from "vitest";

import * as core from "../src/index.js";
import { LinkClosed, type AgentOptions, type DispatchOptions, type DispatcherOptions, type LinkOptions, type ReceiverOptions } from "../src/index.js";
import { Lifetime, refuses } from "../src/lifetime.js";
import { handTimers } from "./helpers.js";

class RecordingSocket {
  static opened: RecordingSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    RecordingSocket.opened.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

const recordingSockets = (): typeof WebSocket => {
  RecordingSocket.opened = [];
  return RecordingSocket as unknown as typeof WebSocket;
};

describe("a lifetime", () => {
  it("closes once, and stays closed", () => {
    const lifetime = new Lifetime(handTimers());
    expect(lifetime.closed).toBe(false);
    lifetime.close();
    lifetime.close();
    expect(lifetime.closed).toBe(true);
  });

  it("sets no timer once closed", () => {
    const timers = handTimers();
    const lifetime = new Lifetime(timers);
    lifetime.close();
    const fire = vi.fn();
    lifetime.setTimer(fire, 10).cancel();
    expect(timers.waits).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
  });

  it("clears every timer it set when it closes, whether or not their setters still hold them, and fires none after", () => {
    const timers = handTimers();
    const lifetime = new Lifetime(timers);
    const fire = vi.fn();
    lifetime.setTimer(fire, 10);
    lifetime.setTimer(fire, 20);
    lifetime.close();
    expect(timers.waits.map((wait) => [wait.ms, wait.cleared])).toEqual([
      [10, true],
      [20, true],
    ]);
    for (const wait of timers.waits) wait.fire();
    expect(fire).not.toHaveBeenCalled();
  });

  it("fires a timer once, and clears one cancelled before it fired", () => {
    const timers = handTimers();
    const lifetime = new Lifetime(timers);
    const fired: string[] = [];
    lifetime.setTimer(() => fired.push("kept"), 10);
    lifetime.setTimer(() => fired.push("cancelled"), 20).cancel();
    for (const wait of timers.waits) wait.fire();
    timers.waits[0]!.fire();
    expect(fired).toEqual(["kept"]);
    expect(timers.waits.map((wait) => wait.cleared)).toEqual([false, true]);
  });

  it("passes a request to the transport while open, and refuses one at the call once closed without reaching the transport", async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("answered"));
    const lifetime = new Lifetime(handTimers());
    const gated = lifetime.fetch(transport);
    expect(await (await gated("https://example.org/", { method: "POST" })).text()).toBe("answered");
    expect(transport).toHaveBeenCalledWith("https://example.org/", { method: "POST" });

    lifetime.close();
    await expect(gated("https://example.org/")).rejects.toBeInstanceOf(LinkClosed);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("leaves a request made before it closed to be answered, its body read after", async () => {
    let answer = (_: Response): void => undefined;
    const lifetime = new Lifetime(handTimers());
    const asked = lifetime.fetch(() => new Promise<Response>((resolve) => (answer = resolve)))("https://example.org/");
    lifetime.close();
    answer(new Response("late"));
    expect(await (await asked).text()).toBe("late");
  });

  it("takes no transport a lifetime gates already, so that whoever calls one asks the one lifetime it goes through", () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const first = new Lifetime(handTimers());
    const gated = first.fetch(transport);
    expect(() => first.fetch(gated)).toThrow("the transport is gated by a lifetime already");
    expect(() => new Lifetime(handTimers()).fetch(gated)).toThrow("the transport is gated by a lifetime already");
    expect([refuses(transport), refuses(gated)]).toEqual([false, false]);
    first.close();
    expect([refuses(transport), refuses(gated)]).toEqual([false, true]);
  });

  it("opens a socket and sends over it while open, handing down what it says", () => {
    const lifetime = new Lifetime(handTimers());
    const socket = lifetime.sockets(recordingSockets()).open("wss://example.org/ws");
    const heard: string[] = [];
    socket.onopen = () => heard.push("open");
    socket.onmessage = (event) => heard.push(String(event.data));
    socket.onclose = () => heard.push("close");
    const [opened] = RecordingSocket.opened;
    opened!.onopen?.();
    opened!.onmessage?.({ data: "frame" });
    socket.send("hello");
    socket.close();
    expect(opened!.url).toBe("wss://example.org/ws");
    expect(opened!.sent).toEqual(["hello"]);
    expect(heard).toEqual(["open", "frame", "close"]);
  });

  it("opens no socket once closed, and sends nothing over one opened before", () => {
    const lifetime = new Lifetime(handTimers());
    const sockets = lifetime.sockets(recordingSockets());
    const socket = sockets.open("wss://example.org/ws");
    lifetime.close();
    expect(() => sockets.open("wss://example.org/ws")).toThrow(LinkClosed);
    expect(() => socket.send("hello")).toThrow(LinkClosed);
    expect(RecordingSocket.opened).toHaveLength(1);
    expect(RecordingSocket.opened[0]!.sent).toEqual([]);
  });
});

test("a lifetime is its owner's alone: the package exports none, and no part is handed one, or told when it has closed", () => {
  expect(Object.keys(core)).not.toContain("Lifetime");
  expectTypeOf<AgentOptions>().not.toHaveProperty("lifetime");
  expectTypeOf<DispatchOptions>().not.toHaveProperty("lifetime");
  expectTypeOf<DispatcherOptions>().not.toHaveProperty("lifetime");
  expectTypeOf<ReceiverOptions>().not.toHaveProperty("lifetime");
  expectTypeOf<LinkOptions>().not.toHaveProperty("lifetime");
  expectTypeOf<DispatchOptions>().not.toHaveProperty("closed");
  expectTypeOf<LinkOptions>().not.toHaveProperty("closed");
});
