<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { heldNow, openIndex, refreshReplicas, sendHistory } from "../core/store.js";
import type { ReplicaId, ReplicaRecord } from "../core/types.js";
import AddDevice from "./AddDevice.vue";
import Icon from "./Icon.vue";
import { dateOf, mergedNote, whenOf } from "./util.js";

const snapshot = computed(() => openIndex()?.snapshot ?? null);
const listing = computed(() => snapshot.value?.mediations.find((mediation) => mediation.selected)?.replicas ?? null);
const own = computed(() => listing.value?.replicas.find((replica) => replica.self) ?? null);
const others = computed(() => listing.value?.replicas.filter((replica) => !replica.self) ?? []);
const reachable = computed(() => others.value.filter((replica) => replica.state === "active"));
const received = computed(() => snapshot.value?.historyReceived ?? null);
/** A device that holds no conversation and was sent no history yet: most likely one that has just joined. */
const empty = computed(() => snapshot.value !== null && snapshot.value.conversations.length === 0 && received.value === null && reachable.value.length > 0);

const nameOf = (replicaId: ReplicaId): string => `Device ${replicaId.slice(-4).toUpperCase()}`;

const joinedSince = (replica: ReplicaRecord): boolean => replica.state === "active" && replica.sent === null && replica.addedAt !== null && own.value?.addedAt != null && replica.addedAt > own.value.addedAt;

function aboutOf(replica: ReplicaRecord): string {
  if (replica.state === "removed") return replica.removedAt === null ? "removed from the mediator" : `removed ${dateOf(replica.removedAt)}`;
  const joined = replica.addedAt === null ? "" : `joined ${dateOf(replica.addedAt)}`;
  if (replica.self) return joined;
  if (replica.sent === null) return joinedSince(replica) ? `${joined}: send it your history` : joined;
  const sent = replica.sent.outcome === "sent" ? `history sent ${whenOf(replica.sent.at)}` : `history not sent ${whenOf(replica.sent.at)}: ${replica.sent.because}`;
  return joined === "" ? sent : `${joined} · ${sent}`;
}

const receivedNote = computed(() => {
  const history = received.value;
  if (history === null) return null;
  const from = nameOf(history.from);
  switch (history.status) {
    case "importing":
      return `Importing the history ${from} sent…`;
    case "imported":
      return `History from ${from}, ${whenOf(history.at)}: ${mergedNote(history.merged, "it")}`;
    case "failed":
      return `The history ${from} sent ${whenOf(history.at)} was not imported: ${history.because}`;
  }
});

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sending = ref<ReplicaId | "all" | null>(null);
const note = ref<string | null>(null);
const failed = ref(false);

async function send(to?: ReplicaId) {
  sending.value = to ?? "all";
  note.value = null;
  failed.value = false;
  const held = heldNow();
  try {
    const told = await sendHistory(to);
    if (!held()) return;
    const missed = (to === undefined ? reachable.value.length : 1) - told.length;
    note.value = told.length === 0 ? "The history did not go: what stopped it is beside each device." : `Sent the history to ${told.length === 1 ? nameOf(told[0]!) : `${told.length} devices`}; each takes it in as it arrives.${missed > 0 ? " It did not go to every one: what stopped it is beside each." : ""}`;
    failed.value = told.length === 0;
  } catch (err) {
    if (!held()) return;
    note.value = reasonOf(err);
    failed.value = true;
  } finally {
    sending.value = null;
  }
}

const asking = ref(false);
/** why the mediator could not be asked the last time: the listing shown is the one before */
const unasked = ref<string | null>(null);

// Asked whenever the devices come into view, and when the sheet a device is added from closes: a device that joined meanwhile shows up with nothing to press.
async function ask() {
  if (asking.value) return;
  asking.value = true;
  const held = heldNow();
  try {
    await refreshReplicas();
    if (held()) unasked.value = null;
  } catch (err) {
    if (held()) unasked.value = reasonOf(err);
  } finally {
    asking.value = false;
  }
}

const askWhenShown = () => {
  if (document.visibilityState === "visible") void ask();
};

onMounted(() => {
  void ask();
  document.addEventListener("visibilitychange", askWhenShown);
});
onUnmounted(() => document.removeEventListener("visibilitychange", askWhenShown));

const listedNote = computed(() => {
  const listed = listing.value === null ? (asking.value ? "Asking the mediator…" : "Not asked of the mediator yet.") : `As the mediator listed them ${whenOf(listing.value.listedAt)}.`;
  return unasked.value === null ? listed : `${listed} It could not be asked just now: ${unasked.value}`;
});

const addingDevice = ref(false);

function added() {
  addingDevice.value = false;
  void ask();
}
</script>

<template>
  <div class="section" data-devices>
    <div class="eyebrow">Your devices</div>
    <p v-if="empty" class="note" data-devices-empty>
      This device holds none of your conversations yet. Send it your history from a device that has them, or import a link under Your vault.
    </p>
    <div class="group">
      <div v-for="replica in listing?.replicas ?? []" :key="replica.replicaId" class="row" :class="{ gone: replica.state === 'removed' }" :data-device="replica.self ? 'self' : replica.state">
        <span class="row-main">
          <span>
            {{ replica.self ? "This device" : nameOf(replica.replicaId) }}
            <span v-if="joinedSince(replica)" class="chip accent" data-device-new>new</span>
          </span>
          <span class="row-sub">{{ aboutOf(replica) }}</span>
        </span>
        <span v-if="joinedSince(replica)" class="row-end">
          <button class="link alone" type="button" :disabled="sending !== null" data-send-history @click="send(replica.replicaId)">
            {{ sending === replica.replicaId ? "sending…" : "Send history" }}
          </button>
        </span>
      </div>
      <button v-if="reachable.length > 0" class="row" type="button" :disabled="sending !== null" data-sync-now @click="send()">
        <span class="row-main">
          <span>{{ sending === "all" ? "Sending…" : "Sync now" }}</span>
          <span class="row-sub">your history to every other device, which takes in what it lacks</span>
        </span>
      </button>
      <div class="row">
        <span class="row-main">
          <span class="row-sub" data-devices-listed>{{ listedNote }}</span>
        </span>
        <span class="row-end">
          <button class="link alone" type="button" :disabled="asking" data-list-devices @click="ask">{{ asking ? "asking…" : "ask again" }}</button>
        </span>
      </div>
      <button class="row" type="button" data-add-device @click="addingDevice = true">
        <span class="row-main">
          <span>Add a device</span>
          <span class="row-sub">a link it joins with</span>
        </span>
        <Icon name="chevron" class="chevron" :size="20" />
      </button>
    </div>
    <p v-if="note" class="note" :class="{ 'error-text': failed }" data-devices-note>{{ note }}</p>
    <p v-if="receivedNote" class="note" :class="{ 'error-text': received?.status === 'failed' }" data-history-received>{{ receivedNote }}</p>
    <AddDevice v-if="addingDevice" @close="added" />
  </div>
</template>
