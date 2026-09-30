<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

import { cancel, completeResponse, eraseMessage, retry, state } from "../core/store.js";
import type { MessageRecord } from "../core/types.js";
import Icon from "../ui/Icon.vue";
import Sheet from "../ui/Sheet.vue";
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
 *
 * What is rarely done to a message, erasing its content, does not take
 * room on the bubble. A press-and-hold or a right click on the bubble
 * opens it; so does a More button, shown on hover where there is a
 * mouse and otherwise kept out of sight until the keyboard reaches it,
 * so that assistive technology always has a named control to activate.
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

const erasable = computed(() => props.message.body.state === "available");
const erasing = ref(false);

function offerErase() {
  if (erasable.value && !busy.value) erasing.value = true;
}

function erase() {
  erasing.value = false;
  void act(() => eraseMessage(props.message.messageId));
}

// A finger that drifts further than this while held is scrolling, not pressing.
const HOLD_MS = 500;
const HOLD_SLACK_PX = 10;
let hold: { timer: ReturnType<typeof setTimeout>; pointerId: number; x: number; y: number } | null = null;

function pressed(event: PointerEvent) {
  if (event.pointerType === "mouse" || event.button !== 0 || erasing.value) return;
  released();
  const pointerId = event.pointerId;
  const timer = setTimeout(() => {
    hold = null;
    offerEraseFromTouch(pointerId);
  }, HOLD_MS);
  hold = { timer, pointerId, x: event.clientX, y: event.clientY };
}

function moved(event: PointerEvent) {
  if (hold !== null && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLACK_PX) released();
}

function released() {
  if (hold !== null) {
    clearTimeout(hold.timer);
    hold = null;
  }
}

// When the finger that held the message lifts, the browser turns it into a
// click aimed at whatever is under it by then, which is the sheet's Erase
// button. That click belongs to a gesture that has already had its effect,
// so it is dropped: only the click that follows that finger's own lift,
// told from other fingers by the pointer a click names where the browser
// names one, and by its order after the lift where it does not. A key
// pressed or another finger set down while the finger stays held does not
// end its gesture, and a control activated from the keyboard meanwhile is
// honoured. A lift the browser follows with no click, as after a native
// long press, leaves the sheet answering normally once a moment has passed.
const CLICK_AFTER_LIFT_MS = 400;
let settleTouch: (() => void) | null = null;

function offerEraseFromTouch(pointerId: number) {
  if (erasing.value) return;
  offerErase();
  if (!erasing.value) return;
  settleTouch?.();
  let lifted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    window.removeEventListener("click", drop, true);
    window.removeEventListener("pointerup", ended, true);
    window.removeEventListener("pointercancel", ended, true);
    if (timer !== null) clearTimeout(timer);
    settleTouch = null;
  };
  const fromKeyboard = (event: MouseEvent) => event.detail === 0;
  const fromAnotherPointer = (event: MouseEvent) => event instanceof PointerEvent && event.pointerId !== pointerId;
  const drop = (event: MouseEvent) => {
    if (!lifted || fromKeyboard(event) || fromAnotherPointer(event)) return;
    event.stopPropagation();
    event.preventDefault();
    settle();
  };
  const ended = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (event.type === "pointercancel") {
      settle();
      return;
    }
    lifted = true;
    timer = setTimeout(settle, CLICK_AFTER_LIFT_MS);
  };
  window.addEventListener("click", drop, true);
  window.addEventListener("pointerup", ended, true);
  window.addEventListener("pointercancel", ended, true);
  settleTouch = settle;
}

onBeforeUnmount(() => {
  released();
  settleTouch?.();
});

function contextMenu(event: MouseEvent) {
  if (!erasable.value) return;
  event.preventDefault();
  if (hold === null) {
    offerErase();
    return;
  }
  const { pointerId } = hold;
  released();
  offerEraseFromTouch(pointerId);
}
</script>

<template>
  <div
    class="bubble"
    :class="[message.direction === 'out' ? 'sent' : 'received', { system }]"
    :data-message="message.messageId"
    @contextmenu="contextMenu"
    @pointerdown="pressed"
    @pointerup="released"
    @pointercancel="released"
    @pointermove="moved"
    @pointerleave="released"
  >
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
      <button v-if="erasable" type="button" class="icon-btn more" aria-label="More" :disabled="busy" data-more @click="offerErase">
        <Icon name="more" :size="16" />
      </button>
    </div>
    <p v-for="(diagnostic, i) in message.diagnostics" :key="i" class="diagnostic">{{ diagnostic.kind }}: {{ diagnostic.because }}</p>
    <p v-if="failure" class="diagnostic error">{{ failure }}</p>
    <Sheet v-if="erasing" label="This message" @close="erasing = false">
      <div class="sheet-title">Erase this message's content?</div>
      <p class="note">Every copy this vault is merged with erases it too. The other side keeps theirs.</p>
      <button class="btn-danger" type="button" data-erase @click="erase">Erase</button>
      <button class="btn-quiet" type="button" data-cancel @click="erasing = false">Cancel</button>
    </Sheet>
  </div>
</template>
