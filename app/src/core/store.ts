import { shallowReactive, toRaw } from "vue";
import type { Client, ConnectionState, DaemonMethods } from "@estoc/daemon-api/client";
import type { Epoch, Outcome, StateValue } from "@estoc/daemon-api/contract";
import { basicMessage, indexSnapshot, invitationOf, invitationUrl, parseInvitation, parseSnapshotLink, profileMessage, snapshotLinkUrl } from "@estoc/daemon-api/views";

import { daemonSocket, startDaemon } from "../daemon/client.js";
import { forgetSeedKey } from "../daemon/keycache.js";
import { FOLDER_VAULT } from "../daemon/places.js";
import { saveFile } from "./backup.js";
import { carryDrafts, dropDrafts } from "./drafts.js";
import { explained } from "./failure.js";
import { isInstalled, setupPwa } from "./pwa.js";
import { markExported } from "./seen.js";
import { fileSystemRefused, isStoragePersisted, persistStorage } from "./storage.js";
import type { ChannelId, ContactId, ConversationId, EventCid, ExecutionId, Hold, Invitation, InvitationRecord, Lines, MergeResult, MessageId, PublishedSnapshotLink, SendTarget, Snapshot, SnapshotIndex, SnapshotLink, SnapshotLinkRecord, TraceLevel } from "./types.js";

export type VaultViewState = Exclude<StateValue, { phase: "open" }> | { phase: "open"; hold: Hold; index: SnapshotIndex };
/** A `#snapshot=` this page was opened with: the link as it came, or why it is not one. */
export type OpenedSnapshotLink = { link: string } | { unreadable: string };

/**
 * The one store: the vault as the daemon last published it, plus the
 * runtime around it (the lines to the mediators, the activity log,
 * storage and install state, the connection to the daemon). The vault
 * and the agent live in the daemon (src/daemon); every state it
 * publishes replaces the one before, whole, so the UI renders what the
 * vault holds and never the other way round, and every action here is
 * a call across to it. The state is reactive one level deep for that
 * reason: a field changes by being replaced, and what it holds stays
 * the plain value that crossed from the daemon, which a call can hand
 * back as it is.
 *
 * The passphrase is typed when the identity is created or restored, and
 * again only after "Lock"; the daemon keeps the unlocked seed between
 * sessions. The file a backup exports carries the seed sealed under that
 * passphrase, and everything else in the clear.
 */

export const state = shallowReactive({
  vault: { phase: "booting", hold: null, detail: null } as VaultViewState,
  lines: null as Lines | null,
  /** where the connection to the daemon stands, apart from what the daemon last said */
  connection: { state: "connecting" } as ConnectionState,
  /** why a daemon over a socket is not answering; null in the worker, and while it answers */
  away: null as string | null,
  log: [] as string[],
  /** whether the browser has promised not to evict this origin's storage */
  persisted: false,
  /** the socket of an `estoc-daemon` this page is using instead of its own worker; null in the worker */
  daemonAt: null as string | null,
  /** why the browser refuses the worker the files it would keep the vault in; no worker is started then */
  fileSystemRefused: null as string | null,
  installed: isInstalled(),
  /** set when the browser offers to install; call to prompt */
  install: null as (() => Promise<void>) | null,
  /** set when a new version is waiting; call to reload into it */
  applyUpdate: null as (() => void) | null,
  /** true once the service worker has the shell cached */
  offlineReady: false,
  /**
   * An invitation this page was opened with (`?_oob=` in the URL) and has
   * not acted on yet: a person's opens the new-conversation sheet to be
   * accepted; a mediator's is offered where a mediator is chosen. Kept here,
   * not in the URL, so it survives onboarding and unlocking.
   */
  pendingInvitation: null as Invitation | null,
  pendingMediatorInvitation: null as string | null,
  /**
   * What this page was opened with as `#snapshot=`, until a vault is made
   * or restored here: the link to another device's vault, offered where
   * a vault is restored, or why what came is not one. While this device
   * holds a vault it is only said to be of no use here.
   */
  pendingSnapshotLink: null as OpenedSnapshotLink | null,
  /** the invitations made since this page opened, by ID, as the links they were handed over as: the vault keeps the disclosure and not what it was said to be for */
  links: {} as Record<string, string>,
  /** what this device keeps of what its agent observes: this copy's own state, never in a backup */
  traceLevel: "normal" as TraceLevel,
});

let client: Client | null = null;

function log(line: string): void {
  state.log = [...state.log, `${new Date().toLocaleTimeString()}  ${line}`].slice(-200);
}

