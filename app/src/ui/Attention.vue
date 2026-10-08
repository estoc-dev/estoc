<script setup lang="ts">
import { computed, ref } from "vue";

import { cancel, completeNotification, completeResponse, openIndex, retry, rotate, selectPreparation, state } from "../core/store.js";
import type { ChannelId } from "../core/types.js";
import { useAttention } from "./attention.js";
import { go } from "./nav.js";
import Topbar from "./Topbar.vue";
import { dispositionOf, labelOf, shortDid } from "./util.js";

/**
 * Everything that waits for the person, each thing on a card with the
 * step it waits for. Opening a vault sends nothing on its own: a
 * message a transport was never called for, a reply an input still
 * earns, a private address a peer's first message calls for, a rotation
 * the peer was never told of, each waits here. A message sealed on more
 * than one device waits for the person to choose the copy this one
 * sends. What has no step says what it waits for.
 */
const { pending, byHand, waiting, discarded, unplacedInputs, unplacedOutputs, count } = useAttention();
const sendsClosed = computed(() => openIndex()?.snapshot.restoreUnexplained ?? false);

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

/** The person at the other end of a channel, by the name they go by here, or their address when no conversation shows it. */
function whoIs(channelId: ChannelId): string {
  const peerDid = openIndex()?.channel(channelId)?.peerDid ?? null;
  if (peerDid === null) return "someone";
  const conversation = openIndex()?.conversations.find((c) => c.channels.some((channel) => channel.peerDid === peerDid));
  return conversation === undefined ? shortDid(peerDid) : labelOf(conversation);
}

const peerOf = (channelId: ChannelId): string => {
  const channel = openIndex()?.channel(channelId) ?? null;
  return channel === null ? channelId : shortDid(channel.peerDid);
};

</script>

