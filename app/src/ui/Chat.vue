<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { draftIn, moveDraft, writeDraft, writtenDrafts } from "../core/drafts.js";
import { markSeen } from "../core/seen.js";
import { sendMessage, state } from "../core/store.js";
import type { ChannelId, ChannelRecord, Conversation, ConversationId } from "../core/types.js";
import { rendererFor, showsInThread, typeOf } from "../renderers/index.js";
import Icon from "./Icon.vue";
import { FINE_POINTER, go, layout } from "./nav.js";
import Sheet from "./Sheet.vue";
import { useStatus } from "./status.js";
import Topbar from "./Topbar.vue";
import { dayOf, endsOf, initialOf, labelOf, shortDid } from "./util.js";

const props = defineProps<{ conversationKey: ConversationId }>();

const conversation = computed(() => state.conversations.find((c) => c.id === props.conversationKey) ?? null);
const { mediation } = useStatus();
const sendsClosed = computed(() => state.snapshot?.restoreUnexplained ?? false);

// A thread is every message of every channel the conversation shows that
// its renderer wants shown, under the day it was recorded.
const thread = computed(() => {
  const lines: ({ day: string } | { message: Conversation["messages"][number] })[] = [];
  let day = "";
  for (const message of conversation.value?.messages.filter(showsInThread) ?? []) {
    const heading = dayOf(message.at);
    if (heading !== day) {
      day = heading;
      lines.push({ day });
    }
    lines.push({ message });
  }
  return lines;
});

const subtitle = computed(() => {
  const c = conversation.value;
  if (c === null) return "";
  if (c.petname === null) return "not a contact yet";
  if (c.claimedName === null || c.claimedName.name === c.petname) return "";
  return `calls themself “${c.claimedName.name}”`;
});

// Opening the conversation, and every message that arrives while it is open, is it being read.
watch(
  () => [conversation.value, thread.value.length] as const,
  ([c]) => {
    if (c !== null && document.visibilityState === "visible") markSeen(c);
  },
  { immediate: true }
);

const sending = ref(false);
const sendError = ref("");
/** the channel picked to write in; none while the conversation's own choice is taken */
const picked = ref<ChannelId | null>(null);
const choosing = ref(false);

const channelOf = (channelId: ChannelId): ChannelRecord | null => conversation.value?.channels.find((channel) => channel.channelId === channelId) ?? state.index?.channel(channelId) ?? null;

// The channel this conversation writes in now. A send names it, never
// the contact: what was written for one pair goes out in that pair, or
// is refused if the pair has been replaced since the snapshot on screen.
const target = computed(() => {
  const c = conversation.value;
  if (c === null) return null;
  const chosen = c.writeTo.find((candidate) => candidate === picked.value) ?? c.defaultWriteTo;
  return chosen === null ? null : channelOf(chosen);
});

const draft = computed({
  get: () => (target.value === null ? "" : (draftIn(target.value.channelId)?.text ?? "")),
  set: (text) => {
    if (target.value !== null) writeDraft(target.value, text);
  },
});

function pick(channelId: ChannelId) {
  const before = target.value;
  picked.value = channelId;
  choosing.value = false;
  if (before !== null && target.value !== null) moveDraft(before.channelId, target.value);
  void nextTick(() => composerEl.value?.focus());
}

const channelsOf = (c: Conversation): ChannelId[] => [...c.writeTo, ...c.channels.map(({ channelId }) => channelId)];

/**
 * What is written and not in the composer: in another channel of this
 * conversation, or in a channel no conversation shows any more. A newer
 * selection can take a channel with no message in it out of every
 * conversation; its draft is listed wherever the person is, or nothing
 * would be left to read it by. A draft in another conversation's channel
 * waits there.
 */
const draftsElsewhere = computed(() => {
  const c = conversation.value;
  const here = new Set(c === null ? [] : channelsOf(c));
  const shown = new Set(state.conversations.flatMap(channelsOf));
  const writable = new Set(c?.writeTo ?? []);
  const current = target.value?.channelId ?? null;
  return writtenDrafts().flatMap((draft) => {
    const { channelId } = draft;
    if (channelId === current || (shown.has(channelId) && !here.has(channelId))) return [];
    const channel = channelOf(channelId);
    return [{ channelId, draft, writable: writable.has(channelId), ends: channel === null ? channelId : endsOf(channel) }];
  });
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    sendError.value = "It could not be copied from here: select the text instead.";
  }
}

