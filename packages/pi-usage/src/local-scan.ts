// Local token-history scan for /tokens: reads pi's session JSONL files under
// <agentDir>/sessions and aggregates usage records (tokens, cost) from assistant
// messages, nested tool-result usage, standalone usage entries, and compaction
// / branch-summary usage — the same sources pi's session totals use.
//
// Runs inside the package's UsageRuntime ManagedRuntime graph like the provider
// queries: per-file parsing is wrapped in Effect, files are read concurrently
// (bounded), and global message-id dedup removes replayed/resumed copies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Data, Effect } from "effect";
import {
  NESTED_USAGE_MODEL,
  NESTED_USAGE_PROVIDER,
  type UsageRecord,
} from "../lib/tokens-model.ts";

export class LocalScanError extends Data.TaggedError("LocalScanError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ScanOptions {
  /** Include messages with timestamp >= sinceMs. */
  readonly sinceMs: number;
  /** Sessions root; defaults to <agentDir>/sessions. */
  readonly sessionsDir?: string;
  readonly signal?: AbortSignal;
  /** File parse concurrency (default 8). */
  readonly concurrency?: number;
}

export interface ScanResult {
  readonly records: readonly UsageRecord[];
  readonly filesScanned: number;
  readonly filesSkipped: number;
  readonly parseErrors: number;
  readonly oldestTs: number | undefined;
}

/** Sessions a file's messages may legally drift past the window start. */
const SESSION_DRIFT_MS = 7 * 24 * 60 * 60 * 1000;

export function defaultSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

export const scanLocalUsage = (options: ScanOptions): Effect.Effect<ScanResult, LocalScanError> =>
  Effect.gen(function* () {
    const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
    const files = yield* listSessionFiles(sessionsDir);
    const eligible = files.filter((file) => {
      const fileStart = sessionFileStartMs(path.basename(file));
      return fileStart === undefined || fileStart >= options.sinceMs - SESSION_DRIFT_MS;
    });
    const skipped = files.length - eligible.length;

    const perFile = yield* Effect.forEach(eligible, (file) => parseSessionFile(file, options), {
      concurrency: options.concurrency ?? 8,
    });

    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    let parseErrors = 0;
    let oldestTs: number | undefined;
    for (const parsed of perFile) {
      parseErrors += parsed.parseErrors;
      for (const record of parsed.records) {
        if (seen.has(record.id)) continue; // replayed/resumed copy
        seen.add(record.id);
        records.push(record);
        if (oldestTs === undefined || record.ts < oldestTs) oldestTs = record.ts;
      }
    }

    return {
      records,
      filesScanned: eligible.length,
      filesSkipped: skipped,
      parseErrors,
      oldestTs,
    };
  });

function listSessionFiles(sessionsDir: string): Effect.Effect<string[], LocalScanError> {
  return Effect.try({
    try: () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return; // unreadable or missing dir — nothing to scan
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
        }
      };
      walk(sessionsDir);
      return files.sort();
    },
    catch: (cause) =>
      new LocalScanError({ message: `Failed to list sessions in ${sessionsDir}`, cause }),
  });
}

interface FileParseResult {
  readonly records: UsageRecord[];
  readonly parseErrors: number;
}

function parseSessionFile(
  file: string,
  options: ScanOptions,
): Effect.Effect<FileParseResult, LocalScanError> {
  return Effect.callback<FileParseResult, LocalScanError>((resume) => {
    const records: UsageRecord[] = [];
    let parseErrors = 0;
    let settled = false;
    const settle = (result: FileParseResult | LocalScanError) => {
      if (settled) return;
      settled = true;
      resume(result instanceof LocalScanError ? Effect.fail(result) : Effect.succeed(result));
    };

    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(file, { encoding: "utf8" });
    } catch (cause) {
      settle(new LocalScanError({ message: `Failed to open ${file}`, cause }));
      return;
    }

    stream.on("error", () => {
      // Unreadable file: report zero records rather than failing the scan.
      settle({ records, parseErrors });
    });

    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line: string) => {
      if (options.signal?.aborted) {
        rl.close();
        stream.destroy();
        return;
      }
      // Cheap prefilter: usage-bearing entries always contain the key.
      if (!line.includes('"usage"')) return;
      const parsed = parseUsageLine(line);
      if (parsed === "invalid") {
        parseErrors += 1;
        return;
      }
      if (parsed === undefined) return;
      if (parsed.ts < options.sinceMs) return;
      records.push(parsed);
    });
    rl.on("close", () => settle({ records, parseErrors }));
    rl.on("error", () => settle({ records, parseErrors }));
  });
}

