<script setup lang="ts">
import { computed, ref } from "vue";

import { cancel, completeResponse, eraseMessage, retry, state } from "../core/store.js";
import type { MessageRecord } from "../core/types.js";
import { timeOf } from "../ui/util.js";
import { shownAttachment } from "./attachments.js";

/**
 * The frame every renderer sits in: sent to the right, received to the
 * left, or a system aside in the middle; the time underneath. Renderers
 * put their reading of the message in the slot, which is shown only
 * while the content is here to read; what the message carries as
 * attachments is listed under it by the frame, whatever its type.
 *
 * Under it, the vault's own account of the message, never the
 * renderer's: for one of ours, whether it arrived, and what is left to
 * do by hand when it did not; for one received, whether it is taken in,
 * what became of a continuity proof it brought, and the replies it may
 * still be given.
 */
const props = defineProps<{
  message: MessageRecord;
  /** a protocol aside, centered and quieter than chat */
  system?: boolean;
}>();

const VERIFICATION: Record<string, string> = {
  "pending-proof": "new address, proof waits for its document",
  "pending-history": "new address, proof waits for history",
  verified: "new address, verified",
  unsupported: "ends the relationship, not applied",
  invalid: "new address, proof invalid",
  conflict: "new address, continuity in conflict",
};

const verification = computed(() => {
  const status = props.message.verification;
  if (status.status === "not-present") {
    return null;
  }
  return { status: status.status, word: VERIFICATION[status.status] ?? status.status, because: "because" in status ? status.because : undefined };
});

const open = computed(() => state.snapshot?.pending.pendingOutbounds.find((outbound) => outbound.messageId === props.message.messageId) ?? null);
const owed = computed(() => (state.snapshot?.pending.missingResponses ?? []).filter((response) => response.messageId === props.message.messageId && response.entries.includes("completeResponse")));

// Where a message of ours stands, in a word: on its way, arrived, or not sent and why.
const delivery = computed(() => {
  const { delivery, acknowledged, late, manualAction } = props.message;
  if (delivery === null) {
    return null;
  }
  const because = open.value?.because ?? null;
  if (manualAction === "retry" || delivery.status === "terminal") {
    const why = delivery.status === "terminal" ? delivery.code : because;
    return { status: delivery.status, tone: "failed", word: why === null ? "not sent" : `not sent · ${why}`, because: undefined };
  }
  switch (delivery.status) {
    case "queued":
      return { status: "queued", tone: "waiting", word: "sending", because: undefined };
    case "prepared":
      return { status: "prepared", tone: "waiting", word: "sealed, not sent yet", because: undefined };
    case "submitted":
      return acknowledged
        ? { status: "acknowledged", tone: "", word: late ? "received, after it expired" : "received", because: undefined }
        : { status: "submitted", tone: "", word: "sent", because: undefined };
    case "conflict":
      return { status: "conflict", tone: "conflict", word: "conflict", because: delivery.because };
  }
});

const attachments = computed(() => (props.message.body.state === "available" ? props.message.body.attachments.map(shownAttachment) : []));

const input = computed(() => {
  const status = props.message.input;
  return status === null || status.status === "complete" ? null : status;
});

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

function erase() {
  if (confirm("Erase this message's content from the vault? Every copy this vault is merged with erases it too. The other side keeps theirs.")) {
    void act(() => eraseMessage(props.message.messageId));
  }
}
</script>

<template>
  <div class="bubble" :class="[message.direction === 'out' ? 'sent' : 'received', { system }]" :data-message="message.messageId">
    <div class="bubble-body">
      <slot v-if="message.body.state === 'available'" />
      <span v-else class="gone">{{ message.body.state === "erased" ? "erased" : "the content is not here" }}</span>
      <ul v-if="attachments.length > 0" class="attachments" data-attachments>
        <li v-for="(attachment, i) in attachments" :key="i" data-attachment>
          <span class="attachment-name">{{ attachment.name }}</span>
          <span v-if="attachment.details">{{ attachment.details }}</span>
          <span class="mono" :title="attachment.reference">{{ attachment.reference }}</span>
        </li>
        <li class="gone">attached; nothing here opens it yet</li>
      </ul>
    </div>
    <div class="bubble-meta">
      <span>{{ timeOf(Date.parse(message.at)) }}</span>
      <slot name="meta" />
      <span v-if="delivery" class="delivery" :class="[delivery.status, delivery.tone]" :title="delivery.because" data-delivery>{{ delivery.word }}</span>
      <span v-if="input" class="delivery" :class="input.status === 'conflict' ? 'conflict' : 'waiting'" :title="input.because">{{ input.status === "pending" ? "taken in, sender now unconfirmed" : "conflict" }}</span>
      <span v-if="verification" class="delivery" :class="{ failed: verification.status === 'invalid' || verification.status === 'conflict', waiting: verification.status.startsWith('pending') }" :title="verification.because" data-verification>{{ verification.word }}</span>
      <button v-if="message.manualAction === 'retry'" type="button" class="link" :disabled="busy || sendsClosed" data-retry @click="act(() => retry(message.messageId))">
        {{ busy ? "…" : "Retry" }}
      </button>
      <button v-if="open?.entries.includes('cancel')" type="button" class="link danger" :disabled="busy" @click="act(() => cancel(message.messageId))">cancel</button>
      <button
        v-for="response in owed"
        :key="response.effectType"
        type="button"
        class="link"
        :disabled="busy || sendsClosed"
        :title="`give the reply this message still earns: ${response.effectType}`"
        @click="act(() => completeResponse(response.executionId, response.effectType))"
      >
        reply: {{ response.effectType }}
      </button>
      <button v-if="message.body.state === 'available'" type="button" class="link faint" :disabled="busy" @click="erase">erase</button>
    </div>
    <p v-for="(diagnostic, i) in message.diagnostics" :key="i" class="diagnostic">{{ diagnostic.kind }}: {{ diagnostic.because }}</p>
    <p v-if="failure" class="diagnostic error">{{ failure }}</p>
  </div>
</template>
