import { ref } from "vue";

/**
 * An operation whose failure is shown over whatever screen there is by
 * then. A removal or a lock changes which screen is shown, and its
 * answer may come back after the screen it was asked on is gone, or
 * after the vault changed hands: a failure put on that screen would go
 * with it. The state is one for the whole app, kept until the person
 * dismisses it.
 *
 * What is kept is the reason the operation was not confirmed, which is
 * not the same as a promise that nothing was done: a connection that
 * drops after the daemon acted and before it answered fails the same
 * way as a refusal, and only the daemon knows which it was.
 */
export interface Unconfirmed {
  what: string;
  because: string;
}

const unconfirmed = ref<Unconfirmed | null>(null);
const busy = ref(false);

function dismiss(): void {
  unconfirmed.value = null;
}

/** Run `work`, reported as `what` when it fails; a second one while one is under way is not started. */
async function attempt(what: string, work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  unconfirmed.value = null;
  try {
    await work();
  } catch (err) {
    unconfirmed.value = { what, because: err instanceof Error ? err.message : String(err) };
  } finally {
    busy.value = false;
  }
}

/**
 * A removal a screen offers. What is to be removed is settled by the
 * caller before the question is put, so that the answer removes what
 * was asked about and nothing that took its place while the question
 * stood.
 */
async function remove(question: string, removal: () => Promise<void>): Promise<void> {
  if (busy.value || !confirm(question)) return;
  await attempt("The removal", removal);
}

export function useUnconfirmed() {
  return { unconfirmed, busy, attempt, remove, dismiss };
}
