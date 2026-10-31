/**
 * Pure file-based reads over a terminal's complete spill log, for the Code
 * Mode `output` field. Windows are byte addressed and snapped to UTF-8
 * code-point boundaries.
 */

import * as fs from "node:fs";
import { codePointStart, completeCodePointEnd } from "./utf8.ts";

export type LogReadMode = "page" | "head_tail";

export interface LogReadBody {
  readonly mode: LogReadMode;
  readonly offset: number;
  readonly nextOffset: number;
  /** Bytes of returned text. */
  readonly bytesRead: number;
  readonly size: number;
  readonly text: string;
  /** First omitted byte (head_tail). */
  readonly omittedStart?: number;
  /** Byte after the omitted range (head_tail). */
  readonly omittedEnd?: number;
}

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
  const readOffset = start + leading;
  // Only trim a split trailing sequence when the rest of it is already on
  // disk. At EOF there is nothing to stitch to. When the window cannot hold
  // even one code point (limit smaller than the sequence), expand to exactly
  // that code point — at most 3 bytes past limit — so the page still decodes
  // and the next page can continue after it.
  let bytes = atEof || complete === 0 ? body : body.subarray(0, complete);
  if (!atEof && complete === 0 && body.length > 0) {
    const lead = body[0];
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    bytes = readWindow(filePath, readOffset, Math.min(seqLen, size - readOffset));
  }
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

/**
 * The head of a head+tail view: the first `maxBytes`, cut on a code point.
 *
 * A window too small to hold the first code point would decode to U+FFFD, so
 * it expands to exactly that code point (at most 3 bytes over `maxBytes`).
 * These helpers are reachable from a public `limit` as low as 1, where a
 * multi-byte first character is the normal case, not an edge case.
 */
function headWindow(filePath: string, size: number, maxBytes: number) {
  const raw = readWindow(filePath, 0, Math.max(1, maxBytes));
  const complete = completeCodePointEnd(raw);
  if (complete > 0) return raw.subarray(0, complete);
  const lead = raw[0];
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return readWindow(filePath, 0, Math.min(Math.max(seqLen, raw.length), size));
}

/**
 * The whole log when it fits `limit`; otherwise the first and last
 * `limit / 2` bytes, joined by an explicit omitted byte range.
 *
 * This is the Code Mode contract Pi's built-in bash implements for
 * `structuredContent.output` (`readFullOutput`): equal halves around a
 * marker, so a script can tell where the omission starts and that the text
 * either side of it is a complete prefix and suffix. Both edges are snapped
 * to code points, so neither half decodes to U+FFFD.
 */
export function readLogHeadTail(filePath: string, limit: number): LogReadBody {
  const size = fs.statSync(filePath).size;
  if (size <= limit) return readLogPage(filePath, 0, limit);
  const head = headWindow(filePath, size, Math.floor(limit / 2));
  const tailStart = size - Math.max(1, limit - head.length);
  const tailRaw = readWindow(filePath, tailStart, size - tailStart);
  const tailLead = codePointStart(tailRaw);
  const tail = tailRaw.subarray(tailLead);
  const omittedStart = head.length;
  const omittedEnd = tailStart + tailLead;
  const omitted = omittedEnd - omittedStart;
  const text = `${head.toString("utf8")}\n\n[... ${omitted} bytes omitted ...]\n\n${tail.toString("utf8")}`;
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
