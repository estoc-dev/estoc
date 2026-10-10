<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";

import { acceptInvitation, addContactFrom, createInvitation, dismissPendingInvitation, heldNow, invitationLink, openIndex, state } from "../core/store.js";
import type { Invitation } from "../core/types.js";
import Icon from "./Icon.vue";
import { invitationIn } from "./invitation-code.js";
import { back, go, swap } from "./nav.js";
import { qrSvgOf } from "./qr.js";
import { canScanQr, scanQr, type Scan } from "./scanner.js";
import Sheet from "./Sheet.vue";
import { useStatus } from "./status.js";

/**
 * How a conversation starts: a link of ours, shown as a QR code or
 * copied, or theirs for us, scanned or pasted, and accepted
 * under the name we give them; a DID they handed over on its own is
 * pasted the same way. A link this page was opened with is offered
 * here too.
 */
const { mediation } = useStatus();
const sendsClosed = computed(() => openIndex()?.snapshot.restoreUnexplained ?? false);
const ready = computed(() => mediation.value !== null && !sendsClosed.value);

type Mode = "menu" | "qr" | "scan" | "paste" | "accept";
const mode = ref<Mode>(state.pendingInvitation === null ? "menu" : "accept");
const error = ref<string | null>(null);

function close() {
  stopScan();
  back();
}

function show(next: Mode) {
  error.value = null;
  mode.value = next;
}

// our invitations: each a link anyone holding it may write to; the QR is the same link, for a phone
const openInvitations = computed(() => (openIndex()?.snapshot.invitations ?? []).filter((i) => i.state.status === "available"));
const inviting = ref(false);
const shownInvitation = ref<string | null>(null);
const copied = ref(false);
const readable = ref(false);

async function invite(then: "qr" | "copy") {
  error.value = null;
  inviting.value = true;
  const held = heldNow();
  try {
    shownInvitation.value = await createInvitation();
    if (!held()) return;
    show("qr");
    if (then === "copy" && shownUrl.value !== null) await copy(shownUrl.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviting.value = false;
  }
}

const shownRecord = computed(() => openIndex()?.snapshot.invitations.find((i) => i.oobId === shownInvitation.value) ?? null);
const shownUrl = computed(() => (shownRecord.value === null || shownRecord.value.state.status !== "available" ? null : invitationLink(shownRecord.value)));

// A link can outgrow what a QR code holds: its length follows the DID,
// and so the mediator's endpoints in it. The link is whole either way.
const qrSvg = computed(() => (shownUrl.value === null ? null : qrSvgOf(shownUrl.value)));

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    readable.value = true;
    error.value = "It could not be copied from here: select the link below and copy it yourself.";
  }
}

const selectAll = (event: Event) => (event.target as HTMLInputElement).select();

// theirs: pasted, scanned, or handed to this page as its URL
const name = ref("");
const link = ref("");
const accepting = ref(false);
const pending = computed(() => state.pendingInvitation);

async function accept(input: string | Invitation) {
  const label = name.value.trim();
  if (label === "") {
    error.value = "Give them a name first.";
    return;
  }
  accepting.value = true;
  error.value = null;
  const held = heldNow();
  try {
    const key = typeof input === "string" ? await addContactFrom(input, label) : await acceptInvitation(input, label);
    if (!held()) return;
    name.value = "";
    link.value = "";
    swap(key === null ? { kind: "list" } : { kind: "chat", key });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    accepting.value = false;
  }
}

function paste() {
  if (link.value.trim() === "") {
    error.value = "Paste the invitation link they made for you, or their DID.";
    return;
  }
  void accept(link.value.trim());
}

function notNow() {
  dismissPendingInvitation();
  close();
}

const video = ref<HTMLVideoElement | null>(null);
const scanned = ref<Invitation | null>(null);
let scan: Scan | null = null;

async function startScanning() {
  show("scan");
  await nextTick();
  const el = video.value;
  if (el === null) return;
  stopScan();
  scan = scanQr(
    el,
    (rawValue) => {
      const invitation = invitationIn(rawValue);
      if (invitation === null) return false;
      scanned.value = invitation;
      show("accept");
      return true;
    },
    () => (error.value = "The camera could not be opened. Paste their link instead.")
  );
}

function stopScan() {
  scan?.stop();
  scan = null;
}

onUnmounted(stopScan);

watch(pending, (invitation) => {
  if (invitation !== null) show("accept");
});

const offered = computed(() => scanned.value ?? pending.value);
</script>

