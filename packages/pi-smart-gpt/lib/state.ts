// What each probe left behind: one JSON line per run under
// ~/.pi/smart-gpt/runs.jsonl, so a series survives reloads and sessions.
//
// Nothing here reads or writes the repository, and no key is ever stored.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProbeRun } from "./magpie.ts";

const ACCOUNT_WIDTH = 32;

/** Where the runs live: PI_SMART_STATE_DIR, else ~/.pi/smart-gpt. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_SMART_STATE_DIR?.trim() || path.join(os.homedir(), ".pi", "smart-gpt");
}

export function runsFile(dir: string): string {
  return path.join(dir, "runs.jsonl");
}

export function appendRun(dir: string, run: ProbeRun): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(runsFile(dir), `${JSON.stringify(run)}\n`);
}

/** Every run on disk, oldest first. A line that cannot be read is skipped. */
export function readRuns(dir: string): ProbeRun[] {
  const file = runsFile(dir);
  if (!fs.existsSync(file)) return [];
  const runs: ProbeRun[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ProbeRun;
      if (typeof parsed?.at === "string" && typeof parsed.account === "string") runs.push(parsed);
    } catch {
      // A half-written line from a crash is not a run.
    }
  }
  return runs;
}

export function lastRuns(dir: string, count: number, account?: string): ProbeRun[] {
  const runs = readRuns(dir).filter((run) => account === undefined || run.account === account);
  return runs.slice(-count);
}

export function medianOf(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** How many runs in a row, this one included, were not 21. */
export function streakOf(runs: ProbeRun[]): number {
  let count = 0;
  for (const run of [...runs].reverse()) {
    if (run.verdict === "ok") break;
    count += 1;
  }
  return count;
}

/** A run's time in this computer's zone; the file keeps UTC. */
export function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(5, 16).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function fit(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

/** One probe, one line. */
export function formatRun(run: ProbeRun): string {
  if (run.verdict === "error") {
    return `${clockOf(run.at)}  ${fit(run.account, ACCOUNT_WIDTH)}  error  ${fit(run.error ?? "", 100).trimEnd()}`;
  }
  const reasoning = run.reasoningTokens === undefined ? "?" : String(run.reasoningTokens);
  return [
    clockOf(run.at),
    fit(run.account, ACCOUNT_WIDTH),
    `${String(run.answer ?? "?")} ${run.verdict}`.padEnd(10),
    `reasoning ${reasoning.padStart(4)}`,
    `${(run.latencyMs / 1000).toFixed(1)}s`,
  ].join("  ");
}

/** A series for one account, newest last, with its own baseline. */
export function formatHistory(runs: ProbeRun[], title: string): string {
  if (runs.length === 0) return `${title}\n  no runs yet — run /smart to record the first one`;
  const lines = [title];
  for (const run of runs) lines.push(`  ${formatRun(run)}`);
  const reasoning = runs
    .map((run) => run.reasoningTokens)
    .filter((value): value is number => value !== undefined);
  const median = medianOf(reasoning);
  const passed = runs.filter((run) => run.verdict === "ok").length;
  lines.push(
    `  ${runs.length} runs · ${passed} answered 21 · median reasoning ${median === undefined ? "?" : median} tok`,
  );
  const streak = streakOf(runs);
  if (streak >= 2) lines.push(`  the last ${streak} runs did not answer 21`);
  return lines.join("\n");
}
