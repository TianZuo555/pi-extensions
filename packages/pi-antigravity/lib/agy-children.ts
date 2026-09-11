import { spawnSync } from "node:child_process";

/**
 * Tracking and process-group cleanup for agy subprocesses.
 *
 * agy runs as a process tree; signaling only the direct child (node's
 * default timeout/kill behavior) leaves grandchildren running. Worse, when
 * pi itself dies first — closing a terminal pane delivers SIGHUP — pending
 * timeouts die with it and nothing kills the child: a wedged `agy mcp remove`
 * from shutdown could linger forever.
 *
 * Children are spawned detached (own process group), so one negative-pid
 * SIGKILL (or taskkill /T on Windows) reaps the whole tree, and exit/SIGHUP
 * hooks sweep every tracked group synchronously before the process goes away.
 */

const AGY_CHILDREN_REGISTRY_SYMBOL = Symbol.for("pi-antigravity.agy-children");

/**
 * Identity tolerance for recorded orphans: `etime` quantization plus
 * differing scan instants give ~2s of legitimate drift on any process's
 * start time between two scans.
 */
const ORPHAN_IDENTITY_TOLERANCE_MS = 3_000;

/** One `ps` row: identity plus an approximate start time. */
export interface AgyProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  startMs: number;
}

/** `ps -o etime` → elapsed milliseconds. Handles `45`, `03:05`, `02:03:04`, `1-02:03:04`. */
export function parseEtimeMs(raw: string): number {
  const match = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$|^(\d+)$/);
  if (!match) return Number.NaN;
  if (match[5] !== undefined) return Number.parseInt(match[5], 10) * 1_000;
  const days = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const hours = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3], 10);
  const seconds = Number.parseInt(match[4], 10);
  if (!Number.isInteger(seconds) || !Number.isInteger(days)) return Number.NaN;
  return ((days * 24 + hours) * 3_600 + minutes * 60 + seconds) * 1_000;
}

/** Parse `ps -axo pid=,ppid=,pgid=,etime=` output into process rows. */
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
 * Fresh process-table snapshot — synchronous so exit/signal paths can use
 * it. `undefined` means the scan itself failed: that must never be confused
 * with an empty table, or a transient `ps` failure would look like "every
 * recorded process is gone" and destroy ownership records while real
 * processes keep running.
 */
export function syncAgyProcessRows(): AgyProcessRow[] | undefined {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,etime="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const rows = parseAgyProcessRows(result.stdout);
  // A successful ps always lists at least itself; zero parsed rows means the
  // output was unusable — treat that as a failed scan too.
  return rows.length > 0 ? rows : undefined;
}

/**
 * A process group recorded as a conversation's group-leading agy child at
 * detach time. `startMs` is the leader's start time from that same scan —
 * a record whose live pid shows a different start is a reused pid, not
 * ours. `members` holds the group's member identities (pid → startMs) and
 * is refreshed on every scan while the group still verifies: after the
 * leader exits, a live member matching a recorded identity is what proves
 * the surviving group is the recorded one rather than a reused pgid.
 */
export interface AgyTaskOrphan {
  conversationId: string;
  /** The spawning agy instance; a live parent means this may still be foreground work. */
  parent: { pid: number; startMs: number };
  startMs: number;
  /** Absent only on records written before member tracking existed. */
  members?: Map<number, number>;
}

export interface AgyChildrenRegistry {
  live: Set<number>;
  hooksInstalled: boolean;
  /**
   * Processes proven to be group-leading children of a conversation's agy at
   * the moment that agy was detached for teardown: pid → orphan record.
   * Recorded while ancestry is still inspectable — after agy exits its
   * children re-parent to launchd and no signal can prove which conversation
   * spawned them. The only orphan evidence safe enough to stop.
   */
  taskOrphans: Map<number, AgyTaskOrphan>;
}

export function getAgyChildrenRegistry(): AgyChildrenRegistry {
  const globalObj = globalThis as unknown as {
    [AGY_CHILDREN_REGISTRY_SYMBOL]?: AgyChildrenRegistry;
  };
  if (!globalObj[AGY_CHILDREN_REGISTRY_SYMBOL]) {
    globalObj[AGY_CHILDREN_REGISTRY_SYMBOL] = {
      live: new Set<number>(),
      hooksInstalled: false,
      taskOrphans: new Map<number, AgyTaskOrphan>(),
    };
  }
  const registry = globalObj[AGY_CHILDREN_REGISTRY_SYMBOL];
  // A registry created by an older copy of this module in the same process
  // lacks the orphan map — backfill it.
  registry.taskOrphans ??= new Map<number, AgyTaskOrphan>();
  return registry;
}

