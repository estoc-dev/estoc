/** One kind of notification a view subscribes to; a listener's throw is its own, raised out of band, and never stops the session. */
export class Listeners<Value> {
  private readonly listeners = new Set<(value: Value) => void>();

  add(listener: (value: Value) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: Value): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
