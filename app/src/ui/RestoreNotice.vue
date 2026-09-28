<script setup lang="ts">
import { ref } from "vue";

import { explainedRestore } from "../core/store.js";

/**
 * Shown over a vault restored from a backup until the person says they
 * have read it. Until then the daemon refuses what the person would
 * send: a message, accepting an invitation, a rotation, and sending
 * again or completing by hand. Receiving goes on underneath, with the
 * acknowledgements it answers by itself, and steps that send nothing,
 * such as cancelling, stay open.
 */
const busy = ref(false);
const failure = ref<string | null>(null);
const more = ref(false);

async function understood() {
  busy.value = true;
  try {
    await explainedRestore();
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card" data-restore-notice>
    <div class="eyebrow">Restored from a backup</div>
    <p>This vault is the backup as it was taken, and nothing after. Sending stays closed until you have read what that means.</p>
    <template v-if="more">
      <p class="note">
        Addresses you minted since the backup, addresses your contacts moved to since, and what tied old ones to new ones are not in it. Mail to or from
        such an address is discarded on arrival; the Needs you page lists what was turned away. If this vault and another copy both rotate an address
        from here, the conversation has no current channel until one of you starts a fresh one. Importing a newer backup closes the gap; failing that, a
        new invitation does.
      </p>
      <p class="note">
        Messages the backup holds as unsent are not sent on their own: each waits under Needs you. The backup file is readable by anyone who has it: the
        passphrase seals the seed, not the history.
      </p>
    </template>
    <button v-else class="link" type="button" style="align-self: flex-start" @click="more = true">What a restore cannot bring back</button>
    <p v-if="failure" class="error-text">{{ failure }}</p>
    <div class="card-actions">
      <button class="btn small" type="button" :disabled="busy" data-restore-understood @click="understood">I understand, open sending</button>
    </div>
  </div>
</template>
