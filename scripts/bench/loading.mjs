// What the benchmark needs of the module loader, installed before anything
// of the workspace is imported. The test doubles it borrows are TypeScript
// that imports the sources under `src/`: they are compiled as they load, and
// what they import of `src/` is taken from the built `dist/` instead, so that
// they meet the same modules the daemon runs on. Their syntax is more than
// Node strips on its own, so the workspace's TypeScript compiles them. The
// functions named in
// `TIMED` are wrapped as their module loads, which counts and times them with
// no counter in the code that ships.
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages");
const CALLS = Symbol.for("estoc.bench.calls");
const ts = createRequire(path.join(packages, "daemon/package.json"))("typescript");
const compiled = (file) => ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true } }).outputText;

const TIMED = {
  "vault/dist/fold/vault.js": ["scanVault", "checkVault", "foldVault"],
  "vault/dist/fold/evidence.js": ["verifyResolutions"],
  "vault/dist/fold/channels.js": ["verifyProofs"],
  "vault/dist/fold/routes.js": ["verifyDidKeys"],
  "vault/dist/fold/mediation.js": ["verifyMediationKeys"],
  "daemon/dist/projection.js": ["project"],
};

/** Every call counted and timed by name, from the call to its return or, for a promise, to its settling. */
export const calls = (globalThis[CALLS] = {
  counts: {},
  ms: {},
  timed(name, run) {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    const began = performance.now();
    const ended = () => {
      this.ms[name] = (this.ms[name] ?? 0) + performance.now() - began;
    };
    let result;
    try {
      result = run();
    } catch (error) {
      ended();
      throw error;
    }
    if (typeof result?.then !== "function") {
      ended();
      return result;
    }
    return result.finally(ended);
  },
  reset() {
    this.counts = {};
    this.ms = {};
  },
});

function timed(source, names, file) {
  for (const name of names) {
    const declared = new RegExp(`^export (async )?function ${name}\\(`, "m");
    if (!declared.test(source)) throw new Error(`${file} declares no function ${name} to time`);
    source = `${source.replace(declared, `$1function ${name}Untimed(`)}\nexport function ${name}(...args) {\n  return globalThis[Symbol.for("estoc.bench.calls")].timed(${JSON.stringify(name)}, () => ${name}Untimed(...args));\n}\n`;
  }
  return source;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const from = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
    if (from !== null && from.startsWith(packages) && from.endsWith(".ts") && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const target = path.resolve(path.dirname(from), specifier);
      const [, name, rest] = /^([^/]+)\/src\/(.+)$/.exec(path.relative(packages, target)) ?? [];
      if (name !== undefined) return nextResolve(pathToFileURL(path.join(packages, name, "dist", rest)).href, context);
      const typescript = target.replace(/\.js$/, ".ts");
      if (!existsSync(target) && existsSync(typescript)) return { url: pathToFileURL(typescript).href, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context);
    const file = fileURLToPath(url);
    if (!file.startsWith(packages)) return nextLoad(url, context);
    if (file.endsWith(".ts")) return { format: "module", source: compiled(file), shortCircuit: true };
    const names = TIMED[path.relative(packages, file)];
    if (names === undefined) return nextLoad(url, context);
    return { format: "module", source: timed(readFileSync(file, "utf8"), names, file), shortCircuit: true };
  },
});
