import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agyTaskParentIsAlive,
  getAgyChildrenRegistry,
  signalVerifiedAgyOrphans,
} from "../lib/agy-children.ts";
import {
  agyGroupSurvivors,
  listAgyTasks,
  recordAgyTaskOrphans,
  stopAgyTask,
} from "../lib/tasks.ts";

const posix = { skip: process.platform === "win32", timeout: 10_000 };

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function spawnOwner() {
  const worker = "process.send('ready'); setInterval(() => {}, 1000);";
  const owner = spawn(
    process.execPath,
    [
      "-e",
      `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
       c.once('message', () => { console.log(c.pid); c.disconnect(); c.unref(); });
       setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const [chunk] = await once(owner.stdout, "data");
  return { owner, taskPid: Number(String(chunk).trim()) };
}

test(
  "conversation stop-all protects attached foreground work but reaps actual orphans",
  posix,
  async () => {
    const live = await spawnOwner();
    const retired = await spawnOwner();
    const registry = getAgyChildrenRegistry();
    try {
      recordAgyTaskOrphans(live.owner.pid, "same-conversation");
      recordAgyTaskOrphans(retired.owner.pid, "same-conversation");
      assert.ok(registry.taskOrphans.has(live.taskPid));
      assert.ok(registry.taskOrphans.has(retired.taskPid));
      const retiredExit = once(retired.owner, "exit");
      retired.owner.kill("SIGTERM");
      await retiredExit;

      const killed = signalVerifiedAgyOrphans("SIGTERM", {
        conversationId: "same-conversation",
        protectAttached: true,
      });
      assert.equal(killed, 1, "only the group whose agy parent exited is signalled");
      process.kill(live.taskPid, 0);
      process.kill(live.owner.pid as number, 0);

      // Whole-Pi shutdown must still reach the attached group.
      assert.ok(signalVerifiedAgyOrphans("SIGKILL") >= 1);
    } finally {
      for (const child of [live, retired]) {
        registry.taskOrphans.delete(child.taskPid);
        killGroup(child.taskPid);
        killGroup(child.owner.pid);
      }
    }
  },
);

test(
  "an unscoped interactive sweep still protects attached work across conversations",
  posix,
  async () => {
    // `/agy-tasks stop all` after /agy reset has no conversation to scope to:
    // it sweeps every recorded group this pi owns — but protectAttached must
    // still spare groups whose recorded parent is alive, whatever conv they
    // were recorded under.
    const live = await spawnOwner();
    const retired = await spawnOwner();
    const registry = getAgyChildrenRegistry();
    try {
      recordAgyTaskOrphans(live.owner.pid, "conv-a");
      recordAgyTaskOrphans(retired.owner.pid, "conv-b");
      assert.ok(registry.taskOrphans.has(live.taskPid));
      assert.ok(registry.taskOrphans.has(retired.taskPid));
      const retiredExit = once(retired.owner, "exit");
      retired.owner.kill("SIGTERM");
      await retiredExit;

      const killed = signalVerifiedAgyOrphans("SIGTERM", { protectAttached: true });
      assert.equal(killed, 1, "only the dead-parent group is signalled, cross-conversation");
      process.kill(live.taskPid, 0);
      process.kill(live.owner.pid as number, 0);
    } finally {
      for (const child of [live, retired]) {
        registry.taskOrphans.delete(child.taskPid);
        killGroup(child.taskPid);
        killGroup(child.owner.pid);
      }
    }
  },
);

test("parent identity, not a reused parent pid, determines whether work is attached", () => {
  const record = {
    conversationId: "conv",
    parent: { pid: 100, startMs: 10_000 },
    startMs: 11_000,
  };
  const parent = { pid: 100, ppid: 1, pgid: 100, startMs: 10_500 };
  assert.equal(agyTaskParentIsAlive(record, [parent]), true);
  assert.equal(agyTaskParentIsAlive(record, [{ ...parent, startMs: 60_000 }]), false);
  assert.equal(agyTaskParentIsAlive(record, []), false);
});

test(
  "stop reports the real pgid for escalation when a non-leader holds the log",
  posix,
  async () => {
    const brainDir = await mkdtemp(path.join(tmpdir(), "agy-stop-pgid-"));
    const taskDir = path.join(brainDir, "conv", ".system_generated", "tasks");
    await mkdir(taskDir, { recursive: true });
    const logPath = path.join(taskDir, "task-1.log");
    await writeFile(logPath, "worker log\n");
    const worker = `require('node:fs').openSync(${JSON.stringify(logPath)}, 'a');
    process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
       c.once('message', () => console.log(c.pid)); setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      const [chunk] = await once(leader.stdout, "data");
      const memberPid = Number(String(chunk).trim());
      const [task] = await listAgyTasks("conv", { brainDir });
      assert.ok(task);
      assert.deepEqual(task.pids, [memberPid]);
      const leaderExit = once(leader, "exit");
      const result = await stopAgyTask(task);
      await leaderExit;
      assert.ok(result.signaled > 0);
      assert.deepEqual(result.pgids, [leader.pid]);
      assert.deepEqual(await agyGroupSurvivors(result.pgids), [leader.pid]);
      assert.deepEqual(await agyGroupSurvivors(task.pids), [], "holder pid is not the pgid");
      for (const pgid of result.pgids) killGroup(pgid);
    } finally {
      killGroup(leader.pid);
      await rm(brainDir, { recursive: true, force: true });
    }
  },
);
