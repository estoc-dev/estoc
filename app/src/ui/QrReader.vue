<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import { scanQr, type Scan } from "./scanner.js";

/**
 * The back camera, read for a QR code for as long as this is on screen:
 * whatever takes it off the screen stops the camera with it.
 */
const props = defineProps<{
  /** a code read; true when it is the one looked for, which ends the scan */
  take: (rawValue: string) => boolean;
}>();
const emit = defineEmits<{ failed: [] }>();

const video = ref<HTMLVideoElement | null>(null);
let scan: Scan | null = null;

onMounted(() => {
  if (video.value !== null) scan = scanQr(video.value, props.take, () => emit("failed"));
});
onUnmounted(() => scan?.stop());
</script>

<template>
  <video ref="video" muted playsinline style="width: 100%; border-radius: 12px; background: #000; aspect-ratio: 1"></video>
</template>
