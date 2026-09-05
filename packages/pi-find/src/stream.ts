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
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { SEARCH_TIMEOUT_MS } from "../lib/prompt.ts";
import { missingBinaryMessage, resolveBinary, type SearchBinary } from "./binaries.ts";
import { SearchAbortedError, SearchProcessError, SearchToolMissingError } from "./errors.ts";

export interface StreamRequest {
  readonly binary: SearchBinary;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * Called for each stdout line. Return false to stop consuming; the child is
   * killed and the run settles successfully with what was gathered so far.
   */
  readonly onLine: (line: string) => boolean;
  readonly signal?: AbortSignal;
  /** Wall-clock budget; defaults to SEARCH_TIMEOUT_MS. Overridable for tests. */
  readonly timeoutMs?: number;
}

export interface StreamResult {
  /** True when onLine asked to stop, meaning more output was available. */
  readonly stoppedEarly: boolean;
  /** True when the wall-clock budget killed the child; gathered output is partial. */
  readonly timedOut: boolean;
  readonly exitCode: number | null;
}

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
  if (code === 0 || code === null) return true;
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

    const reader = createInterface({ input: child.stdout });
    let stderr = "";
    let stoppedEarly = false;
    let timedOut = false;
    let settled = false;
    let aborted = false;

    const cleanup = () => {
      reader.close();
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
      stopChild();
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
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });

    reader.on("line", (line: string) => {
      if (stoppedEarly || aborted) return;
      let wantsMore: boolean;
      try {
        wantsMore = request.onLine(line);
      } catch (error) {
        stoppedEarly = true;
        stopChild();
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
        stopChild();
      }
    });

    child.on("error", (error: Error) => {
      settle(
        new SearchProcessError({
          message: `Failed to run ${request.binary}: ${error.message}`,
          tool: request.binary,
        }),
      );
    });

    child.on("close", (code: number | null) => {
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
      stopChild();
      cleanup();
    });
  });
}