/** What a procedure came to, in its own word: a resolved call is not a message sent. */
function said(what: string, { outcome, because }: Outcome): void {
  log(because === null ? `${what}: ${outcome}` : `${what}: ${outcome} (${because})`);
}

/** The open vault's snapshot read by ID; null while no vault is open. */
export function openIndex(): SnapshotIndex | null {
  return state.vault.phase === "open" ? state.vault.index : null;
}

/** the epoch whose open state is on screen: a vault opened is asked once for what only it knows */
let opened: Epoch | null = null;
/** how many times what stands here has changed since the page opened: a vault, or none, in place of another */
let turn = 0;

function show(epoch: Epoch, value: StateValue): void {
  if (value.phase === "onboarding") dropDrafts();
  if (value.hold !== state.vault.hold) {
    turn += 1;
    // the links were made for the vault that stood; another in its place has none of them
    state.links = {};
  }
  if (value.phase !== "open") {
    opened = null;
    state.lines = null;
    state.vault = value;
    return;
  }
  carryDrafts(value.snapshot);
  state.vault = { phase: "open", hold: value.hold, index: indexSnapshot(value.snapshot) };
  if (opened === epoch) return;
  opened = epoch;
  // the level is the open vault's own local state
  const held = heldNow();
  void call((daemon) => daemon.traceLevel({})).then(
    ({ level }) => {
      if (held()) state.traceLevel = level;
    },
    () => undefined
  );
  if (state.daemonAt === null) {
    void isStoragePersisted().then((persisted) => (state.persisted = persisted));
  }
}

async function connectDaemon(): Promise<void> {
  const socket = daemonSocket();
  state.daemonAt = socket;
  if (socket === null) {
    const refused = await fileSystemRefused();
    if (refused !== null) {
      state.fileSystemRefused = refused;
      return;
    }
  }
  const started = startDaemon(socket);
  started.onConnection((connection) => {
    state.connection = connection;
    if (connection.state === "connected") state.away = null;
    else if (connection.state === "disconnected" && connection.because !== null && state.daemonAt !== null) state.away = `daemon at ${new URL(state.daemonAt).host} is not answering`;
  });
  started.onState(({ epoch, value }) => show(epoch, value));
  started.onLines(({ value }) => (state.lines = value));
  started.onLog(({ line }) => log(line));
  client = started;
}

function connected(): Client {
  if (client === null) {
    throw new Error("the daemon is not connected");
  }
  return client;
}

/** A call of the daemon's, its failure in words for the person; `tooLarge` is what to do instead when it is refused as too large. */
async function call<T>(work: (daemon: DaemonMethods) => Promise<T>, tooLarge?: string): Promise<T> {
  try {
    return await work(connected().daemon);
  } catch (error) {
    throw explained(error, tooLarge);
  }
}

/** Where a state covering every change committed so far is on screen; a wait the connection or the epoch ends is over too. */
export async function refresh(): Promise<void> {
  await connected()
    .refresh()
    .catch(() => undefined);
}

/**
 * Bring the app up: connect to the daemon, which takes the vault's files
 * (or waits for the tab that has them) and says which screen they
 * dictate: nothing there, a vault without its cached seed, or straight in.
 * A browser that refuses the worker its files gets no daemon, and the
 * screen says why.
 */
export async function boot(): Promise<void> {
  takePendingInvitation();
  takePendingSnapshotLink();
  // A link pasted over this page's address changes only the fragment: the page stays, and takes it as it would on opening.
  window.addEventListener("hashchange", takePendingSnapshotLink);
  setupPwa({
    onUpdateReady: (apply) => (state.applyUpdate = apply),
    onOfflineReady: () => (state.offlineReady = true),
    onInstallable: (prompt) => (state.install = prompt),
  });
  // A page looked at again is first brought up to what the daemon has committed since.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.vault.phase === "open") void refresh();
  });
  // The daemon in a worker hears `online` only where the browser tells workers; the page's is passed on as well.
  window.addEventListener("online", () => {
    if (state.vault.phase === "open") void reconnect().catch(() => undefined);
  });
  await connectDaemon();
}

/**
 * An `_oob` in this page's URL is an invitation someone handed over as a
 * link. Take it off the URL (a reload should not re-offer it, and it should
 * not ride into a bookmark) and hold it until a screen can act on it.
 */
function takePendingInvitation(): void {
  const params = new URLSearchParams(location.search);
  const oob = params.get("_oob");
  if (oob === null) {
    return;
  }
  const clean = `${location.pathname}${location.hash}`;
  try {
    const invitation = parseInvitation(oob);
    if (invitation.body.goal_code === "request-mediate") {
      state.pendingMediatorInvitation = location.href;
    } else {
      state.pendingInvitation = invitation;
    }
  } catch (err) {
    log(`the link this page was opened with is not an invitation: ${err instanceof Error ? err.message : err}`);
  }
  history.replaceState(null, "", clean);
}

