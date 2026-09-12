/**
 * Streaming child-process execution for rg and fd.
 *
 * Both tools can produce far more output than a search should ever return, so
 * consumption is incremental and the child is killed when its caller reaches
 * a result or candidate cap. That bounds memory even when a broad pattern
 * would otherwise enumerate an entire monorepo.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { Effect } from "effect";
import { SEARCH_TIMEOUT_MS } from "../lib/prompt.ts";
import { missingBinaryMessage, resolveBinary, type SearchBinary } from "./binaries.ts";
import { SearchAbortedError, SearchProcessError, SearchToolMissingError } from "./errors.ts";

export interface StreamRequest {
  readonly binary: SearchBinary;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Called for each stdout record. Return false to stop consuming; the child is
   * killed and the run settles successfully with what was gathered so far.
   *
   * `clipped` marks a record that was longer than `maxRecordBytes`: only its
   * head is delivered, so callers must treat the tail as unknown.
   */
  readonly onLine: (line: string, clipped: boolean) => boolean;
  /** fd uses NUL records so newlines in filenames remain intact. */
  readonly delimiter?: "\n" | "\0";
  readonly signal?: AbortSignal;
  /** Wall-clock budget; defaults to SEARCH_TIMEOUT_MS. Overridable for tests. */
  readonly timeoutMs?: number;
  /** Bytes buffered per record before the tail is dropped; overridable for tests. */
  readonly maxRecordBytes?: number;
}

export interface StreamResult {
  /** True when onLine asked to stop, meaning more output was available. */
  readonly stoppedEarly: boolean;
  /** True when the wall-clock budget killed the child; gathered output is partial. */
  readonly timedOut: boolean;
  readonly exitCode: number | null;
}

/**
 * Bytes buffered per record. A record is one rg JSON match or one fd path, so
 * this only ever cuts pathological lines: without it, a 100 MiB single-line
 * file (an explicitly named bundle, sourcemap, or lockfile bypasses
 * --max-filesize) buffers the whole line and its decode copies, which measured
 * at 866 MiB RSS. Twice the traversal file cap leaves room for JSON escaping,
 * so ordinary searches are never cut.
 */
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * Exit codes that are not failures. rg uses 1 for "no matches", which is a
 * perfectly good answer; fd uses 0 even when nothing matched. A killed child
 * reports null, which is expected whenever we stop early or time out.
 */
function isBenignExit(
  binary: SearchBinary,
  code: number | null,
  stoppedEarly: boolean,
  timedOut: boolean,
): boolean {
  if (code === 0) return true;
  if (stoppedEarly || timedOut) return true;
  return binary === "rg" && code === 1;
}

