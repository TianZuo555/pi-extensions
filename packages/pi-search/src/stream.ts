/**
 * Streaming child-process execution for rg and fd.
 *
 * Both tools can produce far more output than a search should ever return, so
 * consumption is incremental and the child is killed when its caller reaches
 * a result or candidate cap. That bounds memory even when a broad pattern
 * would otherwise enumerate an entire monorepo.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import {
  missingBinaryMessage,
  resolveBinary,
  type SearchBinary,
} from "./binaries.ts";
import {
  SearchAbortedError,
  SearchProcessError,
  SearchToolMissingError,
} from "./errors.ts";

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
}

export interface StreamResult {
  /** True when onLine asked to stop, meaning more output was available. */
  readonly stoppedEarly: boolean;
  readonly exitCode: number | null;
}

/**
 * Exit codes that are not failures. rg uses 1 for "no matches", which is a
 * perfectly good answer; fd uses 0 even when nothing matched. A killed child
 * reports null, which is expected whenever we stop early.
 */
function isBenignExit(
  binary: SearchBinary,
  code: number | null,
  stoppedEarly: boolean,
): boolean {
  if (code === 0 || code === null) return true;
  if (stoppedEarly) return true;
  return binary === "rg" && code === 1;
}

export function streamLines(
  request: StreamRequest,
): Effect.Effect<
  StreamResult,
  SearchToolMissingError | SearchProcessError | SearchAbortedError
> {
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
      resume(
        new SearchAbortedError({ message: `${request.binary} search aborted` }),
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
    let settled = false;
    let aborted = false;

    const cleanup = () => {
      reader.close();
      outerSignal?.removeEventListener("abort", onAbort);
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

    const stopChild = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    };

    function onAbort() {
      aborted = true;
      stopChild();
    }

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
      if (!isBenignExit(request.binary, code, stoppedEarly)) {
        const detail = stderr.trim().split("\n")[0] ?? "";
        settle(
          new SearchProcessError({
            message: detail.length > 0
              ? `${request.binary} failed: ${detail}`
              : `${request.binary} exited with code ${code}`,
            tool: request.binary,
            exitCode: code ?? undefined,
          }),
        );
        return;
      }
      settle(Effect.succeed({ stoppedEarly, exitCode: code }));
    });

    // Interruption path: kill the child so a cancelled turn leaves nothing behind.
    return Effect.sync(() => {
      stopChild();
      cleanup();
    });
  });
}
