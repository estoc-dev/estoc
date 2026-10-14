import { API_VERSION, WIRE_VERSION, schemas, type Baseline, type Bootstrap, type Limits, type LinesState, type State } from "../../src/contract/index.js";
import { ownFrame, readBootstrap, readFrame, Refusal, serveApi, writeBootstrap, writeFrame, type MethodHandlers, type Port, type RawFrame, type ServeOptions, type Session } from "../../src/wire/index.js";
import { as, linesState, openState } from "../contract/fixtures.js";
import { pair, settle, type Pair } from "../wire/ports.js";

export const limits: Limits = { maxFrameBytes: 4000, maxBackupBytes: 100 };
export const baseline: Baseline = { state: openState, lines: linesState };

export const at = (revision: number, epoch = "epoch-1"): State => ({ ...openState, epoch: as(epoch), revision });
export const linesAt = (revision: number, epoch = "epoch-1"): LinesState => ({ ...linesState, epoch: as(epoch), revision });

const notNow = new Refusal({ code: "WrongPhase", message: "not now", effect: "none" });

/** Every method refuses unless a test says otherwise. */
export const handlers = (overrides: Partial<MethodHandlers> = {}): MethodHandlers => {
  const table: Record<string, unknown> = {};
  for (const name of schemas.METHOD_NAMES) {
    if (name !== "attach")
      table[name] = () => {
        throw notNow;
      };
  }
  return { ...(table as MethodHandlers), ...overrides };
};

export interface Served {
  link: Pair;
  session: Session;
  /** the view's end */
  port: Port;
}

/** A real daemon side on the right end of a link; the left end is the view's. */
export function served(options: Partial<ServeOptions> = {}): Served {
  const link = pair();
  const session = serveApi(link.right, { methods: handlers(), limits, implementation: "test daemon", attach: () => baseline, ...options });
  return { link, session, port: link.left };
}

export interface Scripted {
  link: Pair;
  port: Port;
  /** what the view sent, read as frames or bootstrap records */
  received(): (RawFrame | Bootstrap | null)[];
  calls(): Extract<RawFrame, { kind: "call" }>[];
  say(data: Uint8Array): Promise<void>;
  frame(frame: RawFrame, bytesAt?: readonly string[]): Promise<void>;
  welcome(own?: Partial<Limits>): Promise<void>;
  /** answers the attachment, whose call ID is 1 */
  attach(value?: unknown): Promise<void>;
  /** welcome and baseline: what a view needs to be connected */
  greet(): Promise<void>;
  close(): void;
  /** whether the view's end closed the link */
  closed(): boolean;
}

/** A daemon side the test speaks for, frame by frame, on the right end of a link. */
export function scripted(): Scripted {
  const link = pair();
  let closed = false;
  link.right.listen({
    message() {},
    close() {
      closed = true;
    },
  });
  const s: Scripted = {
    link,
    port: link.left,
    received: () => link.toRight.map((data) => readFrame(data) ?? readBootstrap(data)),
    calls: () => s.received().filter((frame): frame is Extract<RawFrame, { kind: "call" }> => frame?.kind === "call"),
    say: async (data) => {
      if (!closed) await link.right.send(data);
      await settle();
    },
    frame: (frame, bytesAt) => s.say(writeFrame(ownFrame(frame, bytesAt))),
    welcome: (own = {}) => s.say(writeBootstrap({ kind: "welcome", wire: WIRE_VERSION, api: API_VERSION, implementation: "scripted", limits: { ...limits, ...own } })),
    attach: (value = baseline) => s.frame({ kind: "result", id: 1, value }),
    greet: async () => {
      await s.welcome();
      await s.attach();
    },
    close: () => link.right.close(),
    closed: () => closed,
  };
  return s;
}