function isDirectoryPath(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function streamLines(
  request: StreamRequest,
): Effect.Effect<StreamResult, SearchToolMissingError | SearchProcessError | SearchAbortedError> {
  return Effect.callback<
    StreamResult,
    SearchToolMissingError | SearchProcessError | SearchAbortedError
  >((resume, effectSignal) => {
    const binaryPath = resolveBinary(request.binary);
    if (binaryPath === null) {
      resume(
        new SearchToolMissingError({
          message: missingBinaryMessage(request.binary),
          tool: request.binary,
        }),
      );
      return;
    }

    const outerSignal = request.signal;
    if (outerSignal?.aborted === true || effectSignal.aborted) {
      resume(new SearchAbortedError({ message: `${request.binary} search aborted` }));
      return;
    }

    // Node reports a missing spawn cwd as `spawn <binary> ENOENT`, blaming
    // the executable instead of the directory. Guard it so any future caller
    // that bypasses the runtime-level root check still gets an honest error.
    if (!isDirectoryPath(request.cwd)) {
      resume(
        new SearchProcessError({
          message: `${request.binary} could not start: working directory does not exist or is not a directory: ${request.cwd}`,
          tool: request.binary,
        }),
      );
      return;
    }

    const child = spawn(binaryPath, [...request.args], {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const delimiter = request.delimiter ?? "\n";
    const maxRecordBytes = request.maxRecordBytes ?? MAX_RECORD_BYTES;
    let pending = "";
    let cutting = false;
    let stderr = "";
    let stoppedEarly = false;
    let timedOut = false;
    let settled = false;
    let aborted = false;

    const cleanup = () => {
      child.stdout.removeListener("data", onData);
      clearTimeout(timeoutId);
      outerSignal?.removeEventListener("abort", onAbort);
      effectSignal.removeEventListener("abort", onAbort);
    };

    const settle = (
      effect: Effect.Effect<
        StreamResult,
        SearchToolMissingError | SearchProcessError | SearchAbortedError
      >,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };

    const stopChild = (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };

    function onAbort() {
      aborted = true;
      stopChild("SIGKILL");
    }

    // A search should finish in well under the budget; the timer only bounds a
    // pathological hang (huge tree, network mount, FIFO) so it can never run
    // for a night. SIGKILL like Maka/Grok: a wedged child must not linger.
    const timeoutId = setTimeout(() => {
      timedOut = true;
      stopChild("SIGKILL");
    }, request.timeoutMs ?? SEARCH_TIMEOUT_MS);

    outerSignal?.addEventListener("abort", onAbort, { once: true });
    effectSignal.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: a pathological glob can make rg complain per file, and the
      // message we surface only ever needs the first few lines.
      if (stderr.length < 4096) stderr = (stderr + chunk.toString("utf8")).slice(0, 4096);
    });

    function onLine(line: string, clipped: boolean) {
      if (settled || stoppedEarly || aborted) return;
      let wantsMore: boolean;
      try {
        wantsMore = request.onLine(line, clipped);
      } catch (error) {
        stoppedEarly = true;
        stopChild("SIGKILL");
        settle(
          new SearchProcessError({
            message: `Failed to read ${request.binary} output: ${
              error instanceof Error ? error.message : String(error)
            }`,
            tool: request.binary,
          }),
        );
        return;
      }
      if (!wantsMore) {
        stoppedEarly = true;
        stopChild("SIGKILL");
      }
    }

    /** Emit the buffered record, cut short when it outgrew the buffer. */
    function flush(cut: boolean) {
      const line = pending;
      pending = "";
      cutting = false;
      onLine(line, cut);
    }

    function onData(chunk: string) {
      if (settled || stoppedEarly || aborted) return;
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(delimiter, start);
        if (cutting) {
          // Discard the tail of an over-long record; its head is already buffered.
          if (end === -1) return;
          flush(true);
          if (settled || stoppedEarly || aborted) return;
          start = end + 1;
          continue;
        }

        const room = maxRecordBytes - pending.length;
        const segment = end === -1 ? chunk.slice(start) : chunk.slice(start, end);
        if (segment.length > room) {
          pending += segment.slice(0, room);
          // Drop the tail, wherever it ended: the record cannot be decoded whole.
          if (end === -1) {
            cutting = true;
            return;
          }
          flush(true);
          if (settled || stoppedEarly || aborted) return;
          start = end + 1;
          continue;
        }

        pending += segment;
        if (end === -1) return;
        flush(false);
        if (settled || stoppedEarly || aborted) return;
        start = end + 1;
      }
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);

    child.on("error", (error: Error) => {
      settle(
        new SearchProcessError({
          message: `Failed to run ${request.binary}: ${error.message}`,
          tool: request.binary,
        }),
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      // A killed producer's trailing fragment is garbage, not a record: a
      // partial rg match would be dropped by the decoder anyway, but a
      // truncated fd path would silently become a bogus result. Only flush on a
      // natural exit, and only flush a cut record as cut.
      if (!timedOut && (pending.length > 0 || cutting)) flush(cutting);
      pending = "";
      cutting = false;
      if (aborted) {
        settle(
          new SearchAbortedError({
            message: `${request.binary} search aborted`,
          }),
        );
        return;
      }
      if (!isBenignExit(request.binary, code, stoppedEarly, timedOut)) {
        const detail = stderr.trim().split("\n")[0] ?? "";
        settle(
          new SearchProcessError({
            message:
              detail.length > 0
                ? `${request.binary} failed: ${detail}`
                : signal !== null
                  ? `${request.binary} terminated by ${signal}`
                  : `${request.binary} exited with code ${code}`,
            tool: request.binary,
            exitCode: code ?? undefined,
          }),
        );
        return;
      }
      settle(Effect.succeed({ stoppedEarly, timedOut, exitCode: code }));
    });

    // Interruption path: kill the child so a cancelled turn leaves nothing behind.
    return Effect.sync(() => {
      stopChild("SIGKILL");
      cleanup();
    });
  });
}
