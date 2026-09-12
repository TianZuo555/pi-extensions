/**
 * devin binary discovery and compatibility checks.
 *
 * Selection policy: `DEVIN_BINARY` is a strict override (no fallback when it
 * fails); otherwise `devin` from PATH. `devin version` prints
 * `devin X.Y.Z (<commit>)`; the minimum supported version is enforced.
 */

import { spawn } from "node:child_process";
import { gte, valid } from "semver";
import which from "which";

export const MIN_DEVIN_VERSION = "3000.10.0";
export const DEVIN_VERSION_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 64 * 1024;

export type DevinBinarySource = "override" | "path";

export type DevinBinaryFailureCategory =
  | "not-found"
  | "permission-denied"
  | "timeout"
  | "spawn-failed"
  | "invalid-version"
  | "unsupported-version";

export interface DevinBinarySuccess {
  ok: true;
  configured: string;
  binary: string;
  source: DevinBinarySource;
  version: string;
  revision?: string;
  message?: string;
}

export interface DevinBinaryFailure {
  ok: false;
  configured: string;
  binary?: string;
  source?: DevinBinarySource;
  category: DevinBinaryFailureCategory;
  message: string;
}

export type DevinBinaryCheck = DevinBinarySuccess | DevinBinaryFailure;

export class DevinCompatibilityError extends Error {
  readonly diagnostic: DevinBinaryFailure;
  constructor(diagnostic: DevinBinaryFailure) {
    super(diagnostic.message);
    this.name = "DevinCompatibilityError";
    this.diagnostic = diagnostic;
  }
}

export interface CheckDevinBinaryOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnOverride?: typeof spawn;
  whichOverride?: (command: string) => Promise<string>;
}

let cachedSuccess: { key: string; result: DevinBinarySuccess } | undefined;

export function resetDevinBinaryCache(): void {
  cachedSuccess = undefined;
}

/** Extract `X.Y.Z` and the parenthesized commit from `devin version` output. */
export function parseDevinVersion(
  output: string,
): { version: string; revision?: string } | undefined {
  const match = output.match(/devin\s+(\d+\.\d+\.\d+)(?:\s*\(([^)]+)\))?/i);
  if (!match || !valid(match[1])) return undefined;
  return { version: match[1], revision: match[2] };
}

export interface DevinCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run a devin subcommand with a bounded capture; used for models/version. */
export function runDevinCommand(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; spawnOverride?: typeof spawn } = {},
): Promise<DevinCommandResult> {
  const spawnImpl = options.spawnOverride ?? spawn;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnImpl> | undefined;
    try {
      child = spawnImpl(binary, args, {
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | undefined, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`devin ${args.join(" ")} timed out after ${timeoutMs}ms`), null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > OUTPUT_LIMIT) stdout = stdout.slice(0, OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > OUTPUT_LIMIT) stderr = stderr.slice(0, OUTPUT_LIMIT);
    });
    child.on("error", (error) => finish(error, null));
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        finish(
          new Error(`devin ${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 400)}`),
          code,
        );
        return;
      }
      finish(undefined, code);
    });
  });
}

async function probeBinary(
  binary: string,
  configured: string,
  source: DevinBinarySource,
  options: CheckDevinBinaryOptions,
): Promise<DevinBinaryCheck> {
  const timeoutMs = options.timeoutMs ?? DEVIN_VERSION_TIMEOUT_MS;
  let result: DevinCommandResult;
  try {
    result = await runDevinCommand(binary, ["version"], { ...options, timeoutMs });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const category: DevinBinaryFailureCategory =
      code === "ENOENT"
        ? "not-found"
        : code === "EACCES"
          ? "permission-denied"
          : /timed out/.test((error as Error).message)
            ? "timeout"
            : "spawn-failed";
    return {
      ok: false,
      configured,
      binary,
      source,
      category,
      message: `${binary} version probe failed: ${(error as Error).message}`,
    };
  }
  const parsed = parseDevinVersion(`${result.stdout}\n${result.stderr}`);
  if (!parsed) {
    return {
      ok: false,
      configured,
      binary,
      source,
      category: "invalid-version",
      message: `${binary} version output unrecognized: ${(result.stdout || result.stderr).trim().slice(0, 160)}`,
    };
  }
  if (!gte(parsed.version, MIN_DEVIN_VERSION)) {
    return {
      ok: false,
      configured,
      binary,
      source,
      category: "unsupported-version",
      message: `${binary} is devin ${parsed.version}, below the supported minimum ${MIN_DEVIN_VERSION}.`,
    };
  }
  return {
    ok: true,
    configured,
    binary,
    source,
    version: parsed.version,
    revision: parsed.revision,
  };
}

/**
 * Resolve and validate the devin binary. The successful result is cached by
 * the resolution key (override env or PATH); a failed probe never caches.
 */
export async function checkDevinBinary(
  options: CheckDevinBinaryOptions & { refresh?: boolean } = {},
): Promise<DevinBinaryCheck> {
  const env = options.env ?? process.env;
  const configured = env.DEVIN_BINARY?.trim() || "devin";
  const cacheKey = `${env.DEVIN_BINARY ?? ""}|${env.PATH ?? ""}`;
  if (!options.refresh && cachedSuccess?.key === cacheKey) return cachedSuccess.result;

  let binary = configured;
  const source: DevinBinarySource = env.DEVIN_BINARY?.trim() ? "override" : "path";
  if (source === "path") {
    try {
      const whichImpl = options.whichOverride ?? which;
      binary = await whichImpl("devin");
    } catch {
      return {
        ok: false,
        configured,
        source,
        category: "not-found",
        message:
          "devin not found on PATH. Install the Devin CLI or set DEVIN_BINARY to its absolute path.",
      };
    }
  }

  const result = await probeBinary(binary, configured, source, options);
  if (result.ok && source === "path") {
    cachedSuccess = { key: cacheKey, result };
  }
  return result;
}
