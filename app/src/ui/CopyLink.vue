<script setup lang="ts">
import { ref } from "vue";

import { heldNow, publishSnapshotLink } from "../core/store.js";
import type { PublishedSnapshotLink } from "../core/types.js";
import Sheet from "./Sheet.vue";
import ShownLink from "./ShownLink.vue";

const making = ref(false);
const note = ref<string | null>(null);
const shown = ref<PublishedSnapshotLink | null>(null);

async function make() {
  making.value = true;
  note.value = null;
  const held = heldNow();
  try {
    const made = await publishSnapshotLink("content");
    if (held()) shown.value = made;
  } catch (err) {
    if (held()) note.value = err instanceof Error ? err.message : String(err);
  } finally {
    making.value = false;
  }
}
</script>

<template>
  <button class="row" type="button" :disabled="making" data-make-copy-link @click="make">
    <span class="row-main">
      <span>{{ making ? "Sealing and uploading…" : "Put your history on a link" }}</span>
      <span class="row-sub">for a device of yours to import; whoever holds the link reads your messages</span>
    </span>
  </button>
  <p v-if="note" class="note error-text" style="padding: 0 16px 12px" data-copy-link-note>{{ note }}</p>
  <Sheet v-if="shown" label="Your history on a link" data-copy-link-sheet @close="shown = null">
    <div class="sheet-title">Your history on a link</div>
    <ShownLink :shown="shown" @done="shown = null">
      <p class="note">It is listed under You › Add a device, to show again or revoke.</p>
    </ShownLink>
  </Sheet>
</template>
