/**
 * agy model-quota fetch — ports the interactive `/usage` (`/quota`) slash
 * command by expanding it in print mode. agy has no `usage` subcommand; with
 * slash expansion left enabled, `agy --print /usage --output-format json`
 * returns the same structured quota payload the TUI panel shows, and reports
 * zero tokens (it is a command, not a model turn).
 */

import { spawn } from "node:child_process";
import { killAgyTree, trackAgyChild, untrackAgyChild } from "./agy-children.ts";
import { AGY_BINARY } from "./agy-client.ts";

export const USAGE_TIMEOUT_MS = 30_000;

export interface AgyUsageBucket {
  id: string;
  name: string;
  description?: string;
  window: string;
  remainingFraction: number;
  resetTime?: string;
}

export interface AgyUsageGroup {
  name: string;
  description?: string;
  buckets: AgyUsageBucket[];
}

export interface AgyUsageReport {
  description?: string;
  groups: AgyUsageGroup[];
}

export interface FetchAgyUsageOptions {
  binary?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam: replaces `execFile`. */
  execFileOverride?: (
    file: string,
    args: readonly string[],
    options: { timeout?: number; signal?: AbortSignal; encoding?: string; maxBuffer?: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unwrapResult(parsed: unknown): Record<string, unknown> {
  const root = asRecord(parsed);
  if (!root) throw new Error("agy-usage: quota response was not an object.");
  if (root.event === "result") {
    const inner = asRecord(root.result);
    if (inner) return inner;
  }
  return root;
}

function parseBucket(value: unknown): AgyUsageBucket | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const id = asString(rec.id) ?? asString(rec.name);
  const name = asString(rec.name) ?? asString(rec.id);
  const remaining =
    asNumber(rec.remaining_fraction) ?? asNumber(rec.remainingFraction) ?? asNumber(rec.remaining);
  if (!id || !name || remaining === undefined) return undefined;
  return {
    id,
    name,
    description: asString(rec.description),
    window: asString(rec.window) ?? id,
    remainingFraction: remaining,
    resetTime: asString(rec.reset_time) ?? asString(rec.resetTime),
  };
}

function parseGroup(value: unknown): AgyUsageGroup | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const name = asString(rec.name);
  if (!name) return undefined;
  const buckets = Array.isArray(rec.buckets)
    ? rec.buckets
        .map(parseBucket)
        .filter((bucket): bucket is AgyUsageBucket => bucket !== undefined)
    : [];
  return { name, description: asString(rec.description), buckets };
}

/** Parse `agy --print /usage --output-format json` stdout (or a stream-json result envelope). */
export function parseAgyUsageJson(text: string): AgyUsageReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("agy-usage: quota response was not valid JSON.");
  }
  const result = unwrapResult(parsed);
  const status = asString(result.status);
  if (status && status !== "SUCCESS" && status !== "OK") {
    throw new Error(asString(result.error) ?? `agy-usage: quota command failed (${status}).`);
  }
  const command = asRecord(result.command);
  if (command && asString(command.name) && command.name !== "usage") {
    throw new Error(`agy-usage: expected usage command, got "${asString(command.name)}".`);
  }
  const data = asRecord(command?.data) ?? asRecord(result.data);
  const groups = Array.isArray(data?.groups)
    ? data.groups.map(parseGroup).filter((group): group is AgyUsageGroup => group !== undefined)
    : [];
  if (groups.length === 0) {
    throw new Error("agy-usage: no quota groups returned.");
  }
  return { description: asString(data?.description), groups };
}

const BAR_SEGMENTS = 20;
const LABEL_COLUMN = 18;

/** Remaining allowance as a 0–100 percentage. */
export function remainingPercent(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

function padTime(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Clock-style reset matching pi-usage `/usage`: `14:30` today or `09:10 on 4 Sep`. */
export function formatReset(iso: string, now: Date = new Date()): string | undefined {
  const reset = new Date(iso);
  if (Number.isNaN(reset.getTime())) return undefined;
  const time = `${padTime(reset.getHours())}:${padTime(reset.getMinutes())}`;
  if (reset.toDateString() === now.toDateString()) return time;
  return `${time} on ${reset.getDate()} ${reset.toLocaleDateString("en-US", { month: "short" })}`;
}

export function usageBar(fraction: number, segments = BAR_SEGMENTS): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * segments);
  return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
}

