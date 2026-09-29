// The wire and the views run in a browser, a worker or Node, and are
// compiled against the library of none of them: what they take from the
// platform is declared here, in the shape every one of them provides.
declare function setTimeout(callback: () => void, delay: number): unknown;
declare function clearTimeout(timer: unknown): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare class TextEncoder {
  encode(source: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(bytes: Uint8Array): string;
}
declare class URLSearchParams {
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
}
declare class URL {
  constructor(url: string, base?: string);
  readonly host: string;
  readonly origin: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  toString(): string;
}
declare function queueMicrotask(callback: () => void): void;
