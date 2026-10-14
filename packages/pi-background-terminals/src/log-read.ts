/**
 * Pure file-based reads over a terminal's complete spill log.
 *
 * The manager resolves the model's opaque ref to a private path and delegates
 * here; nothing in this module knows about terminals. All windows are byte
 * addressed and snapped to UTF-8 code-point boundaries so paging with
 * `nextOffset` is byte-exact.
 */

import * as fs from "node:fs";
import { codePointStart, completeCodePointEnd } from "./utf8.ts";

export type LogReadMode = "page" | "head_tail" | "tail" | "search";

export interface LogReadBody {
  readonly mode: LogReadMode;
  readonly offset: number;
  readonly nextOffset: number;
  /** Bytes of returned text — what the run budget charges. */
  readonly bytesRead: number;
  readonly size: number;
  readonly text: string;
  /** First omitted byte (head_tail). */
  readonly omittedStart?: number;
  /** Byte after the omitted range (head_tail). */
  readonly omittedEnd?: number;
  /** Matching lines found in the scanned range (search). */
  readonly matchCount?: number;
  /** Shown matching lines with line-start byte offsets (search). */
  readonly matches?: ReadonlyArray<{ offset: number; text: string }>;
  /** Search regex source (search). */
  readonly pattern?: string;
}

