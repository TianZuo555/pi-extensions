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
 *      task's output straight into the file (older agy versions). The only
 *      proven ownership — these pids are stoppable.
 *   2. A process-group-leading child of a live agy process we spawned
 *      (agy >= 1.2.0 pipes task output through itself, so nothing holds
 *      the log open; tasks run as agy's children in their own group).
 *      Advisory only: a still-running foreground `run_command` shares the
 *      exact same shape, so an ancestry+birth match cannot prove which —
 *      these pids surface as `ambiguous` and are never signalled.
 *   3. Proven orphans: group-leading children recorded against this
 *      conversation while their agy parent was still alive to link them
 *      (recordAgyTaskOrphans), re-verified by identity on every scan so a
 *      stale record can never name a reused pid. Advisory only — nothing
 *      can bind a recorded process to THIS task (a sibling foreground
 *      `run_command` shares the shape and even the command line), so they
 *      are shown as `orphans` but never signalled. Whole-pi orphan cleanup
 *      lives in `signalVerifiedAgyOrphans`/`killAllAgyTrees`.
 *   4. Orphan heuristic for tasks that outlived their agy parent without
 *      being recorded: re-parented to launchd, sitting in the session cwd
 *      or agy's own config directory, started when the log was created.
 *      Advisory only — that directory is shared by every conversation, so
 *      these can name another session's work. `ambiguous`, never signalled.
 * - Stopping: SIGTERM the process, preferring the whole process group so
 *   wrappers like `npm start` take their children down too. Only `pids`
 *   (proven log holders) may be signalled per-task; every other bucket is
 *   advisory, because stop signals address whole process groups.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  agyTaskParentIsAlive,
  getAgyChildrenRegistry,
  parseAgyProcessRows,
  syncAgyProcessRows,
  verifyAgyOrphans,
  type AgyProcessRow,
} from "./agy-children.ts";

export { parseAgyProcessRows, parseEtimeMs, type AgyProcessRow } from "./agy-children.ts";

