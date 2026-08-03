/**
 * Deferred one-shot delivery: a settled background result is held until drained
 * into a follow-up message. Keyed by run id so double delivery is impossible.
 */
export function createDeferredResultDelivery<T extends { runId: string }>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(result.runId, result);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}
