<script setup lang="ts">
import Icon from "./Icon.vue";
import { back } from "./nav.js";

/** The bar over a screen: a way back when the screen was stepped into, its title, and whatever acts on it. */
defineProps<{ title?: string; canBack?: boolean; closes?: boolean }>();
</script>

<template>
  <div class="topbar" :class="{ plain: !canBack }">
    <button v-if="canBack" class="icon-btn accent" type="button" :aria-label="closes ? 'Close' : 'Back'" data-back @click="back()">
      <Icon :name="closes ? 'close' : 'back'" :size="closes ? 22 : 26" />
    </button>
    <slot><span class="title">{{ title }}</span></slot>
    <slot name="end" />
  </div>
</template>
