<script setup lang="ts">
import { ref, watch } from "vue";
import { parseSnapshotLink } from "@estoc/daemon-api/views";

import { createIdentity, heldNow, restoreFromLink, restoreIdentity, state } from "../core/store.js";
import QrReader from "./QrReader.vue";
import { canScanQr } from "./scanner.js";
import { bytesOf } from "./util.js";

/**
 * First run: mint an identity here, or restore one from a backup file
 * or from a link another device of this vault made. All end in the same
 * place, a vault in this browser with its seed sealed under the
 * passphrase typed here. Being reachable comes after, on the You screen.
 */
// `scan` is the Restore tab with the camera reading for a link.
const mode = ref<"create" | "restore" | "scan">("create");

const name = ref("");
const passphrase = ref("");
const confirmPass = ref("");
const creating = ref(false);
const createError = ref<string | null>(null);

async function create() {
  createError.value = null;
  const label = name.value.trim();
  if (label === "") {
    createError.value = "Give yourself a name. It is what contacts see.";
    return;
  }
  if (passphrase.value.length < 8) {
    createError.value = "Use a passphrase of at least 8 characters.";
    return;
  }
  if (passphrase.value !== confirmPass.value) {
    createError.value = "The two passphrases differ.";
    return;
  }
  creating.value = true;
  try {
    await createIdentity(label, passphrase.value);
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err);
  } finally {
    creating.value = false;
  }
}

const backupFile = ref<File | null>(null);
const snapshotLink = ref("");
const restorePass = ref("");
const restoring = ref(false);
const restoreError = ref<string | null>(null);

watch(
  () => state.pendingSnapshotLink,
  (opened) => {
    if (opened === null) return;
    mode.value = "restore";
    if ("link" in opened) {
      snapshotLink.value = opened.link;
      restoreError.value = null;
    } else {
      snapshotLink.value = "";
      restoreError.value = `The link this page was opened with cannot be used: ${opened.unreadable}. Open it again, or paste it here.`;
    }
  },
  { immediate: true }
);

function pickBackup(event: Event) {
  backupFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function restore() {
  restoreError.value = null;
  const link = snapshotLink.value.trim();
  if (backupFile.value === null && link === "") {
    restoreError.value = "Choose the backup file, or paste the link your other device made.";
    return;
  }
  if (backupFile.value !== null && link !== "") {
    restoreError.value = "Restore from the file or from the link, not both: clear one of them.";
    return;
  }
  restoring.value = true;
  try {
    if (backupFile.value === null) {
      await restoreFromLink(link, restorePass.value);
      return;
    }
    const held = heldNow();
    const backup = await bytesOf(backupFile.value);
    if (!held()) return;
    await restoreIdentity(backup, restorePass.value);
  } catch (err) {
    restoreError.value = err instanceof Error ? err.message : String(err);
  } finally {
    restoring.value = false;
  }
}

function toggleScan() {
  restoreError.value = null;
  mode.value = mode.value === "scan" ? "restore" : "scan";
}

function takeScanned(rawValue: string): boolean {
  try {
    parseSnapshotLink(rawValue);
  } catch {
    return false;
  }
  snapshotLink.value = rawValue;
  mode.value = "restore";
  return true;
}

function cameraFailed() {
  mode.value = "restore";
  restoreError.value = "The camera could not be opened. Paste the link instead.";
}
</script>

<template>
  <div class="hollow" data-onboarding>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Your messages, <em>your</em> keeping</h1>
      <p>Your identity is minted here, from one seed. Your messages stay here, in a vault you can export as one file and take with you.</p>
      <p v-if="state.away" class="error-text">{{ state.away }}</p>

      <div class="tabs">
        <button class="tab" :class="{ active: mode === 'create' }" type="button" data-tab-create @click="mode = 'create'">New identity</button>
        <button class="tab" :class="{ active: mode !== 'create' }" type="button" data-tab-restore @click="mode = 'restore'">Restore</button>
      </div>

      <form v-if="mode === 'create'" class="form" @submit.prevent="create">
        <input v-model="name" class="field" placeholder="Your name" autocomplete="nickname" data-your-name />
        <input v-model="passphrase" class="field" type="password" placeholder="Passphrase" autocomplete="new-password" data-passphrase />
        <input v-model="confirmPass" class="field" type="password" placeholder="Passphrase again" autocomplete="new-password" data-passphrase-again />
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <button class="btn" type="submit" :disabled="creating" data-create>{{ creating ? "Minting…" : "Create identity" }}</button>
        <p class="note">The passphrase seals your seed and is the one thing that opens it. There is no reset. A mediator is chosen once you are in.</p>
      </form>

      <form v-else class="form" @submit.prevent="restore">
        <label class="note" for="backup-file">From a backup file</label>
        <input id="backup-file" class="field" type="file" accept=".sqlite,application/vnd.sqlite3" data-backup-file @change="pickBackup" />
        <label class="note" for="snapshot-link">Or from a link your other device made (You › Add a device)</label>
        <input id="snapshot-link" v-model="snapshotLink" class="field" placeholder="The link" autocomplete="off" data-snapshot-link-input />
        <template v-if="canScanQr">
          <QrReader v-if="mode === 'scan'" :take="takeScanned" @failed="cameraFailed" />
          <button class="link alone" type="button" style="align-self: flex-start" data-scan-snapshot-link @click="toggleScan">
            {{ mode === "scan" ? "Stop scanning" : "Scan its QR code" }}
          </button>
        </template>
        <input v-model="restorePass" class="field" type="password" placeholder="The vault's passphrase" autocomplete="current-password" data-backup-passphrase />
        <p v-if="restoreError" class="error-text">{{ restoreError }}</p>
        <button class="btn" type="submit" :disabled="restoring" data-restore>{{ restoring ? "Restoring…" : "Restore" }}</button>
        <p class="note">
          A backup or a link brings back the moment it was made and nothing after it. What that means for your conversations is explained before anything is
          sent.
        </p>
      </form>
    </div>
  </div>
</template>
