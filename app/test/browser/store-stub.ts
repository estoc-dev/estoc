import { reactive } from "vue";

/**
 * Stands in for the app's store when a renderer is mounted in a browser
 * for its gestures alone: every action the renderer asks for is written
 * down on the page instead of reaching a vault.
 */
export const actions: { name: string; args: unknown[] }[] = [];

export const snapshot = reactive({
  restoreUnexplained: false,
  pending: { pendingOutbounds: [] as { messageId: string; entries: string[]; because: string | null }[], missingResponses: [] as unknown[] },
});

export const openIndex = () => ({ snapshot });

const recorded =
  (name: string) =>
  async (...args: unknown[]): Promise<void> => {
    actions.push({ name, args });
  };

export const eraseMessage = recorded("eraseMessage");
export const retry = recorded("retry");
export const cancel = recorded("cancel");
export const completeResponse = recorded("completeResponse");