<template>
  <Sheet label="New conversation" data-new-sheet @close="close">
    <template v-if="mode === 'menu'">
      <div class="sheet-title">New conversation</div>
      <p v-if="mediation === null" class="note error">
        Choose a mediator first, so that they can reach you.
        <button class="link" type="button" data-choose-one @click="go({ kind: 'you' })">Choose one</button>
      </p>
      <p v-else-if="sendsClosed" class="note error">Sending waits until you have read what the restore means, above your conversations.</p>
      <div class="section">
        <div class="eyebrow">Invite someone</div>
        <div class="group">
          <button class="row" type="button" :disabled="!ready || inviting" data-show-qr @click="invite('qr')">
            <Icon name="qr" class="chevron" style="color: var(--accent)" />
            <span class="row-main"><span>Show my QR code</span><span class="row-sub">for whoever is in front of you</span></span>
          </button>
          <button class="row" type="button" :disabled="!ready || inviting" data-copy-link @click="invite('copy')">
            <Icon name="link" class="chevron" style="color: var(--accent)" />
            <span class="row-main"><span>Copy an invitation link</span><span class="row-sub">sent any way you like</span></span>
          </button>
        </div>
      </div>
      <div class="section">
        <div class="eyebrow">Someone invited you</div>
        <div class="group">
          <button v-if="canScanQr" class="row" type="button" :disabled="!ready" data-scan @click="startScanning">
            <Icon name="scan" class="chevron" style="color: var(--accent)" />
            <span class="row-main">Scan their QR code</span>
          </button>
          <button class="row" type="button" :disabled="!ready" data-paste-link @click="show('paste')">
            <Icon name="paste" class="chevron" style="color: var(--accent)" />
            <span class="row-main"><span>Paste their link</span><span class="row-sub">or the DID they handed you</span></span>
          </button>
        </div>
      </div>
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="openInvitations.length" class="note" data-open-links>
        {{ openInvitations.length }} link{{ openInvitations.length === 1 ? "" : "s" }} of yours still open
        <template v-for="i in openInvitations" :key="i.oobId">
          ·
          <button class="link alone" type="button" @click="shownInvitation = i.oobId; show('qr')">show</button>
        </template>
      </p>
      <button class="btn-quiet" type="button" data-cancel @click="close">Cancel</button>
    </template>

    <template v-else-if="mode === 'qr'">
      <div class="sheet-title">Your invitation</div>
      <template v-if="shownUrl">
        <div v-if="qrSvg" class="qr" v-html="qrSvg"></div>
        <p v-else class="note" data-no-qr>This link is too long for a QR code. Copy it instead.</p>
        <button class="btn" type="button" :title="shownUrl" data-invitation-url @click="copy(shownUrl)">{{ copied ? "Copied" : "Copy the link" }}</button>
        <input v-if="readable" class="field mono" readonly :value="shownUrl" aria-label="The invitation link" data-invitation-text @focus="selectAll" />
        <p class="note">Whoever opens it and writes arrives as a new conversation; the link stays good for the next.</p>
      </template>
      <p v-else class="note">Minting…</p>
      <p v-if="error" class="error-text">{{ error }}</p>
      <button class="btn-quiet" type="button" data-done @click="show('menu')">Done</button>
    </template>

    <template v-else-if="mode === 'scan'">
      <div class="sheet-title">Scan their QR code</div>
      <video ref="video" muted playsinline style="width: 100%; border-radius: 12px; background: #000; aspect-ratio: 1"></video>
      <p v-if="error" class="error-text">{{ error }}</p>
      <button class="btn-quiet" type="button" @click="stopScan(); show('menu')">Cancel</button>
    </template>

    <template v-else-if="mode === 'paste'">
      <div class="sheet-title">Paste their link or DID</div>
      <form class="form" @submit.prevent="paste">
        <input v-model="name" class="field" placeholder="What you call them" autocomplete="off" data-contact-name />
        <input v-model="link" class="field" placeholder="Their invitation link, or their DID" autocomplete="off" data-invitation-link />
        <p v-if="error" class="error-text">{{ error }}</p>
        <button class="btn" type="submit" :disabled="accepting || !ready" data-accept>{{ accepting ? "Adding…" : "Add them" }}</button>
        <button class="btn-quiet" type="button" @click="show('menu')">Back</button>
      </form>
    </template>

    <template v-else-if="mode === 'accept' && offered">
      <div class="sheet-title">You were handed an invitation</div>
      <p class="note">
        <em v-if="offered.body.goal">“{{ offered.body.goal }}”. </em>Name them and add them: they see you arrive, and you each write from an address
        minted for the other alone.
      </p>
      <form class="form" @submit.prevent="accept(offered!)">
        <input v-model="name" class="field" placeholder="What you call them" autocomplete="off" data-contact-name />
        <p v-if="mediation === null" class="note error">
          Choose a mediator first: accepting writes to them.
          <button class="link" type="button" data-choose-one @click="go({ kind: 'you' })">Choose one</button>
        </p>
        <p v-if="error" class="error-text">{{ error }}</p>
        <button class="btn" type="submit" :disabled="accepting || !ready" data-accept>{{ accepting ? "Adding…" : "Accept invitation" }}</button>
        <button class="btn-quiet" type="button" data-not-now @click="notNow">Not now</button>
      </form>
    </template>

    <template v-else>
      <p class="note">Nothing to accept.</p>
      <button class="btn-quiet" type="button" @click="show('menu')">Back</button>
    </template>
  </Sheet>
</template>
