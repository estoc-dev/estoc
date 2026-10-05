import { type App, createApp, h } from "vue";

import "../../src/style.css";
import type { MessageRecord } from "../../src/core/types.js";
import BasicMessage from "../../src/renderers/BasicMessage.vue";
import Generic from "../../src/renderers/Generic.vue";
import { actions, snapshot } from "./store-stub.js";

/**
 * A page that mounts one message in the frame the thread gives it, for a
 * browser to press, hold and tap: a plain message, one of ours waiting to
 * be retried, or one of a type with no renderer. The store is the stub;
 * what the frame asks of it is read back from `window.actions`.
 */
export type Fixture = "basic" | "retry" | "generic";

declare global {
  interface Window {
    mount: (fixture: Fixture) => void;
    actions: typeof actions;
  }
}

const message = (fixture: Fixture): MessageRecord =>
  ({
    messageId: "message-1",
    direction: fixture === "retry" ? "out" : "in",
    channelId: null,
    contactIds: [],
    at: "2026-09-30T12:00:00.000Z",
    headers: { type: fixture === "generic" ? "https://didcomm.org/poll/1.0/question" : "https://didcomm.org/basicmessage/2.0/message", thid: null, pthid: null, createdTime: null, expiresTime: null },
    body: { state: "available", body: { content: "A message to hold and let go of", question: "Meet at six?" }, attachments: [] },
    kind: "application",
    effectType: null,
    input: null,
    delivery: fixture === "retry" ? { status: "queued" } : null,
    acknowledged: false,
    late: false,
    verification: { status: "not-present" },
    manualAction: fixture === "retry" ? "retry" : null,
    diagnostics: [],
    summary: null,
  }) as unknown as MessageRecord;

let app: App | null = null;

window.actions = actions;
window.mount = (fixture) => {
  app?.unmount();
  actions.length = 0;
  snapshot.pending.pendingOutbounds = fixture === "retry" ? [{ messageId: "message-1", entries: ["cancel"], because: null }] : [];
  app = createApp({ render: () => h("div", { class: "thread" }, [h(fixture === "generic" ? Generic : BasicMessage, { message: message(fixture) })]) });
  app.mount("#app");
};