export interface AgyTask {
  /** e.g. "task-3". */
  id: string;
  logPath: string;
  /**
   * Live task processes with proven ownership (a process holding the log
   * open). The only bucket a stop may signal.
   */
  pids: number[];
  /**
   * Live processes plausibly tied to this task but never provably owned:
   * ancestry+birth matches against our agy children (indistinguishable from
   * a foreground `run_command` still running under the same agy), or orphans
   * tied to a sibling within the `ps` resolution window. Shown as uncertain,
   * never signalled: stopping a task kills its process group, so acting on a
   * guess could kill a different task's work — or the user's active command.
   */
  ambiguous: number[];
  /**
   * Orphaned process groups that are provably this conversation's work:
   * recorded as group-leading children of its agy while it was still alive
   * (`recordAgyTaskOrphans`) and re-verified against the live process table
   * on every scan, so a stale record can never name a reused pid. Advisory
   * only — conversation-level provenance cannot distinguish a background
   * task from a sibling foreground command, so these are never signalled.
   * Whole-pi cleanup of recorded orphans goes through
   * `signalVerifiedAgyOrphans`, which re-verifies identity before signalling.
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

function execTextOrFail(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (error, stdout) => {
      if (error || typeof stdout !== "string") {
        resolve(undefined);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Fresh process-table snapshot, async. `undefined` means the scan itself
 * failed — callers must not treat that as "no matching processes": an empty
 * table would look like every recorded process exited, and acting on it
 * would destroy ownership records (or signal nothing) while real work is
 * still running.
 */
async function agyProcessRows(): Promise<AgyProcessRow[] | undefined> {
  if (process.platform === "win32") return undefined;
  const output = await execTextOrFail("ps", ["-axo", "pid=,ppid=,pgid=,etime="]);
  if (output === undefined) return undefined;
  const rows = parseAgyProcessRows(output);
  // A successful ps always lists at least itself; zero rows means unusable
  // output — also a failed scan.
  return rows.length > 0 ? rows : undefined;
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
  const rows = await agyProcessRows();
  if (rows === undefined) return false;
  return selectAgyTaskDescendants(rows, agyPids).length > 0;
}

/**
 * Every process-group-leading child of the given agy processes. Unlike the
 * per-task listing above, no ownership guess is needed: these are direct
 * children of processes this pi spawned, so signalling their groups at
 * shutdown can never hit a stranger's work. This is how detached background
 * tasks (each in its own group, invisible to `killAllAgyTrees`) get reaped.
 */
export async function agyGroupLeadingDescendants(agyPids: number[]): Promise<number[]> {
  if (agyPids.length === 0) return [];
  const rows = await agyProcessRows();
  if (rows === undefined) return [];
  return selectAgyTaskDescendants(rows, agyPids).map(({ pid }) => pid);
}

/**
 * Group ids among `pids` that still hold live members — the SIGKILL targets
 * after a SIGTERM grace. Matching by pgid (never by the bare pid) means a
 * group leader that already exited can be escalated without risking a reused
 * pid: a group outlives its leader until its last member dies.
 */
export async function agyGroupSurvivors(pids: Iterable<number>): Promise<number[]> {
  const wanted = new Set(pids);
  if (wanted.size === 0) return [];
  const rows = await agyProcessRows();
  if (rows === undefined) return [];
  return [...new Set(rows.filter((row) => wanted.has(row.pgid)).map((row) => row.pgid))];
}

/**
 * Record an agy process's live task-shaped children as orphans of
 * `conversationId` — the only orphan attribution that survives reparenting.
 * Called just before the driver detaches an agy child for teardown (kill,
 * recycle, close): afterwards the children re-parent to launchd and nothing
 * can prove which conversation spawned them. Each record carries the
 * group's member identities too, so a surviving group can still prove it is
 * the recorded one after its leader exits. A failed scan records nothing —
 * writing an unverifiable record would be worse than writing none.
 * Best effort — orphan bookkeeping must never delay a teardown.
 */
export function recordAgyTaskOrphans(
  agyPid: number | undefined,
  conversationId: string | undefined,
): void {
  if (agyPid === undefined || !conversationId) return;
  try {
    const rows = syncAgyProcessRows();
    const parent = rows?.find((row) => row.pid === agyPid);
    if (rows === undefined || parent === undefined) return;
    const { taskOrphans } = getAgyChildrenRegistry();
    for (const { pid, startMs } of selectAgyTaskDescendants(rows, [agyPid])) {
      const members = new Map<number, number>();
      for (const row of rows) {
        if (row.pgid === pid) members.set(row.pid, row.startMs);
      }
      taskOrphans.set(pid, {
        conversationId,
        parent: { pid: parent.pid, startMs: parent.startMs },
        startMs,
        members,
      });
    }
    // Entries prune lazily during task scans once their process disappears;
    // the cap only guards processes that outlive every scan.
    while (taskOrphans.size > 256) {
      const oldest = taskOrphans.keys().next().value;
      if (oldest === undefined) break;
      taskOrphans.delete(oldest);
    }
  } catch {
    // Orphan bookkeeping is advisory; never let it break a kill path.
  }
}

/** Start small, but allow a complete JSONL response as large as a stream line. */
const TRANSCRIPT_TAIL_BYTES = 65_536;
const TRANSCRIPT_TAIL_MAX_BYTES = 8 * 1024 * 1024;

async function readTranscriptVerdict(
  filePath: string,
  minStepIndex: number,
): Promise<AgyTranscriptVerdict | undefined> {
  const handle = await fs.open(filePath, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    let bytes = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    for (;;) {
      const start = size - bytes;
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, start);
      // The file was truncated/replaced during the read; decline this scan.
      if (bytesRead !== bytes) return undefined;
      const text = buffer.toString("utf8");
      // A window may begin halfway through JSON or a UTF-8 character. Only
      // parse records whose beginning is known, never the leading fragment.
      const boundary = start === 0 ? 0 : text.indexOf("\n") + 1;
      const verdict =
        start === 0 || boundary > 0
          ? transcriptTailVerdict(text.slice(boundary), minStepIndex)
          : undefined;
      if (verdict !== undefined) return verdict;
      if (start === 0 || bytes >= TRANSCRIPT_TAIL_MAX_BYTES) return undefined;
      bytes = Math.min(size, bytes * 2, TRANSCRIPT_TAIL_MAX_BYTES);
    }
  } finally {
    await handle.close();
  }
}

/**
 * What the newest complete transcript step says about the turn: `finished`
 * means the agent's answer is final (a DONE `*_RESPONSE` step carrying no
 * `tool_calls` — a DONE response that still requests tool calls is mid-turn
 * planning, not an answer). `response` recovers the answer text agy withheld
 * from the result event.
 */
