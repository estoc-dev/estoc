<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { heldNow, publishSnapshotLink, revokeSnapshotLink, snapshotLinkOf, snapshotLinks } from "../core/store.js";
import type { SnapshotLinkRecord } from "../core/types.js";
import { qrSvgOf } from "./qr.js";
import Sheet from "./Sheet.vue";
import { dateOf, timeOf } from "./util.js";

/**
 * A link to a copy of this vault, sealed under a key the link itself
 * carries: whoever holds the link reads the vault's messages, while the
 * seed inside the copy stays sealed under the passphrase.
 */
const emit = defineEmits<{ close: [] }>();

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const madeAt = (iso: string): string => `${dateOf(iso)}, ${timeOf(Date.parse(iso))}`;

const links = ref<SnapshotLinkRecord[] | null>(null);
/** why the list could not be read: what it shows is not what the daemon holds until it is read again */
const unlisted = ref<string | null>(null);
const error = ref<string | null>(null);

async function load(held: () => boolean) {
  try {
    const listed = await snapshotLinks();
    if (!held()) return;
    links.value = listed;
    unlisted.value = null;
  } catch (err) {
    if (held()) unlisted.value = reasonOf(err);
  }
}

onMounted(() => void load(heldNow()));

const making = ref(false);
const shownHash = ref<string | null>(null);

// A publish or revoke that fails can still have changed what the
// mediator holds (an upload cut short leaves its pending link behind):
// the list is read again whatever came of it.
async function make() {
  making.value = true;
  error.value = null;
  const held = heldNow();
  try {
    const made = await publishSnapshotLink();
    if (held()) shownHash.value = made.hash;
  } catch (err) {
    if (held()) error.value = reasonOf(err);
  }
  await load(held);
  making.value = false;
}

const revoking = ref<string | null>(null);

async function revoke(hash: string) {
  revoking.value = hash;
  error.value = null;
  const held = heldNow();
  try {
    await revokeSnapshotLink(hash);
    if (held() && shownHash.value === hash) shownHash.value = null;
  } catch (err) {
    if (held()) error.value = reasonOf(err);
  }
  await load(held);
  revoking.value = null;
}

const reloading = ref(false);

async function reload() {
  reloading.value = true;
  await load(heldNow());
  reloading.value = false;
}

const shown = computed(() => {
  const record = links.value?.find((link) => link.hash === shownHash.value);
  return record?.status === "published" ? record : null;
});
const shownUrl = computed(() => (shown.value === null ? null : snapshotLinkOf(shown.value.link)));
const qrSvg = computed(() => (shownUrl.value === null ? null : qrSvgOf(shownUrl.value)));

function show(hash: string) {
  shownHash.value = hash;
  copied.value = false;
  readable.value = false;
}

const copied = ref(false);
const readable = ref(false);

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    readable.value = true;
  }
}

const selectAll = (event: Event) => (event.target as HTMLInputElement).select();
</script>

<template>
  <Sheet label="Add a device" data-add-device-sheet @close="emit('close')">
    <div class="sheet-title">Add a device</div>

    <template v-if="shown && shownUrl">
      <div v-if="qrSvg" class="qr" v-html="qrSvg" data-snapshot-qr></div>
      <p v-else class="note">This link is too long for a QR code. Copy it instead.</p>
      <button class="btn" type="button" :title="shownUrl" data-snapshot-url @click="copy(shownUrl)">{{ copied ? "Copied" : "Copy the link" }}</button>
      <input v-if="readable" class="field mono" readonly :value="shownUrl" aria-label="The link" data-snapshot-text @focus="selectAll" />
      <p v-if="readable" class="note">It could not be copied from here: select the link above and copy it yourself.</p>
      <p class="note">
        On the new device, open this link or scan the code, then type this vault's passphrase. It works until {{ dateOf(shown.retainUntil) }}<template
          v-if="shown.revocable"
          >, or until you revoke it</template
        >.
      </p>
      <button class="btn-quiet" type="button" data-snapshot-done @click="shownHash = null">Done</button>
    </template>

    <template v-else>
      <p class="note">
        A link to a sealed copy of this vault, kept at your mediator. The new device starts from this vault as it is now: what happens here afterwards does
        not reach it.
      </p>
      <button class="btn" type="button" :disabled="making" data-make-snapshot-link @click="make">{{ making ? "Sealing and uploading…" : "Make a link" }}</button>
      <p class="note">Whoever holds the link can read your messages until it expires or you revoke it. Your keys stay sealed under the passphrase.</p>

      <p v-if="unlisted" class="error-text" data-snapshot-links-unread>
        The links made here could not be read: {{ unlisted }}.
        <button class="link" type="button" :disabled="reloading" data-reload-snapshot-links @click="reload">Read them again</button>
      </p>
      <div v-else-if="links && links.length" class="section" data-snapshot-links>
        <div class="eyebrow">Links made here</div>
        <div class="group">
          <div v-for="link in links" :key="link.hash" class="row" :data-snapshot-link="link.status">
            <span class="row-main">
              <span>{{ link.status === "published" ? "A link" : "An unfinished link" }}</span>
              <span v-if="link.status === 'pending'" class="row-sub">started {{ madeAt(link.placedAt) }}: revoke it to free what the mediator holds of it</span>
              <span v-else class="row-sub">
                made {{ madeAt(link.placedAt) }} · works until {{ dateOf(link.retainUntil)
                }}<template v-if="!link.revocable">. It was made under an earlier ID of this device, which alone could revoke it.</template>
              </span>
            </span>
            <span class="row-end card-actions">
              <button v-if="link.status === 'published'" class="link alone" type="button" data-show-snapshot-link @click="show(link.hash)">show</button>
              <button
                v-if="link.status === 'pending' || link.revocable"
                class="link alone danger"
                type="button"
                :disabled="revoking !== null"
                data-revoke-snapshot-link
                @click="revoke(link.hash)"
              >
                {{ revoking === link.hash ? "revoking…" : "revoke" }}
              </button>
            </span>
          </div>
        </div>
      </div>
    </template>

    <p v-if="error" class="error-text" data-add-device-error>{{ error }}</p>
    <button v-if="!shown" class="btn-quiet" type="button" data-add-device-close @click="emit('close')">Close</button>
  </Sheet>
</template>