// A contact that prefers an address none of its open channels is under
// gets no default, even with one channel open: writing as another
// address is the person's call, made here.
const mustPick = computed(() => {
  const c = conversation.value;
  return c !== null && c.writeTo.length > 0 && target.value === null;
});

const closedBecause = computed(() => {
  const c = conversation.value;
  if (c === null || c.writeTo.length > 0) return null;
  const closed = c.channels.flatMap(({ send }) => (send.status === "closed" ? [send.because] : []));
  return closed[0] ?? "no channel of this conversation is open";
});

const composerEl = ref<HTMLTextAreaElement | null>(null);

function grow() {
  const el = composerEl.value;
  if (el === null) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

watch(draft, () => void nextTick(grow), { immediate: true });

function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && FINE_POINTER.matches && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

async function send() {
  if (mustPick.value) {
    choosing.value = true;
    return;
  }
  const text = draft.value.trim();
  const channel = target.value;
  if (text === "" || channel === null || sending.value) {
    return;
  }
  // held by identity: the conversation on screen, and the channel the draft is under, may both move before this returns
  const written = draftIn(channel.channelId);
  sending.value = true;
  sendError.value = "";
  try {
    await sendMessage({ channelId: channel.channelId }, text);
    if (written !== null && written.text.trim() === text) written.text = "";
    void toFoot();
  } catch (err) {
    sendError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

const threadEl = ref<HTMLElement | null>(null);

// The thread rests at its foot: the newest message is the one you want in
// view. Someone scrolled up reading history is left where they are, an
// arriving message does not yank the page out from under them, but
// opening a conversation, and writing in one, always come back to the end.
let resting = true;

function atFoot(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
}

function noteScroll() {
  const el = threadEl.value;
  if (el !== null) {
    resting = atFoot(el);
  }
}

async function toFoot() {
  await nextTick();
  const el = threadEl.value;
  if (el !== null) {
    el.scrollTop = el.scrollHeight;
    resting = true;
  }
}

watch(
  () => thread.value.length,
  () => {
    if (resting) {
      void toFoot();
    }
  }
);

// A window that shrinks, or a phone keyboard opening, must not lift the
// newest message off the foot and leave it floating in the middle.
onMounted(() => {
  void toFoot();
  const el = threadEl.value;
  if (el === null) {
    return;
  }
  const observer = new ResizeObserver(() => {
    if (resting) {
      el.scrollTop = el.scrollHeight;
    }
  });
  observer.observe(el);
  onUnmounted(() => observer.disconnect());
});

const details = () => go({ kind: "details", key: props.conversationKey });
</script>

<template>
  <div class="screen" data-chat :data-channels="conversation?.channels.length ?? 0">
    <Topbar :can-back="layout === 'narrow'">
      <button v-if="conversation" class="chat-head-link" type="button" data-details @click="details">
        <span class="avatar small" :class="{ nameless: conversation.contactId === null }">{{ initialOf(conversation) }}</span>
        <span class="row-main">
          <span class="name" :class="{ nameless: conversation.petname === null }" data-name>{{ labelOf(conversation) }}</span>
          <span v-if="subtitle" class="row-sub">{{ subtitle }}</span>
        </span>
      </button>
      <span v-else class="title">…</span>
      <template #end>
        <button v-if="conversation" class="icon-btn" type="button" aria-label="Conversation details" @click="details"><Icon name="info" /></button>
      </template>
    </Topbar>

    <div ref="threadEl" class="thread" @scroll.passive="noteScroll">
      <p v-if="conversation && mediation === null" class="thread-note error">
        No mediator yet: nothing leaves and nothing arrives.
        <button class="link" type="button" @click="go({ kind: 'you' })">Choose one</button>
      </p>
      <p v-else-if="conversation && thread.length === 0" class="thread-note">No messages yet. What you write crosses the mediator sealed to them.</p>
      <template v-for="line in thread" :key="'day' in line ? line.day : line.message.messageId">
        <div v-if="'day' in line" class="thread-note">{{ line.day }}</div>
        <component :is="rendererFor(typeOf(line.message)).component" v-else :message="line.message" />
      </template>
      <button
        v-if="conversation && conversation.unadmitted.length > 0"
        class="aside"
        type="button"
        style="border: none; text-decoration: underline; background: none"
        data-unadmitted
        :data-count="conversation.unadmitted.length"
        @click="go({ kind: 'hood', key: conversationKey })"
      >
        {{ conversation.unadmitted.length }} deliver{{ conversation.unadmitted.length === 1 ? "y" : "ies" }} here {{ conversation.unadmitted.length === 1 ? "was" : "were" }} not taken in
      </button>
    </div>

    <div v-if="conversation" class="composer-area">
      <div v-for="{ channelId, draft: kept, writable, ends } in draftsElsewhere" :key="channelId" class="composer-line" :title="ends" data-draft-elsewhere>
        <span style="flex: 1; min-width: 0">
          <template v-if="writable">Something you wrote waits in another channel of theirs.</template>
          <template v-else>Something you wrote is in a channel that takes no send now.</template>
        </span>
        <button v-if="writable" type="button" class="link" @click="picked = channelId">write there</button>
        <template v-else>
          <button v-if="target !== null && draft === ''" type="button" class="link" data-draft-here @click="moveDraft(kept.channelId, target)">write it here</button>
          <button type="button" class="link" data-draft-copy @click="copy(kept.text)">copy</button>
        </template>
        <button type="button" class="link danger" data-draft-discard @click="kept.text = ''">discard</button>
        <blockquote v-if="!writable" class="draft-text" style="flex-basis: 100%" data-draft-text>{{ kept.text }}</blockquote>
      </div>
      <p v-if="sendError" class="composer-line error" data-send-error>{{ sendError }}</p>
      <p v-if="sendsClosed" class="composer-line" data-sends-closed>Restored from a backup: sending opens once you have read what that means, above your conversations.</p>
      <p v-if="closedBecause" class="composer-line error" data-closed>Nothing can be written here: {{ closedBecause }}</p>
      <p v-else-if="mustPick" class="composer-line" data-must-pick>
        {{ conversation.writeTo.length === 1 ? "Their only open channel is not under the address you prefer." : "Several channels take a send." }}
        <button class="link" type="button" data-channel-change @click="choosing = true">Choose where this goes</button>
      </p>
      <p v-else-if="conversation.writeTo.length > 1 && target" class="composer-line">
        writing as {{ shortDid(target.localDid) }} → {{ shortDid(target.peerDid) }}
        <button class="link" type="button" data-channel-change @click="choosing = true">change</button>
      </p>
      <form v-if="!closedBecause" class="composer" @submit.prevent="send">
        <textarea
          ref="composerEl"
          v-model="draft"
          class="field"
          rows="1"
          :placeholder="mustPick ? 'Choose where this goes first' : `Write to ${labelOf(conversation)}`"
          :aria-label="`Write to ${labelOf(conversation)}`"
          :disabled="sending || sendsClosed || target === null"
          data-composer
          @keydown="keydown"
          @input="grow"
        ></textarea>
        <button class="send-btn" type="submit" aria-label="Send" :disabled="sending || sendsClosed || target === null || draft.trim() === ''" data-send>
          <Icon name="send" :size="20" />
        </button>
      </form>
    </div>

    <Sheet v-if="choosing && conversation" label="Where this goes" @close="choosing = false">
      <div class="sheet-title">Send as which address?</div>
      <p class="note">Each channel pairs one address of yours with one of theirs. The message goes out in the one you pick.</p>
      <div class="group">
        <template v-for="channelId in conversation.writeTo" :key="channelId">
          <button v-if="channelOf(channelId)" class="row" type="button" :title="endsOf(channelOf(channelId)!)" data-channel-option @click="pick(channelId)">
            <span class="row-main">
              <span class="mono">you {{ shortDid(channelOf(channelId)!.localDid) }}</span>
              <span class="mono" style="color: var(--ink-soft)">them {{ shortDid(channelOf(channelId)!.peerDid) }}</span>
            </span>
            <Icon v-if="target && channelId === target.channelId" name="check" class="chevron" :size="20" />
          </button>
        </template>
      </div>
      <button class="btn-quiet" type="button" @click="choosing = false">Cancel</button>
    </Sheet>
  </div>
</template>
