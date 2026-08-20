// Local token-history scan for /tokens: reads pi's session JSONL files under
// <agentDir>/sessions and aggregates per-message usage records (tokens, cost).
//
// Runs inside the package's UsageRuntime ManagedRuntime graph like the provider
// queries: per-file parsing is wrapped in Effect, files are read concurrently
// (bounded), and global message-id dedup removes replayed/resumed copies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Data, Effect } from "effect";
import type { UsageRecord } from "../lib/tokens-model.ts";

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
    catch: (cause) => new LocalScanError({ message: `Failed to list sessions in ${sessionsDir}`, cause }),
  });
}

interface FileParseResult {
  readonly records: UsageRecord[];
  readonly parseErrors: number;
}

function parseSessionFile(file: string, options: ScanOptions): Effect.Effect<FileParseResult, LocalScanError> {
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
      // Cheap prefilter: usage only appears on assistant message records.
      if (!line.startsWith('{"type":"message"') || !line.includes('"usage"')) return;
      const record = parseUsageLine(line);
      if (!record) {
        parseErrors += 1;
        return;
      }
      if (record.ts < options.sinceMs) return;
      records.push(record);
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

interface RawMessageRecord {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown; // ISO string on the record envelope
  message?: {
    role?: unknown;
    timestamp?: unknown; // epoch ms on the message
    provider?: unknown;
    model?: unknown;
    usage?: RawUsage;
  };
}

function parseUsageLine(line: string): UsageRecord | undefined {
  let parsed: RawMessageRecord;
  try {
    parsed = JSON.parse(line) as RawMessageRecord;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant" || !message.usage) return undefined;
  const id = typeof parsed.id === "string" ? parsed.id : undefined;
  if (!id) return undefined;

  const ts = normalizeTimestamp(parsed.timestamp, message.timestamp);
  if (ts === undefined) return undefined;

  const usage = message.usage;
  return {
    id,
    ts,
    provider: typeof message.provider === "string" ? message.provider : "unknown",
    model: typeof message.model === "string" ? message.model : "unknown",
    inputTokens: toNumber(usage.input),
    outputTokens: toNumber(usage.output),
    cacheReadTokens: toNumber(usage.cacheRead),
    cacheWriteTokens: toNumber(usage.cacheWrite),
    totalTokens: toNumber(usage.totalTokens),
    costUSD: usage.cost ? toNumber(usage.cost.total) : 0,
  };
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
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(ms)),
  );
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}
