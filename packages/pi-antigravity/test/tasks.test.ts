import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeTaskLog,
  findAgyTask,
  parseEtimeMs,
  parseLsofPids,
  type AgyTask,
} from "../lib/tasks.ts";

test("parseLsofPids extracts unique positive pids", () => {
  assert.deepEqual(parseLsofPids("37101\n37101\n402\n"), [37101, 402]);
  assert.deepEqual(parseLsofPids(""), []);
  assert.deepEqual(parseLsofPids("not-a-pid\n-5\n0\n"), []);
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
