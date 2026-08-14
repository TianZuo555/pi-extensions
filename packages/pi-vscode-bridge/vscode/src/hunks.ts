export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse the `@@ -a,b +c,d @@` headers out of a unified diff.
 * When the `,count` part is missing the count is 1: `@@ -1 +1 @@`.
 * Ignore every other line. Return hunks in file order.
 */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK_HEADER_RE.exec(line);
    if (!match) continue;
    hunks.push({
      oldStart: Number.parseInt(match[1], 10),
      oldLines: match[2] ? Number.parseInt(match[2], 10) : 1,
      newStart: Number.parseInt(match[3], 10),
      newLines: match[4] ? Number.parseInt(match[4], 10) : 1,
    });
  }
  return hunks;
}

/** [start, end] new-side line range of a hunk, using max(newLines,1). */
export function hunkNewRange(hunk: DiffHunk): [number, number] {
  const lines = Math.max(hunk.newLines, 1);
  return [hunk.newStart, hunk.newStart + lines - 1];
}

/**
 * Find the hunk whose NEW-side line range contains `line` (1-based).
 * The range is [newStart, newStart + max(newLines, 1) - 1].
 * Return undefined when no hunk contains the line.
 */
export function findHunkForNewLine(hunks: DiffHunk[], line: number): DiffHunk | undefined {
  for (const hunk of hunks) {
    const [start, end] = hunkNewRange(hunk);
    if (line >= start && line <= end) {
      return hunk;
    }
  }
  return undefined;
}
