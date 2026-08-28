import { spawnSync } from "node:child_process";
import type { ChildJobHandle } from "./win32-job.ts";

/**
 * Synchronously kill a process tree during Node's `exit` event, where async
 * cleanup cannot run. This mirrors Pi's internal detached-child safety net,
 * which is not exported from the package root.
 */
function killProcessTreeSync(pid: number) {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    } catch {
      // Process may already be gone or taskkill may be unavailable.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // The process group may already be gone; try the leader as a fallback.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

export interface DetachedChildTracker {
  track(pid: number): void;
  untrack(pid: number): void;
  /**
   * Track a dedicated per-child Windows job object. Job close is the reliable
   * tree kill (taskkill cannot reach descendants re-parented after the shell
   * exited), so the sweep closes jobs before falling back to pid sweeps.
   */
  trackJob(job: ChildJobHandle): void;
  /** Remove the process listener and synchronously kill any residual trees. */
  dispose(): void;
}

/**
 * Track process groups that must not survive a Pi crash or emergency exit.
 * Graceful session teardown remains the primary cleanup path; this process
 * listener is the last-resort path for exits that skip `session_shutdown`.
 */
export function createDetachedChildTracker(): DetachedChildTracker {
  const pids = new Set<number>();
  const jobs = new Set<ChildJobHandle>();
  let disposed = false;

  const sweep = () => {
    // Jobs first: closing one terminates the whole tree synchronously at the
    // kernel level, including PID-unreachable orphans holding stdio pipes.
    const pendingJobs = [...jobs];
    jobs.clear();
    for (const job of pendingJobs) job.close();

    const pending = [...pids];
    pids.clear();
    for (const pid of pending) killProcessTreeSync(pid);
  };

  process.on("exit", sweep);

  return {
    track(pid) {
      if (!disposed && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    },
    untrack(pid) {
      pids.delete(pid);
    },
    trackJob(job) {
      // Entries settle (closing their own job) long before a crash sweep;
      // double-close is a no-op, so settled jobs may remain in the set.
      if (!disposed) jobs.add(job);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      process.off("exit", sweep);
      // Scope teardown should already have terminated every tree. Sweep any
      // residual pid synchronously in case bounded graceful cleanup failed.
      sweep();
    },
  };
}
