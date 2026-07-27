/**
 * SpillSource — bounded, incremental reader over one stream's complete
 * on-disk capture, backing the /ps detail view.
 *
 * The in-memory OutputBuffer keeps a stable head plus a rolling tail and drops
 * the middle once a stream outgrows its cap; the spill file is the authoritative
 * complete stream. This reader lets the viewer walk that file without ever
 * holding more than one bounded window in memory:
 *
 * - `follow` tracks EOF while the viewport is pinned to the bottom (live tail),
 *   retaining at most `tailBytes`.
 * - `loadEarlier` prepends one chunk. Prepending never moves the viewer's
 *   bottom-anchored scroll offset, so reading upward stays continuous. At the
 *   `windowBytes` cap it re-anchors instead: a fresh window ending exactly where
 *   the previous one began ("reanchored"), which the viewer pins to its bottom.
 * - `seekAfter` pages forward the same way, starting exactly where the current
 *   window ended, which the viewer pins to its top.
 *
 * Every window boundary is snapped to a UTF-8 code point boundary. All reads are
 * serialized behind one `loading` latch, so a chatty 1 Hz pump cannot stack file
 * handles. Plain async/await by design: /ps components render synchronously and
 * never touch the Effect runtime.
 */

import * as fs from "node:fs/promises";

/** Live-tail window: what `follow` retains while pinned to EOF. */
export const SPILL_TAIL_BYTES = 1024 * 1024;
/** Absolute in-memory window, reachable by paging backwards. */
export const SPILL_WINDOW_BYTES = 4 * 1024 * 1024;
/** One backwards step. */
export const SPILL_CHUNK_BYTES = 512 * 1024;

export interface SpillWindowState {
  /** Decoded window text, or "" before the first load. */
  readonly text: string;
  /** Bumped on every window/error change; keys the viewer's line cache. */
  readonly version: number;
  /** Absolute byte offset of the first loaded byte. */
  readonly start: number;
  /** Absolute byte offset one past the last loaded byte. */
  readonly end: number;
  /** File size at the last successful stat. */
  readonly size: number;
  readonly loading: boolean;
  /** Set when the file became unreadable (pruned, permissions, ...). */
  readonly error?: string;
}

/** How `loadEarlier` moved the window, so the viewer can keep its anchor. */
export type EarlierOutcome = "noop" | "prepended" | "reanchored";

export interface SpillSource {
  readonly path: string;
  state(): SpillWindowState;
  /** Initial tail load, then EOF growth. Safe to call on a timer. */
  follow(): Promise<boolean>;
  loadEarlier(): Promise<EarlierOutcome>;
  /** Page one window forward. Resolves true when the window moved. */
  seekAfter(): Promise<boolean>;
  dispose(): void;
}

/** Offset of the first UTF-8 code point boundary at or after the buffer start. */
function leadingBoundary(buf: Buffer) {
  let index = 0;
  while (index < buf.length && (buf[index] & 0xc0) === 0x80) index++;
  return index;
}