export interface SearchLogOptions {
  readonly pattern: RegExp;
  readonly offset: number;
  readonly limit: number;
  /** Scan chunk size; injectable for tests. */
  readonly chunkSizeBytes?: number;
  /** Lines longer than this are tested on their prefix only. */
  readonly maxLineBytes?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_SEARCH_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const MATCH_LINE_MAX_CHARS = 300;

function readWindow(filePath: string, start: number, length: number) {
  if (length <= 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, "r");
  try {
    const window = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, window, 0, length, start);
    return window.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Exact page `[offset, offset + limit)` with both edges snapped to code-point
 * boundaries. Without this a window that splits a multi-byte character decodes
 * to U+FFFD, which silently corrupts the text AND every page stitched after it.
 */
export function readLogPage(filePath: string, offset: number, limit: number): LogReadBody {
  const size = fs.statSync(filePath).size;
  const start = Math.min(offset, size);
  const raw = readWindow(filePath, start, Math.min(limit, size - start));
  const leading = start > 0 ? codePointStart(raw) : 0;
  const body = raw.subarray(leading);
  const atEof = start + raw.length >= size;
  const complete = completeCodePointEnd(body);
  // Only trim a split trailing sequence when the rest of it is already on
  // disk. At EOF there is nothing to stitch to, and a window too small to
  // hold one code point must still advance.
  const bytes = atEof || complete === 0 ? body : body.subarray(0, complete);
  const readOffset = start + leading;
  const text = bytes.toString("utf8");
  return {
    mode: "page",
    offset: readOffset,
    nextOffset: readOffset + bytes.length,
    bytesRead: Buffer.byteLength(text),
    size,
    text,
  };
}

/** The newest `limit` bytes, start-snapped to a code-point boundary. */
export function readLogTail(filePath: string, limit: number): LogReadBody {
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - limit);
  const raw = readWindow(filePath, start, size - start);
  const leading = start > 0 ? codePointStart(raw) : 0;
  const bytes = raw.subarray(leading);
  const text = bytes.toString("utf8");
  return {
    mode: "tail",
    offset: start + leading,
    nextOffset: size,
    bytesRead: Buffer.byteLength(text),
    size,
    text,
  };
}

/**
 * The whole log when it fits `limit`; otherwise a startup head (one quarter)
 * plus the newest remainder, joined by an explicit omitted byte range.
 */
export function readLogAuto(filePath: string, limit: number): LogReadBody {
  const size = fs.statSync(filePath).size;
  if (size <= limit) {
    return readLogPage(filePath, 0, limit);
  }
  const headLength = Math.floor(limit / 4);
  const headRaw = readWindow(filePath, 0, headLength);
  const headEnd = completeCodePointEnd(headRaw);
  const head = headRaw.subarray(0, headEnd === 0 ? headRaw.length : headEnd);
  const tailStart = size - Math.max(1, limit - head.length);
  const tailRaw = readWindow(filePath, tailStart, size - tailStart);
  const tailLead = codePointStart(tailRaw);
  const tail = tailRaw.subarray(tailLead);
  const omittedStart = head.length;
  const omittedEnd = tailStart + tailLead;
  const text =
    head.toString("utf8") +
    `\n[… bytes ${omittedStart}-${omittedEnd - 1} omitted …]\n` +
    tail.toString("utf8");
  return {
    mode: "head_tail",
    offset: 0,
    nextOffset: size,
    bytesRead: Buffer.byteLength(text),
    size,
    text,
    omittedStart,
    omittedEnd,
  };
}

/**
 * Streaming case-insensitive line search from `offset` to the size observed
 * at scan start. Reads chunks (never the whole file — spills can be
 * 256 MiB), carries partial lines across chunk boundaries, and records each
 * match as `@<line-start-byte-offset>: <line>` with the line cut to 300
 * chars. Collection stops when the next formatted line would exceed `limit`
 * bytes; `matchCount` still counts the rest so the caller knows how much was
 * left out.
 */
export async function searchLogFile(
  filePath: string,
  options: SearchLogOptions,
): Promise<LogReadBody> {
  const chunkSize = Math.max(1, options.chunkSizeBytes ?? DEFAULT_SEARCH_CHUNK_BYTES);
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  const size = fs.statSync(filePath).size;
  const start = Math.min(Math.max(0, options.offset), size);

  const matches: Array<{ offset: number; text: string }> = [];
  let matchCount = 0;
  let shownBytes = 0;
  /** Line-start byte of the first match that did not fit; set once, so shown
   * matches are always a contiguous first-N prefix and a follow-up search from
   * `nextOffset` continues exactly where collection stopped. */
  let capOffset: number | undefined;

  const recordLine = (line: Buffer, lineOffset: number) => {
    const text = (
      line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line
    ).toString("utf8");
    options.pattern.lastIndex = 0;
    if (!options.pattern.test(text)) return;
    matchCount++;
    const shown =
      text.length > MATCH_LINE_MAX_CHARS ? `${text.slice(0, MATCH_LINE_MAX_CHARS)}…` : text;
    const formatted = `@${lineOffset}: ${shown}`;
    const cost = Buffer.byteLength(formatted) + (matches.length > 0 ? 1 : 0);
    if (capOffset !== undefined) return;
    if (shownBytes + cost <= options.limit) {
      matches.push({ offset: lineOffset, text: formatted });
      shownBytes += cost;
    } else {
      capOffset = lineOffset;
    }
  };

  // `pending` holds the current line's first `maxLineBytes`; a runaway line
  // is tested on that prefix only. `lineOffset` is the line's absolute start
  // byte, reset at every observed newline.
  let pending = Buffer.alloc(0);
  let lineOffset = start;

  const stream =
    start < size
      ? fs.createReadStream(filePath, {
          start,
          end: size - 1,
          highWaterMark: chunkSize,
        })
      : undefined;
  try {
    let chunkStart = start;
    for await (const chunk of stream ?? []) {
      options.signal?.throwIfAborted();
      const buffer = chunk as Buffer;
      const base = chunkStart;
      chunkStart += buffer.length;
      let segStart = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== 0x0a) continue;
        const whole =
          pending.length === 0
            ? buffer.subarray(segStart, index)
            : Buffer.concat([pending, buffer.subarray(segStart, index)]);
        recordLine(whole.subarray(0, maxLineBytes), lineOffset);
        pending = Buffer.alloc(0);
        segStart = index + 1;
        lineOffset = base + index + 1;
      }
      const rest = buffer.subarray(segStart);
      if (rest.length > 0 && pending.length < maxLineBytes) {
        const room = maxLineBytes - pending.length;
        pending =
          pending.length === 0
            ? Buffer.from(rest.subarray(0, room))
            : Buffer.concat([pending, rest.subarray(0, room)]);
      }
    }
    // A last line without a trailing newline still counts.
    if (pending.length > 0) recordLine(pending.subarray(0, maxLineBytes), lineOffset);
  } finally {
    stream?.destroy();
  }

  const text = matches.map((match) => match.text).join("\n");
  return {
    mode: "search",
    offset: start,
    nextOffset: capOffset ?? size,
    bytesRead: Buffer.byteLength(text),
    size,
    text,
    matchCount,
    matches,
    pattern: options.pattern.source,
  };
}
