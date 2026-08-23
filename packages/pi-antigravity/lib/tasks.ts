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
 * - Liveness: a running task holds its log file open, so `lsof -t <log>`
 *   yields the live pid(s). No pids means the task already exited.
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

function tasksDir(conversationId: string): string {
  return path.join(agyBrainDir(), conversationId, ".system_generated", "tasks");
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
    execFile(command, args, { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? "" : String(stdout));
    });
  });
}

/**
 * Find a task's orphaned processes: re-parented (ppid 1), sitting in the
 * session cwd, and started within a small window of the log's creation.
 */
async function scanOrphans(
  sessionCwd: string,
  birthMs: number,
): Promise<number[]> {
  const psOut = await execText("ps", ["-axo", "pid=,ppid=,etime="]);
  const now = Date.now();
  const candidates: number[] = [];
  for (const line of psOut.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (ppid !== 1 || pid === process.pid) continue;
    const startMs = now - parseEtimeMs(match[3]);
    if (!Number.isFinite(startMs) || Math.abs(startMs - birthMs) > 15_000) continue;
    candidates.push(pid);
  }
  const orphans: number[] = [];
  for (const pid of candidates) {
    const lsofOut = await execText("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    if (lsofOut.split("\n").some((entry) => entry.startsWith("n") && entry.slice(1) === sessionCwd)) {
      orphans.push(pid);
    }
  }
  return orphans;
}

async function lsofPids(logPath: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-t", "--", logPath], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? [] : parseLsofPids(String(stdout)));
    });
  });
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
  const logs = entries.filter((name) => /^task-.+\.log$/.test(name)).sort();
  return Promise.all(
    logs.map(async (name): Promise<AgyTask> => {
      const logPath = path.join(dir, name);
      const [stat, content, pids] = await Promise.all([
        fs.stat(logPath),
        fs.readFile(logPath, "utf8").catch(() => ""),
        lsofPids(logPath),
      ]);
      const birthMs = stat.birthtimeMs || stat.mtimeMs;
      const orphans =
        pids.length === 0 && options.sessionCwd
          ? await scanOrphans(options.sessionCwd, birthMs)
          : [];
      return {
        id: name.replace(/\.log$/, ""),
        logPath,
        pids,
        orphans,
        description: describeTaskLog(content),
        bytes: stat.size,
      };
    }),
  );
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
): number[] {
  return [...new Set([...task.pids, ...(includeOrphans ? task.orphans : [])])];
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
