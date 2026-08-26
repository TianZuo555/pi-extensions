/**
 * Discovery and control of agy background tasks.
 *
 * agy runs long-lived commands as background tasks and redirects their
 * stdout/stderr into `~/.gemini/antigravity-cli/brain/<conversation-id>/
 * .system_generated/tasks/task-N.log`. The stream-json RPC never reports
 * these tasks (the tool step stays ACTIVE until the turn errors out), so
 * this module works from the filesystem instead:
 *
 * - Listing: one log file per task; the first meaningful line usually shows
 *   the command.
 * - Liveness: a running task holds its log file open, so one batched `lsof`
 *   scan maps logs to live pid(s). No pids means the task already exited.
 * - Stopping: SIGTERM the process, preferring the whole process group so
 *   wrappers like `npm start` take their children down too.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface AgyTask {
  /** e.g. "task-3". */
  id: string;
  logPath: string;
  /** Live process pids holding the log open; empty when agy has exited. */
  pids: number[];
  /**
   * Likely orphaned processes: re-parented to launchd, sitting in the session
   * cwd, started when the log was created. agy pipes task output through
   * itself, so after agy exits nothing holds the log open and `pids` is
   * empty even though the task is still running.
   */
  orphans: number[];
  /** First meaningful log line — usually the command. */
  description: string;
  bytes: number;
}

export function agyBrainDir(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

/** Extract unique positive pids from `lsof -t` output. */
export function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** First meaningful log line, bounded — usually the command that ran. */
export function describeTaskLog(content: string): string {
  const line = content
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("npm warn"));
  if (!line) return "(no output)";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** Parse `ps -o etime=` output ([[dd-]hh:]mm:ss) into milliseconds. */
export function parseEtimeMs(etime: string): number {
  const [dayPart, timePart] = etime.trim().includes("-")
    ? etime.trim().split("-")
    : [undefined, etime.trim()];
  const parts = (timePart ?? "0").split(":").map((value) => Number.parseInt(value, 10));
  if (parts.some((value) => !Number.isInteger(value))) return Number.NaN;
  const seconds = parts.reverse().reduce((sum, value, index) => sum + value * 60 ** index, 0);
  const days = dayPart === undefined ? 0 : Number.parseInt(dayPart, 10);
  if (!Number.isInteger(seconds) || !Number.isInteger(days)) return Number.NaN;
  return (days * 86_400 + seconds) * 1_000;
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (_error, stdout) => {
      // `lsof` exits 1 when it found no files. Preserve any stdout it did
      // produce instead of coupling parsing to the command's exit status.
      resolve(String(stdout ?? ""));
    });
  });
}

/** Numeric newest-first ordering (`task-12.log` before `task-9.log`). */
export function compareAgyTaskLogNames(left: string, right: string): number {
  const leftMatch = left.match(/^task-(\d+)\.log$/);
  const rightMatch = right.match(/^task-(\d+)\.log$/);
  if (leftMatch && rightMatch) {
    return Number.parseInt(rightMatch[1], 10) - Number.parseInt(leftMatch[1], 10);
  }
  return right.localeCompare(left, undefined, { numeric: true });
}

/**
 * Parse one batched `lsof -Fpn` result into task-log → holder pids. Matching
 * by basename is safe because every input log is a direct child of one task
 * directory, and avoids macOS `/var` → `/private/var` canonicalization drift.
 */
export function parseTaskLogHolders(
  output: string,
  ownPid = process.pid,
): Map<string, number[]> {
  const holders = new Map<string, Set<number>>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
      continue;
    }
    if (!line.startsWith("n") || pid === undefined || pid === ownPid) continue;
    const name = path.basename(line.slice(1));
    const values = holders.get(name) ?? new Set<number>();
    values.add(pid);
    holders.set(name, values);
  }
  return new Map([...holders].map(([name, pids]) => [name, [...pids]]));
}

/** Inspect every log in one process, before this process opens any log. */
async function taskLogHolders(logPaths: string[]): Promise<Map<string, number[]>> {
  if (logPaths.length === 0) return new Map();
  const output = await execText("lsof", ["-nP", "-Fpn", "--", ...logPaths]);
  return parseTaskLogHolders(output);
}

interface TaskBirth {
  name: string;
  birthMs: number;
}

/** Parse pid → cwd from `lsof -Fpn -d cwd`. */
function parseProcessCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    } else if (line.startsWith("n") && pid !== undefined) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/**
 * Find orphan candidates once per scan, then assign each process to the
 * nearest task birth time. The old per-log implementation ran a full `ps`
 * and one or more `lsof` processes for every historical task.
 */
