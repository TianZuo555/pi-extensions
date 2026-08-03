import { spawnSync } from "node:child_process";

function killProcessTreeSync(pid: number) {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
    } catch {
      // Process may already be gone.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Process group may already be gone.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

export interface DetachedChildTracker {
  track(pid: number): void;
  untrack(pid: number): void;
  dispose(): void;
}

export function createDetachedChildTracker(): DetachedChildTracker {
  const pids = new Set<number>();
  let disposed = false;

  const sweep = () => {
    for (const pid of pids) killProcessTreeSync(pid);
    pids.clear();
  };

  process.on("exit", sweep);

  return {
    track(pid) {
      if (!disposed && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    },
    untrack(pid) {
      pids.delete(pid);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      process.off("exit", sweep);
      sweep();
    },
  };
}
