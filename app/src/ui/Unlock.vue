<script setup lang="ts">
import { ref } from "vue";

import { forgetDevice } from "../core/seen.js";
import { forgetIdentity, state, unlock } from "../core/store.js";
import { useUnconfirmed } from "./unconfirmed.js";

/** The vault is here with its seed sealed: the passphrase opens it, and nothing else does. */
const passphrase = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const { remove } = useUnconfirmed();

async function submit() {
  if (passphrase.value === "" || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await unlock(passphrase.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function forget() {
  const hold = state.hold;
  return remove("Delete this identity from this device? Its keys and messages here are gone for good. Only a backup brings them back.", async () => {
    await forgetIdentity(hold);
    forgetDevice();
  });
}
</script>

<template>
  <div class="hollow" data-locked>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Locked</h1>
      <p>The passphrase opens your vault.</p>
      <form class="form" @submit.prevent="submit">
        <input v-model="passphrase" class="field" type="password" placeholder="Passphrase" autocomplete="current-password" autofocus data-passphrase />
        <p v-if="error" class="error-text">{{ error }}</p>
        <button class="btn" type="submit" :disabled="busy || passphrase === ''" data-unlock>{{ busy ? "Opening…" : "Unlock" }}</button>
      </form>
      <p class="note">
        Forgot it? There is no reset. You can
        <button class="link" type="button" data-start-over @click="forget">start over</button>
        with a new identity.
      </p>
    </div>
  </div>
</template>
