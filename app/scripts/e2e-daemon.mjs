/**
 * The app on a Node daemon: `estoc serve` runs the daemon on a temp folder
 * and serves the app (@estoc/app) for it; Alice's page is opened at that origin and talks to the
 * process over its own socket; Bob is an ordinary in-browser install at
 * the preview. The preview opened with the `?_daemon=` link the daemon also
 * prints reaches the same vault. They meet over an invitation link and
 * exchange messages both ways (records cross the socket), Alice's history
 * survives a reload and a second tab (both are the same daemon, so neither
 * yields), the vault is a file on disk that `estoc status` asks the daemon
 * about while it runs, and lock asks for the passphrase.
 *
 *   npm run preview                      # the build on :4173
 *   node scripts/e2e-daemon.mjs [app-url]   (default http://localhost:4173)
 *
 * The mediator is mediator.estoc.dev: the daemon `estoc serve` runs reaches
 * public addresses only, so a mediator on this machine is not one it can use.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const APP_URL = process.argv[2] ?? "http://localhost:4173";
const MEDIATOR_LABEL = "mediator.estoc.dev";
const executablePath = "/usr/bin/chromium";
const PASS = { Alice: "alice-passes-the-salt", Bob: "bob-builds-boats-2026" };
const BIN = fileURLToPath(new URL("../../packages/cli/dist/bin.js", import.meta.url));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}
function ok(message) {
  console.log(`✓ ${message}`);
}
function watch(page, name) {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error(`[${name} console] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.error(`[${name} pageerror] ${err}`));
}

const waitLive = (page) => page.waitForSelector('[data-status]:has-text("live"), [data-status-sentence]:has-text("live delivery on")', { timeout: 30000 });

async function createIdentity(page, name, startUrl) {
  await page.goto(startUrl);
  await page.fill("[data-your-name]", name);
  await page.fill("[data-passphrase]", PASS[name]);
  await page.fill("[data-passphrase-again]", PASS[name]);
  await page.click("[data-create]");
  await mediate(page, name);
}

/** A vault `estoc init` made: the page finds it locked and unlocks it. */
async function unlockIdentity(page, name, startUrl) {
  await page.goto(startUrl);
  await page.waitForSelector("[data-locked] [data-passphrase]", { timeout: 15000 });
  await page.fill("[data-locked] [data-passphrase]", PASS[name]);
  await page.click("[data-unlock]");
  await mediate(page, name);
}

/** Name the mediator on the You screen, and stay there. */
async function mediate(page, name) {
  await page.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  await page.click("[data-you]");
  await page.selectOption("[data-you-screen] [data-mediator-choice]", { label: MEDIATOR_LABEL });
  await page.click("[data-you-screen] [data-mediator-use]");
  await waitLive(page);
  ok(`${name} mediated: live delivery on`);
}

const leaveYou = (page) => page.click("[data-you-screen] [data-back]");

async function invite(page) {
  await page.click("[data-new-conversation]");
  await page.click("[data-new-sheet] [data-show-qr]");
  await page.waitForSelector("[data-invitation-url]", { timeout: 20000 });
  const url = await page.getAttribute("[data-invitation-url]", "title");
  await page.click("[data-new-sheet] [data-done]");
  await page.click("[data-new-sheet] [data-cancel]");
  return url;
}

async function acceptLink(page, name, link) {
  await page.click("[data-new-conversation]");
  await page.click("[data-new-sheet] [data-paste-link]");
  await page.fill("[data-contact-name]", name);
  await page.fill("[data-invitation-link]", link);
  await page.click("[data-accept]");
  await page.waitForSelector(`[data-chat] [data-name]:has-text("${name}")`, { timeout: 30000 });
}

const row = (name) => `.convo-row:has(.convo-name:has-text("${name}"))`;
const namelessRow = (name) => `.convo-row.nameless:has(.convo-name:has-text("${name}"))`;
const channelsShown = (page, count) => page.waitForSelector(`[data-chat][data-channels="${count}"]`, { timeout: 45000 });

async function send(page, text) {
  await page.fill("[data-composer]", text);
  await page.click("[data-send]");
}
async function expectBubble(page, text, timeout = 30000) {
  await page.waitForSelector(`.bubble:has-text("${text}")`, { timeout });
}

