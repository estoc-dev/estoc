/**
 * The app on a Node daemon: `estoc serve` runs the daemon on a temp folder
 * and serves the app (@estoc/app) for it; Alice's page is opened at that origin and talks to the
 * process over its own socket; Bob is an ordinary in-browser install at
 * the preview. The preview opened with the `?_daemon=` link the daemon also
 * prints reaches the same vault. They meet over an invitation link and
 * exchange messages both ways (records cross the socket), Alice's history
 * survives a reload and a second tab (both are the same daemon, so neither
 * yields), the vault is a file on disk that `estoc status` asks the daemon
 * about while it runs, and lock asks for the passphrase. A refusal is shown
 * where it was asked, an answer lost with the socket is shown as a doubt over
 * whatever screen is there by then, and a page cut off while the vault was
 * replaced shows nothing of the old vault when it comes back.
 *
 *   npm run preview                      # the build on :4173
 *   node scripts/e2e-daemon.mjs [app-url]   (default http://localhost:4173)
 *
 * The mediator is mediator.estoc.dev: the daemon `estoc serve` runs reaches
 * public addresses only, so a mediator on this machine is not one it can use.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

/** Wait until `condition` holds, for at most `timeout` ms; `what` names it when the wait is given up. */
async function until(page, condition, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${typeof what === "function" ? what() : what}`);
    await page.waitForTimeout(50);
  }
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
      process.stderr.write(chunk.toString().replace(/^(?=.)/gm, "[daemon] "));
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
  await alice.waitForSelector("[data-unconfirmed]", { timeout: 15000 });
  if (await alice.$("[data-you-screen]")) {
    fail("the refusal should show where Alice is now, which is no longer the You screen");
  }
  await other.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 5000 });
  await alice.click("[data-unconfirmed] button");
  await alice.waitForSelector("[data-unconfirmed]", { state: "detached", timeout: 5000 });
  ok("a removal confirmed after the vault changed hands removed nothing, and said so on the screen Alice was on");
  await other.close();

  // a removal that went through but whose answer was lost: the socket drops
  // after the daemon removed the vault and before its reply reached the page.
  // The page cannot tell this from a refusal, so it must not claim the vault
  // is still there.
  const lost = await aliceCtx.newPage();
  watch(lost, "alice@lost");
  lost.on("dialog", (d) => void d.accept());
  let removing = null;
  await lost.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const wire = typeof message === "string" ? JSON.parse(message) : null;
      if (wire?.kind === "call" && wire.method === "forgetIdentity") removing = wire.id;
      server.send(message);
    });
    server.onMessage((message) => {
      const wire = typeof message === "string" ? JSON.parse(message) : null;
      if (removing !== null && wire?.id === removing && (wire.kind === "result" || wire.kind === "error")) {
        removing = null;
        ws.close();
        return;
      }
      ws.send(message);
    });
  });
  await lost.goto(new URL(link.own).origin + "/");
  await lost.waitForSelector("[data-you]", { timeout: 15000 });
  await lost.click("[data-you]");
  await lost.click("[data-forget]");
  await lost.waitForSelector("[data-unconfirmed]", { timeout: 15000 });
  const said = await lost.textContent("[data-unconfirmed]");
  if (!/not confirmed/.test(said) || /nothing was removed/i.test(said)) {
    fail(`with the answer lost, the page must not say what became of the vault: "${said}"`);
  }
  await stat(join(root, ".estoc", "vault.sqlite")).then(
    () => fail("the daemon should have removed the vault before its answer was lost"),
    () => {},
  );
  await lost.close();
  ok("a removal whose answer was lost is reported as unconfirmed, not as undone");
  // the other tab heard the daemon: the vault is gone, and a new one can be made
  await alice.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await alice.fill("[data-your-name]", "Alice");
  await alice.fill("[data-passphrase]", PASS.Alice);
  await alice.fill("[data-passphrase-again]", PASS.Alice);
  await alice.click("[data-create]");
  await alice.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });

  const wireOf = (message) => (typeof message === "string" ? JSON.parse(message) : null);

  // a refusal the daemon answers with is shown where it was asked: the export's, under its button
  const refused = await aliceCtx.newPage();
  watch(refused, "alice@refused");
  let exporting = null;
  await refused.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const wire = wireOf(message);
      if (wire?.kind === "call" && wire.method === "exportBackup") exporting = wire.id;
      server.send(message);
    });
    server.onMessage((message) => {
      const wire = wireOf(message);
      if (exporting !== null && wire?.id === exporting && wire.kind === "result") {
        exporting = null;
        ws.send(JSON.stringify({ kind: "error", id: wire.id, error: { code: "ResourceLimit", message: "the backup is larger than this daemon hands out", effect: "none", messageId: null } }));
        return;
      }
      ws.send(message);
    });
  });
  await refused.goto(new URL(link.own).origin + "/");
  await refused.waitForSelector("[data-you]", { timeout: 15000 });
  await refused.click("[data-you]");
  await refused.click("[data-export]");
  await refused.waitForSelector('[data-export-note]:has-text("larger than this daemon hands out")', { timeout: 10000 });
  await refused.waitForSelector('[data-export]:has-text("not yet")', { timeout: 5000 });
  await refused.close();
  ok("an export the daemon refused says why under its button, and is not counted as a backup made");

  // a lock whose answer was lost: the socket drops after the daemon locked and before its
  // reply reached the page. The screen the lock was asked on is gone by then; the doubt
  // is shown over the one that took its place.
  const lostLock = await aliceCtx.newPage();
  watch(lostLock, "alice@lost-lock");
  let locking = null;
  let attaching = null;
  let attached = 0;
  await lostLock.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const wire = wireOf(message);
      if (wire?.kind === "call" && wire.method === "lock") locking = wire.id;
      if (wire?.kind === "call" && wire.method === "attach") attaching = wire.id;
      server.send(message);
    });
    server.onMessage((message) => {
      const wire = wireOf(message);
      if (locking !== null && wire?.id === locking && (wire.kind === "result" || wire.kind === "error")) {
        locking = null;
        ws.close();
        return;
      }
      if (attaching !== null && wire?.id === attaching && wire.kind === "result") attached++;
      ws.send(message);
    });
  });
  await lostLock.goto(new URL(link.own).origin + "/");
  await lostLock.waitForSelector("[data-you]", { timeout: 15000 });
  await lostLock.click("[data-you]");
  await lostLock.click("[data-lock]");
  await lostLock.waitForSelector("[data-unconfirmed]", { timeout: 15000 });
  const doubted = await lostLock.textContent("[data-unconfirmed]");
  if (!/Locking was not confirmed/.test(doubted) || !/unknown/.test(doubted)) {
    fail(`with the answer lost, the page must say the lock's result is unknown: "${doubted}"`);
  }
  await lostLock.waitForSelector("[data-locked] [data-passphrase]", { timeout: 15000 });
  // the page is back on the daemon once it has attached again; the vault is locked there
  while (attached < 2) await new Promise((resolve) => setTimeout(resolve, 200));
  await lostLock.fill("[data-locked] [data-passphrase]", PASS.Alice);
  await lostLock.click("[data-unlock]");
  await lostLock.waitForSelector("[data-you]", { timeout: 15000 });
  await lostLock.close();
  await alice.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 15000 });
  ok("a lock whose answer was lost is shown as unconfirmed over the screen that followed, and the passphrase opens the vault again");

  // the vault replaced while a page was cut off: that page had a DID of the old vault on its You
  // screen, had exported a backup of it, and had two pieces of work waiting on things other than
  // the daemon, a mediator lookup and a file being read, when its socket dropped; another page
  // locked the vault, removed it and made a new one; the first page's next baseline is the new
  // vault, open. Nothing of the old one stays on screen, the work released now sends nothing to the
  // new vault, and the new identity is not shown the old one's backup date
  const cut = await aliceCtx.newPage();
  watch(cut, "alice@cut");
  await cut.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no clipboard here")) } });
  });
  let severed = false;
  let wire = null;
  const called = [];
  cut.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const frame = wireOf(String(payload));
      if (frame?.kind === "call") called.push(frame.method);
    })
  );
  await cut.routeWebSocket(/./, (ws) => {
    if (severed) {
      ws.close();
      return;
    }
    wire = ws;
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => ws.send(message));
  });
  let releaseLookup = null;
  await cut.route("http://mediator.invalid/**", (route) => {
    releaseLookup = () => route.fulfill({ contentType: "application/json", body: JSON.stringify({ did: "did:web:mediator.invalid" }) });
  });
  await cut.goto(new URL(link.own).origin + "/");
  await mediate(cut, "Alice");
  await cut.click("[data-public-did]");
  await cut.waitForSelector("[data-public-did-text]", { timeout: 15000 });
  const oldDid = await cut.inputValue("[data-public-did-text]");
  await Promise.all([cut.waitForEvent("download", { timeout: 15000 }), cut.click("[data-export]")]);
  await cut.waitForSelector('[data-export]:has-text("last:")', { timeout: 5000 });
  await cut.click("[data-change-mediator]");
  await cut.selectOption("[data-mediator-choice]", "custom");
  await cut.fill("[data-mediator-paste]", "http://mediator.invalid/");
  await cut.click("[data-mediator-use]");
  await until(cut, () => releaseLookup !== null, "the mediator lookup to be under way");
  await cut.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "held.sqlite") return read.call(this);
      return new Promise((resolve) => (globalThis.releaseFile = () => resolve(new Uint8Array([1, 2, 3]).buffer)));
    };
  });
  await cut.setInputFiles("[data-import]", { name: "held.sqlite", mimeType: "application/vnd.sqlite3", buffer: Buffer.from([1, 2, 3]) });
  await cut.waitForFunction(() => typeof globalThis.releaseFile === "function", null, { timeout: 5000 });
  severed = true;
  wire.close();
  await cut.waitForSelector('[data-status-sentence]:has-text("not answering")', { timeout: 10000 });
  await alice.click("[data-you]");
  await alice.click("[data-lock]");
  await alice.waitForSelector("[data-locked]", { timeout: 10000 });
  alice.once("dialog", (d) => void d.accept());
  await alice.click("[data-start-over]");
  await alice.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await alice.fill("[data-your-name]", "Alicia");
  await alice.fill("[data-passphrase]", PASS.Alice);
  await alice.fill("[data-passphrase-again]", PASS.Alice);
  await alice.click("[data-create]");
  await alice.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  severed = false;
  await cut.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 15000 });
  if (await cut.$("[data-public-did-text]")) {
    fail("the page cut off should come back on the new vault's list, not on the old vault's You screen");
  }
  // the page asks the trace level once the new vault is open: the socket is up and answering by then
  await until(cut, () => called.filter((method) => method === "traceLevel").length >= 2, () => `a second traceLevel call, after ${called.join(", ")}`);
  const calledBefore = called.length;
  await Promise.all([cut.waitForResponse("http://mediator.invalid/**", { timeout: 5000 }), releaseLookup()]);
  await cut.evaluate(() => globalThis.releaseFile());
  await cut.waitForTimeout(1000);
  const sentOn = called.slice(calledBefore).filter((method) => method === "setMediator" || method === "mergeBackup");
  if (sentOn.length > 0) {
    fail(`work begun on the old vault must not go on into the new one, yet the page called ${sentOn.join(", ")}`);
  }
  await cut.click("[data-you]");
  await cut.waitForSelector('[data-you-screen]:has-text("Alicia")', { timeout: 15000 });
  await cut.waitForSelector("[data-choose-mediator]", { timeout: 5000 });
  const shown = await cut.textContent("[data-you-screen]");
  if ((await cut.$("[data-public-did-text]")) || shown.includes(oldDid)) {
    fail(`the old vault's DID must not stay on screen under the new identity: ${oldDid}`);
  }
  if (!(await cut.$('[data-export]:has-text("not yet")'))) {
    fail(`the new identity must not be shown the old one's backup date: ${await cut.textContent("[data-export]")}`);
  }
  await cut.close();
  ok("a page cut off while the vault was replaced shows the new vault alone when it comes back, sends nothing it had begun, and shows no backup of the old one");

  // the vault replaced while a page has calls of it under way: their answers come back over the
  // same socket after the new vault is on screen, and the person has begun something there. The
  // answers are the old vault's: they settle nothing on the new one's screen, drop nothing typed
  // there, and do not stand in for what the new vault said of itself
  const late = await aliceCtx.newPage();
  watch(late, "alice@late");
  const holding = new Set();
  const heldIds = new Set();
  const heldAnswers = [];
  const lateCalled = [];
  await late.routeWebSocket(/./, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const wire = wireOf(message);
      if (wire?.kind === "call") {
        lateCalled.push(wire.method);
        if (holding.has(wire.method)) heldIds.add(wire.id);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const wire = wireOf(message);
      if ((wire?.kind === "result" || wire?.kind === "error") && heldIds.has(wire.id)) heldAnswers.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  await late.goto(new URL(link.own).origin + "/");
  await mediate(late, "Alicia");
  holding.add("setTraceLevel");
  await late.selectOption("[data-trace-level]", "verbose");
  await until(late, () => heldAnswers.length >= 1, () => `the setTraceLevel answer to be held (${heldAnswers.length} held)`);
  await leaveYou(late);
  holding.add("acceptInvitation");
  const lateLink = await invite(bob);
  await late.click("[data-new-conversation]");
  await late.click("[data-new-sheet] [data-paste-link]");
  await late.fill("[data-contact-name]", "Bob again");
  await late.fill("[data-invitation-link]", lateLink);
  await late.click("[data-accept]");
  await until(late, () => heldAnswers.length >= 2, () => `the acceptInvitation answer to be held (${heldAnswers.length} held)`, 60000);
  alice.once("dialog", (d) => void d.accept());
  await alice.click("[data-you]");
  await alice.click("[data-forget]");
  await alice.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await late.waitForSelector("[data-onboarding]", { timeout: 15000 });
  await alice.fill("[data-your-name]", "Alix");
  await alice.fill("[data-passphrase]", PASS.Alice);
  await alice.fill("[data-passphrase-again]", PASS.Alice);
  await alice.click("[data-create]");
  await alice.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  await late.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 15000 });
  await late.click("[data-you]");
  await late.waitForSelector('[data-you-screen]:has-text("Alix")', { timeout: 15000 });
  await late.selectOption("[data-you-screen] [data-mediator-choice]", "custom");
  await late.fill("[data-mediator-paste]", "http://typed-on-the-new-vault.invalid/");
  if ((await late.inputValue("[data-trace-level]")) !== "normal") {
    fail(`the new vault's trace level should be its own, normal: ${await late.inputValue("[data-trace-level]")}`);
  }
  const lateCalledBefore = lateCalled.length;
  for (const answer of heldAnswers.splice(0)) answer();
  await late.waitForTimeout(1000);
  if (!(await late.$("[data-you-screen]"))) {
    fail("an old contact's answer must not take the page off the screen the person is on");
    await late.click("[data-you]");
    await late.waitForSelector("[data-you-screen]", { timeout: 15000 });
  } else if ((await late.inputValue("[data-mediator-paste]")) !== "http://typed-on-the-new-vault.invalid/") {
    fail(`what was typed on the new vault's screen must stay: ${await late.inputValue("[data-mediator-paste]")}`);
  }
  if ((await late.inputValue("[data-trace-level]")) !== "normal") {
    fail(`the old vault's trace level must not be shown for the new one: ${await late.inputValue("[data-trace-level]")}`);
  }
  const lateSentOn = lateCalled.slice(lateCalledBefore).filter((method) => method === "send");
  if (lateSentOn.length > 0) {
    fail("the introduction of a contact made in the old vault must not be sent from the new one");
  }
  await late.close();
  ok("answers of the old vault arriving on the new one's screen settle nothing there: the screen, what was typed on it and its own trace level stay");

  // a restore begun where no vault stood, held on the file being read while another page made a
  // vault and removed it again: the page is back where it began, and the restore does not go on,
  // as the vault of the moment it began in is not the one that would take the backup now. A
  // restore begun afresh goes through
  const pend = await aliceCtx.newPage();
  watch(pend, "alice@pend");
  const pendCalled = [];
  pend.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const frame = wireOf(String(payload));
      if (frame?.kind === "call") pendCalled.push(frame.method);
    })
  );
  await pend.goto(new URL(link.own).origin + "/");
  await pend.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 15000 });
  await pend.click("[data-you]");
  const [backupDownload] = await Promise.all([pend.waitForEvent("download", { timeout: 15000 }), pend.click("[data-export]")]);
  const backupPath = join(root, "alix.sqlite");
  await backupDownload.saveAs(backupPath);
  const backup = await readFile(backupPath);
  pend.once("dialog", (d) => void d.accept());
  await pend.click("[data-forget]");
  await pend.waitForSelector("[data-onboarding] [data-tab-restore]", { timeout: 15000 });
  await alice.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await pend.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name !== "held-backup.sqlite") return read.call(this);
      return new Promise((resolve, reject) => (globalThis.releaseBackup = () => read.call(this).then(resolve, reject)));
    };
  });
  await pend.click("[data-tab-restore]");
  await pend.setInputFiles("[data-backup-file]", { name: "held-backup.sqlite", mimeType: "application/vnd.sqlite3", buffer: backup });
  await pend.fill("[data-backup-passphrase]", PASS.Alice);
  await pend.click("[data-restore]");
  await pend.waitForFunction(() => typeof globalThis.releaseBackup === "function", null, { timeout: 5000 });
  await alice.fill("[data-your-name]", "Interim");
  await alice.fill("[data-passphrase]", PASS.Alice);
  await alice.fill("[data-passphrase-again]", PASS.Alice);
  await alice.click("[data-create]");
  await alice.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  await pend.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 15000 });
  alice.once("dialog", (d) => void d.accept());
  await alice.click("[data-you]");
  await alice.click("[data-forget]");
  await alice.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await pend.waitForSelector("[data-onboarding] [data-your-name]", { timeout: 15000 });
  await pend.evaluate(() => globalThis.releaseBackup());
  await pend.waitForTimeout(1000);
  if (pendCalled.includes("restoreIdentity")) {
    fail("a restore begun before a vault stood and went must not go on once none stands again");
  }
  if (!(await pend.$("[data-onboarding] [data-your-name]"))) {
    fail("the page should still be where it begins, with no vault standing");
  } else {
    await pend.click("[data-tab-restore]");
    await pend.setInputFiles("[data-backup-file]", { name: "alix.sqlite", mimeType: "application/vnd.sqlite3", buffer: backup });
    await pend.fill("[data-backup-passphrase]", PASS.Alice);
    await pend.click("[data-restore]");
    await pend.waitForSelector("[data-you]", { timeout: 30000 });
    await pend.click("[data-you]");
    await pend.waitForSelector('[data-you-screen]:has-text("Alix")', { timeout: 15000 });
    if (pendCalled.filter((method) => method === "restoreIdentity").length !== 1) {
      fail(`one restore was asked for, and one should have been sent: ${pendCalled.filter((method) => method === "restoreIdentity").length}`);
    }
  }
  await pend.close();
  await alice.waitForSelector('[data-status]:has-text("no mediator"), [data-status]:has-text("live")', { timeout: 15000 });
  ok("a restore held on its file while a vault stood and went does not go on; one begun afresh restores the backup");

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
