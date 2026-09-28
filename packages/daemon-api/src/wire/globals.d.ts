// The wire runs in a browser, a worker or Node, and is compiled against
// the library of none of them: what it takes from the platform is declared
// here, in the shape every one of them provides.
declare function setTimeout(callback: () => void, delay: number): unknown;
declare function clearTimeout(timer: unknown): void;
declare function atob(data: string): string;
declare function btoa(data: string): string;