export interface AgyTranscriptVerdict {
  finished: boolean;
  /** Final answer text recorded on the finishing step, when present. */
  response?: string;
}

/**
 * Verdict from the newest complete transcript step after `minStepIndex`. The
 * final line may be truncated mid-write, so unparseable and non-step lines
 * are skipped. Returns undefined when the tail holds no well-formed step.
 */
export function transcriptTailVerdict(
  tail: string,
  minStepIndex: number,
): AgyTranscriptVerdict | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    let step: {
      type?: unknown;
      status?: unknown;
      step_index?: unknown;
      tool_calls?: unknown;
      content?: unknown;
    };
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof step.type !== "string" || typeof step.status !== "string") continue;
    if (typeof step.step_index === "number" && step.step_index <= minStepIndex) {
      return { finished: false };
    }
    const hasToolCalls =
      step.tool_calls !== undefined &&
      step.tool_calls !== null &&
      !(Array.isArray(step.tool_calls) && step.tool_calls.length === 0);
    const finished = step.status === "DONE" && /RESPONSE$/.test(step.type) && !hasToolCalls;
    return finished && typeof step.content === "string"
      ? { finished, response: step.content }
      : { finished };
  }
  return undefined;
}

/**
 * agy holds a turn's `result` event — and everything the agent produced —
 * while background work is still running (bounded by `--print-timeout`, which
 * the driver sets to ~25 days). Nothing reaches stdout during that wait, but
 * agy still appends every step to `<brain>/<conversation>/.system_generated/
 * logs/transcript*.jsonl` in real time — including the answer text itself.
 * When the transcript's newest step is a finished agent response, the turn's
 * remaining silence is bookkeeping: the caller should end the turn
 * gracefully (recovering `verdict.response`) instead of waiting on the task.
 *
 * `activeStepIndexes` are the step_index values of the stream's still-ACTIVE
 * tool steps; the transcript's finishing response must postdate all of them,
 * which also rejects tails belonging to an earlier turn. Callers pass [] when
 * the active steps carry no ids — the check then declines (cannot prove the
 * finished response is ours) and the normal stall path applies. Returns
 * undefined when no transcript gives a verdict.
 */
