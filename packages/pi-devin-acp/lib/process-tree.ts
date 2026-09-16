/**
 * Detached-shell cleanup for the `devin acp` child process.
 *
 * Devin detaches long-running background shells into their own process
 * groups (pgid === pid, setsid-style). Those groups survive the acp child's
 * death — they get reparented to init and keep running, while pi loses every
 * handle: it only ever knew devin's shell ids, never OS pids, and the next
 * turn bootstraps a fresh session that never reconnects to them. Killing the
 * groups while their PPID chain still links them to the dying child is the
 * last chance to avoid leaking processes on /new, /quit, and /reload.
 *
 * Safety: the acp child shares pi's process group (spawn inherits it), so a
 * group equal to the root's or the caller's own group is never signalled —
 * only groups created *by* descendants are targets.
 *
 * POSIX enumerates via `ps`; Windows has no process groups or `ps`, so it
 * falls back to a best-effort `taskkill /T` tree kill (detached processes
 * may still escape there).
 */

import { spawn } from "node:child_process";

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
}

const POSIX = process.platform !== "win32";
/** Grace period between SIGTERM and SIGKILL for a detached group. */
const KILL_GRACE_MS = 300;

function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, pgid] = parts.map(Number);
    if (parts.every((part) => /^\d+$/.test(part)) && pid > 0) {
      rows.push({ pid, ppid, pgid });
    }
  }
  return rows;
}

function listProcesses(): Promise<PsRow[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,ppid=,pgid="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(parsePs(out));
      else reject(new Error(`ps exited with code ${code}`));
    });
  });
}

/** All rows whose pid chain leads to rootPid (root excluded). */
export function descendantRows(rows: readonly PsRow[], rootPid: number): PsRow[] {
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.ppid) ?? [];
    list.push(row.pid);
    childrenOf.set(row.ppid, list);
  }
  const out: PsRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) continue;
    for (const childPid of childrenOf.get(pid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      queue.push(childPid);
      const row = rowByPid.get(childPid);
      if (row) out.push(row);
    }
  }
  return out;
}

/** Group ids signalled (empty when the root or its groups are gone). */
function targetGroups(descendants: readonly PsRow[], rootPgid: number, ownPgid: number): number[] {
  const groups = new Set<number>();
  for (const row of descendants) {
    // Never signal the root's own group (shared with pi) or our own; both
    // would take the pi process down with the acp child.
    if (row.pgid > 0 && row.pgid !== rootPgid && row.pgid !== ownPgid) groups.add(row.pgid);
  }
  return [...groups];
}

function signalGroups(groups: readonly number[], signal: NodeJS.Signals): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Group already gone.
    }
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Windows fallback: kill the whole visible tree of rootPid, best effort. */
function taskkillTree(rootPid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

/**
 * Kill every process group a root process detached from itself (its
 * descendants' groups that are neither the root's nor the caller's).
 * Returns the signalled group ids. Best-effort: failures never throw.
 */
export async function killDetachedDescendantGroups(rootPid: number): Promise<number[]> {
  if (!POSIX) {
    await taskkillTree(rootPid);
    return [];
  }
  try {
    const rows = await listProcesses();
    const root = rows.find((row) => row.pid === rootPid);
    if (!root) return [];
    const getpgrp = (process as NodeJS.Process & { getpgrp?: () => number }).getpgrp;
    const ownPgid = typeof getpgrp === "function" ? getpgrp.call(process) : 0;
    const groups = targetGroups(descendantRows(rows, rootPid), root.pgid, ownPgid);
    if (groups.length === 0) return [];
    signalGroups(groups, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    signalGroups(
      groups.filter((pgid) => groupAlive(pgid)),
      "SIGKILL",
    );
    return groups;
  } catch {
    return [];
  }
}
