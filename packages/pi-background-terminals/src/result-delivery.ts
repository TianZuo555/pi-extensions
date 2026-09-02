/**
 * Deferred one-shot delivery map (same semantics as subagents'): a settled
 * terminal's result is held here until it is either drained into a follow-up
 * message or consumed by bash when its initial wait already
 * returned the settlement. Keyed by id, so double delivery is
 * structurally impossible — whoever drains first wins.
 */
export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    size() {
      return pending.size;
    },
    clear() {
      pending.clear();
    },
  };
}
