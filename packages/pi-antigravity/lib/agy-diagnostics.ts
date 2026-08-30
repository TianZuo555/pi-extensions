import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gte, prerelease, rcompare, valid } from "semver";
import which from "which";
import { killAgyTree, trackAgyChild, untrackAgyChild } from "./agy-children.ts";

export const MIN_AGY_VERSION = "1.1.22";
export const AGY_VERSION_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_LIMIT = 8_192;
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;

export type AgyBinarySource = "override" | "path" | "managed";
export type AgyBinaryFailureCategory =
  | "not-found"
  | "permission-denied"
  | "timeout"
  | "spawn-failed"
  | "invalid-version"
  | "unsupported-version";

export interface AgyBinaryCandidateReport {
  binary: string;
  source: AgyBinarySource;
  ok: boolean;
  version?: string;
  development?: boolean;
  category?: AgyBinaryFailureCategory;
  message?: string;
}

export interface AgyBinarySuccess {
  ok: true;
  configured: string;
  binary: string;
  source: AgyBinarySource;
  version: string;
  development: boolean;
  stdout: string;
  stderr: string;
  candidates?: AgyBinaryCandidateReport[];
  selectionReason?: string;
  revision?: string;
}

export interface AgyBinaryFailure {
  ok: false;
  configured: string;
  binary?: string;
  source?: AgyBinarySource;
  category: AgyBinaryFailureCategory;
  message: string;
  stdout: string;
  stderr: string;
  candidates?: AgyBinaryCandidateReport[];
}

export type AgyBinaryCheck = AgyBinarySuccess | AgyBinaryFailure;

export class AgyCompatibilityError extends Error {
  readonly diagnostic: AgyBinaryFailure;

  constructor(diagnostic: AgyBinaryFailure) {
    super(diagnostic.message);
    this.name = "AgyCompatibilityError";
    this.diagnostic = diagnostic;
  }
}

interface BinaryCandidate {
  configured: string;
  binary: string;
  source: AgyBinarySource;
}

interface SpawnLikeError extends Error {
  code?: string;
}

export interface CheckAgyBinaryOptions {
  refresh?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  spawnOverride?: typeof spawn;
  statOverride?: (file: string) => Promise<{ mtimeMs: number; ctimeMs?: number; size: number }>;
  whichOverride?: (
    command: string,
    options?: { path?: string; pathExt?: string },
  ) => Promise<string>;
}

let cachedSuccess: { key: string; result: AgyBinarySuccess } | undefined;

export function resetAgyBinaryCache(): void {
  cachedSuccess = undefined;
}

async function binaryCacheIdentity(
  options: CheckAgyBinaryOptions,
  resolved: Awaited<ReturnType<typeof resolveAgyBinary>>,
): Promise<{ key: string; candidateRevisions: Map<string, string> }> {
  const env = options.env ?? process.env;
  const stat = options.statOverride ?? fs.stat;
  const signatures = await Promise.all(
    resolved.candidates.map(async (candidate) => {
      let signature: string;
      try {
        const info = await stat(candidate.binary);
        signature = `${candidate.binary}:${info.size}:${info.mtimeMs}:${info.ctimeMs ?? ""}`;
      } catch {
        signature = `${candidate.binary}:missing`;
      }
      return {
        cache: `${candidate.source}:${signature}`,
        binary: candidate.binary,
        revision: createHash("sha256").update(signature).digest("hex"),
      };
    }),
  );
  const material = [
    env.AGY_BINARY === undefined ? "auto" : `override:${env.AGY_BINARY}`,
    env.PATH ?? "",
    env.PATHEXT ?? "",
    options.homeDir ?? os.homedir(),
    options.platform ?? process.platform,
    ...signatures.map(({ cache }) => cache),
  ].join("\0");
  return {
    key: createHash("sha256").update(material).digest("hex"),
    candidateRevisions: new Map(
      signatures.map(({ binary, revision }) => [binary, revision] as const),
    ),
  };
}

function boundedAppend(current: string, chunk: string, limit = DIAGNOSTIC_LIMIT): string {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(-limit);
}

export function extractAgyVersion(
  stdout: string,
  stderr = "",
):
  | { version: string; development: false }
  | { version: "dev" | "HEAD"; development: true }
  | undefined {
  const text = `${stdout}\n${stderr}`;
  if (/\bHEAD\b/.test(text)) return { version: "HEAD", development: true };
  if (/\bdev(?:elopment)?\b/i.test(text)) return { version: "dev", development: true };
  const match = text.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/m);
  if (!match || !valid(match[1])) return undefined;
  return { version: match[1], development: false };
}

async function resolveCandidate(
  configured: string,
  source: AgyBinarySource,
  resolveWhich: NonNullable<CheckAgyBinaryOptions["whichOverride"]>,
  env: NodeJS.ProcessEnv,
): Promise<BinaryCandidate | undefined> {
  if (!configured.trim()) return undefined;
  try {
    const resolved = await resolveWhich(configured, {
      path: env.PATH,
      pathExt: env.PATHEXT,
    });
    return { configured, binary: path.resolve(resolved), source };
  } catch {
    return undefined;
  }
}

