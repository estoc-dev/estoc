// Packs the daemon and every workspace library under it as they would be
// published, installs the tarballs into an empty project outside the
// workspace, and runs a daemon over the API there: a vault made through
// agent-core and one restored by the daemon itself both publish a commit,
// the packed ranges accept the packed siblings, and one copy of the event
// store serves both paths. Run from the root, after `pnpm build`:
//   pnpm release-check
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const manifestOf = (dir) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));

/** The workspace packages `@estoc/daemon` is published with: itself and every `workspace:` dependency under it, by directory. */
function released() {
  const byName = new Map(readdirSync(packagesDir).map((dir) => [manifestOf(path.join(packagesDir, dir)).name, dir]));
  const dirs = new Map();
  const visit = (name) => {
    if (dirs.has(name)) return;
    const dir = byName.get(name);
    if (dir === undefined) throw new Error(`${name} is no package of the workspace`);
    dirs.set(name, dir);
    for (const [dependency, range] of Object.entries(manifestOf(path.join(packagesDir, dir)).dependencies ?? {})) if (range.startsWith("workspace:")) visit(dependency);
  };
  visit("@estoc/daemon");
  return dirs;
}

/** Whether `^range` admits `version`: the same major, or the same minor while the major is 0, at or past the range's start. */
function caretAdmits(range, version) {
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (caret === null) return false;
  const [floor, given] = [caret.slice(1).map(Number), version.split(".").map(Number)];
  const sameLine = floor[0] === 0 ? given[0] === 0 && given[1] === floor[1] : given[0] === floor[0];
  const atOrPast = given[0] !== floor[0] ? given[0] > floor[0] : given[1] !== floor[1] ? given[1] > floor[1] : given[2] >= floor[2];
  return sameLine && atOrPast;
}

const work = mkdtempSync(path.join(tmpdir(), "estoc-release-"));
try {
  const packed = new Map();
  for (const [name, dir] of released()) {
    const before = new Set(readdirSync(work));
    run("pnpm", ["pack", "--pack-destination", work], path.join(packagesDir, dir));
    const tarball = readdirSync(work).find((entry) => entry.endsWith(".tgz") && !before.has(entry));
    if (tarball === undefined) throw new Error(`pnpm pack of ${name} produced no tarball`);
    const manifest = JSON.parse(run("tar", ["-xOf", path.join(work, tarball), "package/package.json"], work));
    packed.set(name, { tarball, version: manifest.version, dependencies: manifest.dependencies ?? {} });
  }

  // As published, each package's range must admit the sibling published beside it: a consumer with the set installs one version of each.
  for (const [name, { dependencies }] of packed) {
    for (const [dependency, range] of Object.entries(dependencies)) {
      const sibling = packed.get(dependency);
      if (sibling === undefined) continue;
      if (range.startsWith("workspace:")) throw new Error(`${name} was packed with ${dependency} still at ${range}`);
      if (!caretAdmits(range, sibling.version)) throw new Error(`${name} asks for ${dependency} ${range}, which does not admit the ${sibling.version} packed beside it`);
    }
  }

  const consumer = path.join(work, "consumer");
  mkdirSync(consumer);
  const local = Object.fromEntries([...packed].map(([name, { tarball }]) => [name, `file:../${tarball}`]));
  // The overrides point every range at the tarball packed beside it; pnpm 9 reads them from package.json, pnpm 10 from the workspace file.
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "estoc-release-consumer", private: true, type: "module", dependencies: { "@estoc/daemon": local["@estoc/daemon"], "@estoc/daemon-api": local["@estoc/daemon-api"] }, pnpm: { overrides: local } }, null, 2)
  );
  writeFileSync(path.join(consumer, "pnpm-workspace.yaml"), `packages: []\noverrides:\n${Object.entries(local).map(([name, spec]) => `  "${name}": "${spec}"\n`).join("")}`);
  writeFileSync(
    path.join(consumer, "check.mjs"),
    `import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nodeHost, serveDaemon } from "@estoc/daemon/node";
import { connect } from "@estoc/daemon-api/client";
import { webSocketOf } from "@estoc/daemon-api/wire";

const PASSPHRASE = "release-check";
const shortForm = (name) => \`did:peer:4zQm\${name.padEnd(44, "1")}\`;

async function daemonInFolder() {
  const served = await serveDaemon({ host: nodeHost(mkdtempSync(path.join(tmpdir(), "estoc-vault-"))), port: 0, token: "t" });
  await served.daemon.boot();
  const client = connect(webSocketOf(new WebSocket(served.url)));
  await client.connected();
  return { served, client };
}

/** A contact committed over the API is in the state published afterwards only if the event store said it changed. */
async function commitShown(client, petname) {
  const { channelId } = await client.daemon.resolveChannel({ localDid: shortForm("Anna"), peerDid: shortForm(petname) });
  await client.daemon.createContact({ petname, channelIds: [channelId] });
  await client.refresh();
  const { value } = client.state;
  const shown = value.phase === "open" && value.snapshot.conversations.some((conversation) => conversation.petname === petname);
  if (!shown) throw new Error(\`the commit of \${petname} was not published: the state is \${value.phase}, and the event store did not say it changed\`);
}

const made = await daemonInFolder();
const restored = await daemonInFolder();
try {
  await made.client.daemon.createIdentity({ name: "Release", passphrase: PASSPHRASE });
  await commitShown(made.client, "Bob");
  const { bytes } = await made.client.daemon.exportBackup({});
  await restored.client.daemon.restoreIdentity({ backup: bytes, passphrase: PASSPHRASE });
  await commitShown(restored.client, "Carmen");
  console.log(\`ok: a vault made through agent-core and one restored by the daemon both publish their commits, over \${made.client.connection.implementation}\`);
} finally {
  made.client.close();
  restored.client.close();
  await made.served.close();
  await restored.served.close();
}
`
  );
  run("pnpm", ["install", "--no-frozen-lockfile", "--reporter=silent"], consumer);
  const output = run("node", ["check.mjs"], consumer).trim();
  if (!output.startsWith("ok:")) throw new Error(`the daemon did not run: ${output}`);

  // Both paths to the runtime must resolve one event store, or a commit through the other copy would say nothing.
  const store = path.join(consumer, "node_modules", ".pnpm");
  const installed = (name) => readdirSync(store).filter((entry) => entry.startsWith(`${name.replace("/", "+")}@`));
  const resolvedFrom = (name) => {
    const [only, ...more] = installed(name);
    if (only === undefined || more.length > 0) throw new Error(`${name} was installed ${more.length + (only === undefined ? 0 : 1)} times`);
    const dir = path.join(store, only, "node_modules", name);
    writeFileSync(path.join(dir, "estoc-release-probe.mjs"), 'console.log(import.meta.resolve("@estoc/event-store"));\n');
    return realpathSync(fileURLToPath(run("node", ["estoc-release-probe.mjs"], dir).trim()));
  };
  const [fromAgentCore, fromDaemon] = [resolvedFrom("@estoc/agent-core"), resolvedFrom("@estoc/daemon")];
  if (fromAgentCore !== fromDaemon) throw new Error(`two event stores were installed: agent-core resolves ${fromAgentCore}, the daemon ${fromDaemon}`);
  const copies = installed("@estoc/event-store");
  if (copies.length !== 1) throw new Error(`${copies.length} copies of @estoc/event-store were installed: ${copies.join(", ")}`);
  console.log(`${output}; ${[...packed].map(([name, { version }]) => `${name}@${version}`).join(", ")}; one event store at ${path.relative(consumer, fromDaemon)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