export interface TrackableChild {
  pid?: number;
}

export function killProcessTreeSync(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    } catch {
      // Process may already be gone or taskkill unavailable.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Process group may already be gone; try leader as fallback.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

export function trackAgyChild(child: TrackableChild): void {
  if (child.pid === undefined) return;
  getAgyChildrenRegistry().live.add(child.pid);
}

export function untrackAgyChild(child: TrackableChild): void {
  if (child.pid === undefined) return;
  getAgyChildrenRegistry().live.delete(child.pid);
}

/** Send a signal to a detached process tree without removing it from tracking. */
export function signalAgyTree(child: TrackableChild, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no process-group SIGTERM equivalent; callers escalate with taskkill.
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Process group may already be gone; try the leader.
  }
  try {
    process.kill(child.pid, signal);
  } catch {
    // Already exited.
  }
}

/**
 * Signal the process group led by `pid` — group-addressed only, no bare-pid
 * fallback. Callers reach this with a recorded group id whose leader may be
 * gone; the group is addressed by pgid either way, and a bare pid could
 * name a reused, unrelated process once the leader's slot is free.
 */
export function signalAgyDetachedGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Group already gone.
    return false;
  }
}

/** Synchronously terminate a child's whole process tree. */
export function killAgyTree(child: TrackableChild): void {
  if (child.pid === undefined) return;
  untrackAgyChild(child);
  killProcessTreeSync(child.pid);
}

/**
 * A recorded orphan verifies only when its recorded identity still holds in
 * the process table: either the recorded group leader is alive with the
 * recorded start time, or the leader is gone but its process group still
 * holds a member matching an identity recorded while the group was
 * verifiable. Anything else — a dead group, a reused pid, foreign members —
 * is unverifiable and excluded, so no signal path can ever act on a stale
 * record.
 *
 * `rows === undefined` means the scan failed: nothing verifies, and nothing
 * is pruned — a transient `ps` failure must not destroy ownership records
 * for processes that are still running. Pruning only happens on positive
 * evidence: a live pid with a different start is a reused pid, and a group
 * with no members left is simply gone.
 */
export function verifyAgyOrphans(rows: AgyProcessRow[] | undefined): Set<number> {
  const registry = getAgyChildrenRegistry();
  const verified = new Set<number>();
  if (rows === undefined || registry.taskOrphans.size === 0) return verified;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const byGroup = new Map<number, AgyProcessRow[]>();
  for (const row of rows) {
    const members = byGroup.get(row.pgid) ?? [];
    members.push(row);
    byGroup.set(row.pgid, members);
  }
  for (const [pid, raw] of registry.taskOrphans) {
    const record: AgyTaskOrphan | undefined =
      typeof raw === "object" && raw !== null ? raw : undefined;
    if (!record?.parent) {
      registry.taskOrphans.delete(pid); // Records lacking the parent identity cannot be trusted.
      continue;
    }
    const recordedMembers = record.members ?? new Map<number, number>();
    const row = byPid.get(pid);
    const members = byGroup.get(pid) ?? [];
    // A live leader with the recorded start time is the strongest proof.
    if (row && Math.abs(row.startMs - record.startMs) <= ORPHAN_IDENTITY_TOLERANCE_MS) {
      verified.add(pid);
      // While the group still verifies, refresh the recorded member
      // identities — members spawned late (builds, watcher restarts) are
      // captured here so they can keep proving the group after the leader
      // is gone.
      record.members = new Map(members.map((member) => [member.pid, member.startMs]));
      continue;
    }
    if (members.length === 0) {
      registry.taskOrphans.delete(pid); // Leader and group both gone.
      continue;
    }
    // The leader slot is dead or reused, but the group lives on: a member
    // matching an identity recorded while the group was verifiable proves
    // this is still the recorded group — including the edge where the pid
    // was reused while our members still run. A group with no such member
    // stays recorded (its process is still out there) but is never signalled.
    const linked = members.some((member) => {
      const recordedStart = recordedMembers.get(member.pid);
      return (
        recordedStart !== undefined &&
        Math.abs(member.startMs - recordedStart) <= ORPHAN_IDENTITY_TOLERANCE_MS
      );
    });
    if (linked) {
      verified.add(pid);
      record.members = new Map(members.map((member) => [member.pid, member.startMs]));
      continue;
    }
    if (row) {
      // The pid is alive but it is a different process, and no group member
      // links back — the record names a reused pid.
      registry.taskOrphans.delete(pid);
    }
  }
  return verified;
}

