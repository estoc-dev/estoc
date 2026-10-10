<script setup lang="ts">
import { computed } from "vue";

import { discardFolderVault, dismissPendingSnapshotLink, forgetIdentity, state } from "./core/store.js";
import Onboarding from "./ui/Onboarding.vue";
import Shell from "./ui/Shell.vue";
import Unlock from "./ui/Unlock.vue";
import { useUnconfirmed } from "./ui/unconfirmed.js";

const { unconfirmed, remove, dismiss } = useUnconfirmed();
const removeVault = (question: string) => {
  const hold = state.vault.hold;
  return remove(question, () => forgetIdentity(hold));
};

const startOver = () => remove("Delete the old vault from this device? Only a backup made by the version that wrote it brings it back.", discardFolderVault);
const removeUnreadable = () => removeVault("Remove this vault from here and begin a new identity? Nothing of it can be exported by this version. What you keep is what a backup holds.");
const removeDamaged = () => removeVault("Remove the damaged vault from here? It cannot be opened again afterwards. What you keep is what your backup holds.");

const daemonHost = computed(() => (state.daemonAt === null ? "its origin" : new URL(state.daemonAt).host));
/** A daemon over a socket that has never answered this page: nothing to show but that. */
const unreachable = computed(() => state.vault.phase === "booting" && state.away !== null);
const incompatible = computed(() => (state.connection.state === "incompatible" ? state.connection.message : null));
/** A link to restore a vault from, opened where a vault is held already: it is kept for the screen that restores one, should this vault be removed. */
const snapshotLinkUnusable = computed(() => state.pendingSnapshotLink !== null && (state.vault.phase === "open" || state.vault.phase === "locked"));
</script>

<template>
  <div v-if="incompatible !== null" class="hollow" data-incompatible>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Another version of the daemon</h1>
      <p>This page and the daemon at {{ daemonHost }} speak different versions of the API: {{ incompatible }}</p>
      <p class="note">Update <code>estoc-daemon</code> and open its link again. <code>?_daemon=off</code> returns this page to a vault of its own in the browser.</p>
    </div>
  </div>

  <div v-else-if="unreachable" class="hollow" data-unreachable>
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

  <div v-else-if="state.fileSystemRefused !== null" class="hollow" data-file-system-refused>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>No room for a vault in this window</h1>
      <p>Estoc keeps your vault in files the browser sets aside for this page, and this window refuses them: {{ state.fileSystemRefused }}</p>
      <p class="note">
        Firefox does this in a private window. Open Estoc in a regular window, or run <code>estoc serve</code> and open the link it prints: its daemon keeps the
        vault on this computer, and the window only shows it.
      </p>
    </div>
  </div>

  <div v-else-if="state.vault.phase === 'booting'" class="hollow"></div>

  <div v-else-if="state.vault.phase === 'elsewhere'" class="hollow" data-elsewhere>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Open in another tab</h1>
      <p>Another tab of this browser holds your vault. Close it and this one takes over on its own.</p>
    </div>
  </div>

  <Onboarding v-else-if="state.vault.phase === 'onboarding'" />

  <div v-else-if="state.vault.phase === 'foreign'" class="hollow" data-foreign>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Vault not readable</h1>
      <p>This version of the app cannot open what is here{{ state.vault.detail === null ? "." : `: ${state.vault.detail}` }}</p>
      <p class="note">
        Nothing has been changed. A vault of the earlier folder format is not converted: export a backup with the version that wrote it if you want to keep
        it<template v-if="state.daemonAt === null">, then <button class="link" type="button" data-start-over @click="startOver">start over</button> with a new identity</template>.
      </p>
    </div>
  </div>

  <div v-else-if="state.vault.phase === 'unreadable'" class="hollow" data-unreadable>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Vault not readable</h1>
      <p>This version of the app cannot open what is here{{ state.vault.detail === null ? "." : `: ${state.vault.detail}` }}</p>
      <p class="note">
        Nothing has been changed. If the vault came from a newer version, update the app. One written by an earlier version is not converted, and nothing of it
        can be exported from here: <button class="link" type="button" data-remove-unreadable @click="removeUnreadable">remove it and start over</button> with a new
        identity, or restore a backup on the screen that follows.
      </p>
    </div>
  </div>

  <div v-else-if="state.vault.phase === 'damaged'" class="hollow" data-damaged>
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>This vault's history is damaged</h1>
      <p>Part of what this vault recorded no longer reads back as it was written{{ state.vault.detail === null ? "." : `: ${state.vault.detail}` }}</p>
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

  <Unlock v-else-if="state.vault.phase === 'locked'" />

  <!-- keyed by the vault held: another vault in its place gets screens of its own, with nothing entered on the old one's -->
  <Shell v-else-if="state.vault.phase === 'open'" :key="state.vault.hold" />

  <div v-if="state.applyUpdate" class="update-chip" data-update>
    <span>A new version of Estoc is ready.</span>
    <button class="btn" type="button" @click="state.applyUpdate?.()">Reload</button>
  </div>

  <div v-if="snapshotLinkUnusable" class="update-chip" data-snapshot-link-unusable>
    <span>That link restores a vault on a device with none, and this one holds a vault already.</span>
    <button class="btn" type="button" @click="dismissPendingSnapshotLink">OK</button>
  </div>

  <div v-if="unconfirmed" class="update-chip alarm" data-unconfirmed>
    <span>{{ unconfirmed.what }} was not confirmed: {{ unconfirmed.because }}</span>
    <button class="btn" type="button" @click="dismiss">OK</button>
  </div>
</template>