function takePendingSnapshotLink(): void {
  if (!new URLSearchParams(location.hash.slice(1)).has("snapshot")) return;
  try {
    parseSnapshotLink(location.href);
    state.pendingSnapshotLink = { link: location.href };
  } catch (err) {
    state.pendingSnapshotLink = { unreadable: err instanceof Error ? err.message : String(err) };
  }
  // The fragment carries the key to the vault's copy: it leaves the address whether or not it reads as a link.
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}

export function dismissPendingSnapshotLink(): void {
  state.pendingSnapshotLink = null;
}

/**
 * Mint an identity: a fresh seed sealed under `passphrase`, a vault around
 * it. No mediator yet: how it is reached is decided afterwards
 * (`chooseMediator`).
 */
export async function createIdentity(name: string, passphrase: string): Promise<void> {
  await call((daemon) => daemon.createIdentity({ name, passphrase }));
  await begun();
}

export async function restoreIdentity(backup: Uint8Array, passphrase: string): Promise<void> {
  await call((daemon) => daemon.restoreIdentity({ backup, passphrase }));
  await begun();
}

/** A vault restored from what was pasted or scanned: a link another device made of its own, read and opened by the daemon, then restored as a backup is. */
export async function restoreFromLink(input: string, passphrase: string): Promise<void> {
  const link = parseSnapshotLink(input);
  await call((daemon) => daemon.restoreFromLink({ link, passphrase }));
  await begun();
}

/** A vault now here, minted or restored: whatever link the page was opened with has had its turn, and the browser is asked to keep the vault's files. */
async function begun(): Promise<void> {
  state.pendingSnapshotLink = null;
  state.persisted = state.daemonAt === null ? await persistStorage() : false;
}

/** The person has read what a restore cannot bring back: sending opens. */
export async function explainedRestore(): Promise<void> {
  await call((daemon) => daemon.explainedRestore({}));
  await refresh();
}

export async function unlock(passphrase: string): Promise<void> {
  await call((daemon) => daemon.unlock({ passphrase }));
}

/** Forget the cached seed; the vault stays, the passphrase is asked next time. */
export async function lock(): Promise<void> {
  await call((daemon) => daemon.lock({}));
}

/** The vault removed: the one under `hold`, read off the screen as the person was asked, and not one that took its place since. */
export async function forgetIdentity(hold: Hold | null): Promise<void> {
  if (hold === null) {
    throw new Error("no vault is held here to remove");
  }
  await call((daemon) => daemon.forgetIdentity({ hold }));
  state.log = [];
}

/**
 * Delete the folder-format vault an earlier version left in this
 * browser, with its cached seed, and come up again on what is left.
 * The daemon never touches that folder; the page is what removes it.
 */
export async function discardFolderVault(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(FOLDER_VAULT, { recursive: true });
  await forgetSeedKey();
  location.reload();
}

