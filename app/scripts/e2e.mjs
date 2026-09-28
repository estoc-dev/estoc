/**
 * Full-flow smoke against a running mediator and a served build: three
 * isolated browser contexts mint Alice, Bob and Carol, meet over invitation
 * links and message each other (live delivery, no reload); then the app's
 * own promises get exercised: a conversation is named, an address is
 * rotated by hand and the thread goes on over it, a draft stays with the
 * peer who rotates under it, history survives a reload, a second tab
 * yields to the first, lock asks for the passphrase, a backup file
 * restores the identity in a fresh browser, where sending waits for the
 * restore to be explained, importing a backup into a live vault merges
 * instead of clobbering, and (where a service worker is serving) the shell
 * opens with the network off.
 *
 *   npm run preview        # serves the build on :4173 with the service worker
 *   node scripts/e2e.mjs [app-url]        (default http://localhost:4173)
 *
 * The mediator every identity uses is whatever the picker offers: the
 * localhost entry unless E2E_MEDIATOR=estoc (production,
 * did:web:mediator.estoc.dev) or E2E_MEDIATOR=<url> (any other value is a
 * mediator's URL, the entry a VITE_MEDIATOR_DID build labels with that
 * URL's host).
 *
 * The window is a desktop one: the list stays beside the conversation,
 * and details open in a column of their own.
 */
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const APP_URL = process.argv[2] ?? "http://localhost:4173";
const E2E_MEDIATOR = process.env.E2E_MEDIATOR;
let MEDIATOR_LABEL = "localhost:8080";
let MEDIATOR_URL = "http://localhost:8080";
if (E2E_MEDIATOR === "estoc" || E2E_MEDIATOR === "web") {
  MEDIATOR_LABEL = "mediator.estoc.dev";
  MEDIATOR_URL = "https://mediator.estoc.dev";
} else if (E2E_MEDIATOR !== undefined && E2E_MEDIATOR !== "local") {
  MEDIATOR_URL = E2E_MEDIATOR;
  MEDIATOR_LABEL = new URL(E2E_MEDIATOR).host;
}

