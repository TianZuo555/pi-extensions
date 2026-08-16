/**
 * Session-scoped pagination cursors.
 *
 * A search that hits its limit stores the remaining rendered lines under an
 * opaque id, so the model can ask for the next page without re-running the
 * search (which could return different results if files changed, making the
 * pages inconsistent). Each cursor is bound to the query that produced it,
 * so a changed query cannot page an old result set unnoticed. Bounded so a
 * long session cannot grow this without limit; the oldest entry is dropped
 * first.
 */

const MAX_CURSORS = 32;

export interface CursorPage {
  /** Rendered output lines not yet shown. */
  readonly lines: readonly string[];
  /** Tool the cursor came from, so a cursor cannot be replayed elsewhere. */
  readonly tool: string;
  /** Canonical query of the search that produced the page. */
  readonly query: string;
}

export type CursorLookup =
  | { readonly status: "ok"; readonly lines: readonly string[] }
  /** Valid cursor, wrong query. Not consumed: the original query can still page it. */
  | { readonly status: "query-mismatch" };

export interface CursorStore {
  save(tool: string, query: string, lines: readonly string[]): string;
  take(tool: string, query: string, id: string): CursorLookup | undefined;
  readonly size: number;
}

export function createCursorStore(maxEntries = MAX_CURSORS): CursorStore {
  const entries = new Map<string, CursorPage>();
  let counter = 0;

  return {
    save(tool, query, lines) {
      const id = `${tool}_c${++counter}`;
      entries.set(id, { lines, tool, query });
      // Map preserves insertion order, so the first key is the oldest.
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return id;
    },

    take(tool, query, id) {
      const entry = entries.get(id);
      if (!entry || entry.tool !== tool) return undefined;
      // A mismatched query leaves the cursor in place: the model can still
      // page the original results by re-sending the original query.
      if (entry.query !== query) {
        return { status: "query-mismatch" };
      }
      entries.delete(id);
      return { status: "ok", lines: entry.lines };
    },

    get size() {
      return entries.size;
    },
  };
}
