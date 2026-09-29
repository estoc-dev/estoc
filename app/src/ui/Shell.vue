<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { ConversationId } from "../core/types.js";
import Attention from "./Attention.vue";
import Chat from "./Chat.vue";
import ConversationList from "./ConversationList.vue";
import Details from "./Details.vue";
import NewConversation from "./NewConversation.vue";
import UnderTheHood from "./UnderTheHood.vue";
import You from "./You.vue";
import { back, keyOf, layout, screen } from "./nav.js";

const kind = computed(() => screen.value.kind);
const key = computed(() => keyOf(screen.value));

// The invitation sheet opens over whatever was on screen; a window with room for a conversation beside the list keeps it there under the sheet.
const lastKey = ref<ConversationId | null>(null);
watch(key, (k) => (k === null ? undefined : (lastKey.value = k)), { immediate: true });
const chatKey = computed(() => (kind.value === "new" ? lastKey.value : key.value));

const aboutConversation = computed(() => kind.value === "details" || kind.value === "hood");
</script>

<template>
  <div class="shell" :class="[layout, { 'with-side': layout === 'wide' && aboutConversation }]">
    <template v-if="layout === 'narrow'">
      <div class="pane">
        <ConversationList v-if="kind === 'list' || kind === 'new'" />
        <Chat v-else-if="kind === 'chat' && key !== null" :key="key" :conversation-key="key" />
        <Details v-else-if="kind === 'details' && key !== null" :key="key" :conversation-key="key" />
        <UnderTheHood v-else-if="kind === 'hood' && key !== null" :key="key" :conversation-key="key" />
        <You v-else-if="kind === 'you'" />
        <Attention v-else-if="kind === 'attention'" />
        <ConversationList v-else />
      </div>
    </template>

    <template v-else>
      <div class="pane pane-list"><ConversationList /></div>
      <div class="pane pane-main">
        <You v-if="kind === 'you'" />
        <Attention v-else-if="kind === 'attention'" />
        <Chat v-else-if="chatKey !== null" :key="chatKey" :conversation-key="chatKey" />
        <div v-else class="screen">
          <div class="empty" style="margin: auto">
            <p>Pick a conversation, or start one.</p>
          </div>
        </div>
        <template v-if="layout === 'medium' && aboutConversation">
          <div class="drawer-scrim" @click="back()"></div>
          <div class="drawer">
            <Details v-if="kind === 'details' && key !== null" :key="key" :conversation-key="key" />
            <UnderTheHood v-else-if="key !== null" :key="key" :conversation-key="key" />
          </div>
        </template>
      </div>
      <div v-if="layout === 'wide' && aboutConversation" class="pane pane-side">
        <Details v-if="kind === 'details' && key !== null" :key="key" :conversation-key="key" />
        <UnderTheHood v-else-if="key !== null" :key="key" :conversation-key="key" />
      </div>
    </template>

    <NewConversation v-if="kind === 'new'" />
  </div>
</template>
