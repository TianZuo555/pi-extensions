/**
 * Pure file-based reads over a terminal's complete spill log.
 *
 * The manager resolves the model's opaque ref to a private path and delegates
 * here; nothing in this module knows about terminals. All windows are byte
 * addressed and snapped to UTF-8 code-point boundaries so paging with
 * `nextOffset` is byte-exact.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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
  /** Hard bound on the whole scan; injectable for tests. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_SEARCH_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

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

/** The newest `limit` bytes, start-snapped to a code-point boundary. */
export function readLogTail(filePath: string, limit: number): LogReadBody {
  const size = fs.statSync(filePath).size;
  let start = Math.max(0, size - limit);
  const raw = readWindow(filePath, start, size - start);
  const leading = start > 0 ? codePointStart(raw) : 0;
  let bytes = raw.subarray(leading);
  let offset = start + leading;
  if (bytes.length === 0 && raw.length > 0) {
    // The window sits entirely inside the final multi-byte code point (limit
    // smaller than the sequence). Back up to its lead byte so tail still
    // returns at least that code point.
    const probeStart = Math.max(0, size - 4);
    const probe = readWindow(filePath, probeStart, size - probeStart);
    let lead = probe.length - 1;
    while (lead > 0 && (probe[lead] & 0xc0) === 0x80) lead--;
    start = probeStart + lead;
    offset = start;
    bytes = probe.subarray(lead);
  }
  const text = bytes.toString("utf8");
  return {
    mode: "tail",
    offset,
    nextOffset: size,
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
  const head = headWindow(filePath, size, headLength);
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
 * chars. The first match is always shown — cut to `limit` bytes on a UTF-8
 * boundary ending in `…` when needed — so `nextOffset` always advances past
 * `offset` and a capped continuation cannot loop. Collection stops when a
 * later match would exceed `limit` bytes; `matchCount` still counts the rest
 * so the caller knows how much was left out.
 *
 * The scan itself runs in a worker (see log-search-worker.mjs): the pattern
 * is a plain V8 RegExp, and a backtracking-heavy one such as `(a+)+b` can
 * spend unbounded time failing against a repetitive line — long enough that
 * the event loop, and with it the whole Pi session, appears to hang. The
 * abort signal cannot interrupt a running `RegExp.test`, so no amount of
 * between-chunk checks helps; only moving the scan off-thread does. A search
 * that outlives `SEARCH_TIMEOUT_MS` is terminated and fails with an
 * actionable error.
 */
export const SEARCH_TIMEOUT_MS = 15_000;

const SEARCH_WORKER_PATH = fileURLToPath(new URL("./log-search-worker.mjs", import.meta.url));

export async function searchLogFile(
  filePath: string,
  options: SearchLogOptions,
): Promise<LogReadBody> {
  options.signal?.throwIfAborted();
  const timeoutMs = Math.max(1, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const size = fs.statSync(filePath).size;
  const request = {
    filePath,
    pattern: options.pattern,
    offset: Math.min(Math.max(0, options.offset), size),
    chunkSizeBytes: Math.max(1, options.chunkSizeBytes ?? DEFAULT_SEARCH_CHUNK_BYTES),
    maxLineBytes: Math.max(1, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES),
    limit: options.limit,
    size,
  };

  const worker = new Worker(SEARCH_WORKER_PATH);
  // An in-flight search must never delay shutdown: if the session ends first,
  // neither the worker nor the timeout timer should hold the event loop.
  worker.unref();
  return new Promise<LogReadBody>((resolve, reject) => {
    const stop = (error: unknown) => {
      clearTimeout(timer);
      worker.terminate();
      reject(error);
    };
    const timer = setTimeout(() => {
      stop(
        new Error(
          `the pattern search stopped after ${timeoutMs / 1000}s without finishing — the pattern is likely too complex; simplify it or narrow the range with offset`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => stop(options.signal?.reason ?? new Error("search aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: { ok: boolean; result?: LogReadBody; error?: string }) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      if (message.ok && message.result) resolve(message.result);
      else reject(new Error(message.error ?? "log search failed"));
    });
    worker.on("error", (error) => stop(error));
    worker.on("exit", (code) => {
      if (code !== 0) stop(new Error(`log search worker exited with code ${code}`));
    });
    worker.postMessage(request);
  });
}
