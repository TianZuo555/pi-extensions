/**
 * Streaming log search, executed inside a worker thread.
 *
 * The search pattern is a plain V8 RegExp, and a backtracking-heavy one such
 * as `(a+)+$` can spend unbounded time on a single line — long enough that
 * the event loop, and with it the whole Pi session, appears to hang. The scan
 * therefore runs off-thread: the caller waits with a hard timeout and
 * terminates the worker when it expires, so no pattern can wedge the session.
 *
 * Plain JS, like win32-child.mjs, because a worker needs a real file and the
 * package ships TypeScript that Node runs through type stripping. The
 * `completeCodePointEnd` helper is inlined rather than imported for the same
 * reason — keep it in sync with src/utf8.ts.
 */

import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";

const MATCH_LINE_MAX_CHARS = 300;

/** Length of the longest prefix of `buf` that ends on a complete code point. */
function completeCodePointEnd(buf) {
  let index = buf.length - 1;
  let continuations = 0;
  while (index >= 0 && (buf[index] & 0xc0) === 0x80 && continuations < 3) {
    index--;
    continuations++;
  }
  if (index < 0) return buf.length;
  const lead = buf[index];
  const needed = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
  if (needed === 0) return buf.length;
  return buf.length - index >= needed ? buf.length : index;
}

parentPort?.on("message", async (request) => {
  try {
    parentPort.postMessage({ ok: true, result: await scan(request) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Same scan contract as the `search` mode of `terminal_log_read`: line-start
 * byte offsets, a contiguous first-N prefix within `limit` bytes, the first
 * match always shown, and `matchCount` counting the rest.
 */
async function scan({ filePath, pattern, offset, chunkSizeBytes, maxLineBytes, limit, size }) {
  const matches = [];
  let matchCount = 0;
  let shownBytes = 0;
  /** Line-start byte of the first match that did not fit; set once, so shown
   * matches are always a contiguous first-N prefix and a follow-up search from
   * `nextOffset` continues exactly where collection stopped. */
  let capOffset;

  const recordLine = (line, lineOffset) => {
    const text = (
      line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line
    ).toString("utf8");
    pattern.lastIndex = 0;
    if (!pattern.test(text)) return;
    matchCount++;
    const shown =
      text.length > MATCH_LINE_MAX_CHARS ? `${text.slice(0, MATCH_LINE_MAX_CHARS)}…` : text;
    const formatted = `@${lineOffset}: ${shown}`;
    const cost = Buffer.byteLength(formatted) + (matches.length > 0 ? 1 : 0);
    if (capOffset !== undefined) return;
    if (matches.length === 0) {
      // The first match is always emitted, even when it cannot fit whole —
      // otherwise nextOffset could equal offset and continuation would loop.
      let line = formatted;
      if (cost > limit) {
        const prefix = `@${lineOffset}: `;
        const room = limit - Buffer.byteLength(prefix) - 3; // "…" is 3 bytes
        const cut = Buffer.from(shown, "utf8").subarray(0, Math.max(0, room));
        line = `${prefix}${cut.subarray(0, completeCodePointEnd(cut)).toString("utf8")}…`;
      }
      matches.push({ offset: lineOffset, text: line });
      shownBytes += Buffer.byteLength(line);
    } else if (shownBytes + cost <= limit) {
      matches.push({ offset: lineOffset, text: formatted });
      shownBytes += cost;
    } else {
      capOffset = lineOffset;
    }
  };

  // `pending` holds the current line's first `maxLineBytes`; a runaway line is
  // tested on that prefix only. `lineOffset` is the line's absolute start
  // byte, reset at every observed newline.
  let pending = Buffer.alloc(0);
  let lineOffset = offset;

  const stream =
    offset < size
      ? fs.createReadStream(filePath, {
          start: offset,
          end: size - 1,
          highWaterMark: chunkSizeBytes,
        })
      : undefined;
  try {
    let chunkStart = offset;
    for await (const chunk of stream ?? []) {
      const buffer = chunk;
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
    offset,
    nextOffset: capOffset ?? size,
    bytesRead: Buffer.byteLength(text),
    size,
    text,
    matchCount,
    matches,
    pattern: pattern.source,
  };
}
