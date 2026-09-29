// Installs the packed package into an empty project outside the workspace,
// compiles and runs a view against its declarations, and asserts that no
// runtime package of the daemon side came along. Run from the package:
//   pnpm consumer-check
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = ["@estoc/daemon", "@estoc/agent-core", "@estoc/vault", "@estoc/event-store", "@estoc/keystore", "@estoc/didcomm", "@estoc/didcomm-node", "@estoc/did-peer", "@estoc/continuity", "@estoc/dasl", "ws", "undici"];

const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const work = mkdtempSync(path.join(tmpdir(), "daemon-api-consumer-"));
try {
  run("pnpm", ["pack", "--pack-destination", work], packageRoot);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("pnpm pack produced no tarball");

  const consumer = path.join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "daemon-api-consumer", private: true, type: "module", dependencies: { "@estoc/daemon-api": `file:../${tarball}` }, devDependencies: { typescript: "~5.8.0" } }, null, 2)
  );
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], types: [], strict: true, noEmit: false, outDir: "out", verbatimModuleSyntax: true, skipLibCheck: true }, include: ["view.ts"] }, null, 2)
  );
  writeFileSync(
    path.join(consumer, "view.ts"),
    `import { connect, isCallError, type Client } from "@estoc/daemon-api/client";
import { API_VERSION, WIRE_VERSION, schemas, type Hello, type MethodName, type State } from "@estoc/daemon-api/contract";
import { indexSnapshot, invitationUrl, parseInvitation, successorOf, trailOf, type ConversationView } from "@estoc/daemon-api/views";
import { readFrame, readPayload, writeFrame, type Port, type PortHandlers } from "@estoc/daemon-api/wire";

// The view is compiled with no Node or DOM library, so that the package's own declarations are shown to need neither.
declare const console: { log(message: string): void };

const hello: Hello = { kind: "hello", wire: WIRE_VERSION, apis: [API_VERSION] };
const names: MethodName[] = [...schemas.METHOD_NAMES];
const state: State = schemas.state.parse({ epoch: "e", revision: 1, value: { phase: "onboarding", hold: null, detail: null } });
if (state.value.phase !== "onboarding" || !names.includes("attach") || schemas.hello.parse(hello).apis[0] !== 1) throw new Error("the contract did not behave");
const text = writeFrame({ kind: "call", id: 1, method: "restoreIdentity", input: { backup: new Uint8Array([1, 2, 3]), passphrase: "p" } }, "text", schemas.methods.restoreIdentity.bytes.input);
const frame = readFrame(text, "text");
const read = frame?.kind === "call" ? readPayload(frame.input, "text", { bytesAt: schemas.methods.restoreIdentity.bytes.input, maxBytes: 3 }) : null;
if (typeof text !== "string" || read === null || !read.ok || !schemas.methods.restoreIdentity.input.safeParse(read.value).success) throw new Error("the wire did not behave");
const opened: State = schemas.state.parse({ epoch: "e", revision: 2, value: { phase: "open", hold: "h", snapshot: { anchor: "did:key:z6Mk", label: "v", restoreUnexplained: false, mediations: [], dids: [], contacts: [], channels: [], messages: [], observations: [], conversations: [], invitations: [], pending: { pendingOutbounds: [], missingResponses: [], missingNotifications: [], notificationConflicts: [], pendingProofs: [] }, unplaced: { observationIds: [], outputs: [] } } } });
const shown: ConversationView[] = opened.value.phase === "open" ? indexSnapshot(opened.value.snapshot).conversations : [];
const invitation = parseInvitation(invitationUrl("https://estoc.example/", { type: "https://didcomm.org/out-of-band/2.0/invitation", id: "oob", typ: "application/didcomm-plain+json", from: "did:peer:4zQm", body: {} }));
if (shown.length !== 0 || invitation.from !== "did:peer:4zQm" || (opened.value.phase === "open" && (trailOf(opened.value.snapshot, schemas.conversationId.parse("contact:none")) !== null || successorOf({ anchor: opened.value.snapshot.anchor, id: schemas.conversationId.parse("contact:none"), channels: [] }, opened.value.snapshot) !== null))) throw new Error("the views did not behave");
let handlers: PortHandlers | null = null;
const port: Port = {
  transport: "clone",
  async send(data) {
    if ((data as Hello).kind === "hello") handlers?.message({ kind: "incompatible", wire: WIRE_VERSION, supported: [API_VERSION + 1], message: "a daemon from the future" });
  },
  listen: (installed) => (handlers = installed),
  close() {},
};
const client: Client = connect(port);
const failure: unknown = await client.connected().catch((error: unknown) => error);
if (client.connection.state !== "incompatible" || !isCallError(failure) || failure.code !== "Incompatible" || failure.origin !== "client") throw new Error("the client did not behave");
console.log(\`ok: api \${API_VERSION}, \${names.length} methods, a backup of \${read.size} logical bytes, an invitation from \${invitation.from}, a client that stops at \${client.connection.message}\`);
`
  );
  run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile", "--reporter=silent"], consumer);
  run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], consumer);
  const output = run("node", ["out/view.js"], consumer).trim();
  if (!output.startsWith("ok:")) throw new Error(`the view did not run: ${output}`);

  const installed = new Set();
  const modules = path.join(consumer, "node_modules");
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith("@")) for (const scoped of readdirSync(path.join(modules, entry))) installed.add(`${entry}/${scoped}`);
    else if (entry !== ".pnpm" && entry !== ".bin" && !entry.startsWith(".")) installed.add(entry);
  }
  const store = path.join(modules, ".pnpm");
  if (existsSync(store)) for (const entry of readdirSync(store)) if (entry.includes("@") && !entry.startsWith(".")) installed.add(entry.replace(/@[^@]*$/, "").replace("+", "/"));
  const leaked = FORBIDDEN.filter((name) => installed.has(name));
  if (leaked.length > 0) throw new Error(`the consumer installed daemon-side packages: ${leaked.join(", ")}`);
  console.log(`${output}; installed: ${[...installed].filter((name) => name !== "@estoc/daemon-api" && name !== "typescript").sort().join(", ") || "nothing else"}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
