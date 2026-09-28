<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * A sheet over the screen, modal the browser's own way: it takes the
 * keyboard focus when it opens, leaves nothing behind it to act on,
 * closes on Escape or a tap outside, and hands the focus back to where
 * it came from. Tab past its last control comes round to the first,
 * rather than out to the browser's own bar.
 */
defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();

const el = ref<HTMLDialogElement | null>(null);
let leaving = false;

onMounted(() => el.value?.showModal());
onBeforeUnmount(() => {
  leaving = true;
  el.value?.close();
});

function closed() {
  if (!leaving) emit("close");
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function keydown(event: KeyboardEvent) {
  const dialog = el.value;
  if (event.key !== "Tab" || dialog === null) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((control) => control.offsetParent !== null);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function tapped(event: MouseEvent) {
  const dialog = el.value;
  if (dialog === null || event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  if (!inside) dialog.close();
}
</script>

<template>
  <dialog ref="el" class="sheet" :aria-label="label" @close="closed" @click="tapped" @keydown="keydown">
    <div class="grip"></div>
    <slot />
  </dialog>
</template>
