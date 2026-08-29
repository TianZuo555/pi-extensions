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

export interface AgyChildrenRegistry {
  live: Set<number>;
  hooksInstalled: boolean;
}

export function getAgyChildrenRegistry(): AgyChildrenRegistry {
  const globalObj = globalThis as unknown as {
    [AGY_CHILDREN_REGISTRY_SYMBOL]?: AgyChildrenRegistry;
  };
  if (!globalObj[AGY_CHILDREN_REGISTRY_SYMBOL]) {
    globalObj[AGY_CHILDREN_REGISTRY_SYMBOL] = {
      live: new Set<number>(),
      hooksInstalled: false,
    };
  }
  return globalObj[AGY_CHILDREN_REGISTRY_SYMBOL];
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

/** Synchronously terminate a child's whole process tree. */
export function killAgyTree(child: TrackableChild): void {
  if (child.pid === undefined) return;
  untrackAgyChild(child);
  killProcessTreeSync(child.pid);
}

/** Synchronously terminate every tracked process tree. Signal-handler safe. */
export function killAllAgyTrees(): void {
  const registry = getAgyChildrenRegistry();
  for (const pid of [...registry.live]) {
    killProcessTreeSync(pid);
  }
  registry.live.clear();
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
