<script setup lang="ts">
import { computed, ref } from "vue";

import { blockChannels, introduce, rotate, state } from "../core/store.js";
import type { ConversationChannel, DidId, ObservationRecord } from "../core/types.js";
import Topbar from "./Topbar.vue";
import { dispositionOf, labelOf, shortDid, shortFormOf, timeOf, whenOf } from "./util.js";

/**
 * A conversation as the vault has it: the channels it shows, each a
 * pair of one DID of ours and one of theirs, with what stands in the
 * way of writing in it; everything received in them as the vault
 * disposed of it; and what the vault finds wrong with the contact.
 */
const props = defineProps<{ conversationKey: string }>();

const conversation = computed(() => state.conversations.find((c) => c.key === props.conversationKey) ?? null);
const sendsClosed = computed(() => state.snapshot?.restoreUnexplained ?? false);

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

function localDidIdOf(channel: ConversationChannel): DidId | null {
  return state.snapshot?.dids.find((did) => did.did !== null && shortFormOf(did.did) === channel.channel.localDid)?.didId ?? null;
}

const isHead = (channel: ConversationChannel) => channel.head !== null && channel.head.localDid === channel.channel.localDid && channel.head.peerDid === channel.channel.peerDid;

function flagsOf(channel: ConversationChannel): { word: string; tone: string }[] {
  return [
    ...(isHead(channel) ? [{ word: "current", tone: "accent" }] : []),
    { word: channel.selected ? "selected" : "history", tone: "" },
    ...(channel.superseded ? [{ word: "the peer moved on", tone: "" }] : []),
    ...(channel.blocked ? [{ word: "blocked", tone: "alarm" }] : []),
    ...(channel.conflicted ? [{ word: "conflict", tone: "alarm" }] : []),
  ];
}

const admittedOf = (channel: ConversationChannel): number => channel.observations.filter(({ disposition }) => disposition.status === "admitted").length;

const observations = computed(() => {
  const all = new Map<string, ObservationRecord>();
  for (const { observations: seen } of conversation.value?.channels ?? []) for (const o of seen) all.set(o.sourceEventCid, o);
  return [...all.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
});

const showAll = ref(false);
const shown = computed(() => (showAll.value ? observations.value : observations.value.slice(0, 4)));

function whenOfObservation(at: string): string {
  const when = whenOf(at);
  return /\d:\d\d/.test(when) ? when : `${when} ${timeOf(Date.parse(at))}`;
}

function lineOf(o: ObservationRecord): string {
  const parts = [dispositionOf(o)];
  if (o.contradicting) parts.push("carries another content than the one taken in");
  if (o.verification.status !== "not-present") parts.push(`new address, proof ${o.verification.status}`);
  return parts.join(" · ");
}
</script>

<template>
  <div class="screen" data-hood>
    <Topbar :title="conversation ? `${labelOf(conversation)} · under the hood` : ''" can-back />

    <div v-if="conversation" class="screen-body">
      <div class="section">
        <div class="eyebrow">Channels</div>
        <p class="note">Each channel is one address of yours paired with one of theirs. Messages go out in the current one.</p>
        <div
          v-for="channel in conversation.channels"
          :key="channel.channel.localDid + channel.channel.peerDid"
          class="card"
          :class="{ quiet: !isHead(channel) }"
          data-channel
          :data-current="isHead(channel) ? '' : undefined"
        >
          <div class="chips">
            <span v-for="{ word, tone } in flagsOf(channel)" :key="word" class="chip" :class="tone">{{ word }}</span>
          </div>
          <div class="pair">
            <div><span class="who">you</span><span :title="channel.channel.localDid">{{ shortDid(channel.channel.localDid) }}</span></div>
            <div><span class="who">them</span><span :title="channel.channel.peerDid">{{ shortDid(channel.channel.peerDid) }}</span></div>
          </div>
          <p class="note">
            <template v-if="channel.send.status === 'closed'">cannot write here: {{ channel.send.because }} · </template>
            <template v-if="channel.peerName">they call themself “{{ channel.peerName.name }}” · </template>
            {{ channel.observations.length }} received, {{ admittedOf(channel) }} taken in
          </p>
          <div v-if="channel.send.status === 'open'" class="card-actions">
            <button v-if="localDidIdOf(channel)" class="btn-quiet small" type="button" :disabled="busy || sendsClosed" data-rotate @click="act(() => rotate(localDidIdOf(channel)!, channel.channel.peerDid))">
              Rotate my address
            </button>
            <button v-if="channel.profileSubmitted === null" class="btn-quiet small" type="button" :disabled="busy || sendsClosed" @click="act(() => introduce(channel.channel))">Introduce yourself</button>
            <button class="btn-danger small" type="button" :disabled="busy" @click="act(() => blockChannels([channel.channel]))">Block this channel</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="eyebrow">Received</div>
        <div v-if="observations.length === 0" class="card quiet note">Nothing received yet.</div>
        <div v-else class="group received-list" data-receipts>
          <div v-for="o in shown" :key="o.sourceEventCid" class="row" :title="o.sourceEventCid" :data-disposition="o.disposition.status">
            <span class="when">{{ whenOfObservation(o.at) }}</span>
            <span class="row-main" :style="o.disposition.status === 'refused' ? 'color: var(--alarm)' : ''">{{ lineOf(o) }}</span>
          </div>
        </div>
        <button v-if="observations.length > shown.length" class="link" type="button" style="align-self: flex-start; min-height: 40px" @click="showAll = true">Show all {{ observations.length }}</button>
      </div>

      <div class="section">
        <div class="eyebrow">Diagnostics</div>
        <div v-if="conversation.diagnostics.length === 0" class="card quiet note">Nothing to report for this conversation.</div>
        <div v-else class="card">
          <p v-for="(line, i) in conversation.diagnostics" :key="i" class="error-text">{{ line }}</p>
        </div>
      </div>

      <p v-if="failure" class="error-text">{{ failure }}</p>
    </div>
  </div>
</template>
