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
 * - Liveness, in order of trust:
 *   1. A process holding the log open (`lsof`), when agy redirects the
 *      task's output straight into the file (older agy versions).
 *   2. A process-group-leading child of a live agy process we spawned
 *      (agy >= 1.2.0 pipes task output through itself, so nothing holds
 *      the log open; tasks run as agy's children in their own group).
 *   3. Orphan heuristic for tasks that outlived their agy parent:
 *      re-parented to launchd, sitting in the session cwd or agy's own
 *      config directory (agy >= 1.2.0 spawns tasks from there), started
 *      when the log was created.
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
  /** Live task processes (log holders or children of a live agy process). */
  pids: number[];
  /**
   * Live processes that could belong to this task or a sibling started in the
   * same `ps` resolution window. Shown as uncertain, never signalled: stopping
   * a task kills its process group, so acting on a guess could kill a
   * different task's work.
   */
  ambiguous: number[];
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

/** One `ps` row: identity plus an approximate start time. */
export interface AgyProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  startMs: number;
}

/** Parse `ps -axo pid=,ppid,pgid,etime=` output into process rows. */
export function parseAgyProcessRows(output: string, now = Date.now()): AgyProcessRow[] {
  const rows: AgyProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const startMs = now - parseEtimeMs(match[4]);
    if (!Number.isFinite(startMs)) continue;
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      pgid: Number.parseInt(match[3], 10),
      startMs,
    });
  }
  return rows;
}

/**
 * Candidate task processes among live agy children: agy spawns each task
 * as a process-group leader, so `pgid === pid` separates task commands
 * from agy's own helpers.
 */
