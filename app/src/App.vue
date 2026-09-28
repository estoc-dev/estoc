<script setup lang="ts">
import { computed } from "vue";

import { discardFolderVault, forgetIdentity, state } from "./core/store.js";
import Onboarding from "./ui/Onboarding.vue";
import Shell from "./ui/Shell.vue";
import Unlock from "./ui/Unlock.vue";

function startOver() {
  if (confirm("Delete the old vault from this browser? Only a backup made by the version that wrote it brings it back.")) {
    void discardFolderVault();
  }
}

function removeDamaged() {
  if (confirm("Remove the damaged vault from here? It cannot be opened again afterwards. What you keep is what your backup holds.")) {
    void forgetIdentity();
  }
}

const daemonHost = computed(() => (state.daemonAt === null ? "its origin" : new URL(state.daemonAt).host));
</script>

<template>
  <div v-if="state.phase === 'booting'" class="hollow"></div>

  <div v-else-if="state.phase === 'elsewhere'" class="hollow" data-elsewhere>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Open in another tab</h1>
      <p>Another tab of this browser holds your vault. Close it and this one takes over on its own.</p>
    </div>
  </div>

  <Onboarding v-else-if="state.phase === 'onboarding'" />

  <div v-else-if="state.phase === 'unreadable'" class="hollow" data-unreadable>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Vault not readable</h1>
      <p>This version of the app cannot open what is here{{ state.phaseDetail === null ? "." : `: ${state.phaseDetail}` }}</p>
      <p class="note">
        Nothing has been changed. If it came from a newer version, update the app. A vault of the earlier folder format is not converted: export a backup with the
        version that wrote it<template v-if="state.daemonAt === null">, then <button class="link" type="button" data-start-over @click="startOver">start over</button></template>.
      </p>
    </div>
  </div>

  <div v-else-if="state.phase === 'damaged'" class="hollow" data-damaged>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>This vault's history is damaged</h1>
      <p>Part of what this vault recorded no longer reads back as it was written{{ state.phaseDetail === null ? "." : `: ${state.phaseDetail}` }}</p>
      <p>The vault has stopped: it takes nothing in and sends nothing, rather than build on a history with a hole in it. Nothing here has been changed.</p>
      <p class="note">
        The history comes back one way: by restoring a backup into a new vault. What the backup holds is what returns. The seed is in every backup, and the passphrase
        still opens it there.
      </p>
      <p class="note">
        To restore, <button class="link" type="button" data-remove-damaged @click="removeDamaged">remove the damaged vault</button> and choose the backup on the
        screen that follows.
      </p>
    </div>
  </div>

  <Unlock v-else-if="state.phase === 'locked'" />

  <div v-else-if="state.phase === 'unreachable'" class="hollow" data-unreachable>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>No daemon is answering</h1>
      <p>This page expects a daemon at {{ daemonHost }} and nothing there answers. It keeps trying.</p>
      <p class="note">
        If <code>estoc serve</code> is running, open the link it printed: it carries the key this page needs, and the page remembers it. <code>?_daemon=off</code>
        returns this page to a vault of its own in the browser.
      </p>
    </div>
  </div>

  <Shell v-else-if="state.snapshot" />

  <div v-if="state.applyUpdate" class="update-chip" data-update>
    <span>A new version of Estoc is ready.</span>
    <button class="btn" type="button" @click="state.applyUpdate?.()">Reload</button>
  </div>
</template>
