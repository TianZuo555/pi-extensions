/**
 * Optional local debug log for studying how grep/find are used and where they
 * mislead: which notices fire, how often results come back empty or partial,
 * and which errors surface. Disabled unless PI_FIND_DEBUG is set.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

export interface SearchDebugEvent {
  readonly ts: string;
  readonly tool: "grep" | "find";
  readonly cwd: string;
  readonly params: Record<string, unknown>;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly resultCount?: number;
  readonly fileCount?: number;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly skippedRecords?: number;
  readonly contextLines?: number;
  readonly notices?: readonly string[];
  readonly error?: string;
}

export function debugEnabled(): boolean {
  const value = process.env.PI_FIND_DEBUG;
  return value === "1" || value === "true" || value === "on";
}

function debugFile(): string {
  return (
    process.env.PI_FIND_DEBUG_FILE ?? nodePath.join(homedir(), ".pi", "pi-find", "debug.jsonl")
  );
}

export function recordSearch(event: SearchDebugEvent): void {
  if (!debugEnabled()) return;
  try {
    const file = debugFile();
    mkdirSync(nodePath.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // Debug logging must never break a search.
  }
}
