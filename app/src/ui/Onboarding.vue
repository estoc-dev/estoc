<script setup lang="ts">
import { ref } from "vue";

import { createIdentity, restoreIdentity, state } from "../core/store.js";
import { bytesOf } from "./util.js";

/**
 * First run: mint an identity here, or restore one from a backup file.
 * Both end in the same place, a vault in this browser with its seed
 * sealed under the passphrase typed here. Being reachable comes after,
 * on the You screen.
 */
const mode = ref<"create" | "restore">("create");

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
const restorePass = ref("");
const restoring = ref(false);
const restoreError = ref<string | null>(null);

function pickBackup(event: Event) {
  backupFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function restore() {
  restoreError.value = null;
  if (backupFile.value === null) {
    restoreError.value = "Choose the backup file first.";
    return;
  }
  restoring.value = true;
  try {
    await restoreIdentity(await bytesOf(backupFile.value), restorePass.value);
  } catch (err) {
    restoreError.value = err instanceof Error ? err.message : String(err);
  } finally {
    restoring.value = false;
  }
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
        <button class="tab" :class="{ active: mode === 'restore' }" type="button" data-tab-restore @click="mode = 'restore'">Restore a backup</button>
      </div>

      <form v-if="mode === 'create'" class="form" @submit.prevent="create">
        <input v-model="name" class="field" placeholder="Your name" autocomplete="nickname" data-name />
        <input v-model="passphrase" class="field" type="password" placeholder="Passphrase" autocomplete="new-password" data-passphrase />
        <input v-model="confirmPass" class="field" type="password" placeholder="Passphrase again" autocomplete="new-password" data-passphrase-again />
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <button class="btn" type="submit" :disabled="creating" data-create>{{ creating ? "Minting…" : "Create identity" }}</button>
        <p class="note">The passphrase seals your seed and is the one thing that opens it. There is no reset. A mediator is chosen once you are in.</p>
      </form>

      <form v-else class="form" @submit.prevent="restore">
        <input class="field" type="file" accept=".sqlite,application/vnd.sqlite3" data-backup-file @change="pickBackup" />
        <input v-model="restorePass" class="field" type="password" placeholder="The backup's passphrase" autocomplete="current-password" data-backup-passphrase />
        <p v-if="restoreError" class="error-text">{{ restoreError }}</p>
        <button class="btn" type="submit" :disabled="restoring" data-restore>{{ restoring ? "Restoring…" : "Restore" }}</button>
        <p class="note">A backup brings back the moment it was made and nothing after it. What that means for your conversations is explained before anything is sent.</p>
      </form>
    </div>
  </div>
</template>
