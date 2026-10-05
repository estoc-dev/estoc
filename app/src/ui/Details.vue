<script setup lang="ts">
import { computed, ref } from "vue";

import { blockChannels, deleteContact, heldNow, introduce, nameConversation, openIndex, renameContact, rotate } from "../core/store.js";
import type { ConversationId, ShownChannel } from "../core/types.js";
import { editableFrom } from "./editable.js";
import Icon from "./Icon.vue";
import { go, layout, swap } from "./nav.js";
import Sheet from "./Sheet.vue";
import Topbar from "./Topbar.vue";
import { initialOf, labelOf, observationsOf, ownsEnd, shortDid } from "./util.js";

/**
 * A conversation as the person deals with it: the name they give it,
 * a way to say who they are, a fresh address toward the peer, and what
 * ends it. Everything the protocol keeps underneath is one step further.
 */
const props = defineProps<{ conversationKey: ConversationId }>();

const conversation = computed(() => openIndex()?.conversation(props.conversationKey) ?? null);
const sendsClosed = computed(() => openIndex()?.snapshot.restoreUnexplained ?? false);

const petname = editableFrom(computed(() => conversation.value?.petname ?? conversation.value?.claimedName?.name ?? ""));

const busy = ref(false);
const failure = ref<string | null>(null);

