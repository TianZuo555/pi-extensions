/**
 * Tracking and process-group cleanup for agy subprocesses.
 *
 * agy runs as a process tree; signaling only the direct child (node's
 * default timeout/kill behavior) leaves grandchildren running. Worse, when
 * pi itself dies first — closing a terminal pane delivers SIGHUP and node's
 * default is instant death — every pending timeout timer dies with it and
 * nothing kills the child: a wedged `agy mcp remove` from shutdown then
 * lingers forever, reparented to init.
 *
 * Children are therefore spawned detached (own process group), so one
 * negative-pid SIGKILL reaps the whole tree, and exit/SIGHUP hooks sweep
 * every tracked group synchronously before the process goes away.
 */

const live = new Set<number>();

export interface TrackableChild {
  pid?: number;
}

export function trackAgyChild(child: TrackableChild): void {
  if (child.pid === undefined) return;
  live.add(child.pid);
}

export function untrackAgyChild(child: TrackableChild): void {
  if (child.pid === undefined) return;
  live.delete(child.pid);
}

/** SIGKILL a child's whole process group (direct child as fallback). */
export function killAgyTree(child: TrackableChild): void {
  if (child.pid === undefined) return;
  untrackAgyChild(child);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** SIGKILL every tracked process group. Synchronous — signal-handler safe. */
export function killAllAgyTrees(): void {
  for (const pgid of [...live]) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  live.clear();
}

let hooksInstalled = false;

/**
 * Reap agy trees when this pi process dies. `exit` covers graceful
 * shutdown; SIGHUP (terminal/pane close) has no default exit handlers in
 * node, so the handler sweeps and exits with HUP's conventional status.
 */
export function installAgyDeathHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", killAllAgyTrees);
  process.on("SIGHUP", () => {
    killAllAgyTrees();
    process.exit(129);
  });
}
