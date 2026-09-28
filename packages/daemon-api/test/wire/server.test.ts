import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_VERSION, WIRE_VERSION, schemas, type ApiError, type Baseline, type Hello, type Limits, type State } from "../../src/contract/index.js";
import { readBootstrap, readFrame, Refusal, serveApi, writeBootstrap, writeFrame, type MethodHandlers, type RawFrame, type ServeOptions, type Session, type Transport } from "../../src/wire/index.js";
import { linesState, openState } from "../contract/fixtures.js";
import { pair, settle, type Pair } from "./ports.js";

const limits: Limits = { maxFrameBytes: 4000, maxBackupBytes: 100, maxValueBytes: 2000, maxDepth: 6 };
const transports: Transport[] = ["text", "clone"];
const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };
const baseline: Baseline = { state: openState, lines: linesState };

const notNow = new Refusal({ code: "WrongPhase", message: "not now", effect: "none" });

/** Every method refuses unless a test says otherwise. */
const handlers = (overrides: Partial<MethodHandlers> = {}): MethodHandlers => {
  const table: Record<string, unknown> = {};
  for (const name of schemas.METHOD_NAMES) {
    if (name !== "attach")
      table[name] = () => {
        throw notNow;
      };
  }
  return { ...(table as MethodHandlers), ...overrides };
};

interface Talk {
  link: Pair;
  session: Session;
  failures: unknown[];
  /** what the view received, bootstrap records and frames read */
  received(): (RawFrame | ReturnType<typeof readBootstrap>)[];
  say(data: unknown): Promise<void>;
  call(id: number, method: string, input: unknown, bytesAt?: readonly string[]): Promise<void>;
  greet(): Promise<void>;
  attach(id?: number): Promise<void>;
}

const talk = (transport: Transport, options: Partial<ServeOptions> = {}): Talk => {
  const link = pair(transport);
  const failures: unknown[] = [];
  const session = serveApi(link.right, { methods: handlers(), limits, implementation: "test daemon", attach: () => baseline, failed: (error) => failures.push(error), ...options });
  const t: Talk = {
    link,
    session,
    failures,
    received: () => link.toLeft.map((data) => readFrame(data, transport) ?? readBootstrap(data, transport)),
    say: async (data) => {
      await link.left.send(data);
      await settle();
    },
    call: (id, method, input, bytesAt) => t.say(writeFrame({ kind: "call", id, method, input }, transport, bytesAt)),
    greet: () => t.say(writeBootstrap(hello, transport)),
    attach: async (id = 1) => {
      await t.greet();
      await t.call(id, "attach", {});
    },
  };
  link.left.listen({ message() {}, close() {} });
  return t;
};