export async function resolveAgyBinary(
  options: CheckAgyBinaryOptions = {},
): Promise<{ candidates: BinaryCandidate[]; configured: string; strict: boolean }> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const resolveWhich =
    options.whichOverride ?? ((command, opts) => which(command, opts) as Promise<string>);
  const explicit = env.AGY_BINARY;
  if (explicit !== undefined) {
    const candidate = await resolveCandidate(explicit, "override", resolveWhich, env);
    return {
      candidates: candidate ? [candidate] : [],
      configured: explicit,
      strict: true,
    };
  }

  const candidates: BinaryCandidate[] = [];
  const fromPath = await resolveCandidate("agy", "path", resolveWhich, env);
  if (fromPath) candidates.push(fromPath);
  const managed = path.join(homeDir, ".gemini", "bin", platform === "win32" ? "agy.exe" : "agy");
  const managedCandidate = await resolveCandidate(managed, "managed", resolveWhich, env);
  if (
    managedCandidate &&
    !candidates.some((candidate) => candidate.binary === managedCandidate.binary)
  ) {
    candidates.push(managedCandidate);
  }
  return { candidates, configured: "agy", strict: false };
}

function classifySpawnError(error: SpawnLikeError): AgyBinaryFailureCategory {
  if (error.code === "ENOENT") return "not-found";
  if (error.code === "EACCES" || error.code === "EPERM") return "permission-denied";
  return "spawn-failed";
}

