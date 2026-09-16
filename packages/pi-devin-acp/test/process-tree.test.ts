import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { descendantRows, killDetachedDescendantGroups } from "../lib/process-tree.ts";

/** POSIX-only: process groups and `ps` do not exist on Windows. */
const posix = process.platform !== "win32";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startRoot(): { root: ChildProcess; detachedPid: Promise<number> } {
  // The root spawns a detached child (own process group via setsid) and a
  // regular in-group child, then idles — the shape of `devin acp` with a
  // background shell plus ordinary helpers.
  const script = `
const { spawn } = require("node:child_process");
const detached = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  detached: true,
  stdio: "ignore",
});
detached.unref();
const inGroup = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: "ignore",
});
console.log("READY " + detached.pid + " " + inGroup.pid);
setInterval(() => {}, 1000);
`;
  const root = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  let buffer = "";
  const detachedPid = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("root never reported readiness")), 10_000);
    root.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk;
      const match = /READY (\d+) (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    root.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`root exited before readiness: ${buffer}`));
    });
  });
  return { root, detachedPid };
}

test(
  "detached descendant groups are killed; root and in-group children survive",
  { skip: !posix },
  async () => {
    const { root, detachedPid } = startRoot();
    try {
      const detached = await detachedPid;
      assert.ok(alive(detached), "detached child is running before cleanup");

      const groups = await killDetachedDescendantGroups(root.pid!);

      assert.equal(groups.length, 1, "exactly the detached group is targeted");
      await until(() => !alive(detached), "detached child dies with its group");
      assert.ok(alive(root.pid!), "root survives its own cleanup");
    } finally {
      root.kill("SIGKILL");
    }
  },
);

test(
  "cleanup without detached descendants signals nothing and keeps the tree",
  { skip: !posix },
  async () => {
    const script = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: "ignore",
});
console.log("READY " + child.pid);
setInterval(() => {}, 1000);
`;
    const root = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const inGroup = await new Promise<number>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(
          () => reject(new Error("root never reported readiness")),
          10_000,
        );
        root.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk;
          const match = /READY (\d+)/.exec(buffer);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
      });
      const groups = await killDetachedDescendantGroups(root.pid!);
      assert.deepEqual(groups, [], "no group leaves the root's own group");
      assert.ok(alive(inGroup), "in-group child is not signalled");
      assert.ok(alive(root.pid!), "root is not signalled");
    } finally {
      root.kill("SIGKILL");
    }
  },
);

test(
  "cleanup for an unknown root pid is a no-op",
  { skip: !posix },
  async () => {
    const groups = await killDetachedDescendantGroups(999_999_999);
    assert.deepEqual(groups, []);
  },
);

test("descendantRows walks the pid chain and skips the root and cycles", () => {
  const rows = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 10, ppid: 1, pgid: 1 },
    { pid: 11, ppid: 10, pgid: 11 },
    { pid: 12, ppid: 11, pgid: 11 },
    { pid: 13, ppid: 1, pgid: 13 },
    // Cycle guard: 11 -> 10 -> 11 must not loop.
    { pid: 10, ppid: 11, pgid: 1 },
  ];
  const descendants = descendantRows(rows, 10);
  assert.deepEqual(
    descendants.map((row) => row.pid).sort((a, b) => a - b),
    [11, 12],
  );
  assert.deepEqual(descendantRows(rows, 13), []);
});