/** Window label matching `/usage` (`weekly` → `Weekly limit`, `5h` → `5h limit`). */
export function usageWindowLabel(bucket: AgyUsageBucket): string {
  const window = bucket.window.toLowerCase();
  if (window === "weekly" || window.includes("week")) return "Weekly limit";
  if (window === "5h" || window.includes("5") || window.includes("hour")) return "5h limit";
  const stripped = bucket.name.replace(/\s*limit remaining$/i, "").trim() || bucket.name;
  return /limit$/i.test(stripped) ? stripped : `${stripped} limit`;
}

function windowRank(bucket: AgyUsageBucket): number {
  const window = bucket.window.toLowerCase();
  if (window === "5h" || window.includes("hour") || /\b5h\b/.test(window)) return 0;
  if (window === "weekly" || window.includes("week")) return 1;
  return 2;
}

function formatBucket(bucket: AgyUsageBucket, now: Date): string {
  const label = `${usageWindowLabel(bucket)}:`.padEnd(LABEL_COLUMN);
  const percent = remainingPercent(bucket.remainingFraction);
  const parts = [`${usageBar(bucket.remainingFraction)} ${percent}% left`];
  const reset = bucket.resetTime ? formatReset(bucket.resetTime, now) : undefined;
  if (reset) parts.push(`resets ${reset}`);
  return `  ${label}${parts.join(" · ")}`;
}

/** Multi-line report in the same layout as pi-usage `/usage`. */
export function formatAgyUsageReport(report: AgyUsageReport, now: Date = new Date()): string {
  return report.groups
    .map((group) => {
      const buckets = [...group.buckets].sort((a, b) => windowRank(a) - windowRank(b));
      const lines = [group.name];
      for (let i = 0; i < buckets.length; i++) {
        if (i > 0) lines.push("");
        lines.push(formatBucket(buckets[i], now));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function buildAgyUsageArgs(timeoutMs = USAGE_TIMEOUT_MS): string[] {
  const timeout = Math.max(1, Math.ceil(timeoutMs / 1000));
  // Slash expansion is the whole point: do NOT pass --disable-slash-commands.
  // --print consumes the next token as the prompt, so /usage must follow it.
  return ["--print", "/usage", "--output-format", "json", "--print-timeout", `${timeout}s`];
}

function defaultExec(
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal; encoding?: string; maxBuffer?: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let out = "";
  let errOut = "";
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn();
  };
  // Raw spawn (execFile drops `detached`): own process group + tracked, so
  // timeout/abort reaps agy's whole tree instead of the direct child only.
  const child = spawn(file, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    signal: options.signal,
  });
  trackAgyChild(child);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
    if (options.maxBuffer !== undefined && out.length > options.maxBuffer) {
      settle(() => {
        killAgyTree(child);
        callback(new Error("stdout maxBuffer exceeded"), "", "");
      });
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    errOut += chunk;
  });
  child.on("error", (error) => {
    settle(() => {
      untrackAgyChild(child);
      callback(error, "", "");
    });
  });
  child.on("close", (code) => {
    settle(() => {
      untrackAgyChild(child);
      callback(
        code === 0 ? null : new Error(errOut.trim() || `${file} exited with code ${code ?? "signal"}`),
        out,
        errOut,
      );
    });
  });
  options.signal?.addEventListener(
    "abort",
    () => {
      settle(() => {
        killAgyTree(child);
        callback(new Error("aborted"), "", "");
      });
    },
    { once: true },
  );
  if (options.timeout !== undefined) {
    timer = setTimeout(() => {
      settle(() => {
        killAgyTree(child);
        callback(new Error(`${file} timed out after ${options.timeout}ms`), "", "");
      });
    }, options.timeout);
  }
}

/** Run `agy --print /usage` and parse the structured quota payload. */
export function fetchAgyUsage(options: FetchAgyUsageOptions = {}): Promise<AgyUsageReport> {
  const binary = options.binary ?? AGY_BINARY;
  const timeoutMs = options.timeoutMs ?? USAGE_TIMEOUT_MS;
  const run = options.execFileOverride ?? defaultExec;
  return new Promise((resolve, reject) => {
    run(
      binary,
      buildAgyUsageArgs(timeoutMs),
      { timeout: timeoutMs, signal: options.signal, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (options.signal?.aborted || error.name === "AbortError") {
            const abort = new Error(error.message);
            abort.name = "AbortError";
            reject(abort);
            return;
          }
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(parseAgyUsageJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