export async function agyTurnTranscriptVerdict(
  conversationId: string | undefined,
  activeStepIndexes: number[],
  brainDir?: string,
): Promise<AgyTranscriptVerdict | undefined> {
  if (!conversationId || activeStepIndexes.length === 0) return undefined;
  const dir = path.join(brainDir ?? agyBrainDir(), conversationId, ".system_generated", "logs");
  const minStepIndex = Math.max(...activeStepIndexes);
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const verdict = await readTranscriptVerdict(path.join(dir, name), minStepIndex);
    if (verdict !== undefined) return verdict;
  }
  return undefined;
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
  /**
   * Orphans proven to descend from this conversation's agy (recorded at
   * detach time while ancestry was still inspectable), by task log.
   */
  orphans: Map<string, number[]>;
  /** Processes plausibly — but not provably — tied to a task, by task log. */
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
  brainDir: string | undefined,
  claimedPids: Iterable<number> = [],
  conversationId?: string,
): Promise<UnownedTaskScan> {
  if (tasks.length === 0) {
    return { orphans: new Map(), ambiguous: new Map() };
  }
  // A failed process scan is not an empty table: attribute nothing and leave
  // the orphan registry untouched, so the next successful scan can still
  // verify the records against live processes.
  const rows = await agyProcessRows();
  if (rows === undefined) {
    return { orphans: new Map(), ambiguous: new Map() };
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const claimed = new Set(claimedPids);
  // Expand ownership to process groups: a claimed leader owns its group, and a
  // claimed member implicates its whole group.
  const claimedGroups = new Set(rows.filter((row) => claimed.has(row.pid)).map((row) => row.pgid));
  const isClaimed = (row: AgyProcessRow) => claimed.has(row.pid) || claimedGroups.has(row.pgid);
  const nearTaskBirth = (startMs: number) =>
    tasks.some((task) => Math.abs(startMs - task.birthMs) <= 15_000);

  const orphans = new Map<string, number[]>();
  const ambiguous = new Map<string, number[]>();
  const addTo = (map: Map<string, number[]>, name: string, pids: number[]) =>
    map.set(name, [...(map.get(name) ?? []), ...pids]);

  // Proven orphans: pids recorded while this conversation's agy still owned
  // them (recordAgyTaskOrphans), re-verified against the live process table
  // so a stale record can never name a reused pid or a foreign group. Even a
  // verified record only proves conversation-level ownership, though — a
  // foreground `run_command` sibling has the identical shape — so these are
  // advisory too: `orphans` when a unique nearest task exists, `ambiguous`
  // otherwise, and never part of any stop set.
  const { taskOrphans } = getAgyChildrenRegistry();
  const verifiedOrphans = verifyAgyOrphans(rows);
  // Verified orphans are excluded from every later pool — including records
  // owned by a different conversation, which must never surface here at all.
  const provenPgids = new Set<number>(verifiedOrphans);
  for (const pid of verifiedOrphans) {
    const record = taskOrphans.get(pid);
    if (record === undefined || record.conversationId !== conversationId) continue;
    const members = rows.filter((row) => row.pgid === pid);
    // An already-claimed group can never be re-attributed to another task.
    if (members.some((member) => isClaimed(member))) continue;
    const row = byPid.get(pid);
    const startMs = row?.startMs ?? Math.min(...members.map((member) => member.startMs));
    if (!nearTaskBirth(startMs)) continue;
    const nearest = assignNearestBirth([{ pid, startMs }], tasks);
    const bucket = agyTaskParentIsAlive(record, rows) ? ambiguous : orphans;
    for (const [name, pids] of nearest.assigned) addTo(bucket, name, pids);
    for (const [name, pids] of nearest.ambiguous) addTo(ambiguous, name, pids);
  }

  const available = rows.filter((row) => !isClaimed(row) && !provenPgids.has(row.pgid));
  // Ancestry + birth proximity can never prove a pid belongs to THIS task —
  // a foreground `run_command` still executing under the same agy has the
  // exact same shape (group-leading child, often near a task log's birth).
  // Since stopping a task signals the whole process group, a guess could
  // kill the user's active command: every ancestry match is advisory only.
  const descendantMatch = assignNearestBirth(
    selectAgyTaskDescendants(available, agyPids).filter(({ startMs }) => nearTaskBirth(startMs)),
    tasks,
  );
  for (const [name, pids] of descendantMatch.assigned) addTo(ambiguous, name, pids);
  for (const [name, pids] of descendantMatch.ambiguous) addTo(ambiguous, name, pids);

  const orphanCandidates = available.filter(
    (row) => row.ppid === 1 && row.pid !== process.pid && nearTaskBirth(row.startMs),
  );
  if (!sessionCwd || orphanCandidates.length === 0) {
    return { orphans, ambiguous };
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
  // Heuristic orphans are never stoppable: the agy config cwd is shared by
  // every conversation, so a match can name another session's process. They
  // stay visible under the nearest task (or all tied ones) as `ambiguous`.
  for (const [name, pids] of orphanMatch.assigned) addTo(ambiguous, name, pids);
  for (const [name, pids] of orphanMatch.ambiguous) addTo(ambiguous, name, pids);
  return { orphans, ambiguous };
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
      conversationId,
    ),
  ]);

  return metadata.map(
    ({ name, logPath, stat }, index): AgyTask => ({
      id: name.replace(/\.log$/, ""),
      logPath,
      pids: holders.get(name) ?? [],
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
 * The only pids a task stop may signal: proven log holders. `orphans` and
 * `ambiguous` are display-only — conversation-level provenance cannot bind a
 * process instance to one task, so they are never part of a stop set.
 */
export function agyTaskStopPids(task: Pick<AgyTask, "pids">, ownPid = process.pid): number[] {
  return [...new Set(task.pids)].filter((pid) => pid !== ownPid);
}

export interface AgyTaskStopResult {
  signaled: number;
  /** Actual groups signalled, not holder pids; used for shutdown escalation. */
  pgids: number[];
}

/** Stop proven holders, avoiding Pi's own group, and report the groups reached. */
export async function stopAgyTask(task: AgyTask): Promise<AgyTaskStopResult> {
  const mine = await ownPgid();
  const pgids = new Set<number>();
  let signaled = 0;
  for (const pid of agyTaskStopPids(task)) {
    const pgid = await pgidOf(pid);
    if (mine !== undefined && pgid !== undefined && pgid !== mine && pgid !== process.pid) {
      try {
        process.kill(-pgid, "SIGTERM");
        pgids.add(pgid);
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
  return { signaled, pgids: [...pgids] };
}