/** Start `estoc serve` on `root`; resolves to the links it prints: its own app, and the preview with `?_daemon=`. */
function startDaemon(root) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0", "--app", APP_URL], {
    cwd: root,
    stdio: ["ignore", "inherit", "pipe"],
  });
  const link = new Promise((resolve, reject) => {
    let out = "";
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
      const m = out.match(/^open:\s+(\S+)\nor:\s+(\S+)$/m);
      if (m) {
        resolve({ own: m[1], elsewhere: m[2] });
      }
      process.stderr.write(chunk.toString().replace(/^/gm, "[daemon] "));
    });
    child.once("exit", (code) => reject(new Error(`estoc serve exited with ${code}\n${out}`)));
  });
  return { child, link };
}

const root = await mkdtemp(join(tmpdir(), "estoc-e2e-daemon-"));
execFileSync(process.execPath, [BIN, "init", "--label", "Alice"], {
  cwd: root,
  env: { ...process.env, ESTOC_PASSPHRASE: PASS.Alice },
  stdio: "inherit",
});
const daemon = startDaemon(root);
const browser = await chromium.launch({ executablePath });
try {
  const link = await daemon.link;
  ok(`estoc serve up on ${root}, serving the app at ${link.own}`);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  watch(alice, "alice");
  watch(bob, "bob");

  await unlockIdentity(alice, "Alice", link.own);
  await alice.waitForSelector("text=via estoc-daemon at", { timeout: 5000 });
  // the link carried the token; the page took it off the URL and kept it
  if (new URL(alice.url()).origin !== new URL(link.own).origin || alice.url().includes("token=")) {
    fail(`Alice should be at the daemon's own origin with the token taken off the URL, not ${alice.url()}`);
  }
  await stat(join(root, ".estoc", "vault.sqlite"));
  ok("Alice's vault is the file estoc init made, unlocked in the daemon; the You screen says so");
  await leaveYou(alice);
  const status = execFileSync(process.execPath, [BIN, "status"], { cwd: root, encoding: "utf8" });
  if (!/^daemon\s+ws:\S+\s+open$/m.test(status) || !/^label\s+Alice$/m.test(status) || !/^anchor\s+did:key:/m.test(status) || status.includes("token=")) {
    fail(`estoc status should ask the daemon that holds the vault, and keep the token to itself:\n${status}`);
  }
  ok("estoc status, refused the folder, asked the daemon at its socket");
  await createIdentity(bob, "Bob", APP_URL);
  await leaveYou(bob);

  // Bob hands Alice a link; she pastes it into the page the daemon serves.
  const bobLink = await invite(bob);
  await acceptLink(alice, "Bob", bobLink);
  await bob.waitForSelector(namelessRow("Alice"), { timeout: 45000 });
  await bob.click(namelessRow("Alice"));
  await bob.click("[data-chat] [data-details]");
  await bob.fill("[data-details-screen] [data-petname]", "Alice");
  await bob.click("[data-details-screen] [data-rename]");
  await bob.waitForSelector(`${row("Alice")}:not(.nameless)`, { timeout: 15000 });
  await bob.click("[data-details-screen] [data-back]");
  ok("the daemon accepted Bob's invitation; Bob named who arrived");

  // Bob answers from a private address that replaces the disclosed one; she writes once that reached her page.
  await channelsShown(alice, 2);
  await send(alice, "hello bob, from a laptop process");
  await expectBubble(alice, "hello bob");
  await expectBubble(bob, "hello bob");
  ok("Bob received a message the daemon sent");
  await send(bob, "hi alice, got it");
  await expectBubble(alice, "hi alice");
  ok("Alice's page shows what the daemon received, live over the socket");

  // history is the daemon's: a reload and a second tab both see it, neither yields
  await alice.reload();
  await alice.waitForSelector(row("Bob"), { timeout: 15000 });
  await alice.click(row("Bob"));
  await expectBubble(alice, "hi alice");
  ok("Alice's history is there after a reload");
  const tab2 = await aliceCtx.newPage();
  // the bare origin, no token in the link: the page remembers it
  await tab2.goto(new URL(link.own).origin + "/");
  await tab2.waitForSelector(row("Bob"), { timeout: 15000 });
  await send(bob, "second tab too?");
  await tab2.click(row("Bob"));
  await expectBubble(tab2, "second tab too?");
  await expectBubble(alice, "second tab too?");
  ok("a second tab is another client of the same daemon: both open, both live");
  await tab2.close();
  // a browser that never had the link has no token: told so, not left blank
  const strangerCtx = await browser.newContext();
  const stranger = await strangerCtx.newPage();
  await stranger.goto(new URL(link.own).origin + "/");
  await stranger.waitForSelector("text=No daemon is answering", { timeout: 10000 });
  await strangerCtx.close();
  ok("a page without the token is told to open the daemon's link");

  // the preview at another origin, pointed here with the token link: same daemon, same vault
  const elsewhere = await aliceCtx.newPage();
  watch(elsewhere, "alice@preview");
  await elsewhere.goto(link.elsewhere);
  await elsewhere.waitForSelector(row("Bob"), { timeout: 15000 });
  if (elsewhere.url().includes("_daemon=")) {
    fail("the _daemon parameter should be taken off the URL");
  }
  await elsewhere.click("[data-you]");
  await elsewhere.waitForSelector("text=via estoc-daemon at", { timeout: 5000 });
  ok("the preview opened with ?_daemon= is a client of the same daemon (the link remembered, taken off the URL)");
  await elsewhere.close();

  // lock: the seed leaves the daemon's memory; the passphrase opens it again
  await alice.click("[data-you]");
  await alice.click("[data-lock]");
  await alice.waitForSelector("[data-locked] [data-passphrase]", { timeout: 5000 });
  await alice.fill("[data-locked] [data-passphrase]", "wrong one");
  await alice.click("[data-unlock]");
  await alice.waitForSelector("text=wrong passphrase", { timeout: 5000 });
  await alice.fill("[data-locked] [data-passphrase]", PASS.Alice);
  await alice.click("[data-unlock]");
  await alice.waitForSelector(row("Bob"), { timeout: 15000 });
  ok("lock and unlock go through the daemon");

  // a removal confirmed after the vault changed hands: while Alice's tab holds the
  // question open, another tab removes the vault and makes a new one there
  await alice.click("[data-you]");
  const held = new Promise((resolve) => alice.once("dialog", resolve));
  const confirming = alice.click("[data-forget]", { noWaitAfter: true });
  const dialog = await held;
  const other = await aliceCtx.newPage();
  watch(other, "alice@other");
  other.on("dialog", (d) => void d.accept());
  await other.goto(new URL(link.own).origin + "/");
  await other.waitForSelector(row("Bob"), { timeout: 15000 });
  await other.click("[data-you]");
  await other.click("[data-forget]");
  await other.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await other.fill("[data-your-name]", "Alice");
  await other.fill("[data-passphrase]", PASS.Alice);
  await other.fill("[data-passphrase-again]", PASS.Alice);
  await other.click("[data-create]");
  await other.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  await dialog.accept();
  await confirming;
  await alice.waitForSelector("[data-removal-failed]", { timeout: 15000 });
  if (await alice.$("[data-you-screen]")) {
    fail("the refusal should show where Alice is now, which is no longer the You screen");
  }
  await other.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 5000 });
  await alice.click("[data-removal-failed] button");
  await alice.waitForSelector("[data-removal-failed]", { state: "detached", timeout: 5000 });
  ok("a removal confirmed after the vault changed hands removed nothing, and said so on the screen Alice was on");
  await other.close();

  // the daemon gone: the page says so
  daemon.child.kill("SIGTERM");
  await alice.waitForSelector('[data-status]:has-text("daemon away")', { timeout: 10000 });
  ok("Alice's page reports the daemon gone");
  await alice.goto(`${APP_URL}/?_daemon=off`);
  await alice.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  ok("?_daemon=off returns the preview to its own worker: a fresh install there");
} finally {
  await browser.close();
  daemon.child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}
if (process.exitCode) {
  console.error("some checks failed");
} else {
  console.log("all green");
}