async function scanOrphans(
  sessionCwd: string,
  tasks: TaskBirth[],
): Promise<Map<string, number[]>> {
  if (tasks.length === 0) return new Map();
  const psOut = await execText("ps", ["-axo", "pid=,ppid=,etime="]);
  const now = Date.now();
  const candidates: Array<{ pid: number; startMs: number }> = [];
  for (const line of psOut.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (ppid !== 1 || pid === process.pid) continue;
    const startMs = now - parseEtimeMs(match[3]);
    if (
      !Number.isFinite(startMs) ||
      !tasks.some((task) => Math.abs(startMs - task.birthMs) <= 15_000)
    ) {
      continue;
    }
    candidates.push({ pid, startMs });
  }
  if (candidates.length === 0) return new Map();

  const cwdOutput = await execText("lsof", [
    "-a",
    "-nP",
    "-d",
    "cwd",
    "-p",
    candidates.map(({ pid }) => pid).join(","),
    "-Fpn",
  ]);
  const processCwds = parseProcessCwds(cwdOutput);
  const canonicalCwd = await fs.realpath(sessionCwd).catch(() => path.resolve(sessionCwd));
  const orphans = new Map<string, number[]>();
  for (const candidate of candidates) {
    const candidateCwd = processCwds.get(candidate.pid);
    if (candidateCwd !== canonicalCwd && candidateCwd !== path.resolve(sessionCwd)) continue;
    const nearest = tasks.reduce((best, task) =>
      Math.abs(candidate.startMs - task.birthMs) < Math.abs(candidate.startMs - best.birthMs)
        ? task
        : best,
    );
    const values = orphans.get(nearest.name) ?? [];
    values.push(candidate.pid);
    orphans.set(nearest.name, values);
  }
  return orphans;
}

/** List every background task recorded for an agy conversation. */
export async function listAgyTasks(
  conversationId: string,
  options: { brainDir?: string; sessionCwd?: string } = {},
): Promise<AgyTask[]> {
  const dir = path.join(options.brainDir ?? agyBrainDir(), conversationId, ".system_generated", "tasks");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const logs = entries
    .filter((name) => /^task-.+\.log$/.test(name))
    .sort(compareAgyTaskLogNames);
  const metadata = await Promise.all(
    logs.map(async (name) => {
      const logPath = path.join(dir, name);
      const stat = await fs.stat(logPath);
      return {
        name,
        logPath,
        stat,
        birthMs: stat.birthtimeMs || stat.mtimeMs,
      };
    }),
  );

  // Liveness must be sampled before readFile opens the logs. Running both in
  // one Promise.all made lsof randomly identify pi itself as every task's pid.
  const holders = await taskLogHolders(metadata.map(({ logPath }) => logPath));
  const orphanTasks = metadata
    .filter(({ name }) => (holders.get(name)?.length ?? 0) === 0)
    .map(({ name, birthMs }) => ({ name, birthMs }));
  const [contents, orphans] = await Promise.all([
    Promise.all(metadata.map(({ logPath }) => fs.readFile(logPath, "utf8").catch(() => ""))),
    options.sessionCwd
      ? scanOrphans(options.sessionCwd, orphanTasks)
      : Promise.resolve(new Map<string, number[]>()),
  ]);

  return metadata.map(({ name, logPath, stat }, index): AgyTask => ({
    id: name.replace(/\.log$/, ""),
    logPath,
    pids: holders.get(name) ?? [],
    orphans: orphans.get(name) ?? [],
    description: describeTaskLog(contents[index]),
    bytes: stat.size,
  }));
}

/** Resolve a task reference ("3", "task-3") against listed tasks. */
export function findAgyTask(tasks: AgyTask[], ref: string): AgyTask | undefined {
  const normalized = ref.startsWith("task-") ? ref : `task-${ref}`;
  return tasks.find((task) => task.id === normalized);
}

async function pgidOf(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const pgid = Number.parseInt(String(stdout).trim(), 10);
      resolve(Number.isInteger(pgid) && pgid > 1 ? pgid : undefined);
    });
  });
}

let cachedOwnPgid: Promise<number | undefined> | undefined;

/** Our own process group id, so stopAgyTask can refuse to signal it. */
function ownPgid(): Promise<number | undefined> {
  cachedOwnPgid ??= new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=", "-p", String(process.pid)], { timeout: 5_000 }, (error, stdout) => {
      const pgid = Number.parseInt(String(stdout).trim(), 10);
      resolve(error || !Number.isInteger(pgid) ? undefined : pgid);
    });
  });
  return cachedOwnPgid;
}

/**
 * Terminate a task's processes: prefer the process group (covers wrapper
 * scripts spawning children), always including the pid itself. Never signals
 * our own process group — an orphan can inherit agy's pgid, which may be the
 * one pi lives in. Returns the number of signals delivered.
 */
export function agyTaskStopPids(
  task: Pick<AgyTask, "pids" | "orphans">,
  includeOrphans = true,
  ownPid = process.pid,
): number[] {
  return [...new Set([...task.pids, ...(includeOrphans ? task.orphans : [])])].filter(
    (pid) => pid !== ownPid,
  );
}

export async function stopAgyTask(
  task: AgyTask,
  options: { includeOrphans?: boolean } = {},
): Promise<number> {
  const mine = await ownPgid();
  let signaled = 0;
  for (const pid of agyTaskStopPids(task, options.includeOrphans ?? true)) {
    const pgid = await pgidOf(pid);
    if (pgid !== undefined && pgid !== mine && pgid !== process.pid) {
      try {
        process.kill(-pgid, "SIGTERM");
        signaled++;
      } catch {
        // Fall through to the single-pid kill.
      }
    }
    try {
      process.kill(pid, "SIGTERM");
      signaled++;
    } catch {
      // Already gone.
    }
  }
  return signaled;
}
