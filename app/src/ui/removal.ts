import { ref } from "vue";

/**
 * A removal a screen offers. What is to be removed is settled by the
 * caller before the question is put, so that the answer removes what
 * was asked about and nothing that took its place while the question
 * stood. The state is one for the whole app: a refusal that comes back
 * after the vault changed hands, and the screen with it, is shown over
 * whatever screen there is by then, until the person dismisses it.
 */
const failed = ref<string | null>(null);
const busy = ref(false);

function dismiss(): void {
  failed.value = null;
}

async function remove(question: string, removal: () => Promise<void>): Promise<void> {
  if (busy.value || !confirm(question)) return;
  busy.value = true;
  failed.value = null;
  try {
    await removal();
  } catch (err) {
    failed.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

export function useRemoval() {
  return { failed, busy, remove, dismiss };
}