const last = (t: Talk) => t.received().at(-1);
const error = (t: Talk) => (last(t) as { error: ApiError }).error;
const seen = (t: Talk, code: string) => expect(error(t)).toEqual({ code, message: expect.any(String) as string, effect: "none", messageId: null });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("negotiation", () => {
  it.each(transports)("answers hello with a welcome carrying the limits on a %s port", async (transport) => {
    const t = talk(transport);
    await t.greet();
    expect(last(t)).toEqual({ kind: "welcome", wire: 1, api: 1, implementation: "test daemon", limits });
    expect(t.session.closed).toBe(false);
  });

  it("closes the port when the first frame is not a hello, whatever else it is", async () => {
    for (const first of [writeBootstrap({ kind: "welcome", wire: 1, api: 1, implementation: "", limits }, "text"), '{"kind":"call","id":1,"method":"attach","input":{}}', '{"kind":"hello","wire":2,"apis":[1]}', "junk", new Uint8Array(1)]) {
      const t = talk("text");
      await t.say(first);
      expect(t.session.closed).toBe(true);
      expect(t.received()).toEqual([]);
    }
  });

  it("refuses a view that cannot speak this API with the versions it has, then closes", async () => {
    const t = talk("text");
    await t.say(writeBootstrap({ kind: "hello", wire: 1, apis: [2, 3] }, "text"));
    expect(last(t)).toEqual({ kind: "incompatible", wire: 1, supported: [1], message: expect.stringMatching(/API 1/) as string });
    expect(t.session.closed).toBe(true);
  });

  it("closes a port that says hello twice, and one that sends a frame in the daemon's direction", async () => {
    const twice = talk("clone");
    await twice.greet();
    await twice.greet();
    expect(twice.session.closed).toBe(true);
    for (const wrong of [
      { kind: "result", id: 1, value: null },
      { kind: "error", id: 1, error: { code: "x", message: "", effect: "none", messageId: null } },
      { kind: "event", name: "log", value: { epoch: "e", line: "" } },
      { kind: "fault", error: { code: "x", message: "", effect: "none", messageId: null } },
      "not a frame",
      { kind: "call", id: 1, method: "attach", input: {}, __proto__: { extra: true } },
    ]) {
      const t = talk("clone");
      await t.greet();
      await t.say(wrong);
      expect(t.session.closed).toBe(true);
    }
  });

  it("closes a port that does not say hello in time, and keeps one that did", async () => {
    const silent = talk("text", { bootstrapTimeoutMs: 500 });
    vi.advanceTimersByTime(499);
    expect(silent.session.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(silent.session.closed).toBe(true);
    const prompt = talk("text", { bootstrapTimeoutMs: 500 });
    await prompt.greet();
    vi.advanceTimersByTime(10_000);
    expect(prompt.session.closed).toBe(false);
  });
});

describe("attachment", () => {
  it.each(transports)("answers attach with the baseline, once, and other methods only after it, on a %s port", async (transport) => {
    let attachedWith: Session | null = null;
    const t = talk(transport, {
      attach: (session) => {
        attachedWith = session;
        return baseline;
      },
    });
    await t.greet();
    await t.call(1, "unlock", { passphrase: "p" });
    seen(t, "NotAttached");
    expect(t.session.attached).toBe(false);
    await t.call(2, "attach", {});
    expect(last(t)).toEqual({ kind: "result", id: 2, value: baseline });
    expect(attachedWith).toBe(t.session);
    expect(t.session.attached).toBe(true);
    await t.call(3, "attach", {});
    seen(t, "AlreadyAttached");
    expect(t.session.attached).toBe(true);
  });

  it("puts the baseline ahead of every publication, one published from inside attach included", async () => {
    const t = talk("clone", {
      attach: (session) => {
        session.event("log", { epoch: "epoch-1" as never, line: "too early" });
        return baseline;
      },
    });
    await t.attach();
    t.session.event("log", { epoch: "epoch-1" as never, line: "after" });
    await settle();
    expect(t.received().slice(1)).toEqual([
      { kind: "result", id: 1, value: baseline },
      { kind: "event", name: "log", value: { epoch: "epoch-1", line: "after" } },
    ]);
  });

  it("answers a failing attach hook as an operation that did nothing, and tells the host", async () => {
    const t = talk("clone", {
      attach: () => {
        throw new Error("no publisher yet");
      },
    });
    await t.attach();
    seen(t, "OperationFailed");
    expect(t.session.attached).toBe(false);
    expect(t.failures).toHaveLength(1);
  });
});

describe("a call", () => {
  it("is answered from the method table only: no name the daemon object might have", async () => {
    const t = talk("clone");
    await t.attach();
    for (const name of ["nothing", "constructor", "toString", "__proto__", "hasOwnProperty", ""]) {
      await t.call(2, name, {});
      seen(t, "NoSuchMethod");
    }
  });

  it("reaches its handler with the validated input and answers with its result", async () => {
    const inputs: unknown[] = [];
    const t = talk("clone", {
      methods: handlers({
        setTraceLevel: (input) => {
          inputs.push(input);
          return { level: input.level };
        },
        publicDid: async () => ({ didId: "did-1" as never, did: "did:peer:4z" }),
      }),
    });
    await t.attach();
    await t.call(2, "setTraceLevel", { level: "verbose", extra: "ignored" });
    expect(inputs).toEqual([{ level: "verbose" }]);
    expect(last(t)).toEqual({ kind: "result", id: 2, value: { level: "verbose" } });
    await t.call(3, "publicDid", {});
    expect(last(t)).toEqual({ kind: "result", id: 3, value: { didId: "did-1", did: "did:peer:4z" } });
  });

  it("with invalid input is refused before any handler runs, naming the member", async () => {
    let ran = 0;
    const t = talk("clone", {
      methods: handlers({
        setTraceLevel: () => {
          ran++;
          return { level: "off" };
        },
      }),
    });
    await t.attach();
    await t.call(2, "setTraceLevel", { level: "loud" });
    seen(t, "InvalidArgument");
    expect(error(t).message).toMatch(/level/);
    await t.call(3, "setTraceLevel", []);
    seen(t, "InvalidArgument");
    await t.call(4, "send", { target: { channelId: "c", contactId: "k" }, content: { type: "t", body: {} } });
    seen(t, "InvalidArgument");
    await t.say({ kind: "call", id: 5, method: "unlock", input: { passphrase: "p", n: NaN } });
    seen(t, "InvalidArgument");
    expect(ran).toBe(0);
  });

  it("over the advertised bounds is refused with ResourceLimit, unread past the bound", async () => {
    let ran = 0;
    const t = talk("clone", {
      methods: handlers({
        renameContact: () => {
          ran++;
          return null;
        },
      }),
    });
    await t.attach();
    await t.call(2, "renameContact", { contactId: "c", petname: "x".repeat(limits.maxValueBytes) });
    seen(t, "ResourceLimit");
    let deep: unknown = "x";
    for (let i = 0; i < limits.maxDepth; i++) deep = [deep];
    await t.call(3, "renameContact", { contactId: "c", petname: deep });
    seen(t, "ResourceLimit");
    await t.call(4, "mergeBackup", { backup: new Uint8Array(limits.maxBackupBytes + 1) }, ["backup"]);
    seen(t, "ResourceLimit");
    expect(ran).toBe(0);
  });

  it("answers a refusal with the handler's own code, effect and message ID", async () => {
    const t = talk("clone", {
      methods: handlers({
        retry: () => {
          throw new Refusal({ code: "SendClosed", message: "the peer rotated away", effect: "possible", messageId: "m-1" as never });
        },
      }),
    });
    await t.attach();
    await t.call(2, "retry", { messageId: "m-1" });
    expect(last(t)).toEqual({ kind: "error", id: 2, error: { code: "SendClosed", message: "the peer rotated away", effect: "possible", messageId: "m-1" } });
    expect(t.failures).toEqual([]);
  });

  it("answers any other throw as OperationFailed with a possible effect, the throw kept for the host", async () => {
    const boom = new Error("disk on fire: /home/ada/.estoc");
    const t = talk("clone", {
      methods: handlers({
        send: () => {
          throw boom;
        },
      }),
    });
    await t.attach();
    await t.call(2, "send", { target: { contactId: "c" }, content: { type: "t", body: { text: "hi" } } });
    expect(error(t)).toEqual({ code: "OperationFailed", message: expect.not.stringMatching(/disk|ada/) as string, effect: "possible", messageId: null });
    expect(t.failures).toEqual([boom]);
  });

  it.each(transports)("carries a backup in and an export out on a %s port, byte for byte", async (transport) => {
    const view = new Uint8Array(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3);
    let restored: Uint8Array | null = null;
    const t = talk(transport, {
      methods: handlers({
        restoreIdentity: (input) => {
          restored = input.backup;
          return null;
        },
        exportBackup: () => ({ name: "ada.estoc", bytes: view }),
      }),
    });
    await t.attach();
    await t.call(2, "restoreIdentity", { backup: view, passphrase: "p" }, ["backup"]);
    expect(last(t)).toEqual({ kind: "result", id: 2, value: null });
    expect(restored !== null && [...(restored as Uint8Array)]).toEqual([1, 2, 3]);
    expect(restored !== null && (restored as Uint8Array).buffer.byteLength).toBe(3);
    await t.call(3, "exportBackup", {});
    const written = t.link.toLeft.at(-1);
    if (transport === "text") expect(JSON.parse(written as string)).toEqual({ kind: "result", id: 3, value: { name: "ada.estoc", bytes: { encoding: "base64", data: "AQID" } } });
    else expect([...(written as { value: { bytes: Uint8Array } }).value.bytes]).toEqual([1, 2, 3]);
  });

  it("keeps a message body's keys, __proto__ among them, all the way to the handler", async () => {
    const bodies: unknown[] = [];
    const t = talk("text", {
      methods: handlers({
        send: (input) => {
          bodies.push(input.content.body);
          return { outcome: "submitted", because: null, messageId: "m-2" as never, channelId: "ch" as never };
        },
      }),
    });
    await t.attach();
    await t.say('{"kind":"call","id":2,"method":"send","input":{"target":{"contactId":"c"},"content":{"type":"t","body":{"__proto__":{"kept":1},"$bytes":"AQID","encoding":"base64","data":"AQID"}}}}');
    expect(bodies).toHaveLength(1);
    expect(Object.hasOwn(bodies[0] as object, "__proto__")).toBe(true);
    expect(bodies[0]).toEqual(JSON.parse('{"__proto__":{"kept":1},"$bytes":"AQID","encoding":"base64","data":"AQID"}'));
    expect(last(t)).toEqual({ kind: "result", id: 2, value: { outcome: "submitted", because: null, messageId: "m-2", channelId: "ch" } });
  });

  it("with an ID still in flight ends the session", async () => {
    let finish: (() => void) | null = null;
    const t = talk("clone", { methods: handlers({ lock: () => new Promise((resolve) => (finish = () => resolve(null))) }) });
    await t.attach();
    await t.call(2, "lock", {});
    expect(t.session.closed).toBe(false);
    await t.call(2, "lock", {});
    expect(t.session.closed).toBe(true);
    finish!();
  });

  it("may reuse an ID once its reply is queued", async () => {
    const t = talk("clone", { methods: handlers({ lock: () => null }) });
    await t.attach();
    await t.call(2, "lock", {});
    await t.call(2, "lock", {});
    expect(t.received().filter((f) => f?.kind === "result")).toHaveLength(3);
    expect(t.session.closed).toBe(false);
  });
});

describe("a text frame", () => {
  it("over the frame bound ends the session with a ResourceLimit fault, uncorrelated", async () => {
    const t = talk("text");
    await t.attach();
    await t.say(`{"kind":"call","id":2,"method":"unlock","input":{"passphrase":"${"p".repeat(limits.maxFrameBytes!)}"}}`);
    expect(last(t)).toEqual({ kind: "fault", error: { code: "ResourceLimit", message: expect.stringMatching(/4000/) as string, effect: "none", messageId: null } });
    expect(t.session.closed).toBe(true);
  });

  it("is measured in UTF-8 bytes, not string length", async () => {
    const t = talk("text");
    await t.attach();
    const units = limits.maxFrameBytes! - 100;
    await t.say(`{"kind":"call","id":2,"method":"unlock","input":{"passphrase":"${"€".repeat(units / 3)}"}}`);
    expect(t.session.closed).toBe(false);
    await t.say(`{"kind":"call","id":3,"method":"unlock","input":{"passphrase":"${"€".repeat(units)}"}}`);
    expect(t.session.closed).toBe(true);
  });

  it("that is not JSON, or is not a call, closes the port without a word", async () => {
    for (const bad of ["{", "[1]", '{"kind":"event","name":"log","value":{}}', new Uint8Array(3)]) {
      const t = talk("text");
      await t.attach();
      const before = t.received().length;
      await t.say(bad);
      expect(t.session.closed).toBe(true);
      expect(t.received()).toHaveLength(before);
    }
  });
});

describe("the send queue of a slow port", () => {
  const stateAt = (epoch: string, revision: number): State => ({ ...openState, epoch: epoch as never, revision });
  const line = (n: number) => ({ epoch: "epoch-1" as never, line: `log ${n}` });

  it("replaces an unsent state or lines with a newer value of the same epoch, and keeps an epoch transition; what the transport took stays", async () => {
    const t = talk("clone");
    await t.attach();
    const release = t.link.stall();
    t.session.event("state", stateAt("epoch-1", 4));
    t.session.event("lines", { ...linesState, revision: 2 });
    t.session.event("state", stateAt("epoch-1", 5));
    t.session.event("state", stateAt("epoch-2", 1));
    t.session.event("lines", { ...linesState, revision: 3 });
    t.session.event("state", stateAt("epoch-1", 6));
    t.session.event("state", stateAt("epoch-2", 2));
    release();
    await settle();
    const events = t.received().filter((f) => f?.kind === "event") as { name: string; value: State }[];
    expect(events.map((e) => [e.name, e.value.epoch, e.value.revision])).toEqual([
      ["state", "epoch-1", 4],
      ["lines", "epoch-1", 3],
      ["state", "epoch-1", 6],
      ["state", "epoch-2", 2],
    ]);
  });

  it("drops logs before anything else when the queue is full, and keeps replies", async () => {
    const t = talk("clone", { maxQueuedFrames: 3, methods: handlers({ lock: () => null }) });
    await t.attach();
    const release = t.link.stall();
    t.session.event("log", line(1));
    t.session.event("log", line(2));
    t.session.event("log", line(3));
    t.session.event("state", stateAt("epoch-1", 4));
    void t.link.left.send(writeFrame({ kind: "call", id: 2, method: "lock", input: {} }, "clone"));
    await settle();
    expect(t.session.closed).toBe(false);
    release();
    await settle();
    const kinds = t.received().slice(2).map((f) => (f?.kind === "event" ? `${f.kind}:${f.name}` : f?.kind));
    expect(kinds).toEqual(["event:log", "event:state", "result"]);
  });

  it("closes the port when what it owes no longer fits", async () => {
    const t = talk("clone", { maxQueuedFrames: 2, methods: handlers({ lock: () => null }) });
    await t.attach();
    let closed = 0;
    t.session.onClose(() => closed++);
    const release = t.link.stall();
    for (const id of [2, 3, 4, 5]) void t.link.left.send(writeFrame({ kind: "call", id, method: "lock", input: {} }, "clone"));
    await settle();
    expect(t.session.closed).toBe(true);
    expect(closed).toBe(1);
    release();
  });

  it("never lets a stalled port hold up another", async () => {
    const slow = talk("clone");
    const quick = talk("clone");
    await slow.attach();
    await quick.attach();
    slow.link.stall();
    slow.session.event("state", stateAt("epoch-1", 4));
    quick.session.event("state", stateAt("epoch-1", 4));
    await settle();
    expect(quick.received().filter((f) => f?.kind === "event")).toHaveLength(1);
    expect(slow.received().filter((f) => f?.kind === "event")).toHaveLength(0);
  });
});

describe("the end of a session", () => {
  it("sends a fault last and closes the port behind it; nothing follows", async () => {
    const t = talk("text", { methods: handlers({ lock: () => null }) });
    await t.attach();
    let closed = 0;
    t.session.onClose(() => closed++);
    const fault: ApiError = { code: "StateUnavailable", message: "the read failed", effect: "none", messageId: null };
    t.session.fault(fault);
    t.session.event("log", { epoch: "epoch-1" as never, line: "after the fault" });
    await settle();
    expect(last(t)).toEqual({ kind: "fault", error: fault });
    expect(t.session.closed).toBe(true);
    expect(closed).toBe(1);
    await t.call(2, "lock", {}).catch(() => {});
    expect(last(t)).toEqual({ kind: "fault", error: fault });
  });

  it("is a StateUnavailable fault when a publication of the daemon's own cannot be written", async () => {
    const t = talk("text");
    await t.attach();
    const open = openState.value as Extract<State["value"], { phase: "open" }>;
    t.session.event("state", { ...openState, value: { ...open, snapshot: { ...open.snapshot, label: NaN as never } } });
    await settle();
    expect(last(t)).toEqual({ kind: "fault", error: { code: "StateUnavailable", message: expect.any(String) as string, effect: "none", messageId: null } });
    expect(t.session.closed).toBe(true);
    expect(t.failures).toHaveLength(1);
  });

  it("answers a reply that cannot be written as OperationFailed and goes on", async () => {
    const t = talk("text", { methods: handlers({ traceLevel: () => ({ level: new Date(0) as never }) }) });
    await t.attach();
    await t.call(2, "traceLevel", {});
    expect(last(t)).toEqual({ kind: "error", id: 2, error: { code: "OperationFailed", message: expect.any(String) as string, effect: "possible", messageId: null } });
    expect(t.session.closed).toBe(false);
  });

  it("runs its close listeners once whether the daemon or the port closed it", async () => {
    const ours = talk("clone");
    let count = 0;
    ours.session.onClose(() => count++);
    ours.session.close();
    ours.session.close();
    expect(count).toBe(1);
    const theirs = talk("clone");
    theirs.session.onClose(() => count++);
    theirs.link.left.close();
    expect(theirs.session.closed).toBe(true);
    expect(count).toBe(2);
    theirs.session.onClose(() => count++);
    expect(count).toBe(3);
  });

  it("ignores a publication and a call after the port closed", async () => {
    const t = talk("clone", { methods: handlers({ lock: () => null }) });
    await t.attach();
    t.link.left.close();
    t.session.event("log", { epoch: "epoch-1" as never, line: "gone" });
    await t.say(writeFrame({ kind: "call", id: 2, method: "lock", input: {} }, "clone")).catch(() => {});
    expect(t.received()).toHaveLength(2);
  });
});
