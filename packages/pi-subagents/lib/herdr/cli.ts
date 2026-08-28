/**
 * Effect wrapper around the herdr CLI — JSON envelopes vs raw terminal text.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Data, Effect } from "effect";

export class HerdrCommandError extends Data.TaggedError("HerdrCommandError")<{
  readonly message: string;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  /** Subprocess was SIGTERM'd by execFile timeout (distinct from herdr API timeout). */
  readonly killed?: boolean;
}> {}

export class HerdrProtocolError extends Data.TaggedError("HerdrProtocolError")<{
  readonly message: string;
  readonly stdout?: string;
}> {}

export class HerdrApiError extends Data.TaggedError("HerdrApiError")<{
  readonly code: string;
  readonly message: string;
  readonly id?: string;
}> {}

export type HerdrError = HerdrCommandError | HerdrProtocolError | HerdrApiError;

export interface HerdrCliOptions {
  /** Test hook: replace the herdr binary (defaults to `herdr`). */
  command?: string;
  /** Test hook: argv prefix before herdr subcommand args (e.g. `[fixturePath]`). */
  argsPrefix?: string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Grace added to herdr --timeout so the subprocess outlives herdr's own deadline. */
export const HERDR_SUBPROCESS_GRACE_MS = 15_000;

interface HerdrExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
}

function trimOutput(text: string): string {
  return text.trim();
}

function resolveCommand(options?: HerdrCliOptions): string {
  return options?.command ?? "herdr";
}

function resolveArgs(args: string[], options?: HerdrCliOptions): string[] {
  const prefix = options?.argsPrefix ?? [];
  return prefix.length ? [...prefix, ...args] : args;
}

function execHerdr(command: string, args: string[], timeoutMs?: number): Promise<HerdrExecResult> {
  return new Promise((resolve, _reject) => {
    execFile(
      command,
      args,
      {
        env: process.env,
        timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const stdoutStr = stdout?.toString() ?? "";
        const stderrStr = stderr?.toString() ?? "";
        if (error) {
          if ("killed" in error && error.killed) {
            resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 1, killed: true });
            return;
          }
          const exitCode = typeof error.code === "number" ? error.code : 1;
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode });
          return;
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 });
      },
    );
  });
}

function runHerdrEffect(
  args: string[],
  options?: HerdrCliOptions,
): Effect.Effect<HerdrExecResult, HerdrCommandError> {
  return Effect.tryPromise({
    try: () => execHerdr(resolveCommand(options), resolveArgs(args, options), options?.timeoutMs),
    catch: (cause) =>
      new HerdrCommandError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

/** Subprocess timeout for a herdr call that may block up to `herdrTimeoutMs`. */
export function herdrBlockingOptions(
  base: HerdrCliOptions | undefined,
  herdrTimeoutMs: number,
): HerdrCliOptions {
  return {
    ...base,
    timeoutMs: herdrTimeoutMs + HERDR_SUBPROCESS_GRACE_MS,
  };
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = trimOutput(text);
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function rawFailureText(stdout: string, stderr: string, exitCode: number): string {
  return trimOutput(stdout) || trimOutput(stderr) || `herdr exited with code ${exitCode}`;
}

function parseJsonEnvelope(
  stdout: string,
  stderr: string,
  exitCode: number,
): Effect.Effect<unknown, HerdrError> {
  const parsed = tryParseJson(stdout);

  if (parsed) {
    const error = parsed.error as { code?: string; message?: string } | undefined;
    if (error?.code) {
      return Effect.fail(
        new HerdrApiError({
          code: String(error.code),
          message: String(error.message ?? error.code),
          id: typeof parsed.id === "string" ? parsed.id : undefined,
        }),
      );
    }
    if ("result" in parsed) {
      return Effect.succeed(parsed.result);
    }
    return Effect.fail(
      new HerdrProtocolError({
        message: "herdr JSON response missing result",
        stdout: trimOutput(stdout),
      }),
    );
  }

  if (exitCode !== 0) {
    return Effect.fail(
      new HerdrCommandError({
        message: rawFailureText(stdout, stderr, exitCode),
        exitCode,
        stdout,
        stderr,
      }),
    );
  }

  return Effect.fail(
    new HerdrProtocolError({
      message: "herdr stdout was not valid JSON",
      stdout: trimOutput(stdout),
    }),
  );
}

/** Parse a `{id, result}` envelope and return `.result`. Never used for read commands. */
export function herdrJson(
  args: string[],
  options?: HerdrCliOptions,
): Effect.Effect<unknown, HerdrError> {
  return runHerdrEffect(args, options).pipe(
    Effect.flatMap((result) => {
      if (result.killed) {
        return Effect.fail(
          new HerdrCommandError({
            message: "herdr subprocess timed out",
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            killed: true,
          }),
        );
      }
      return parseJsonEnvelope(result.stdout, result.stderr, result.exitCode);
    }),
  );
}

/** Return stdout verbatim — for `agent read` / `pane read` only. Never JSON-parsed. */
export function herdrText(
  args: string[],
  options?: HerdrCliOptions,
): Effect.Effect<string, HerdrError> {
  return runHerdrEffect(args, options).pipe(
    Effect.flatMap((result) => {
      if (result.killed) {
        return Effect.fail(
          new HerdrCommandError({
            message: "herdr subprocess timed out",
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            killed: true,
          }),
        );
      }
      if (result.exitCode !== 0) {
        return Effect.fail(
          new HerdrCommandError({
            message: rawFailureText(result.stdout, result.stderr, result.exitCode),
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        );
      }
      return Effect.succeed(result.stdout);
    }),
  );
}

/** Strip ANSI CSI and OSC escape sequences from terminal read output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

export function resolveExecutableOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];

  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not executable or missing
      }
    }
  }
  return undefined;
}