/** Fresh-scan convenience: recorded orphans whose identity verifies right now. */
export function verifiedAgyOrphanPids(): number[] {
  return [...verifyAgyOrphans(syncAgyProcessRows())];
}

/** Recording ancestry does not make a running foreground command an orphan. */
export function agyTaskParentIsAlive(record: AgyTaskOrphan, rows: AgyProcessRow[]): boolean {
  return rows.some(
    (row) =>
      row.pid === record.parent.pid &&
      Math.abs(row.startMs - record.parent.startMs) <= ORPHAN_IDENTITY_TOLERANCE_MS,
  );
}

/**
 * Signal every recorded orphan whose identity verifies right now — the only
 * legitimate signal path for recorded orphans.
 *
 * `opts.conversationId` scopes the sweep to one conversation (`/agy-tasks`);
 * omit it to sweep every recorded orphan this pi owns regardless of which
 * conversation it came from (whole-pi shutdown, or `/agy-tasks stop all`
 * after a `/agy reset` cleared the conversation snapshot).
 *
 * `opts.protectAttached` skips groups whose recorded agy parent still lives:
 * interactive stops must never signal work that may still be a foreground
 * command under a running driver. Shutdown passes nothing — a dying pi reaps
 * attached work too.
 */
export function signalVerifiedAgyOrphans(
  signal: NodeJS.Signals,
  opts: { conversationId?: string; protectAttached?: boolean } = {},
): number {
  const registry = getAgyChildrenRegistry();
  const rows = syncAgyProcessRows();
  if (rows === undefined) return 0;
  const verified = verifyAgyOrphans(rows);
  let signaled = 0;
  for (const pid of verified) {
    const record = registry.taskOrphans.get(pid);
    if (record === undefined) continue;
    if (opts.conversationId !== undefined && record.conversationId !== opts.conversationId)
      continue;
    if (opts.protectAttached && agyTaskParentIsAlive(record, rows)) continue;
    if (pid === process.pid) continue;
    if (signalAgyDetachedGroup(pid, signal)) signaled += 1;
  }
  return signaled;
}

/**
 * Kill the process group led by `pid`. Never falls back to the bare pid: a
 * recorded orphan's pid may have been reused by a stranger once the leader
 * is gone, and only the group is still ours.
 */
function killAgyProcessGroup(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    } catch {
      // Nothing to reap.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group already gone.
  }
}

/** Synchronously terminate every tracked process tree. Signal-handler safe. */
export function killAllAgyTrees(): void {
  const registry = getAgyChildrenRegistry();
  for (const pid of [...registry.live]) {
    killProcessTreeSync(pid);
  }
  registry.live.clear();
  // Recorded task orphans are proven ours too: they outlived their agy and
  // run in their own groups, so reap them here as well — this also covers
  // exits where the graceful session_shutdown sweep never ran. Only
  // identity-verified records are signalled, and only by group. There is no
  // blanket clear: a failed scan verifies nothing and prunes nothing, so
  // records survive a transient `ps` failure and retry on the next sweep;
  // records confirmed gone by a successful scan were pruned inside
  // verifyAgyOrphans already.
  for (const pid of verifyAgyOrphans(syncAgyProcessRows())) {
    killAgyProcessGroup(pid);
  }
}

/**
 * Reap agy trees when this pi process dies. `exit` covers graceful
 * shutdown; SIGHUP reaps our children without terminating the host process
 * so Pi's async graceful shutdown/session_shutdown is not preempted.
 */
export function installAgyDeathHooks(): void {
  const registry = getAgyChildrenRegistry();
  if (registry.hooksInstalled) return;
  registry.hooksInstalled = true;
  process.on("exit", killAllAgyTrees);
  process.on("SIGHUP", killAllAgyTrees);
}
