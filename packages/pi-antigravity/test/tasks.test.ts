import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agyTaskStopPids,
  compareAgyTaskLogNames,
  describeTaskLog,
  findAgyTask,
  listAgyTasks,
  parseAgyProcessRows,
  parseEtimeMs,
  parseLsofPids,
  parseTaskLogHolders,
  selectAgyTaskDescendants,
  type AgyTask,
} from "../lib/tasks.ts";

test("parseLsofPids extracts unique positive pids", () => {
  assert.deepEqual(parseLsofPids("37101\n37101\n402\n"), [37101, 402]);
  assert.deepEqual(parseLsofPids(""), []);
  assert.deepEqual(parseLsofPids("not-a-pid\n-5\n0\n"), []);
});

test("parseTaskLogHolders maps a batched lsof result and excludes this process", () => {
  const output = [
    "p101",
    "f4",
    "n/private/tmp/tasks/task-12.log",
    "p202",
    "f5",
    "n/private/tmp/tasks/task-9.log",
    "f6",
    "n/private/tmp/tasks/task-12.log",
  ].join("\n");
  assert.deepEqual(parseTaskLogHolders(output, 202), new Map([["task-12.log", [101]]]));
});

test("listAgyTasks never reports its own reader as a live task", async () => {
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-test-"));
  const taskDir = path.join(brainDir, "c-test", ".system_generated", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  const logPath = path.join(taskDir, "task-1.log");
  await fs.writeFile(logPath, "echo hi\n");
  const ownHandle = await fs.open(logPath, "r");
  try {
    const [task] = await listAgyTasks("c-test", { brainDir });
    assert.deepEqual(task?.pids, []);
  } finally {
    await ownHandle.close();
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test("parseAgyProcessRows parses pid/ppid/pgid/etime rows and skips junk", () => {
  const now = Date.now();
  const rows = parseAgyProcessRows(" 101  2144  101  03:05\nnot a row\n 202  1  202  45\n", now);
  assert.deepEqual(rows, [
    { pid: 101, ppid: 2144, pgid: 101, startMs: now - 185_000 },
    { pid: 202, ppid: 1, pgid: 202, startMs: now - 45_000 },
  ]);
});

test("selectAgyTaskDescendants keeps only group-leading agy children", () => {
  const now = Date.now();
  const rows = [
    { pid: 300, ppid: 2144, pgid: 300, startMs: now }, // task command
    { pid: 301, ppid: 2144, pgid: 2141, startMs: now }, // shares agy's group
    { pid: 302, ppid: 999, pgid: 302, startMs: now }, // unrelated parent
    { pid: 303, ppid: 2144, pgid: 303, startMs: now }, // this pi process
  ];
  assert.deepEqual(selectAgyTaskDescendants(rows, [2144], 303), [{ pid: 300, startMs: now }]);
});

test("listAgyTasks detects a running task as a group-leading agy child", async () => {
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-desc-"));
  const taskDir = path.join(brainDir, "c-desc", ".system_generated", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  // Stand in for the task command: a detached (own process group) child of
  // this process, which plays the role of the live agy parent.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await fs.writeFile(path.join(taskDir, "task-1.log"), "long-running command\n");
    const [task] = await listAgyTasks("c-desc", { brainDir, agyPids: [process.pid] });
    assert.ok(task);
    assert.deepEqual(task?.pids, [child.pid]);
    assert.deepEqual(task?.orphans, []);
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test("listAgyTasks leaves tasks done when no agy ancestor is supplied", async () => {
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-node-"));
  const taskDir = path.join(brainDir, "c-none", ".system_generated", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await fs.writeFile(path.join(taskDir, "task-1.log"), "long-running command\n");
    const [task] = await listAgyTasks("c-none", { brainDir, sessionCwd: os.tmpdir() });
    assert.ok(task);
    assert.deepEqual(task?.pids, []);
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test("task logs sort newest-first by numeric task id", () => {
  const names = ["task-9.log", "task-100.log", "task-12.log"];
  assert.deepEqual(names.sort(compareAgyTaskLogNames), [
    "task-100.log",
    "task-12.log",
    "task-9.log",
  ]);
});

test("describeTaskLog picks the first meaningful line, bounded", () => {
  const log = "\nnpm warn Unknown project config\n[dev] $ npm start\nvite ready\n";
  assert.equal(describeTaskLog(log), "[dev] $ npm start");

  assert.equal(describeTaskLog(""), "(no output)");
  assert.equal(describeTaskLog("\n \n"), "(no output)");

  const long = "x".repeat(100);
  assert.equal(describeTaskLog(long), `${"x".repeat(63)}…`);
});

function task(id: string, pids: number[]): AgyTask {
  return { id, logPath: `/tmp/${id}.log`, pids, orphans: [], description: "cmd", bytes: 0 };
}

test("parseEtimeMs handles all ps etime shapes", () => {
  assert.equal(parseEtimeMs("45"), 45_000);
  assert.equal(parseEtimeMs("03:05"), 185_000);
  assert.equal(parseEtimeMs("02:03:04"), 7_384_000);
  assert.equal(parseEtimeMs("1-02:03:04"), 93_784_000);
  assert.ok(Number.isNaN(parseEtimeMs("junk")));
});

test("findAgyTask resolves bare numbers and task- prefixed ids", () => {
  const tasks = [task("task-3", []), task("task-17", [42])];
  assert.equal(findAgyTask(tasks, "3")?.id, "task-3");
  assert.equal(findAgyTask(tasks, "task-17")?.id, "task-17");
  assert.equal(findAgyTask(tasks, "99"), undefined);
});

test("automatic task cleanup can exclude heuristic or self matches", () => {
  const task = { pids: [101, 303], orphans: [202, 101] };
  assert.deepEqual(agyTaskStopPids(task, false, 303), [101]);
  assert.deepEqual(agyTaskStopPids(task, true, 303), [101, 202]);
});