export function selectAgyTaskDescendants(
  rows: AgyProcessRow[],
  agyPids: number[],
  ownPid = process.pid,
): Array<{ pid: number; startMs: number }> {
  const parents = new Set(agyPids);
  return rows
    .filter((row) => parents.has(row.ppid) && row.pgid === row.pid && row.pid !== ownPid)
    .map(({ pid, startMs }) => ({ pid, startMs }));
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

/**
 * Whether an agy process currently owns a running tool command.
 *
 * The stall watchdog's "no stdout" signal cannot distinguish a wedged agy
 * from a healthy one running a quiet foreground command: agy emits nothing
 * on stdout while a tool step is ACTIVE, so a slow `cargo build` looks
 * identical to a hang. It does, however, spawn each tool command as a
 * process-group leader in its own group, so the presence of such a child is
 * positive evidence of real work. Absence is not proof of a hang — agy's
 * in-process tools (`schedule`, `search_web`) never spawn anything — so
 * callers must keep a bounded timeout as the fallback.
 */
export async function agyHasRunningToolProcess(agyPids: number[]): Promise<boolean> {
  if (agyPids.length === 0) return false;
  const rows = parseAgyProcessRows(await execText("ps", ["-axo", "pid=,ppid=,pgid=,etime="]));
  return selectAgyTaskDescendants(rows, agyPids).length > 0;
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
export function parseTaskLogHolders(output: string, ownPid = process.pid): Map<string, number[]> {
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

/** `ps` etime resolution: start times closer than this are indistinguishable. */
const BIRTH_MATCH_RESOLUTION_MS = 1_000;

/**
 * Assign each candidate to the task whose log birth time is nearest.
 *
 * `ps` etime has one-second resolution, so commands launched within the same
 * second cannot be told apart by start time. Guessing is unsafe here: stopping
 * a task signals its whole process group, so mis-assigning pid B to task A
 * means stopping A also kills B. When the nearest task is not unambiguous the
 * candidate is reported as an ambiguous match against every plausible task
 * instead of becoming one task's independently stoppable pid.
 */
function assignNearestBirth(
  candidates: Array<{ pid: number; startMs: number }>,
  tasks: TaskBirth[],
): { assigned: Map<string, number[]>; ambiguous: Map<string, number[]> } {
  const assigned = new Map<string, number[]>();
  const ambiguous = new Map<string, number[]>();
  if (tasks.length === 0) return { assigned, ambiguous };
  const add = (map: Map<string, number[]>, name: string, pid: number) => {
    const values = map.get(name) ?? [];
    values.push(pid);
    map.set(name, values);
  };
  for (const candidate of candidates) {
    const deltas = tasks.map((task) => ({
      task,
      delta: Math.abs(candidate.startMs - task.birthMs),
    }));
    const bestDelta = Math.min(...deltas.map(({ delta }) => delta));
    const tied = deltas.filter(({ delta }) => delta - bestDelta <= BIRTH_MATCH_RESOLUTION_MS);
    if (tied.length === 1) add(assigned, tied[0].task.name, candidate.pid);
    else for (const { task } of tied) add(ambiguous, task.name, candidate.pid);
  }
  return { assigned, ambiguous };
}

interface UnownedTaskScan {
  /** Live group-leading children of our agy processes, by task log. */
  descendants: Map<string, number[]>;
  /** Launchd-re-parented leftovers in the session cwd, by task log. */
  orphans: Map<string, number[]>;
  /** Processes that could belong to more than one task, by task log. */
  ambiguous: Map<string, number[]>;
}

/** agy's own working directory; it spawns task commands from here. */
function agyConfigDir(brainDir?: string): string {
  return path.dirname(brainDir ?? agyBrainDir());
}

/**
 * Resolve liveness for task logs that no process holds open: agy >= 1.2.0
 * pipes task output through itself, so scans fall back to process
 * ancestry (children of the agy processes this pi spawned) and, once agy
 * is gone too, the orphan heuristic. One `ps` pass feeds both.
 *
 * `claimedPids` are processes already proven to belong to a *different* task
 * by the authoritative log-holder scan. They must be excluded here, along with
 * everything sharing their process group: stopping a task signals the whole
 * group, so letting a claimed process be re-matched to an unowned task would
 * make stopping that task kill the confirmed one.
 */
async function scanUnownedProcesses(
  sessionCwd: string | undefined,
  agyPids: number[],
  tasks: TaskBirth[],
  brainDir?: string,
  claimedPids: Iterable<number> = [],
): Promise<UnownedTaskScan> {
  if (tasks.length === 0) {
    return { descendants: new Map(), orphans: new Map(), ambiguous: new Map() };
  }
  const rows = parseAgyProcessRows(await execText("ps", ["-axo", "pid=,ppid=,pgid=,etime="]));
  const claimed = new Set(claimedPids);
  // Expand ownership to process groups: a claimed leader owns its group, and a
  // claimed member implicates its whole group.
  const claimedGroups = new Set(rows.filter((row) => claimed.has(row.pid)).map((row) => row.pgid));
  const isClaimed = (row: AgyProcessRow) => claimed.has(row.pid) || claimedGroups.has(row.pgid);
  const available = rows.filter((row) => !isClaimed(row));
  const nearTaskBirth = (startMs: number) =>
    tasks.some((task) => Math.abs(startMs - task.birthMs) <= 15_000);

  const descendantMatch = assignNearestBirth(
    selectAgyTaskDescendants(available, agyPids).filter(({ startMs }) => nearTaskBirth(startMs)),
    tasks,
  );
  const descendants = descendantMatch.assigned;
  const ambiguous = descendantMatch.ambiguous;

  const orphanCandidates = available.filter(
    (row) => row.ppid === 1 && row.pid !== process.pid && nearTaskBirth(row.startMs),
  );
  const empty = new Map<string, number[]>();
  if (!sessionCwd || orphanCandidates.length === 0) {
    return { descendants, orphans: empty, ambiguous };
  }

  const cwdOutput = await execText("lsof", [
    "-a",
    "-nP",
    "-d",
    "cwd",
    "-p",
    orphanCandidates.map(({ pid }) => pid).join(","),
    "-Fpn",
  ]);
  const processCwds = parseProcessCwds(cwdOutput);
  const acceptedCwds = await acceptedOrphanCwds(sessionCwd, brainDir);
  const inAcceptedCwd = orphanCandidates.filter(({ pid }) =>
    acceptedCwds.has(processCwds.get(pid) ?? ""),
  );
  const orphanMatch = assignNearestBirth(inAcceptedCwd, tasks);
  // Orphans are already advisory (never auto-stopped), but an unresolvable
  // orphan still must not be presented as one task's own process.
  const mergedAmbiguous = new Map(ambiguous);
  for (const [name, pids] of orphanMatch.ambiguous) {
    mergedAmbiguous.set(name, [...(mergedAmbiguous.get(name) ?? []), ...pids]);
  }
  return { descendants, orphans: orphanMatch.assigned, ambiguous: mergedAmbiguous };
}

/** Canonical working directories an orphaned task process may sit in. */
async function acceptedOrphanCwds(
  sessionCwd: string | undefined,
  brainDir?: string,
): Promise<Set<string>> {
  const dirs = [sessionCwd, agyConfigDir(brainDir)].filter(
    (dir): dir is string => dir !== undefined,
  );
  const resolved = new Set(dirs.map((dir) => path.resolve(dir)));
  for (const dir of dirs) {
    const real = await fs.realpath(dir).catch(() => undefined);
    if (real) resolved.add(real);
  }
  return resolved;
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

/** List every background task recorded for an agy conversation. */
export async function listAgyTasks(
  conversationId: string,
  options: {
    brainDir?: string;
    sessionCwd?: string;
    /** Live agy process pids (e.g. from the child-tracking registry). */
    agyPids?: number[];
  } = {},
): Promise<AgyTask[]> {
  const dir = path.join(
    options.brainDir ?? agyBrainDir(),
    conversationId,
    ".system_generated",
    "tasks",
  );
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const logs = entries.filter((name) => /^task-.+\.log$/.test(name)).sort(compareAgyTaskLogNames);
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
  const unownedTasks = metadata
    .filter(({ name }) => (holders.get(name)?.length ?? 0) === 0)
    .map(({ name, birthMs }) => ({ name, birthMs }));
  // Pids the authoritative holder scan already tied to a task must not be
  // re-matched to an unowned one by the ancestry/orphan heuristics.
  const claimedPids = new Set([...holders.values()].flat());
  const [contents, unowned] = await Promise.all([
    Promise.all(metadata.map(({ logPath }) => fs.readFile(logPath, "utf8").catch(() => ""))),
    scanUnownedProcesses(
      options.sessionCwd,
      options.agyPids ?? [],
      unownedTasks,
      options.brainDir,
      claimedPids,
    ),
  ]);

  return metadata.map(
    ({ name, logPath, stat }, index): AgyTask => ({
      id: name.replace(/\.log$/, ""),
      logPath,
      pids: [...new Set([...(holders.get(name) ?? []), ...(unowned.descendants.get(name) ?? [])])],
      ambiguous: unowned.ambiguous.get(name) ?? [],
      orphans: unowned.orphans.get(name) ?? [],
      description: describeTaskLog(contents[index]),
      bytes: stat.size,
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
    execFile(
      "ps",
      ["-o", "pgid=", "-p", String(process.pid)],
      { timeout: 5_000 },
      (error, stdout) => {
        const pgid = Number.parseInt(String(stdout).trim(), 10);
        resolve(error || !Number.isInteger(pgid) ? undefined : pgid);
      },
    );
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