export function createSpillSource(
  spillPath: string,
  onChange: () => void,
  options: {
    readonly tailBytes?: number;
    readonly windowBytes?: number;
    readonly chunkBytes?: number;
  } = {},
): SpillSource {
  const windowBytes = Math.max(1024, options.windowBytes ?? SPILL_WINDOW_BYTES);
  const tailBytes = Math.max(
    1024,
    Math.min(options.tailBytes ?? SPILL_TAIL_BYTES, windowBytes),
  );
  const chunkBytes = Math.max(
    1024,
    Math.min(options.chunkBytes ?? SPILL_CHUNK_BYTES, windowBytes),
  );

  let window = Buffer.alloc(0);
  let start = 0;
  let end = 0;
  let size = 0;
  let version = 0;
  let loading = false;
  let disposed = false;
  let error: string | undefined;
  let cachedText = "";
  let cachedVersion = -1;

  const readRange = async (from: number, to: number) => {
    const length = to - from;
    if (length <= 0) return Buffer.alloc(0);
    const handle = await fs.open(spillPath, "r");
    try {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, from);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };

  /** Replace the window with [from, to), snapped forward off a split char. */
  const readWindow = async (from: number, to: number) => {
    const raw = await readRange(from, to);
    const offset = from === 0 ? 0 : leadingBoundary(raw);
    window = Buffer.from(raw.subarray(offset));
    start = from + offset;
    end = from + raw.length;
  };

  const trimFront = (limit: number) => {
    if (window.length <= limit) return;
    const excess = window.length - limit;
    const cut = excess + leadingBoundary(window.subarray(excess));
    start += cut;
    window = Buffer.from(window.subarray(cut));
  };

  /**
   * Serialize one window mutation. `fn` returns true when it changed the
   * window; errors are recorded rather than thrown so a pruned or unreadable
   * spill degrades to the in-memory view instead of breaking the overlay.
   */
  const run = async (fn: () => Promise<boolean>) => {
    if (disposed || loading) return false;
    loading = true;
    const versionBefore = version;
    let changed = false;
    try {
      changed = await fn();
      if (disposed) return false;
      if (error !== undefined) version++;
      error = undefined;
      if (changed) version++;
    } catch (err) {
      if (disposed) return false;
      const message = err instanceof Error ? err.message : String(err);
      if (error !== message) {
        error = message;
        version++;
      }
      changed = false;
    } finally {
      loading = false;
    }
    if (version !== versionBefore) {
      cachedVersion = -1;
      onChange();
    }
    return changed;
  };

  const follow = () =>
    run(async () => {
      const stat = await fs.stat(spillPath);
      size = stat.size;
      // Fresh tail load when nothing is loaded, the file was replaced/truncated,
      // or the viewer fell so far behind that appending would blow the window.
      if (window.length === 0 || end > size || size - end > tailBytes) {
        if (size === 0 && window.length === 0) return false;
        await readWindow(Math.max(0, size - tailBytes), size);
        return true;
      }
      if (size === end) return false;
      const raw = await readRange(end, size);
      if (raw.length === 0) return false;
      window = Buffer.concat([window, raw]);
      end += raw.length;
      trimFront(tailBytes);
      return true;
    });

  const loadEarlier = async () => {
    if (disposed || loading || start === 0) return "noop" as const;
    let outcome: EarlierOutcome = "noop";
    await run(async () => {
      if (window.length >= windowBytes) {
        // Window cap reached: page backwards, ending exactly where the current
        // window began, so upward reading loses nothing.
        const to = start;
        await readWindow(Math.max(0, to - windowBytes), to);
        outcome = "reanchored";
        return true;
      }
      const from = Math.max(0, start - chunkBytes);
      const raw = await readRange(from, start);
      if (raw.length === 0) return false;
      const offset = from === 0 ? 0 : leadingBoundary(raw);
      window = Buffer.concat([Buffer.from(raw.subarray(offset)), window]);
      start = from + offset;
      outcome = "prepended";
      return true;
    });
    return outcome;
  };

  const seekAfter = async () => {
    let moved = false;
    await run(async () => {
      const stat = await fs.stat(spillPath);
      size = stat.size;
      if (end >= size) return false;
      const from = end;
      await readWindow(from, Math.min(size, from + windowBytes));
      moved = true;
      return true;
    });
    return moved;
  };

  return {
    path: spillPath,
    state: () => {
      if (cachedVersion !== version) {
        cachedText = window.toString("utf8");
        cachedVersion = version;
      }
      return { text: cachedText, version, start, end, size, loading, error };
    },
    follow,
    loadEarlier,
    seekAfter,
    dispose: () => {
      disposed = true;
      window = Buffer.alloc(0);
      cachedText = "";
      cachedVersion = -1;
    },
  };
}
