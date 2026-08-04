/**
 * Exactly-once deferred delivery for background subagent results.
 *
 * A result is stored, claimed before send, confirmed on success, and restored
 * only when the send itself fails. Pending results are retried via claim().
 */
export function createDeferredResultDelivery<T extends { runId: string }>() {
  const pending = new Map<string, T>();
  const inFlight = new Set<string>();
  const delivered = new Set<string>();

  return {
    defer(result: T) {
      if (!inFlight.has(result.runId) && !delivered.has(result.runId)) {
        pending.set(result.runId, result);
      }
    },

    claim(runId: string): T | undefined {
      if (inFlight.has(runId) || delivered.has(runId)) return undefined;
      const result = pending.get(runId);
      if (!result) return undefined;
      pending.delete(runId);
      inFlight.add(runId);
      return result;
    },

    confirm(runId: string) {
      inFlight.delete(runId);
      delivered.add(runId);
    },

    restore(result: T) {
      inFlight.delete(result.runId);
      pending.set(result.runId, result);
    },

    pendingRunIds(): string[] {
      return [...pending.keys()];
    },

    clear() {
      pending.clear();
      inFlight.clear();
      delivered.clear();
    },
  };
}