<template>
  <div class="screen" data-attention-screen>
    <Topbar can-back>
      <span class="title">Needs you</span>
      <template #end>
        <span v-if="count > 0" class="badge attention">{{ count }}</span>
      </template>
    </Topbar>

    <div class="screen-body page">
      <div v-if="count === 0" class="empty" style="margin: auto">
        <p>Nothing needs you.</p>
      </div>

      <div v-if="pending && byHand > 0" class="section" data-pending>
        <div class="eyebrow">Left to do by hand</div>
        <div v-for="outbound in pending.pendingOutbounds" :key="outbound.messageId" class="card" :title="outbound.messageId" data-pending-outbound>
          <p>
            A message {{ outbound.outcome === "queued" ? "not sealed yet" : "sealed, not sent" }}<template v-if="outbound.channelId"> to {{ whoIs(outbound.channelId) }}</template>.
          </p>
          <p v-if="outbound.because" class="note">{{ outbound.because }}</p>
          <template v-if="outbound.entries.includes('selectPreparation')">
            <p class="note">It was sealed on more than one device. Choose the copy this device sends, then send it. If another device sent its copy, it may arrive twice.</p>
            <div class="card-actions" data-preparations>
              <button
                v-for="(cid, i) in outbound.candidates"
                :key="cid"
                class="btn-quiet small"
                type="button"
                :title="cid"
                :aria-pressed="cid === outbound.selected"
                :disabled="busy || cid === outbound.selected"
                data-choose-preparation
                @click="act(() => selectPreparation(outbound.messageId, cid))"
              >
                {{ cid === outbound.selected ? `Copy ${i + 1}, chosen` : `Choose copy ${i + 1}` }}
              </button>
            </div>
          </template>
          <div class="card-actions">
            <button v-if="outbound.entries.includes('retry')" class="btn small" type="button" :disabled="busy || sendsClosed" data-send-now @click="act(() => retry(outbound.messageId))">Send now</button>
            <button v-if="outbound.entries.includes('cancel')" class="btn-quiet small" type="button" :disabled="busy" data-cancel @click="act(() => cancel(outbound.messageId))">Cancel it</button>
          </div>
        </div>
        <div v-for="response in pending.missingResponses" :key="response.executionId + response.effectType" class="card" :title="response.messageId">
          <p>A reply to {{ whoIs(response.channelId) }} is owed.</p>
          <p class="note">{{ response.effectType }}</p>
          <div v-if="response.entries.includes('completeResponse')" class="card-actions">
            <button class="btn small" type="button" :disabled="busy || sendsClosed" @click="act(() => completeResponse(response.executionId, response.effectType))">Give it</button>
          </div>
        </div>
        <div v-for="candidate in pending.rotationCandidates" :key="candidate.channelId" class="card" data-rotation-candidate>
          <p>
            {{ whoIs(candidate.channelId) }} wrote to an address you handed out.
            <template v-if="candidate.status === 'ready'">A private address for them can be made now.</template>
            <template v-else-if="candidate.status === 'waiting'">A private address for them waits for evidence.</template>
            <template v-else>A private address for them cannot be made here.</template>
          </p>
          <p v-if="candidate.because" class="note">{{ candidate.because }}</p>
          <div v-if="candidate.entries.includes('rotate')" class="card-actions">
            <button class="btn small" type="button" :disabled="busy || sendsClosed" data-make-private @click="act(() => rotate(candidate.channelId))">Make one</button>
          </div>
        </div>
        <div v-for="notification in pending.missingNotifications" :key="notification.rotationEventCid" class="card" data-missing-notification>
          <p>{{ whoIs(notification.channelId) }} has not been told of your new address yet.</p>
          <div v-if="notification.entries.includes('completeNotification')" class="card-actions">
            <button class="btn small" type="button" :disabled="busy || sendsClosed" data-tell-them @click="act(() => completeNotification(notification.rotationEventCid))">Tell them</button>
          </div>
        </div>
        <div v-for="conflict in pending.notificationConflicts" :key="conflict.rotationEventCid" class="card">
          <p class="error-text">{{ conflict.messageIds.length }} notices announce one rotation and disagree. None is sent.</p>
        </div>
        <div v-for="proof in pending.pendingProofs" :key="proof.sourceEventCid" class="card" :title="proof.messageId">
          <p>A new address<template v-if="proof.channelId"> of {{ whoIs(proof.channelId) }}</template> waits for the document that proves it.</p>
        </div>
      </div>

      <div v-if="waiting.length || discarded.length" class="section" data-turned-away>
        <div class="eyebrow">Deliveries not taken in</div>
        <div v-for="(held, i) in waiting" :key="`w${i}`" class="card quiet">
          <p>Waiting: {{ held.reason }}</p>
        </div>
        <div v-for="(gone, i) in discarded" :key="`d${i}`" class="card">
          <p class="error-text">{{ gone.reason }}</p>
        </div>
      </div>

      <div v-if="unplacedInputs.length || unplacedOutputs.length" class="section" data-unplaced>
        <div class="eyebrow">In no conversation</div>
        <div v-for="input in unplacedInputs" :key="input.sourceEventCid" class="card" :class="{ quiet: input.disposition.status !== 'refused' }">
          <p :class="{ 'error-text': input.disposition.status === 'refused' }">Received, {{ dispositionOf(input) }}.</p>
        </div>
        <div v-for="output in unplacedOutputs" :key="output.messageId" class="card">
          <p class="error-text">A message of yours names {{ output.candidateChannelIds.length }} channels and goes out in none.</p>
          <p class="note mono">{{ output.candidateChannelIds.map(peerOf).join(", ") }}</p>
        </div>
      </div>

      <p v-if="failure" class="error-text">{{ failure }}</p>
      <p v-if="sendsClosed && byHand > 0" class="note">
        Sending waits until you have read what the restore means, above your conversations.
        <button class="link" type="button" @click="go({ kind: 'list' })">Go there</button>
      </p>

      <div class="spacer"></div>

      <details v-if="state.log.length" class="log" data-log>
        <summary>Log</summary>
        <p v-for="(line, i) in state.log" :key="i">{{ line }}</p>
      </details>
    </div>
  </div>
</template>
