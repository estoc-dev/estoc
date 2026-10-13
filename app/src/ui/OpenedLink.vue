<script setup lang="ts">
import { computed, ref } from "vue";

import { dismissPendingSnapshotLink, heldNow, importFromLink, state } from "../core/store.js";
import { mergedNote } from "./util.js";

const importing = ref(false);
const outcome = ref<{ text: string; failed: boolean } | null>(null);

const offered = computed(() => {
  const opened = state.pendingSnapshotLink;
  const { phase } = state.vault;
  return opened !== null && (phase === "open" || phase === "locked") ? opened : null;
});

async function accept(opened: { link: string }) {
  dismissPendingSnapshotLink(opened);
  importing.value = true;
  const held = heldNow();
  try {
    const merged = await importFromLink(opened.link);
    if (held()) outcome.value = { text: mergedNote(merged, "that copy"), failed: false };
  } catch (err) {
    if (held()) outcome.value = { text: `That link was not imported: ${err instanceof Error ? err.message : String(err)}`, failed: true };
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div v-if="outcome" class="update-chip" :class="{ alarm: outcome.failed }" data-opened-link-outcome>
    <span>{{ outcome.text }}</span>
    <button class="btn" type="button" @click="outcome = null">OK</button>
  </div>

  <div v-else-if="importing" class="update-chip" data-opened-link-importing>
    <span>Importing what that link holds…</span>
  </div>

  <div v-else-if="offered && 'unreadable' in offered" class="update-chip" data-snapshot-link-unusable>
    <span>The link this page was opened with cannot be used: {{ offered.unreadable }}.</span>
    <button class="btn" type="button" @click="dismissPendingSnapshotLink(offered)">OK</button>
  </div>

  <div v-else-if="offered && state.vault.phase === 'locked'" class="update-chip" data-opened-link-locked>
    <span>This page was opened with a link from another device. Unlock to import the history it holds.</span>
    <button class="link" type="button" @click="dismissPendingSnapshotLink(offered)">Not now</button>
  </div>

  <div v-else-if="offered" class="update-chip" data-opened-link>
    <span>This page was opened with a link from another device. Import the history it holds into this vault?</span>
    <button class="btn" type="button" data-import-opened-link @click="accept(offered)">Import</button>
    <button class="link" type="button" @click="dismissPendingSnapshotLink(offered)">Not now</button>
  </div>
</template>
