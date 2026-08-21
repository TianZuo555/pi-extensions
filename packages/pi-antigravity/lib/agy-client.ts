/**
 * Imperative agy CLI client — spawns `agy --print` turns with stream-json
 * output, parses NDJSON, and folds events into an AgyTurnOutcome. The Effect
 * service in src/runtime.ts wraps this for typed lifecycle and abort handling.
 *
 * Every invocation hard-codes --dangerously-skip-permissions: headless agy
 * turns auto-deny any tool that needs a permission prompt, so skipping is
 * required for agy's own tools (run_command, file edits, browser) to work.
 */

import { spawn } from "node:child_process";
import { parseAgyLine } from "./events.ts";
import { applyEvent, newTurnOutcome, type AgyActivity, type AgyTurnOutcome } from "./reducer.ts";

export const AGY_BINARY = process.env.AGY_BINARY ?? "agy";

/** agy reasoning effort, as accepted by `agy --effort`. */
export type AgyEffort = "low" | "medium" | "high";

export interface AgyTurnRequest {
  prompt: string;
  /** Resume a prior conversation; omit to start a new one. */
  conversationId?: string;
  /** agy model id, e.g. "gemini-3.7-flash". */
  model?: string;
  /** Reasoning effort for this turn (agy --effort). */
  effort?: AgyEffort;
  /** Working directory for the agy process. */
  cwd?: string;
  /** Overall turn timeout; agy's own --print-timeout is set from this. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each structured activity event as tool steps stream in. */
  onActivity?: (activity: AgyActivity) => void;
  /** Test seam: replaces the spawned binary. */
  spawnOverride?: typeof spawn;
}

export class AgySpawnError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "AgySpawnError";
    this.stderr = stderr;
  }
}

export function buildAgyArgs(request: AgyTurnRequest): string[] {
  const timeout = Math.ceil((request.timeoutMs ?? 600_000) / 1000);
  // NOTE: agy's --print consumes the NEXT token as the prompt value (it is
  // not a boolean flag). The prompt MUST come immediately after --print,
  // otherwise the first following flag string becomes the prompt.
  const args = [
    "--print",
    request.prompt,
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    // agy's print mode does not treat the process cwd as the workspace; the
    // working directory must be registered explicitly via --add-dir.
    ...(request.cwd ? ["--add-dir", request.cwd] : []),
    "--print-timeout",
    `${timeout}s`,
  ];
  if (request.conversationId) args.push("--conversation", request.conversationId);
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  return args;
}

/**
 * Run one agy turn. Resolves with the reduced outcome once the process exits
 * or the result event arrives. Rejects with AgySpawnError when the process
 * fails before producing any result event (missing binary, auth failure, …).
 */
export function runAgyTurn(request: AgyTurnRequest): Promise<AgyTurnOutcome> {
  return new Promise((resolve, reject) => {
    const doSpawn = request.spawnOverride ?? spawn;
    const child = doSpawn(AGY_BINARY, buildAgyArgs(request), {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome = newTurnOutcome();
    let stdoutBuf = "";
    let stderrBuf = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn();
    };
    let settled = false;

    const killTimer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(
          new AgySpawnError(
            `agy turn timed out after ${Math.round((request.timeoutMs ?? 600_000) / 1000)}s`,
            stderrBuf,
          ),
        );
      });
    }, request.timeoutMs ?? 600_000);

    request.signal?.addEventListener(
      "abort",
      () => {
        finish(() => {
          child.kill("SIGKILL");
          outcome.status = "ERROR";
          outcome.error = "agy turn was aborted.";
          outcome.finished = true;
          resolve(outcome);
        });
      },
      { once: true },
    );

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const parsed = parseAgyLine(line);
        for (const activity of applyEvent(outcome, parsed)) {
          request.onActivity?.(activity);
        }
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 8_192) stderrBuf = stderrBuf.slice(-8_192);
    });

    child.on("error", (err) => {
      finish(() =>
        reject(
          new AgySpawnError(
            `failed to start agy (${err.message}). Install it or set AGY_BINARY.`,
            stderrBuf,
          ),
        ),
      );
    });

    child.on("close", (code) => {
      // Flush any trailing line without a newline.
      if (stdoutBuf.trim()) {
        for (const activity of applyEvent(outcome, parseAgyLine(stdoutBuf))) {
          request.onActivity?.(activity);
        }
      }
      finish(() => {
        if (outcome.finished) {
          resolve(outcome);
          return;
        }
        const tail = stderrBuf.trim().split("\n").slice(-3).join("\n");
        reject(
          new AgySpawnError(
            `agy exited with code ${code ?? "signal"} before producing a result${
              tail ? `: ${tail}` : ""
            }`,
            stderrBuf,
          ),
        );
      });
    });
  });
}