function checkCandidate(
  candidate: BinaryCandidate,
  configured: string,
  options: CheckAgyBinaryOptions,
): Promise<AgyBinaryCheck> {
  return new Promise((resolve) => {
    const doSpawn = options.spawnOverride ?? spawn;
    let stdout = "";
    let stderr = "";
    let versionHint: ReturnType<typeof extractAgyVersion>;
    let settled = false;
    const child = doSpawn(candidate.binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    trackAgyChild(child);

    const settle = (result: AgyBinaryCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      untrackAgyChild(child);
      resolve(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      versionHint ??= extractAgyVersion(chunk);
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      versionHint ??= extractAgyVersion("", chunk);
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", (error: SpawnLikeError) => {
      const category = classifySpawnError(error);
      settle({
        ok: false,
        configured,
        binary: candidate.binary,
        source: candidate.source,
        category,
        message: `antigravity: cannot run agy at ${candidate.binary} (${error.message}).`,
        stdout,
        stderr,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        settle({
          ok: false,
          configured,
          binary: candidate.binary,
          source: candidate.source,
          category: "spawn-failed",
          message: `antigravity: agy --version exited with code ${code ?? "signal"}.`,
          stdout,
          stderr,
        });
        return;
      }
      const parsed = versionHint ?? extractAgyVersion(stdout, stderr);
      if (!parsed) {
        settle({
          ok: false,
          configured,
          binary: candidate.binary,
          source: candidate.source,
          category: "invalid-version",
          message: `antigravity: agy at ${candidate.binary} returned an unrecognized version.`,
          stdout,
          stderr,
        });
        return;
      }
      if (!parsed.development && !gte(parsed.version, MIN_AGY_VERSION)) {
        settle({
          ok: false,
          configured,
          binary: candidate.binary,
          source: candidate.source,
          category: "unsupported-version",
          message: `antigravity: agy ${parsed.version} is unsupported; install ${MIN_AGY_VERSION} or newer.`,
          stdout,
          stderr,
        });
        return;
      }
      settle({
        ok: true,
        configured,
        binary: candidate.binary,
        source: candidate.source,
        version: parsed.version,
        development: parsed.development,
        stdout,
        stderr,
      });
    });

    const timer = setTimeout(() => {
      killAgyTree(child);
      settle({
        ok: false,
        configured,
        binary: candidate.binary,
        source: candidate.source,
        category: "timeout",
        message: `antigravity: agy --version timed out after ${Math.round((options.timeoutMs ?? AGY_VERSION_TIMEOUT_MS) / 1000)}s.`,
        stdout,
        stderr,
      });
    }, options.timeoutMs ?? AGY_VERSION_TIMEOUT_MS);
  });
}

function candidateReport(checked: AgyBinaryCheck): AgyBinaryCandidateReport | undefined {
  if (!checked.binary || !checked.source) return undefined;
  return checked.ok
    ? {
        binary: checked.binary,
        source: checked.source,
        ok: true,
        version: checked.version,
        development: checked.development,
      }
    : {
        binary: checked.binary,
        source: checked.source,
        ok: false,
        category: checked.category,
        message: checked.message,
      };
}

function selectAgyCandidate(successes: AgyBinarySuccess[]): AgyBinarySuccess | undefined {
  const versioned = successes.filter((candidate) => !candidate.development);
  const stable = versioned.filter((candidate) => prerelease(candidate.version) === null);
  if (stable.length > 0) {
    return [...stable].sort((left, right) => rcompare(left.version, right.version))[0];
  }
  if (versioned.length > 0) {
    return [...versioned].sort((left, right) => rcompare(left.version, right.version))[0];
  }
  return successes[0];
}

export async function checkAgyBinary(options: CheckAgyBinaryOptions = {}): Promise<AgyBinaryCheck> {
  if (options.refresh) cachedSuccess = undefined;
  const resolved = await resolveAgyBinary(options);
  const cacheIdentity = await binaryCacheIdentity(options, resolved);
  if (cachedSuccess?.key === cacheIdentity.key) return cachedSuccess.result;
  if (resolved.candidates.length === 0) {
    return {
      ok: false,
      configured: resolved.configured,
      category: "not-found",
      message: resolved.strict
        ? `antigravity: AGY_BINARY=${JSON.stringify(resolved.configured)} is not executable.`
        : "antigravity: agy was not found on PATH or at ~/.gemini/bin/agy. Install agy 1.1.22+ or set AGY_BINARY.",
      stdout: "",
      stderr: "",
      candidates: [],
    };
  }

  const checks = await Promise.all(
    resolved.candidates.map(async (candidate): Promise<AgyBinaryCheck> => {
      try {
        return await checkCandidate(candidate, resolved.configured, options);
      } catch (error) {
        return {
          ok: false,
          configured: resolved.configured,
          binary: candidate.binary,
          source: candidate.source,
          category: "spawn-failed",
          message: `antigravity: cannot run agy at ${candidate.binary} (${error instanceof Error ? error.message : String(error)}).`,
          stdout: "",
          stderr: "",
        };
      }
    }),
  );
  const reports = checks
    .map(candidateReport)
    .filter((report): report is AgyBinaryCandidateReport => report !== undefined);
  const selected = selectAgyCandidate(
    checks.filter((checked): checked is AgyBinarySuccess => checked.ok),
  );
  if (selected) {
    const result: AgyBinarySuccess = {
      ...selected,
      candidates: reports,
      revision: cacheIdentity.candidateRevisions.get(selected.binary),
      selectionReason: resolved.strict
        ? "explicit AGY_BINARY override"
        : selected.development
          ? "development fallback; no compatible versioned candidate was available"
          : prerelease(selected.version) !== null
            ? "highest compatible prerelease; no stable candidate was available"
            : `highest compatible stable version among ${checks.length} candidate${checks.length === 1 ? "" : "s"}`,
    };
    cachedSuccess = { key: cacheIdentity.key, result };
    return result;
  }

  const lastFailure = [...checks]
    .reverse()
    .find((checked): checked is AgyBinaryFailure => !checked.ok);
  return lastFailure
    ? { ...lastFailure, candidates: reports }
    : {
        ok: false,
        configured: resolved.configured,
        category: "spawn-failed",
        message: "antigravity: no agy candidate could be checked.",
        stdout: "",
        stderr: "",
        candidates: reports,
      };
}

export async function getAgyBinary(options: CheckAgyBinaryOptions = {}): Promise<string> {
  const checked = await checkAgyBinary(options);
  if (!checked.ok) throw new AgyCompatibilityError(checked);
  return checked.binary;
}

export interface RunAgyCommandOptions {
  binary?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  cwd?: string;
  spawnOverride?: typeof spawn;
}

export interface AgyCommandResult {
  binary: string;
  stdout: string;
  stderr: string;
}

/** Run one bounded auxiliary agy command through the selected compatible binary. */
export async function runAgyCommand(
  args: readonly string[],
  options: RunAgyCommandOptions = {},
): Promise<AgyCommandResult> {
  const binary = options.binary ?? (await getAgyBinary());
  if (options.signal?.aborted) {
    const error = new Error("agy command was aborted.");
    error.name = "AbortError";
    throw error;
  }
  return new Promise((resolve, reject) => {
    const doSpawn = options.spawnOverride ?? spawn;
    const limit = options.maxOutputBytes ?? COMMAND_OUTPUT_LIMIT;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = doSpawn(binary, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    trackAgyChild(child);

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      untrackAgyChild(child);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const fail = (message: string) => settle(() => reject(new Error(message)));
    const append = (current: string, chunk: string, streamName: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > limit) {
        killAgyTree(child);
        fail(`agy ${args[0] ?? "command"} ${streamName} exceeded ${limit} bytes.`);
        return current;
      }
      return next;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!settled) stdout = append(stdout, chunk, "stdout");
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (!settled) stderr = append(stderr, chunk, "stderr");
    });
    child.on("error", (error: SpawnLikeError) => {
      fail(`failed to run ${binary} (${error.message}).`);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        settle(() => resolve({ binary, stdout, stderr }));
      } else {
        fail(stderr.trim() || `agy ${args[0] ?? "command"} exited with code ${code ?? "signal"}`);
      }
    });

    const onAbort = () => {
      killAgyTree(child);
      settle(() => {
        const error = new Error("agy command was aborted.");
        error.name = "AbortError";
        reject(error);
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      killAgyTree(child);
      fail(
        `agy ${args[0] ?? "command"} timed out after ${Math.round((options.timeoutMs ?? 15_000) / 1000)}s.`,
      );
    }, options.timeoutMs ?? 15_000);
  });
}

/** True when the selected conversation database exists and is readable. */
export async function isReadableFile(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}
