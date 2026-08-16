/**
 * Session-scoped pagination cursors.
 *
 * A search that hits its limit stores the remaining rendered lines under an
 * opaque id, so the model can ask for the next page without re-running the
 * search (which could return different results if files changed, making the
 * pages inconsistent). Bounded so a long session cannot grow this without
 * limit; the oldest entry is dropped first.
 */

const MAX_CURSORS = 32;

export interface CursorPage {
  /** Rendered output lines not yet shown. */
  readonly lines: readonly string[];
  /** Tool the cursor came from, so a cursor cannot be replayed elsewhere. */
  readonly tool: string;
}

export interface CursorStore {
  save(tool: string, lines: readonly string[]): string;
  take(tool: string, id: string): CursorPage | undefined;
  readonly size: number;
}

export function createCursorStore(maxEntries = MAX_CURSORS): CursorStore {
  const entries = new Map<string, CursorPage>();
  let counter = 0;

  return {
    save(tool, lines) {
      const id = `${tool}_c${++counter}`;
      entries.set(id, { lines, tool });
      // Map preserves insertion order, so the first key is the oldest.
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return id;
    },

    take(tool, id) {
      const entry = entries.get(id);
      if (!entry || entry.tool !== tool) return undefined;
      entries.delete(id);
      return entry;
    },

    get size() {
      return entries.size;
    },
  };
}
