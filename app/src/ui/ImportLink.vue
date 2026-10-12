<script setup lang="ts">
import { ref } from "vue";
import { parseSnapshotLink } from "@estoc/daemon-api/views";

import { heldNow, importFromLink } from "../core/store.js";
import QrReader from "./QrReader.vue";
import { canScanQr } from "./scanner.js";
import { mergedNote } from "./util.js";

const open = ref(false);
const scanning = ref(false);
const text = ref("");
const importing = ref(false);
const note = ref<string | null>(null);
const failed = ref(false);

function toggle() {
  open.value = !open.value;
  scanning.value = false;
}

async function submit() {
  note.value = null;
  failed.value = false;
  if (text.value.trim() === "") {
    note.value = "Paste the link your other device made.";
    failed.value = true;
    return;
  }
  importing.value = true;
  const held = heldNow();
  try {
    const merged = await importFromLink(text.value);
    if (!held()) return;
    note.value = mergedNote(merged, "that copy");
    text.value = "";
    open.value = false;
  } catch (err) {
    if (!held()) return;
    note.value = err instanceof Error ? err.message : String(err);
    failed.value = true;
  } finally {
    importing.value = false;
  }
}

function takeScanned(rawValue: string): boolean {
  try {
    parseSnapshotLink(rawValue);
  } catch {
    return false;
  }
  text.value = rawValue;
  scanning.value = false;
  return true;
}

function cameraFailed() {
  scanning.value = false;
  note.value = "The camera could not be opened. Paste the link instead.";
  failed.value = true;
}
</script>

<template>
  <button class="row" type="button" :disabled="importing" data-import-link-open @click="toggle">
    <span class="row-main">
      <span>{{ importing ? "Importing…" : "Import from a link" }}</span>
      <span class="row-sub">what a copy made on another device holds is merged in</span>
    </span>
    <span class="row-end">{{ open ? "close" : "" }}</span>
  </button>
  <form v-if="open" class="form" style="padding: 4px 16px 16px" @submit.prevent="submit">
    <input v-model="text" class="field" placeholder="The link" autocomplete="off" aria-label="The link" data-import-link-input />
    <template v-if="canScanQr">
      <QrReader v-if="scanning" :take="takeScanned" @failed="cameraFailed" />
      <button class="link alone" type="button" style="align-self: flex-start" data-scan-import-link @click="scanning = !scanning">
        {{ scanning ? "Stop scanning" : "Scan its QR code" }}
      </button>
    </template>
    <button class="btn" type="submit" :disabled="importing" data-import-link>{{ importing ? "Importing…" : "Import" }}</button>
  </form>
  <p v-if="note" class="note" :class="{ 'error-text': failed }" style="padding: 0 16px 12px" data-import-link-note>{{ note }}</p>
</template>
