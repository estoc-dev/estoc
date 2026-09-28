<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { blockChannels, deleteContact, introduce, nameConversation, renameContact, rotate, state } from "../core/store.js";
import type { ConversationChannel, DidId } from "../core/types.js";
import Icon from "./Icon.vue";
import { go, layout, swap } from "./nav.js";
import Topbar from "./Topbar.vue";
import { initialOf, labelOf, shortDid, shortFormOf } from "./util.js";

/**
 * A conversation as the person deals with it: the name they give it,
 * a way to say who they are, a fresh address toward the peer, and what
 * ends it. Everything the protocol keeps underneath is one step further.
 */
const props = defineProps<{ conversationKey: string }>();

const conversation = computed(() => state.conversations.find((c) => c.key === props.conversationKey) ?? null);
const sendsClosed = computed(() => state.snapshot?.restoreUnexplained ?? false);

const petname = ref("");
watch(conversation, (c) => (petname.value = c?.petname ?? c?.claimedName ?? ""), { immediate: true });

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

const isHead = (channel: ConversationChannel) => channel.head !== null && channel.head.localDid === channel.channel.localDid && channel.head.peerDid === channel.channel.peerDid;

function localDidIdOf(localDid: string): DidId | null {
  return state.snapshot?.dids.find((did) => did.did !== null && shortFormOf(did.did) === localDid)?.didId ?? null;
}

// The channel a send goes out in now: the one to introduce yourself in, and the one a fresh address replaces.
const current = computed(() => {
  const c = conversation.value;
  if (c === null) return null;
  const channel = c.defaultWriteTo ?? (c.writeTo.length === 1 ? c.writeTo[0]! : null);
  return channel === null ? null : (c.channels.find(({ channel: shown }) => shown.localDid === channel.localDid && shown.peerDid === channel.peerDid) ?? null);
});

const introduced = computed(() => current.value?.profileSubmitted !== null);
const rotatable = computed(() => (current.value === null ? null : localDidIdOf(current.value.channel.localDid)));
const admitted = computed(() => conversation.value?.channels.reduce((n, { observations }) => n + observations.filter(({ disposition }) => disposition.status === "admitted").length, 0) ?? 0);
const received = computed(() => conversation.value?.channels.reduce((n, { observations }) => n + observations.length, 0) ?? 0);

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
      const key = await nameConversation((heads.length > 0 ? heads : c.channels).map(({ channel }) => channel), chosen);
      swap({ kind: "details", key });
    } else {
      await renameContact(c.contactId, chosen);
    }
  });

function block() {
  const c = conversation.value;
  if (c === null) return;
  const channels = c.channels.filter(({ selected, blocked }) => (c.contactId === null || selected) && !blocked).map(({ channel }) => channel);
  if (channels.length > 0 && confirm(`Block ${labelOf(c)}? Nothing more is taken in from their addresses, or from any they move to.`)) {
    void act(() => blockChannels(channels));
  }
}

const deleting = ref(false);
const alsoBlock = ref(false);
const alsoErase = ref(false);

function remove() {
  const contactId = conversation.value?.contactId ?? null;
  if (contactId === null) return;
  deleting.value = false;
  void act(async () => {
    await deleteContact(contactId, { block: alsoBlock.value, erase: alsoErase.value });
    swap({ kind: "list" });
  });
}
</script>

<template>
  <div class="screen" data-details-screen>
    <Topbar :title="conversation ? labelOf(conversation) : ''" can-back :closes="layout !== 'narrow'" />

    <div v-if="conversation" class="screen-body">
      <div style="display: flex; flex-direction: column; align-items: center; gap: 10px">
        <span class="avatar large" :class="{ nameless: conversation.contactId === null }">{{ initialOf(conversation) }}</span>
        <span v-if="conversation.claimedName && conversation.claimedName !== conversation.petname" class="note">calls themself “{{ conversation.claimedName }}”</span>
        <span v-else-if="conversation.contactId === null" class="note">not a contact yet</span>
      </div>

      <form class="form-row" @submit.prevent="name">
        <input v-model="petname" class="field" placeholder="What you call them" aria-label="What you call them" data-petname />
        <button class="btn-quiet" type="submit" :disabled="busy" data-name>{{ conversation.contactId === null ? "Name this conversation" : "Rename" }}</button>
      </form>

      <div class="group">
        <button class="row" type="button" :disabled="busy || sendsClosed || current === null || introduced" data-introduce @click="act(() => introduce(current!.channel))">
          <span class="row-main">Introduce yourself</span>
          <span class="row-end">{{ introduced ? "sent" : "sends your name" }}</span>
        </button>
        <button v-if="rotatable" class="row" type="button" :disabled="busy || sendsClosed" data-rotate @click="act(() => rotate(rotatable!, current!.channel.peerDid))">
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
              <span class="row-sub">{{ conversation.channels.length }}<template v-if="current"> · writing as {{ shortDid(current.channel.localDid) }}</template></span>
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

    <div v-if="deleting && conversation" class="sheet-scrim" @click.self="deleting = false">
      <div class="sheet" role="dialog" aria-label="Delete contact">
        <div class="grip"></div>
        <div class="sheet-title">Delete {{ labelOf(conversation) }}?</div>
        <p class="note">Their channels stay in the vault unless you also erase their messages.</p>
        <label class="check"><input v-model="alsoBlock" type="checkbox" /> Block their addresses too</label>
        <label class="check"><input v-model="alsoErase" type="checkbox" /> Erase their messages</label>
        <button class="btn-danger" type="button" data-delete-confirm @click="remove">Delete</button>
        <button class="btn-quiet" type="button" @click="deleting = false">Cancel</button>
      </div>
    </div>
  </div>
</template>