async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  failure.value = null;
  try {
    await action();
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

const isHead = (channel: ShownChannel) => channel.headChannelId === channel.channelId;

// The channel a send goes out in now: the one to introduce yourself in, and the one a fresh address replaces.
const current = computed(() => {
  const c = conversation.value;
  if (c === null) return null;
  const channelId = c.defaultWriteTo ?? (c.writeTo.length === 1 ? c.writeTo[0]! : null);
  return channelId === null ? null : (c.channels.find((shown) => shown.channelId === channelId) ?? null);
});

const introduced = computed(() => current.value?.profileSubmitted !== null);
const rotatable = computed(() => current.value !== null && ownsEnd(openIndex()?.snapshot ?? null, current.value));
const observations = computed(() => conversation.value?.channels.flatMap((channel) => observationsOf(openIndex(), channel)) ?? []);
const admitted = computed(() => observations.value.filter(({ disposition }) => disposition.status === "admitted").length);
const received = computed(() => observations.value.length);

const name = () =>
  act(async () => {
    const c = conversation.value;
    const chosen = petname.value.trim();
    if (c === null) return;
    if (chosen === "") {
      throw new Error("Give them a name first.");
    }
    if (c.contactId === null) {
      const heads = c.channels.filter(isHead);
      const held = heldNow();
      const key = await nameConversation((heads.length > 0 ? heads : c.channels).map(({ channelId }) => channelId), chosen);
      if (!held()) return;
      swap(key === null ? { kind: "list" } : { kind: "details", key });
    } else {
      await renameContact(c.contactId, chosen);
    }
  });

function block() {
  const c = conversation.value;
  if (c === null) return;
  const channelIds = c.channels.filter(({ selected, blocked }) => (c.contactId === null || selected) && !blocked).map(({ channelId }) => channelId);
  if (channelIds.length > 0 && confirm(`Block ${labelOf(c)}? Nothing more is taken in from their addresses, or from any they move to.`)) {
    void act(() => blockChannels(channelIds));
  }
}

const deleting = ref(false);
const alsoBlock = ref(false);
const alsoErase = ref(false);

function remove() {
  const contactId = conversation.value?.contactId ?? null;
  if (contactId === null) return;
  deleting.value = false;
  const held = heldNow();
  void act(async () => {
    await deleteContact(contactId, { block: alsoBlock.value, erase: alsoErase.value });
    if (held()) swap({ kind: "list" });
  });
}
</script>

<template>
  <div class="screen" data-details-screen>
    <Topbar :title="conversation ? labelOf(conversation) : ''" can-back :closes="layout !== 'narrow'" />

    <div v-if="conversation" class="screen-body">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 10px">
        <span class="avatar large" :class="{ nameless: conversation.contactId === null }">{{ initialOf(conversation) }}</span>
        <span v-if="conversation.claimedName && conversation.claimedName.name !== conversation.petname" class="note">calls themself “{{ conversation.claimedName.name }}”</span>
        <span v-else-if="conversation.contactId === null" class="note">not a contact yet</span>
      </div>

      <form class="form-row" @submit.prevent="name">
        <input v-model="petname" class="field" placeholder="What you call them" aria-label="What you call them" data-petname />
        <button class="btn-quiet" type="submit" :disabled="busy" data-rename>{{ conversation.contactId === null ? "Name this conversation" : "Rename" }}</button>
      </form>

      <div class="group">
        <button class="row" type="button" :disabled="busy || sendsClosed || current === null || introduced" data-introduce @click="act(() => introduce(current!.channelId))">
          <span class="row-main">Introduce yourself</span>
          <span class="row-end">{{ introduced ? "sent" : "sends your name" }}</span>
        </button>
        <button v-if="rotatable" class="row" type="button" :disabled="busy || sendsClosed" data-rotate @click="act(() => rotate(current!.channelId))">
          <span class="row-main">Use a fresh address with {{ labelOf(conversation) }}</span>
          <span class="row-end">rotate</span>
        </button>
        <div v-else-if="conversation.writeTo.length > 1" class="row">
          <span class="row-main"><span class="row-sub">Several channels are open: a fresh address is minted per channel, under the hood.</span></span>
        </div>
      </div>

      <div class="section">
        <div class="eyebrow">Under the hood</div>
        <div class="group">
          <button class="row" type="button" data-under-the-hood @click="go({ kind: 'hood', key: conversationKey })">
            <span class="row-main">
              <span>Channels</span>
              <span class="row-sub" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ conversation.channels.length }}<template v-if="current"> · writing as {{ shortDid(current.localDid) }}</template></span>
            </span>
            <Icon name="chevron" class="chevron" :size="20" />
          </button>
          <button class="row" type="button" @click="go({ kind: 'hood', key: conversationKey })">
            <span class="row-main">
              <span>Received</span>
              <span class="row-sub">{{ received }} message{{ received === 1 ? "" : "s" }}, {{ admitted }} taken in</span>
            </span>
            <Icon name="chevron" class="chevron" :size="20" />
          </button>
          <button v-if="conversation.diagnostics.length" class="row" type="button" @click="go({ kind: 'hood', key: conversationKey })">
            <span class="row-main">
              <span style="color: var(--alarm)">Diagnostics</span>
              <span class="row-sub">{{ conversation.diagnostics.length }} to look at</span>
            </span>
            <Icon name="chevron" class="chevron" :size="20" />
          </button>
        </div>
      </div>

      <p v-if="failure" class="error-text">{{ failure }}</p>
      <div class="spacer"></div>

      <div class="group">
        <button class="row danger" type="button" :disabled="busy" data-block @click="block">
          <span class="row-main">Block {{ labelOf(conversation) }}</span>
        </button>
        <button v-if="conversation.contactId !== null" class="row danger" type="button" :disabled="busy" data-delete @click="deleting = true">
          <span class="row-main">Delete contact</span>
          <span class="row-end">asks what to keep</span>
        </button>
      </div>
    </div>

    <Sheet v-if="deleting && conversation" label="Delete contact" @close="deleting = false">
      <div class="sheet-title">Delete {{ labelOf(conversation) }}?</div>
      <p class="note">Their channels stay in the vault unless you also erase their messages.</p>
      <label class="check"><input v-model="alsoBlock" type="checkbox" /> Block their addresses too</label>
      <label class="check"><input v-model="alsoErase" type="checkbox" /> Erase their messages</label>
      <button class="btn-danger" type="button" data-delete-confirm @click="remove">Delete</button>
      <button class="btn-quiet" type="button" @click="deleting = false">Cancel</button>
    </Sheet>
  </div>
</template>
