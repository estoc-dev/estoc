<script setup lang="ts">
import { computed, ref } from "vue";

import { snapshotLinkOf } from "../core/store.js";
import type { PublishedSnapshotLink } from "../core/types.js";
import { qrSvgOf } from "./qr.js";
import { dateOf } from "./util.js";

/** A link this device made, to hand over: as a QR code and as text, with what to do with it on the other device and until when it works; the slot says more before Done. */
const props = defineProps<{ shown: PublishedSnapshotLink }>();
const emit = defineEmits<{ done: [] }>();

const url = computed(() => snapshotLinkOf(props.shown.link));
const qrSvg = computed(() => qrSvgOf(url.value));

const copied = ref(false);
const readable = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(url.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    readable.value = true;
  }
}

const selectAll = (event: Event) => (event.target as HTMLInputElement).select();
</script>

<template>
  <div v-if="qrSvg" class="qr" v-html="qrSvg" data-snapshot-qr></div>
  <p v-else class="note">This link is too long for a QR code. Copy it instead.</p>
  <button class="btn" type="button" :title="url" data-snapshot-url @click="copy">{{ copied ? "Copied" : "Copy the link" }}</button>
  <input v-if="readable" class="field mono" readonly :value="url" aria-label="The link" data-snapshot-text @focus="selectAll" />
  <p v-if="readable" class="note">It could not be copied from here: select the link above and copy it yourself.</p>
  <p v-if="shown.part === 'seed'" class="note" data-shown-part="seed">
    On the new device, open this link or scan the code, then type this vault's passphrase. It joins as one more device of yours and receives from then on. Once it
    has, it shows up under You › Your devices here: send it your conversations so far from there.
  </p>
  <p v-else class="note" data-shown-part="content">
    On a device of yours, open this link or scan the code, or paste it under You › Import from a link: the history it holds is merged into the vault there.
  </p>
  <p class="note">
    It works until {{ dateOf(shown.retainUntil) }}<template v-if="shown.revocable">, or until you revoke it</template>.
  </p>
  <slot />
  <button class="btn-quiet" type="button" data-snapshot-done @click="emit('done')">Done</button>
</template>
