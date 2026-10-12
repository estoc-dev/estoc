<script setup lang="ts">
import { computed, ref } from "vue";

import { dismissPendingSnapshotLink, heldNow, importFromLink, state } from "../core/store.js";
import { mergedNote } from "./util.js";

/**
 * A snapshot link the page was opened with, where a vault is held
 * already: imported into the open vault once the person asks, and a
 * locked one is unlocked first.
 */
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
    <span>That link holds a copy of a vault. Unlock to import what it holds here.</span>
    <button class="link" type="button" @click="dismissPendingSnapshotLink(offered)">Not now</button>
  </div>

  <div v-else-if="offered" class="update-chip" data-opened-link>
    <span>That link holds a copy of a vault. Import what it holds into this one?</span>
    <button class="btn" type="button" data-import-opened-link @click="accept(offered)">Import</button>
    <button class="link" type="button" @click="dismissPendingSnapshotLink(offered)">Not now</button>
  </div>
</template>