interface RawUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
  cost?: { total?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asUsage(value: unknown): RawUsage | undefined {
  return isRecord(value) ? value : undefined;
}

function usageRecord(
  id: string,
  ts: number | undefined,
  provider: string,
  model: string,
  usage: RawUsage,
): UsageRecord | "invalid" {
  if (ts === undefined) return "invalid";
  return {
    id,
    ts,
    provider,
    model,
    inputTokens: toNumber(usage.input),
    outputTokens: toNumber(usage.output),
    cacheReadTokens: toNumber(usage.cacheRead),
    cacheWriteTokens: toNumber(usage.cacheWrite),
    totalTokens: toNumber(usage.totalTokens),
    costUSD: usage.cost ? toNumber(usage.cost.total) : 0,
  };
}

/**
 * Countable usage follows pi's session totals: assistant messages, tool-result
 * nested usage, standalone usage entries, and compaction / branch summaries.
 * `"invalid"` is broken JSON or a countable entry missing required fields.
 * `undefined` is a valid line that is not usage (skip without a parse error).
 */
function parseUsageLine(line: string): UsageRecord | undefined | "invalid" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "invalid";
  }
  if (!isRecord(parsed)) return "invalid";
  const id = typeof parsed.id === "string" ? parsed.id : undefined;
  const type = parsed.type;

  if (type === "message") {
    if (!isRecord(parsed.message)) return undefined;
    const message = parsed.message;
    const usage = asUsage(message.usage);
    if (!usage) return undefined;
    if (id === undefined) return "invalid";
    if (message.role === "assistant") {
      const model =
        typeof message.responseModel === "string"
          ? message.responseModel
          : typeof message.model === "string"
            ? message.model
            : "unknown";
      return usageRecord(
        id,
        normalizeTimestamp(parsed.timestamp, message.timestamp),
        typeof message.provider === "string" ? message.provider : "unknown",
        model,
        usage,
      );
    }
    if (message.role === "toolResult") {
      return usageRecord(
        id,
        normalizeTimestamp(parsed.timestamp, message.timestamp),
        NESTED_USAGE_PROVIDER,
        NESTED_USAGE_MODEL,
        usage,
      );
    }
    return undefined;
  }

  if (type === "usage") {
    const usage = asUsage(parsed.usage);
    if (!usage || id === undefined) return "invalid";
    return usageRecord(
      id,
      normalizeTimestamp(parsed.timestamp, undefined),
      typeof parsed.provider === "string" ? parsed.provider : "unknown",
      typeof parsed.model === "string" ? parsed.model : "unknown",
      usage,
    );
  }

  if (type === "compaction" || type === "branch_summary") {
    const usage = asUsage(parsed.usage);
    if (!usage) return undefined;
    if (id === undefined) return "invalid";
    return usageRecord(
      id,
      normalizeTimestamp(parsed.timestamp, undefined),
      NESTED_USAGE_PROVIDER,
      NESTED_USAGE_MODEL,
      usage,
    );
  }

  return undefined;
}

function normalizeTimestamp(envelope: unknown, message: unknown): number | undefined {
  if (typeof envelope === "string") {
    const ms = Date.parse(envelope);
    if (!Number.isNaN(ms)) return ms;
  }
  if (typeof envelope === "number" && Number.isFinite(envelope)) return envelope;
  if (typeof message === "number" && Number.isFinite(message)) return message;
  return undefined;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** "2026-08-11T07-15-43-671Z_uuid.jsonl" → epoch ms, or undefined when unparseable. */
export function sessionFileStartMs(name: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (!match) return undefined; // non-standard name (e.g. repro.jsonl) — always scan
  const [, year, month, day, hour, minute, second, ms] = match;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms),
    ),
  );
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}
