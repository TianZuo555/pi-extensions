/** Compact, bounded model output. Headings stay attached to their first row. */
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { GrepOutcome } from "../src/runtime.ts";

export const BODY_MAX_BYTES = DEFAULT_MAX_BYTES - 8 * 1024;

export function displayPath(path: string): string {
  return /[\x00-\x1f\x7f\\"]/.test(path) ? JSON.stringify(path) : path;
}

interface ResultRow {
  readonly path: string;
  readonly text: string;
  readonly isMatch: boolean;
}

export interface SearchBody {
  readonly text: string;
  readonly resultCount: number;
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly quotedPaths: boolean;
}

export function fileRows(files: readonly string[]): ResultRow[] {
  return files.map((path) => ({ path, text: displayPath(path), isMatch: true }));
}

export function grepRows(outcome: GrepOutcome): ResultRow[] {
  const groups = new Map<string, Map<number, { text: string; isMatch: boolean }>>();
  // Only groups containing a returned match are useful. Context from a later
  // file can arrive just before the match that exceeds the result limit.
  for (const match of outcome.matches) {
    const group = groups.get(match.path) ?? new Map();
    group.set(match.lineNumber, { text: match.text, isMatch: true });
    groups.set(match.path, group);
  }
  // Matches win over context, including overlapping windows.
  for (const row of outcome.context) {
    const group = groups.get(row.path);
    if (group && !group.has(row.lineNumber)) {
      group.set(row.lineNumber, { text: row.text, isMatch: false });
    }
  }

  const rows: ResultRow[] = [];
  for (const [path, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let previous: number | undefined;
    for (const [number, row] of [...group].sort(([a], [b]) => a - b)) {
      const prefix =
        previous === undefined
          ? `${rows.length > 0 ? "\n" : ""}${displayPath(path)}\n`
          : number > previous + 1
            ? "--\n"
            : "";
      rows.push({
        path,
        isMatch: row.isMatch,
        text: `${prefix}${number}${row.isMatch ? ":" : "-"} ${row.text}`,
      });
      previous = number;
    }
  }
  return rows;
}

export function boundedBody(rows: readonly ResultRow[], maxBytes = BODY_MAX_BYTES): SearchBody {
  const body: string[] = [];
  const files = new Set<string>();
  let bytes = 0;
  let resultCount = 0;
  let quotedPaths = false;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row.text, "utf8") + (body.length > 0 ? 1 : 0);
    if (bytes + rowBytes > maxBytes) break;
    body.push(row.text);
    bytes += rowBytes;
    files.add(row.path);
    if (row.isMatch) resultCount += 1;
    if (displayPath(row.path) !== row.path) quotedPaths = true;
  }
  return {
    text: body.join("\n"),
    resultCount,
    fileCount: files.size,
    truncated: body.length < rows.length,
    quotedPaths,
  };
}

/** Join a header, an optional body, and notices with exactly one blank line between sections. */
export function resultText(header: string, body: string, notices: readonly string[]): string {
  return [
    header,
    ...(body.length === 0 ? [] : ["", body]),
    ...notices.flatMap((notice) => ["", notice]),
  ].join("\n");
}
