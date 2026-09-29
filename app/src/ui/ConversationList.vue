<script setup lang="ts">
import { computed } from "vue";
import { BASIC_MESSAGE, PROFILE } from "@estoc/daemon-api/contract";
import { announcedName } from "@estoc/daemon-api/views";

import { seenAt } from "../core/seen.js";
import { chooseMediator, state } from "../core/store.js";
import type { Conversation, MessageRecord } from "../core/types.js";
import { showsInThread, typeOf } from "../renderers/index.js";
import { useAttention } from "./attention.js";
import Icon from "./Icon.vue";
import MediatorForm from "./MediatorForm.vue";
import { go, keyOf, layout, screen } from "./nav.js";
import RestoreNotice from "./RestoreNotice.vue";
import { useStatus } from "./status.js";
import Topbar from "./Topbar.vue";
import { failedToSend, initialOf, initialOfName, labelOf, whenOf } from "./util.js";

const { mediation, lamp, word } = useStatus();
const { count: attention } = useAttention();

const current = computed(() => keyOf(screen.value));
const sendsClosed = computed(() => state.snapshot?.restoreUnexplained ?? false);
const openLinks = computed(() => (state.snapshot?.invitations ?? []).filter((i) => i.uses === "one" && i.state.status === "available").length);

interface Row {
  conversation: Conversation;
  last: MessageRecord | null;
  preview: string;
  unsent: boolean;
  unread: number;
}

function previewOf(message: MessageRecord): string {
  const you = message.direction === "out";
  if (message.body.state !== "available") return message.body.state === "erased" ? "erased" : "content not here";
  const type = typeOf(message);
  if (type === BASIC_MESSAGE) return `${you ? "You: " : ""}${message.summary ?? ""}`;
  if (type === PROFILE) return you ? "You introduced yourself" : `Introduced themself as “${announcedName(message.body.body) ?? ""}”`;
  return you ? "You sent a message of another kind" : "A message of another kind";
}

const rows = computed<Row[]>(() =>
  state.conversations
    .map((conversation) => {
      const shown = conversation.messages.filter(showsInThread);
      const last = shown.at(-1) ?? null;
      const since = seenAt(conversation);
      const unread = shown.filter((m) => m.direction === "in" && (since === null || m.at > since)).length;
      return { conversation, last, preview: last === null ? "" : previewOf(last), unsent: last !== null && failedToSend(last), unread };
    })
    .sort((a, b) => (b.last?.at ?? "").localeCompare(a.last?.at ?? ""))
);
</script>

<template>
  <div class="screen">
    <Topbar>
      <button class="avatar" type="button" aria-label="You and settings" data-you @click="go({ kind: 'you' })">{{ initialOfName(state.snapshot?.label ?? null) }}</button>
      <span class="heading">
        <span class="title">Messages</span>
        <span class="status" :class="{ error: lamp === 'error', quiet: lamp === '' }" data-status><span class="lamp" :class="lamp"></span>{{ word }}</span>
      </span>
      <button class="icon-btn ink" type="button" aria-label="New conversation" data-new-conversation @click="go({ kind: 'new' })"><Icon name="compose" /></button>
    </Topbar>

    <button v-if="attention > 0" class="banner" type="button" data-attention @click="go({ kind: 'attention' })">
      <Icon name="alert" class="icon" />
      <span class="banner-text">{{ attention }} thing{{ attention === 1 ? "" : "s" }} need{{ attention === 1 ? "s" : "" }} you</span>
      <Icon name="chevron" class="chevron" :size="20" />
    </button>
    <button v-else-if="mediation === null && rows.length > 0" class="banner error" type="button" @click="go({ kind: 'you' })">
      <Icon name="alert" class="icon" />
      <span class="banner-text">Not reachable yet: choose a mediator</span>
      <Icon name="chevron" class="chevron" :size="20" />
    </button>

    <div class="screen-body flush">
      <div v-if="sendsClosed" class="list-card"><RestoreNotice /></div>
      <div v-if="rows.length === 0 && mediation === null" class="empty" data-choose-mediator>
        <p>You are {{ state.snapshot?.label }}. To be reached, pick a mediator: it holds sealed envelopes until you fetch them.</p>
        <MediatorForm submit-label="Use this mediator" busy-label="Connecting…" :pick="chooseMediator" />
      </div>
      <div v-else-if="rows.length === 0" class="empty">
        <p>No conversations yet. Start one from the top of this list: invite someone, or accept an invitation.</p>
      </div>

      <button
        v-for="{ conversation, last, preview, unsent, unread } in rows"
        :key="conversation.id"
        class="convo-row"
        :class="{ active: layout !== 'narrow' && conversation.id === current, nameless: conversation.contactId === null }"
        type="button"
        :data-conversation="conversation.id"
        @click="go({ kind: 'chat', key: conversation.id })"
      >
        <span class="avatar" :class="{ nameless: conversation.contactId === null }">{{ initialOf(conversation) }}</span>
        <span class="convo-main">
          <span class="convo-line">
            <span class="convo-name" :class="{ nameless: conversation.contactId === null }" data-name>
              {{ labelOf(conversation) }}<template v-if="conversation.contactId === null && conversation.claimedName !== null"> · not named yet</template>
            </span>
            <span v-if="last" class="convo-time" :class="{ fresh: unread > 0 }">{{ whenOf(last.at) }}</span>
          </span>
          <span class="convo-line">
            <span class="convo-preview" :class="{ unsent, unread: unread > 0 }">{{ unsent ? `Not sent: ${preview.replace(/^You: /, "")}` : preview }}</span>
            <span v-if="unread > 0" class="badge" data-unread>{{ unread }}</span>
          </span>
        </span>
      </button>

      <p v-if="openLinks > 0" class="list-note" data-open-links>
        <button class="link" type="button" @click="go({ kind: 'new' })">{{ openLinks }} invitation link{{ openLinks === 1 ? "" : "s" }} of yours {{ openLinks === 1 ? "is" : "are" }} still open</button>
      </p>

      <div class="spacer"></div>
      <p class="brand">Estoc</p>
    </div>
  </div>
</template>
