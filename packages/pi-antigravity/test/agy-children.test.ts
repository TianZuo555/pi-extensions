import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  installAgyDeathHooks,
  killAllAgyTrees,
  killAgyTree,
  trackAgyChild,
  untrackAgyChild,
} from "../lib/agy-children.ts";

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function cleanPid(pid: number | undefined) {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

async function pollUntil(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("tracking tolerates children without a pid", () => {
  trackAgyChild({});
  killAgyTree({});
  untrackAgyChild({});
  killAllAgyTrees(); // must not throw
});

test("killAgyTree and killAllAgyTrees never throw for unknown pids", () => {
  const ghost = { pid: 999_999_999 };
  trackAgyChild(ghost);
  killAllAgyTrees(); // reaps (or ignores ESRCH) and clears the registry
  killAgyTree(ghost); // second sweep after clear is also a no-op
  assert.ok(true);
});

test("untrackAgyChild removes a tracked pid", () => {
  const child = { pid: 42 };
  trackAgyChild(child);
  untrackAgyChild(child);
  killAllAgyTrees();
  assert.ok(true);
});

test("reaps real child and descendant processes with killAgyTree", async () => {
  // Spawn a detached parent process that spawns a grandchild and prints both PIDs.
  const script = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    console.log("grandchild:" + grandchild.pid);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  const parentPid = child.pid!;
  let grandchildPid: number | undefined;

  try {
    trackAgyChild(child);
    assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0);

    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });

    assert.ok(await pollUntil(() => output.includes("grandchild:")), "grandchild pid was printed");
    const match = /grandchild:(\d+)/.exec(output);
    assert.ok(match, "parsed grandchild PID");
    grandchildPid = Number(match[1]);

    assert.equal(processGone(parentPid), false, "parent is running");
    assert.equal(processGone(grandchildPid), false, "grandchild is running");

    killAgyTree(child);

    assert.ok(await pollUntil(() => processGone(parentPid)), "parent process was killed");
    assert.ok(
      await pollUntil(() => processGone(grandchildPid!)),
      "grandchild process was killed as part of the tree",
    );
  } finally {
    cleanPid(parentPid);
    cleanPid(grandchildPid);
  }
});

test("killAllAgyTrees terminates all tracked process trees", async () => {
  const child1 = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  const child2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  const pid1 = child1.pid!;
  const pid2 = child2.pid!;

  try {
    trackAgyChild(child1);
    trackAgyChild(child2);

    assert.equal(processGone(pid1), false);
    assert.equal(processGone(pid2), false);

    killAllAgyTrees();

    assert.ok(await pollUntil(() => processGone(pid1)), "child1 was killed");
    assert.ok(await pollUntil(() => processGone(pid2)), "child2 was killed");
  } finally {
    cleanPid(pid1);
    cleanPid(pid2);
  }
});

test("installAgyDeathHooks is reload-safe and does not duplicate process listeners", async () => {
  const exitListenersBefore = process.listenerCount("exit");
  const sighupListenersBefore = process.listenerCount("SIGHUP");

  installAgyDeathHooks();
  const exitListenersAfterFirst = process.listenerCount("exit");
  const sighupListenersAfterFirst = process.listenerCount("SIGHUP");
  assert.equal(exitListenersAfterFirst, exitListenersBefore + 1);
  assert.equal(sighupListenersAfterFirst, sighupListenersBefore + 1);

  // Simulating reload: calling installAgyDeathHooks again or importing reloaded module
  installAgyDeathHooks();
  const exitListenersAfterSecond = process.listenerCount("exit");
  const sighupListenersAfterSecond = process.listenerCount("SIGHUP");

  assert.equal(
    exitListenersAfterSecond,
    exitListenersAfterFirst,
    "exit listeners count must not grow on reload",
  );
  assert.equal(
    sighupListenersAfterSecond,
    sighupListenersAfterFirst,
    "SIGHUP listeners count must not grow on reload",
  );

  // Dynamic import with cache-busting query to simulate Jiti module reload
  const reloadedUrl = new URL(`../lib/agy-children.ts?reload=${Date.now()}`, import.meta.url);
  const reloaded = await import(reloadedUrl.href);
  reloaded.installAgyDeathHooks();

  assert.equal(
    process.listenerCount("exit"),
    exitListenersAfterFirst,
    "exit listeners must not leak across module reloads",
  );
  assert.equal(
    process.listenerCount("SIGHUP"),
    sighupListenersAfterFirst,
    "SIGHUP listeners must not leak across module reloads",
  );

  // Track in reloaded module and sweep in original module
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  const childPid = child.pid!;
  try {
    reloaded.trackAgyChild(child);
    assert.equal(processGone(childPid), false);

    killAllAgyTrees();
    assert.ok(await pollUntil(() => processGone(childPid)), "reaped across reloaded module");
  } finally {
    cleanPid(childPid);
  }
});

test("SIGHUP signal handler reaps tracked children without terminating host process", async () => {
  if (process.platform === "win32") {
    // SIGHUP is not supported on Windows
    return;
  }
  installAgyDeathHooks();

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid!;
  try {
    trackAgyChild(child);
    assert.equal(processGone(pid), false);

    // Emitting SIGHUP directly on process
    process.emit("SIGHUP");

    // Child must be reaped, and our test process is still running (did not call process.exit(129))
    assert.ok(await pollUntil(() => processGone(pid)), "child was reaped on SIGHUP");
  } finally {
    cleanPid(pid);
  }
});
