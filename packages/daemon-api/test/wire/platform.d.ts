// The platform tests run on Node and reach for what it provides beyond
// the language: declared here in the shape the tests use, as the wire's
// own globals are, since the package is compiled against no platform
// library.
interface PlatformMessagePort {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  addEventListener(type: "message" | "messageerror" | "close", listener: (event: { data?: unknown }) => void): void;
  start(): void;
  close(): void;
}

declare class MessageChannel {
  readonly port1: PlatformMessagePort;
  readonly port2: PlatformMessagePort;
}

/** Node's own WebSocket, as a browser has it. */
declare class WebSocket {
  constructor(url: string);
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number }) => void): void;
}

declare module "ws" {
  export class WebSocket {
    static readonly OPEN: number;
    constructor(address: string);
    readonly readyState: number;
    readonly bufferedAmount: number;
    binaryType: string;
    send(data: Uint8Array): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    /** stops reading from the network, so that what the other side sends piles up */
    pause(): void;
    resume(): void;
    addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { host: string; port: number; maxPayload?: number });
    address(): { port: number };
    on(event: "listening", listener: () => void): this;
    on(event: "connection", listener: (socket: WebSocket) => void): this;
    close(callback?: () => void): void;
  }
}