export async function downloadBackup(): Promise<void> {
  const held = heldNow();
  const anchor = openIndex()?.snapshot.anchor ?? null;
  const { name, bytes } = await call((daemon) => daemon.exportBackup({}), "This version has no way to back up a vault this size, or to move it to another device.");
  if (!held()) {
    log(`${name} was not saved: the vault it backs up is no longer the one here`);
    return;
  }
  saveFile(name, bytes);
  if (anchor !== null) markExported(anchor);
  log(`exported ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

/** The link a snapshot is handed over as: this deployment's origin, like an invitation's; another Estoc reads only the fragment. */
export function snapshotLinkOf(link: SnapshotLink): string {
  return snapshotLinkUrl(`${location.origin}${location.pathname}`, link);
}

/** This vault sealed and put at its mediator, for a new device to restore from the link. */
export async function publishSnapshotLink(): Promise<PublishedSnapshotLink> {
  const made = await call((daemon) => daemon.publishSnapshotLink({}), "A link cannot carry this vault: export a backup and restore the file on the new device instead.");
  log(`put a snapshot for a new device, kept until ${made.retainUntil}`);
  return made;
}

/** The snapshots this device put that its mediator may still keep, newest first. */
export async function snapshotLinks(): Promise<SnapshotLinkRecord[]> {
  return (await call((daemon) => daemon.snapshotLinks({}))).links.reverse();
}

export async function revokeSnapshotLink(hash: string): Promise<void> {
  await call((daemon) => daemon.revokeSnapshotLink({ hash }));
  log(`revoked the snapshot ${hash}`);
}

/** Merge a backup file into the open vault; the daemon goes on over the merged vault. */
export async function mergeBackup(backup: Uint8Array): Promise<MergeResult> {
  const merged = await call((daemon) => daemon.mergeBackup({ backup }));
  log(`merged a backup: ${merged.added} new event${merged.added === 1 ? "" : "s"}, ${merged.objects} object${merged.objects === 1 ? "" : "s"}`);
  return merged;
}

export async function chooseMediator(mediatorDid: string): Promise<void> {
  await call((daemon) => daemon.setMediator({ mediatorDid }));
}

/**
 * The link an invitation is handed over as: this deployment's origin, so
 * tapping it opens an Estoc, the one that issued it or any other; only
 * `_oob` matters to the app that opens it.
 */
function linkOf(invitation: Invitation): string {
  return invitationUrl(`${location.origin}${location.pathname}`, invitation);
}

/**
 * The link of an invitation the vault holds: the one it was made as while
 * this page remembers it, and otherwise one that says the same without
 * what it was for. A stranger resolves the DID from the link alone, so it
 * carries the long form the snapshot holds for the entity; null until it
 * does.
 */
export function invitationLink(record: InvitationRecord): string | null {
  const made = state.links[record.oobId];
  if (made !== undefined) return made;
  const longFormDid = openIndex()?.snapshot.dids.find((did) => did.didId === record.didId)?.longFormDid ?? null;
  return longFormDid === null ? null : linkOf(invitationOf(longFormDid, record.oobId, null));
}

/** A link to hand out: whoever opens it writes to a DID minted for this link, each in a conversation of their own. */
export async function createInvitation(): Promise<string> {
  const held = heldNow();
  const { invitation } = await call((daemon) => daemon.createInvitation({}));
  if (held()) state.links = { ...state.links, [invitation.id]: linkOf(invitation) };
  return invitation.id;
}

/** Say who we are: the name this vault goes by, which the peer holds as a claim of ours. */
async function introduceTo(target: SendTarget): Promise<void> {
  said("introduction", await call((daemon) => daemon.send({ target, content: profileMessage(openIndex()?.snapshot.label ?? "") })));
}

export const introduce = (channelId: ChannelId): Promise<void> => introduceTo({ channelId });

/**
 * Our introduction after the Ping that opened a contact: by the contact,
 * so it goes to whatever address the peer holds by the time it is sent.
 * The peer may already have answered from a private address that replaced
 * the one the Ping went to, and a send to the replaced one is refused.
 */
async function introduceAfterPing(contactId: ContactId): Promise<void> {
  try {
    await introduceTo({ contactId });
  } catch (err) {
    log(`the introduction was not sent: ${err instanceof Error ? err.message : err}`);
  }
}

/** The conversation of a contact just made, once the state that shows it is on screen; null when the vault shows none of it by then, or is not the one the contact was made in. */
async function conversationOf(held: () => boolean, contactId: ContactId): Promise<ConversationId | null> {
  await refresh();
  if (!held()) return null;
  return openIndex()?.contactConversation(contactId)?.id ?? null;
}

/**
 * Whether the vault that stood when a piece of work began has stood
 * since: false once another, or none, took its place, and false for
 * good. Work that waits asks before each step that sends, saves,
 * copies, navigates or writes shared state, and takes none once the
 * answer is no; what the daemon answers about what had reached it is
 * taken as it comes, and nothing is sent again.
 */
export function heldNow(): () => boolean {
  const began = turn;
  return () => turn === began;
}

/** Our introduction after the Ping that opened a contact, and the conversation it opened: each step in the vault the contact was made in. */
async function conversationOpened(held: () => boolean, contactId: ContactId): Promise<ConversationId | null> {
  if (!held()) return null;
  await introduceAfterPing(contactId);
  return conversationOf(held, contactId);
}

/**
 * Accept an invitation under the name we give its issuer: a DID of ours
 * for them alone, a contact that selects the pair, a Ping under the
 * invitation's ID, and our introduction after it. Returns the
 * conversation it opened.
 */
export async function acceptInvitation(input: string | Invitation, petname: string): Promise<ConversationId | null> {
  // what crosses to the daemon must be plain: a Vue proxy does not clone
  const invitation = typeof input === "string" ? parseInvitation(input) : toRaw(input);
  const held = heldNow();
  const accepted = await call((daemon) => daemon.acceptInvitation({ invitation, petname }));
  said("invitation accepted", accepted);
  if (state.pendingInvitation?.id === invitation.id) {
    state.pendingInvitation = null;
  }
  return conversationOpened(held, accepted.contactId);
}

/** A contact under the name we give them, by a DID they handed over on its own: our DID for them alone, a Ping, and our introduction after it. */
export async function addContactByDid(did: string, petname: string): Promise<ConversationId | null> {
  const held = heldNow();
  const added = await call((daemon) => daemon.addContactByDid({ did, petname }));
  said("contact added by DID", added);
  return conversationOpened(held, added.contactId);
}

/** Whatever was pasted for a person: their DID, or the invitation link they made for us. */
export async function addContactFrom(input: string, petname: string): Promise<ConversationId | null> {
  const trimmed = input.trim();
  if (trimmed.startsWith("did:")) return addContactByDid(trimmed, petname);
  let invitation: Invitation;
  try {
    invitation = parseInvitation(trimmed);
  } catch {
    throw new Error("That is neither a DID (did:…) nor an invitation link.");
  }
  return acceptInvitation(invitation, petname);
}

export function dismissPendingInvitation(): void {
  state.pendingInvitation = null;
}

/** The DID this vault hands out to anyone, as the snapshot shows it: the live one disclosed directly, or null before one is minted. */
export function handedOutDid(snapshot: Snapshot | null): string | null {
  const handedOut = snapshot?.dids.find((did) => did.live && did.disclosures.some((d) => d.as === "direct"));
  return handedOut?.longFormDid ?? null;
}

/** The DID this vault hands out to anyone, in the long form that carries its document; minted the first time it is asked for. */
export async function publicDid(): Promise<string> {
  return (await call((daemon) => daemon.publicDid({}))).did;
}

/** A name of ours for a conversation that has none: a contact that selects its channels; the conversation it becomes. */
export async function nameConversation(channelIds: ChannelId[], petname: string): Promise<ConversationId | null> {
  const held = heldNow();
  const { contactId } = await call((daemon) => daemon.createContact({ petname, channelIds }));
  return conversationOf(held, contactId);
}

export async function renameContact(contactId: ContactId, petname: string): Promise<void> {
  await call((daemon) => daemon.renameContact({ contactId, petname }));
}

export async function deleteContact(contactId: ContactId, options: { block: boolean; erase: boolean }): Promise<void> {
  await call((daemon) => daemon.deleteContact({ contactId, block: options.block ? { includeSuccessors: true } : null, erase: options.erase ? "the contact was deleted" : null }));
}

/** Refuse the channels and whatever their peers move to. */
export async function blockChannels(channelIds: ChannelId[]): Promise<void> {
  await call((daemon) => daemon.blockChannels({ channelIds, includeSuccessors: true }));
}

export async function eraseMessage(messageId: MessageId): Promise<void> {
  await call((daemon) => daemon.eraseMessage({ messageId }));
}

/** A line of chat, to a contact where its channels say which one, or in the channel picked. */
export async function sendMessage(target: SendTarget, text: string): Promise<void> {
  said("sent", await call((daemon) => daemon.send({ target, content: basicMessage(text) })));
}

export async function retry(messageId: MessageId): Promise<void> {
  said("retry", await call((daemon) => daemon.retry({ messageId })));
}

export async function cancel(messageId: MessageId): Promise<void> {
  said("cancel", await call((daemon) => daemon.cancel({ messageId })));
}

/** The sealed copy of a message this device sends from now on; sending it is a retry of its own. */
export async function selectPreparation(messageId: MessageId, preparationEventCid: EventCid): Promise<void> {
  said("copy chosen", await call((daemon) => daemon.selectPreparation({ messageId, preparationEventCid })));
}

export async function completeResponse(executionId: ExecutionId, effectType: string): Promise<void> {
  said(`reply ${effectType}`, await call((daemon) => daemon.completeResponse({ executionId, effectType })));
}

export async function completeNotification(rotationEventCid: EventCid): Promise<void> {
  said("rotation notification", await call((daemon) => daemon.completeNotification({ rotationEventCid })));
}

/** A fresh DID of ours in place of the one at our end of the channel, and the peer told. */
export async function rotate(channelId: ChannelId): Promise<void> {
  said("rotation", await call((daemon) => daemon.rotate({ channelId })));
}

export async function reconnect(): Promise<void> {
  await call((daemon) => daemon.reconnect({}));
}

/** Set what this device keeps of what it observes; a stricter level prunes at once. */
export async function setTraceLevel(level: TraceLevel): Promise<void> {
  const held = heldNow();
  const set = await call((daemon) => daemon.setTraceLevel({ level }));
  if (held()) state.traceLevel = set.level;
}