const executablePath = "/usr/bin/chromium";
const PASS = { Alice: "alice-passes-the-salt", Bob: "bob-builds-boats-2026", Carol: "carol-carries-cardamom" };

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function watch(page, name) {
  pages[name] = page;
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error(`[${name} console] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.error(`[${name} pageerror] ${err}`));
}

/** The list's one-word status, or the You screen's sentence, says the line is live. */
const waitLive = (page) => page.waitForSelector('[data-status]:has-text("live"), [data-status-sentence]:has-text("live delivery on")', { timeout: 30000 });

/**
 * Name a mediator on the You screen. An identity is minted without one;
 * the list says so, and a page opened with an invitation is already
 * asking to accept it, so the way to You is the link in that sheet.
 */
async function mediate(page, name, mediatorInvitation = null) {
  await page.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  ok(`${name} minted without a mediator`);
  if ((await page.locator("[data-new-sheet]").count()) > 0) {
    await page.click("[data-new-sheet] [data-choose-one]");
  } else {
    await page.click("[data-you]");
  }
  await page.waitForSelector("[data-you-screen] [data-choose-mediator]", { timeout: 10000 });
  if (mediatorInvitation === null) {
    await page.selectOption("[data-you-screen] [data-mediator-choice]", { label: MEDIATOR_LABEL });
  } else {
    await page.selectOption("[data-you-screen] [data-mediator-choice]", { label: "a pasted invitation…" });
    await page.fill("[data-you-screen] [data-mediator-paste]", mediatorInvitation);
  }
  await page.click("[data-you-screen] [data-mediator-use]");
  await waitLive(page);
  ok(`${name} mediated: live delivery on`);
  await page.click("[data-you-screen] [data-back]");
}

async function createIdentity(page, name, mediatorInvitation = null, startUrl = APP_URL) {
  await page.goto(startUrl);
  await page.fill("[data-your-name]", name);
  await page.fill("[data-passphrase]", PASS[name]);
  await page.fill("[data-passphrase-again]", PASS[name]);
  await page.click("[data-create]");
  await mediate(page, name, mediatorInvitation);
}

/** Open the new-conversation sheet and show a fresh invitation as a QR code; the sheet stays open. */
async function invite(page) {
  await page.click("[data-new-conversation]");
  await page.click("[data-new-sheet] [data-show-qr]");
  await page.waitForSelector("[data-invitation-url]", { timeout: 20000 });
  const url = await page.getAttribute("[data-invitation-url]", "title");
  if (!url?.includes("_oob=")) {
    throw new Error("the invitation link carries no _oob");
  }
  return url;
}

async function closeSheet(page) {
  if ((await page.locator("[data-new-sheet] [data-done]").count()) > 0) await page.click("[data-new-sheet] [data-done]");
  await page.click("[data-new-sheet] [data-cancel]");
  await page.waitForSelector("[data-new-sheet]", { state: "detached", timeout: 5000 });
}

/** Paste someone's link under a name for them; the conversation opens. */
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
const openConversation = (page, name) => page.click(row(name));

async function send(page, text) {
  await page.fill("[data-composer]", text);
  await page.click("[data-send]");
}

async function expectBubble(page, text, timeout = 30000) {
  await page.waitForSelector(`.bubble:has-text("${text}")`, { timeout });
}

const channelsShown = (page, count) => page.waitForSelector(`[data-chat][data-channels="${count}"]`, { timeout: 45000 });

/** Mint a fresh address toward the open conversation's peer, from its details; the details close again. */
async function rotate(page) {
  await page.click("[data-chat] [data-details]");
  await page.click("[data-details-screen] [data-rotate]");
  await page.click("[data-details-screen] [data-back]");
}

const draftText = (page) => page.inputValue("[data-composer]");
const chatName = (page) => page.locator("[data-chat] [data-name]").innerText();

/** What a page says of itself when a step times out: the composer's complaints. */
async function dump(page, name) {
  const lines = await page.locator("[data-send-error], [data-closed], [data-log] p").allInnerTexts().catch(() => []);
  console.error(`[${name}]\n  ${lines.slice(-12).join("\n  ")}`);
}

const pages = {};
const browser = await chromium.launch({ executablePath });
try {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  watch(alice, "alice");
  watch(bob, "bob");

  // Alice onboards by pasting the mediator's OOB invitation URL; Bob uses
  // the dropdown, so both bootstrap paths stay covered.
  const { invitationUrl } = await (await fetch(MEDIATOR_URL)).json();
  if (typeof invitationUrl !== "string" || !invitationUrl.includes("_oob=")) {
    throw new Error(`mediator at ${MEDIATOR_URL} publishes no invitation URL`);
  }
  await createIdentity(alice, "Alice", invitationUrl);
  await createIdentity(bob, "Bob");

  // Bob hands Alice a link; she pastes it under a name of her own for him.
  const bobLink = await invite(bob);
  // A mediator with long endpoints makes a link no QR code holds; the link is what must be there.
  if ((await bob.locator("[data-new-sheet] .qr svg, [data-no-qr]").count()) !== 1) {
    fail("the invitation should show as a QR code too, or say why it cannot");
  }
  ok("Bob issued a single-use invitation link (with a QR where it fits one)");
  await acceptLink(alice, "Bob", bobLink);
  ok("Alice accepted it: Bob is a contact of hers");

  // On Bob's side nobody is named yet: the conversation opens under what
  // she calls herself, quoted as the claim it is, until he names it.
  await bob.waitForSelector("[data-invitation-taken]", { timeout: 45000 });
  await bob.click("[data-new-sheet] [data-done]");
  if ((await bob.locator("[data-new-sheet] [data-open-links]").count()) !== 0) {
    fail("a taken link should no longer count as open");
  }
  await closeSheet(bob);
  await bob.waitForSelector(namelessRow("Alice"), { timeout: 45000 });
  ok("Bob saw Alice arrive under the name she claims; the link is taken");
  await bob.click(namelessRow("Alice"));
  await bob.click("[data-chat] [data-details]");
  await bob.fill("[data-details-screen] [data-petname]", "Alice");
  await bob.click("[data-details-screen] [data-rename]");
  await bob.waitForSelector(`${row("Alice")}:not(.nameless)`, { timeout: 15000 });
  await bob.click("[data-details-screen] [data-back]");
  ok("Bob named the conversation: a contact of his now");

  // Bob answers her Ping from the private address that replaces the disclosed one. A send names the pair on
  // screen and is refused once that pair is replaced, so she writes after his answer has reached her page.
  await channelsShown(alice, 2);
  await send(alice, "hello bob, through the mediator");
  await expectBubble(alice, "hello bob");
  await alice.waitForSelector('.bubble:has-text("hello bob") [data-delivery].submitted', { timeout: 30000 });
  ok("Alice's message shows in her thread, handed over to the mediator");
  await expectBubble(bob, "hello bob");
  ok("Bob received it live over the WebSocket");
  await send(bob, "hi alice, loud and clear");
  await expectBubble(alice, "hi alice");
  ok("Alice received Bob's reply live");

  // The address in Bob's link was disclosed; the first thing written to it
  // moved him to one minted for Alice alone, and she followed the proof.
  await channelsShown(bob, 2);
  await channelsShown(alice, 2);
  ok("Bob's disclosed address gave way to a private one; both sides show the two channels");

  // A rotation by hand: Alice mints a fresh address toward Bob and tells him.
  await rotate(alice);
  await channelsShown(alice, 3);
  await send(alice, "same alice, new address");
  await expectBubble(bob, "same alice, new address", 45000);
  await channelsShown(bob, 3);
  await send(bob, "followed you there");
  await expectBubble(alice, "followed you there", 45000);
  ok("Alice rotated her address by hand; the thread goes on over the new channel both ways");

  // Carol opens a link of Bob's before she has an identity at all.
  const carolLink = await invite(bob);
  await closeSheet(bob);
  const carolCtx = await browser.newContext();
  const carol = await carolCtx.newPage();
  watch(carol, "carol");
  await createIdentity(carol, "Carol", null, carolLink);
  await carol.waitForSelector('[data-new-sheet]:has-text("You were handed an invitation")', { timeout: 10000 });
  ok("Carol opened the link before she had an identity; it waited through onboarding");
  await carol.fill("[data-contact-name]", "Bob (invited)");
  await carol.click("[data-accept]");
  await carol.waitForSelector('[data-chat] [data-name]:has-text("Bob (invited)")', { timeout: 30000 });
  await bob.waitForSelector(namelessRow("Carol"), { timeout: 45000 });
  await bob.click(namelessRow("Carol"));
  await send(bob, "welcome carol");
  await expectBubble(carol, "welcome carol");
  await send(carol, "thanks bob");
  await expectBubble(bob, "thanks bob");
  ok("Bob and Carol talk both ways before he has named her");

  // Carol moves to a new address while Bob, who has named only Alice, is
  // writing to her: the pair his open conversation is known by moves, and
  // the conversation and what he was writing stay hers.
  await channelsShown(bob, 2);
  await bob.fill("[data-composer]", "for carol alone");
  await rotate(carol);
  await channelsShown(bob, 3);
  if ((await chatName(bob)) !== "“Carol”" || (await draftText(bob)) !== "for carol alone") {
    fail("a peer's rotation should leave the open conversation and its draft where they were");
  }
  await bob.click("[data-send]");
  await expectBubble(carol, "for carol alone", 45000);
  await openConversation(bob, "Alice");
  if ((await draftText(bob)) !== "" || (await alice.locator('.bubble:has-text("for carol alone")').count()) !== 0) {
    fail("what was written to Carol should reach nobody else");
  }
  ok("Carol rotated while Bob was writing to her: the draft stayed hers and reached her alone");

  // The same with Bob looking elsewhere: what he left unsent for Carol
  // follows her channel, and is there when he comes back to her.
  await bob.click(namelessRow("Carol"));
  await bob.fill("[data-composer]", "kept for carol");
  await openConversation(bob, "Alice");
  await bob.fill("[data-composer]", "kept for alice");
  const carolKey = await bob.getAttribute(namelessRow("Carol"), "data-conversation");
  const carolChannels = await carol.getAttribute("[data-chat]", "data-channels");
  await rotate(carol);
  await carol.waitForFunction((count) => document.querySelector("[data-chat]")?.dataset.channels !== count, carolChannels, { timeout: 45000 });
  await send(carol, "moved again");
  // A nameless conversation is known by the pair it leads to, so its key moving says her new address reached Bob, here while he looks at Alice.
  await bob.waitForFunction((key) => document.querySelector(".convo-row.nameless")?.dataset.conversation !== key, carolKey, { timeout: 45000 });
  if ((await chatName(bob)) !== "Alice") {
    fail("Bob should still be looking at Alice when Carol's rotation reaches him");
  }
  await bob.click(namelessRow("Carol"));
  await expectBubble(bob, "moved again", 45000);
  await channelsShown(bob, 4);
  if ((await draftText(bob)) !== "kept for carol") {
    fail("a draft left for a peer who rotates in the background should still be theirs");
  }
  await openConversation(bob, "Alice");
  if ((await draftText(bob)) !== "kept for alice") {
    fail("a draft for somebody else should be untouched by it");
  }
  await bob.fill("[data-composer]", "");
  ok("Carol rotated while Bob was elsewhere: his draft for her was there when he came back");
  await carolCtx.close();

  // Reload: history and identity come back from the vault, no passphrase.
  await bob.reload();
  await openConversation(bob, "Alice");
  await expectBubble(bob, "hello bob");
  await waitLive(bob);
  ok("Bob's history and live delivery survive a reload without a passphrase");

  // A second tab of the same browser must not open a second agent.
  const bob2 = await bobCtx.newPage();
  await bob2.goto(APP_URL);
  await bob2.waitForSelector("text=Open in another tab", { timeout: 15000 });
  ok("a second tab waits for the first");
  await bob2.close();

  // Lock: the seed cache is dropped; the passphrase, and only the right one, reopens.
  // What was being written is of the vault that is still here, and is there again.
  await bob.fill("[data-composer]", "unsent over a lock");
  await bob.click("[data-you]");
  await bob.click("[data-lock]");
  await bob.waitForSelector("[data-locked]", { timeout: 15000 });
  if ((await bob.locator("body").innerText()).includes("unsent over a lock")) {
    fail("a locked vault should show nothing that was being written in it");
  }
  await bob.fill("[data-locked] [data-passphrase]", "not-it");
  await bob.click("[data-unlock]");
  await bob.waitForSelector("text=wrong passphrase", { timeout: 15000 });
  await bob.fill("[data-locked] [data-passphrase]", PASS.Bob);
  await bob.click("[data-unlock]");
  await openConversation(bob, "Alice");
  await expectBubble(bob, "hello bob");
  await waitLive(bob);
  if ((await draftText(bob)) !== "unsent over a lock") {
    fail("a draft should still be there when the same vault is unlocked");
  }
  await bob.fill("[data-composer]", "");
  ok("lock → wrong passphrase refused → right passphrase reopens with history and the draft");

  // Backup: Alice exports her vault; a fresh browser restores it and is Alice.
  await alice.click("[data-you]");
  const [download] = await Promise.all([alice.waitForEvent("download"), alice.click("[data-export]")]);
  const backupName = download.suggestedFilename();
  // the download lives with Alice's context; keep a copy that outlives it
  const backupPath = join(await mkdtemp(join(tmpdir(), "estoc-e2e-")), backupName);
  await copyFile(await download.path(), backupPath);
  if (!backupName.endsWith(".estoc.sqlite")) {
    fail(`backup is named ${backupName}, expected *.estoc.sqlite`);
  }
  await alice.waitForSelector('[data-export]:has-text("last:")', { timeout: 5000 });
  ok(`Alice exported ${backupName}`);

  // Merge first, while Alice is still up: her own backup has nothing new.
  await alice.setInputFiles("[data-import]", backupPath);
  await alice.waitForSelector("[data-import-note]:has-text('Nothing new in that backup')", { timeout: 30000 });
  await alice.click("[data-you-screen] [data-back]");
  await openConversation(alice, "Bob");
  await expectBubble(alice, "hello bob");
  await waitLive(alice);
  ok("importing her own backup merges nothing and leaves the vault as it was");

  // One receiver at a time: the original Alice goes away before the restore comes up.
  await aliceCtx.close();
  const alice2Ctx = await browser.newContext();
  const alice2 = await alice2Ctx.newPage();
  watch(alice2, "alice2");
  await alice2.goto(APP_URL);
  await alice2.click("[data-tab-restore]");
  await alice2.setInputFiles("[data-backup-file]", backupPath);
  await alice2.fill("[data-backup-passphrase]", "wrong-one");
  await alice2.click("[data-restore]");
  await alice2.waitForSelector("text=does not open this backup", { timeout: 30000 });
  await alice2.setInputFiles("[data-backup-file]", backupPath);
  await alice2.fill("[data-backup-passphrase]", PASS.Alice);
  await alice2.click("[data-restore]");
  await alice2.waitForSelector(row("Bob"), { timeout: 45000 });
  await openConversation(alice2, "Bob");
  await alice2.waitForSelector("[data-restore-notice]", { timeout: 15000 });
  await expectBubble(alice2, "hello bob");
  await expectBubble(alice2, "hi alice");
  if (!(await alice2.isDisabled("[data-composer]"))) {
    fail("sending should wait for the restore to be explained");
  }
  ok("a fresh browser restored Alice from the file: full history, sending closed until the restore is explained");
  await alice2.click("[data-restore-understood]");
  await alice2.waitForSelector("[data-restore-notice]", { state: "detached", timeout: 15000 });
  await waitLive(alice2);
  await send(alice2, "back from a backup");
  await expectBubble(bob, "back from a backup", 45000);
  await send(bob, "welcome back, alice");
  await expectBubble(alice2, "welcome back", 45000);
  ok("restored Alice writes and receives over the channels the backup held");

  // Offline: with a service worker in charge, the shell opens with the network off.
  // (The worker registered on this page's first load takes control on the next;
  // one online reload first, then the network goes away.)
  const hasSw = await alice2.evaluate(() =>
    "serviceWorker" in navigator
      ? Promise.race([
          navigator.serviceWorker.ready.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
        ])
      : false
  );
  if (hasSw) {
    await alice2.reload();
    await openConversation(alice2, "Bob");
    await expectBubble(alice2, "hello bob");
    await alice2.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
    await alice2Ctx.setOffline(true);
    // written with no network: in the vault at once, and shown as not handed over
    await send(alice2, "written offline, sent later");
    const unsent = '.bubble:has-text("written offline") [data-delivery]:not(.submitted):not(.acknowledged)';
    await alice2.waitForSelector(unsent, { timeout: 30000 });
    ok("offline: a message written with no network is in the thread, not handed over");
    await alice2.reload();
    await openConversation(alice2, "Bob");
    await expectBubble(alice2, "hello bob");
    await alice2.waitForSelector(unsent, { timeout: 30000 });
    ok("offline: the app shell and history open with no network, the unsent message included");
    await alice2Ctx.setOffline(false);
    // Opening a vault sends nothing, so the reload left the message to a
    // hand: sent again where the thread offers it.
    await waitLive(alice2);
    await alice2.click('.bubble:has-text("written offline") [data-retry]', { timeout: 30000 });
    await expectBubble(bob, "written offline, sent later", 45000);
    await alice2.waitForSelector('.bubble:has-text("written offline") [data-delivery].submitted', { timeout: 30000 });
    ok("back online: sent again by hand, it reached Bob");
  } else {
    console.log("· no service worker (dev server?): offline check skipped");
  }

  await alice2.screenshot({ path: "scripts/e2e-alice.png", fullPage: true });
  await bob.screenshot({ path: "scripts/e2e-bob.png", fullPage: true });

  // Forget: whoever makes an identity on the same page next, without a
  // reload between, finds nothing the forgotten one was writing.
  await openConversation(bob, "Alice");
  await bob.fill("[data-composer]", "unsent when bob was forgotten");
  await bob.click("[data-you]");
  bob.once("dialog", (dialog) => dialog.accept());
  await bob.click("[data-forget]");
  await bob.fill("[data-your-name]", "Dora");
  await bob.fill("[data-passphrase]", "dora-dries-dates");
  await bob.fill("[data-passphrase-again]", "dora-dries-dates");
  await bob.click("[data-create]");
  await bob.waitForSelector('[data-status]:has-text("no mediator")', { timeout: 30000 });
  if ((await bob.locator("[data-draft-elsewhere]").count()) !== 0 || (await bob.locator("body").innerText()).includes("unsent when bob was forgotten")) {
    fail("a new identity should find nothing of what the forgotten one was writing");
  }
  ok("Bob forgotten, Dora made on the same page: his draft went with his vault");

  if (process.exitCode !== 1) {
    console.log("\nall green");
  }
} catch (err) {
  for (const [name, page] of Object.entries(pages)) {
    if (!page.isClosed()) await dump(page, name);
  }
  throw err;
} finally {
  await browser.close();
}
