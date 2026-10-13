<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { downloadBackup, heldNow, publishSnapshotLink, revokeSnapshotLink, snapshotLinks } from "../core/store.js";
import type { SnapshotLinkRecord, SnapshotPart } from "../core/types.js";
import Sheet from "./Sheet.vue";
import ShownLink from "./ShownLink.vue";
import { dateOf, timeOf } from "./util.js";

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
/** the link could not be made: a backup file is the other way to the new device */
const unmade = ref(false);
const shownHash = ref<string | null>(null);

// A publish or revoke that fails can still have changed what the
// mediator holds (an upload cut short leaves its pending link behind):
// the list is read again whatever came of it.
async function make() {
  making.value = true;
  error.value = null;
  unmade.value = false;
  const held = heldNow();
  try {
    const made = await publishSnapshotLink("seed");
    if (held()) shownHash.value = made.hash;
  } catch (err) {
    if (held()) {
      error.value = reasonOf(err);
      unmade.value = true;
    }
  }
  await load(held);
  making.value = false;
}

const exporting = ref(false);

async function exportBackup() {
  exporting.value = true;
  error.value = null;
  try {
    await downloadBackup();
  } catch (err) {
    error.value = reasonOf(err);
  } finally {
    exporting.value = false;
  }
}

const NAMES: Record<SnapshotPart, string> = { seed: "A link for a new device", content: "A copy of your history" };

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
</script>

<template>
  <Sheet label="Add a device" data-add-device-sheet @close="emit('close')">
    <div class="sheet-title">Add a device</div>

    <ShownLink v-if="shown" :key="shown.hash" :shown="shown" @done="shownHash = null" />

    <template v-else>
      <p class="note">
        A link a new device joins with: your name and your mediator, not your conversations. It registers at the mediator and receives from then on. Once it has
        joined, send it your conversations from You › Your devices.
      </p>
      <button class="btn" type="button" :disabled="making" data-make-snapshot-link @click="make">
        {{ making ? "Sealing and uploading…" : "Make a link" }}
      </button>
      <p class="note">Your keys stay sealed under the passphrase.</p>

      <p v-if="error" class="error-text" data-add-device-error>{{ error }}</p>
      <template v-if="unmade">
        <p class="note">Or take a backup file to the new device and restore from it there, under the same passphrase: it joins as well, holding your conversations as they were when exported.</p>
        <button class="btn-quiet" type="button" :disabled="exporting" data-add-device-export @click="exportBackup">
          {{ exporting ? "Exporting…" : "Export a backup instead" }}
        </button>
      </template>

      <p v-if="unlisted" class="error-text" data-snapshot-links-unread>
        The links made here could not be read: {{ unlisted }}.
        <button class="link" type="button" :disabled="reloading" data-reload-snapshot-links @click="reload">Read them again</button>
      </p>
      <div v-else-if="links && links.length" class="section" data-snapshot-links>
        <div class="eyebrow">Links made here</div>
        <div class="group">
          <div v-for="link in links" :key="link.hash" class="row" :data-snapshot-link="link.status" :data-snapshot-part="link.part">
            <span class="row-main">
              <span>{{ NAMES[link.part] }}{{ link.status === "pending" ? ", unfinished" : "" }}</span>
              <span v-if="link.status === 'pending'" class="row-sub">started {{ madeAt(link.placedAt) }}: revoke it to free what the mediator holds of it</span>
              <span v-else class="row-sub">
                made {{ madeAt(link.placedAt) }} · works until {{ dateOf(link.retainUntil)
                }}<template v-if="!link.revocable">. It was made under an earlier ID of this device, which alone could revoke it.</template>
              </span>
            </span>
            <span class="row-end card-actions">
              <button v-if="link.status === 'published'" class="link alone" type="button" data-show-snapshot-link @click="shownHash = link.hash">show</button>
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
      <button class="btn-quiet" type="button" data-add-device-close @click="emit('close')">Close</button>
    </template>
  </Sheet>
</template>
