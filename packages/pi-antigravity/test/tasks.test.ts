import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agyGroupLeadingDescendants,
  agyGroupSurvivors,
  agyTaskStopPids,
  agyTurnTranscriptVerdict,
  compareAgyTaskLogNames,
  describeTaskLog,
  findAgyTask,
  listAgyTasks,
  parseAgyProcessRows,
  parseEtimeMs,
  parseLsofPids,
  parseTaskLogHolders,
  recordAgyTaskOrphans,
  selectAgyTaskDescendants,
  transcriptTailVerdict,
  type AgyTask,
} from "../lib/tasks.ts";
import {
  getAgyChildrenRegistry,
  killAllAgyTrees,
  signalVerifiedAgyOrphans,
  syncAgyProcessRows,
  verifiedAgyOrphanPids,
  verifyAgyOrphans,
} from "../lib/agy-children.ts";

// Real-process tests assert ps/pgid/ancestry semantics that do not exist on
// Windows, and their spawned children would outlive POSIX-only group kills —
// a live spawn() handle pins this test file's process forever, which is what
// hung the windows-latest CI job. Skip them there entirely.
const posix = { skip: process.platform === "win32", timeout: 20_000 };

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

test(
  "listAgyTasks reports a group-leading agy child as ambiguous, never stoppable",
  posix,
  async () => {
    // A running foreground run_command shares the exact same process shape as a
    // background task (group-leading child of the same agy, near a log birth),
    // so ancestry can never prove ownership — only a log holder may be stopped.
    const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-desc-"));
    const taskDir = path.join(brainDir, "c-desc", ".system_generated", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await fs.writeFile(path.join(taskDir, "task-1.log"), "long-running command\n");
      const [task] = await listAgyTasks("c-desc", { brainDir, agyPids: [process.pid] });
      assert.ok(task);
      assert.deepEqual(task.pids, [], "ancestry alone is not stoppable ownership");
      assert.deepEqual(task.ambiguous, [child.pid]);
      assert.deepEqual(task.orphans, []);
      assert.equal(agyTaskStopPids(task).length, 0);
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
  },
);

test("listAgyTasks leaves tasks done when no agy ancestor is supplied", posix, async () => {
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
  return {
    id,
    logPath: `/tmp/${id}.log`,
    pids,
    ambiguous: [],
    orphans: [],
    description: "cmd",
    bytes: 0,
  };
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

test("task stop sets contain only proven holders — orphans never qualify", () => {
  const task = { pids: [101, 303], orphans: [202, 101] };
  const orphanOnly = { pids: [] as number[], orphans: [202] };
  // ownPid is filtered; advisory buckets are never signalled per-task.
  assert.deepEqual(agyTaskStopPids(task, 303), [101]);
  assert.deepEqual(agyTaskStopPids(orphanOnly), []);
});

test(
  "tasks started within ps resolution are never claimed as one task's own pids",
  posix,
  async () => {
    // `ps` etime is second-resolution, so two commands launched milliseconds
    // apart cannot be resolved by start time. Guessing is dangerous: stopping a
    // task signals its whole process group, so a wrong guess kills a sibling.
    const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-tie-"));
    const taskDir = path.join(brainDir, "c-tie", ".system_generated", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    const kids = [] as Array<{ pid?: number }>;
    try {
      await fs.writeFile(path.join(taskDir, "task-1.log"), "first command\n");
      kids.push(
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await fs.writeFile(path.join(taskDir, "task-2.log"), "second command\n");
      kids.push(
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore",
        }),
      );

      const tasks = await listAgyTasks("c-tie", { brainDir, agyPids: [process.pid] });
      assert.equal(tasks.length, 2);
      // No task may own a pid it cannot be proven to own...
      for (const task of tasks) {
        assert.deepEqual(task.pids, [], `${task.id} must not claim an ambiguous pid`);
      }
      // ...and the uncertainty must still be visible rather than silently dropped.
      const flagged = tasks.filter((task) => task.ambiguous.length > 0);
      assert.ok(flagged.length > 0, "ambiguous liveness must be reported somewhere");
      assert.equal(
        agyTaskStopPids({ pids: [] }).length,
        0,
        "ambiguous pids are not part of the stop set",
      );
    } finally {
      for (const kid of kids) {
        if (kid.pid !== undefined) {
          try {
            process.kill(-kid.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      await fs.rm(brainDir, { recursive: true, force: true });
    }
  },
);

test(
  "agyGroupLeadingDescendants returns detached children without attributing them",
  posix,
  async () => {
    // The shutdown sweep needs every task-shaped child of our agy processes —
    // proof is ancestry alone, so no task-log matching applies. Non-leading
    // children (sharing agy's group) are excluded: they die with the parent.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const inGroup = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const leaders = await agyGroupLeadingDescendants([process.pid]);
      assert.ok(leaders.includes(child.pid as number), "the detached child is a group leader");
      assert.ok(
        !leaders.includes(inGroup.pid as number),
        "a same-group child is not a task candidate",
      );
    } finally {
      for (const pid of [child.pid, inGroup.pid]) {
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
      }
    }
  },
);

test("transcriptTailVerdict detects agy's finished-but-withheld answer", () => {
  const step = (index: number, type: string, status: string) =>
    JSON.stringify({ step_index: index, type, status });
  // A tool step still RUNNING is the newest entry: not parked.
  assert.deepEqual(
    transcriptTailVerdict(
      [step(0, "USER_INPUT", "DONE"), step(2, "GENERIC", "RUNNING")].join("\n"),
      2,
    ),
    { finished: false },
  );
  // The agent's DONE response postdates the active tool step: parked.
  assert.deepEqual(
    transcriptTailVerdict(
      [
        step(0, "USER_INPUT", "DONE"),
        step(2, "GENERIC", "RUNNING"),
        step(3, "PLANNER_RESPONSE", "DONE"),
      ].join("\n"),
      2,
    ),
    { finished: true },
  );
  // A DONE response that still carries tool_calls is mid-turn planning, not
  // an answer — real agy transcripts show these with content too.
  assert.deepEqual(
    transcriptTailVerdict(
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Running the tests now.",
        tool_calls: [{ name: "run_command", args: { CommandLine: "mise test" } }],
      }),
      2,
    ),
    { finished: false },
  );
  // The finishing step's content is recovered as the withheld answer.
  assert.deepEqual(
    transcriptTailVerdict(
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "All green — summary attached.",
      }),
      2,
    ),
    { finished: true, response: "All green — summary attached." },
  );
  // A finished response from a turn predating the active step is not ours.
  assert.deepEqual(transcriptTailVerdict(step(1, "PLANNER_RESPONSE", "DONE"), 3), {
    finished: false,
  });
  // A truncated final line falls back to the previous complete step.
  assert.deepEqual(
    transcriptTailVerdict(
      `${step(3, "PLANNER_RESPONSE", "DONE")}\n{"step_index":4,"type":"GENER`,
      2,
    ),
    { finished: true },
  );
  assert.equal(transcriptTailVerdict("", 2), undefined);
  assert.equal(transcriptTailVerdict("not json\n", 2), undefined);
});

test("agyTurnTranscriptVerdict reads the conversation transcript tail", async () => {
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-transcript-"));
  const logDir = path.join(brainDir, "conv-1", ".system_generated", "logs");
  await fs.mkdir(logDir, { recursive: true });
  try {
    // No transcript yet: no verdict.
    assert.equal(await agyTurnTranscriptVerdict("conv-1", [2], brainDir), undefined);
    await fs.writeFile(
      path.join(logDir, "transcript_full.jsonl"),
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE" }),
        JSON.stringify({ step_index: 2, type: "GENERIC", status: "RUNNING" }),
        JSON.stringify({
          step_index: 3,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "the answer",
        }),
      ].join("\n"),
    );
    assert.deepEqual(await agyTurnTranscriptVerdict("conv-1", [2], brainDir), {
      finished: true,
      response: "the answer",
    });
    // A step index at/after the finishing response rejects the match.
    assert.deepEqual(await agyTurnTranscriptVerdict("conv-1", [3], brainDir), {
      finished: false,
    });
    assert.equal(await agyTurnTranscriptVerdict("missing", [2], brainDir), undefined);
    assert.equal(await agyTurnTranscriptVerdict("conv-1", [], brainDir), undefined);
  } finally {
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test("agyGroupSurvivors reports groups that still hold members", posix, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    assert.deepEqual(await agyGroupSurvivors([child.pid as number]), [child.pid]);
    assert.deepEqual(await agyGroupSurvivors([]), []);
    // A dead pid has no group to report.
    assert.deepEqual(await agyGroupSurvivors([2 ** 22 + 12345]), []);
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("recorded task orphans surface as advisory only — never in a stop set", posix, async () => {
  // recordAgyTaskOrphans proves conversation-level provenance, but nothing
  // binds a recorded process to a specific task: a sibling foreground
  // `run_command` has the identical shape and may even share the command
  // line. So recorded orphans are display-only (`orphans` under a unique
  // nearest task, `ambiguous` on ties) and every stop set stays empty of
  // them. Cross-conversation isolation still applies.
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-orphan-"));
  for (const conv of ["conv-a", "conv-b"]) {
    await fs.mkdir(path.join(brainDir, conv, ".system_generated", "tasks"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(brainDir, conv, ".system_generated", "tasks", "task-1.log"),
      "leftover command\n",
    );
  }
  const first = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  const second = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    assert.ok(first.pid !== undefined && second.pid !== undefined);
    recordAgyTaskOrphans(process.pid, "conv-a");
    assert.equal(getAgyChildrenRegistry().taskOrphans.get(first.pid)?.conversationId, "conv-a");

    const [a] = await listAgyTasks("conv-a", { brainDir, agyPids: [] });
    assert.ok(a);
    // Both siblings surface — but as advisory buckets only, and the task's
    // stop set stays empty even though every pid is provably ours.
    assert.ok(
      a.orphans.includes(first.pid as number) || a.ambiguous.includes(first.pid as number),
      "a recorded orphan is still listed",
    );
    assert.ok(
      !agyTaskStopPids(a).includes(first.pid as number),
      "a recorded orphan is never per-task stoppable",
    );
    assert.ok(
      !agyTaskStopPids(a).includes(second.pid as number),
      "a sibling command can never be claimed by a task stop",
    );

    const [b] = await listAgyTasks("conv-b", { brainDir, agyPids: [] });
    assert.ok(b);
    for (const bucket of [b.pids, b.orphans, b.ambiguous]) {
      assert.ok(
        !bucket.includes(first.pid as number),
        "conv-b must not see conv-a's recorded orphan",
      );
    }
  } finally {
    getAgyChildrenRegistry().taskOrphans.delete(first.pid as number);
    getAgyChildrenRegistry().taskOrphans.delete(second.pid as number);
    for (const pid of [first.pid, second.pid]) {
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test("a dead orphan leader keeps its record while its group still lives", posix, async () => {
  // A wrapper that exited while its children still run must not lose its
  // orphan record: the group (pgid == recorded pid) is still ours — visible
  // in the listing, and reachable by whole-pi cleanup.
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-deadlead-"));
  const taskDir = path.join(brainDir, "conv-d", ".system_generated", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, "task-1.log"), "wrapped command\n");
  // Detached wrapper spawns a same-group child then exits: the leader dies,
  // the group survives.
  const spawner = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
         { stdio: "ignore" });
       process.stdout.write(String(c.pid));
       setTimeout(() => process.exit(0), 400);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const memberPid = await new Promise<number>((resolve) => {
    spawner.stdout.once("data", (c: Buffer) => resolve(Number.parseInt(c.toString(), 10)));
  });
  const leaderPid = spawner.pid;
  try {
    assert.ok(Number.isInteger(memberPid) && leaderPid !== undefined);
    // Recorded while the leader was still alive, as at teardown time.
    recordAgyTaskOrphans(process.pid, "conv-d");
    await new Promise((resolve) => spawner.once("close", resolve)); // leader exits
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [task] = await listAgyTasks("conv-d", { brainDir, agyPids: [] });
    assert.ok(task);
    assert.ok(
      task.ambiguous.includes(leaderPid as number),
      "the group stays visible, but its recorded agy parent is still alive",
    );
    assert.ok(getAgyChildrenRegistry().taskOrphans.has(leaderPid as number));
    assert.ok(
      !agyTaskStopPids(task).includes(leaderPid as number),
      "advisory only — still not per-task stoppable",
    );
  } finally {
    getAgyChildrenRegistry().taskOrphans.delete(leaderPid as number);
    if (leaderPid !== undefined) {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    }
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test("a stale orphan record is identity-checked before any signal", posix, async () => {
  // A record whose stored start time does not match the live process is a
  // reused pid — it must be pruned and must never be signalled, no matter
  // which exit path sweeps it. This is the killAllAgyTrees path.
  const target = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    assert.ok(target.pid !== undefined);
    getAgyChildrenRegistry().taskOrphans.set(target.pid, {
      conversationId: "old-conversation",
      parent: { pid: process.pid, startMs: Date.now() },
      startMs: Date.now() - 60_000, // wrong on purpose — simulates reuse
    });
    killAllAgyTrees();
    assert.ok(!getAgyChildrenRegistry().taskOrphans.has(target.pid), "the stale record is pruned");
    let alive = true;
    try {
      process.kill(target.pid, 0);
    } catch {
      alive = false;
    }
    assert.ok(alive, "a mismatched-identity record must not be signalled");
  } finally {
    getAgyChildrenRegistry().taskOrphans.delete(target.pid as number);
    if (target.pid !== undefined) {
      try {
        process.kill(-target.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("signalVerifiedAgyOrphans sweeps only verified, in-scope orphan groups", posix, async () => {
  // The unified cleanup entry point: whole-pi (no conversation filter) or
  // scoped to one conversation — but always identity-verified first.
  const inScope = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  const otherConv = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    assert.ok(inScope.pid !== undefined && otherConv.pid !== undefined);
    const registry = getAgyChildrenRegistry();
    const now = Date.now();
    registry.taskOrphans.set(inScope.pid as number, {
      conversationId: "conv-x",
      parent: { pid: process.pid, startMs: now },
      startMs: now,
    });
    registry.taskOrphans.set(otherConv.pid as number, {
      conversationId: "conv-y",
      parent: { pid: process.pid, startMs: now },
      startMs: now,
    });
    // Scoped to a different conversation: nothing is signalled.
    assert.equal(
      signalVerifiedAgyOrphans("SIGTERM", { conversationId: "conv-z", protectAttached: true }),
      0,
    );
    try {
      process.kill(inScope.pid, 0);
      process.kill(otherConv.pid, 0);
    } catch {
      assert.fail("out-of-scope records must not be signalled");
    }
    // Unscoped: every verified group is reaped regardless of conversation.
    const reaped = Promise.all([
      new Promise((resolve) => inScope.once("exit", resolve)),
      new Promise((resolve) => otherConv.once("exit", resolve)),
    ]);
    const signalled = signalVerifiedAgyOrphans("SIGKILL");
    assert.ok(signalled >= 2);
    await reaped;
  } finally {
    for (const pid of [inScope.pid, otherConv.pid]) {
      getAgyChildrenRegistry().taskOrphans.delete(pid as number);
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }
});

test("a failed scan verifies nothing but prunes nothing either", posix, async () => {
  // `verifyAgyOrphans(undefined)` is the contract every scan failure must
  // keep: ownership records survive a transient `ps` failure so the next
  // successful sweep can still find the processes they name.
  const target = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  try {
    assert.ok(target.pid !== undefined);
    recordAgyTaskOrphans(process.pid, "conv-fail");
    assert.ok(getAgyChildrenRegistry().taskOrphans.has(target.pid));
    const verified = verifyAgyOrphans(undefined);
    assert.equal(verified.size, 0, "a failed scan must not verify anything");
    assert.ok(
      getAgyChildrenRegistry().taskOrphans.has(target.pid),
      "a failed scan must not drop ownership records",
    );
    // And once a real scan succeeds again, the record verifies as before.
    const recovered = verifyAgyOrphans(syncAgyProcessRows());
    assert.ok(recovered.has(target.pid));
  } finally {
    getAgyChildrenRegistry().taskOrphans.delete(target.pid as number);
    if (target.pid !== undefined) {
      try {
        process.kill(-target.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

test("real listAgyTasks and killAllAgyTrees keep records through a failed ps", posix, async () => {
  // Failure-injection through PATH: a `ps` that exits 1 must not make the
  // async listing or the exit sweep treat "scan failed" as "all processes
  // gone" — records are retained and verify again once ps recovers.
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-psfail-"));
  const taskDir = path.join(brainDir, "conv-ps", ".system_generated", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, "task-1.log"), "fixture\n");
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fake-bin-"));
  const fakePs = path.join(fakeBin, "ps");
  await fs.writeFile(fakePs, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const target = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  const originalPath = process.env.PATH;
  try {
    assert.ok(target.pid !== undefined);
    recordAgyTaskOrphans(process.pid, "conv-ps");
    assert.ok(getAgyChildrenRegistry().taskOrphans.has(target.pid));

    process.env.PATH = fakeBin;
    try {
      // The async listing must not throw — it degrades to holder-only data —
      // and must not touch the orphan registry.
      const tasks = await listAgyTasks("conv-ps", { brainDir });
      assert.ok(tasks.length > 0);
      assert.ok(
        getAgyChildrenRegistry().taskOrphans.has(target.pid),
        "a failed listing scan must retain records",
      );
      // The exit sweep likewise: no signals, no pruning on a failed scan.
      killAllAgyTrees();
      assert.ok(
        getAgyChildrenRegistry().taskOrphans.has(target.pid),
        "a failed exit sweep must retain records",
      );
      let alive = true;
      try {
        process.kill(target.pid, 0);
      } catch {
        alive = false;
      }
      assert.ok(alive, "a failed sweep must not signal the recorded group");
    } finally {
      process.env.PATH = originalPath ?? "";
    }
    // Recovered ps: the record verifies and the sweep reaps it for real.
    assert.ok(verifiedAgyOrphanPids().includes(target.pid));
    const exited = new Promise((resolve) => target.once("exit", resolve));
    killAllAgyTrees();
    await exited;
    let alive = true;
    try {
      process.kill(target.pid, 0);
    } catch {
      alive = false;
    }
    assert.ok(!alive, "the recovered sweep reaps the verified group");
  } finally {
    process.env.PATH = originalPath ?? "";
    getAgyChildrenRegistry().taskOrphans.delete(target.pid as number);
    if (target.pid !== undefined) {
      try {
        process.kill(-target.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await fs.rm(brainDir, { recursive: true, force: true });
    await fs.rm(fakeBin, { recursive: true, force: true });
  }
});

test("a late-joining member keeps a leaderless group verifiable", posix, async () => {
  // Builds and watchers spawn children long after their leader started. A
  // member's identity is captured while the leader still verifies; after the
  // leader exits, that recorded identity — not any time window — is what
  // proves the surviving group is the recorded one. Leader spawns a
  // SIGTERM-immune same-group member after recording, reports its pid, then
  // exits on TERM.
  const readyDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-late-member-"));
  const memberReady = path.join(readyDir, "member-ready");
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       process.stdout.write("ready");
       setTimeout(() => {
         const c = spawn(process.execPath, ["-e",
           "process.on('SIGTERM', () => {}); " +
           "require('fs').writeFileSync(process.env.M_READY, ''); " +
           "setInterval(() => {}, 1000)"],
           { stdio: "ignore", env: { ...process.env, M_READY: process.env.M_READY } });
         process.stdout.write("M" + c.pid);
       }, 300);
       setInterval(() => {}, 1000);`,
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, M_READY: memberReady },
    },
  );
  const leaderPid = leader.pid;
  let memberPid: number | undefined;
  try {
    assert.ok(leaderPid !== undefined);
    await new Promise((resolve) => leader.stdout?.once("data", resolve));
    // Record the leader alone — the member does not exist yet.
    recordAgyTaskOrphans(process.pid, "conv-late");
    assert.ok(getAgyChildrenRegistry().taskOrphans.has(leaderPid));

    // The member is born after the record was written.
    memberPid = await new Promise<number>((resolve) => {
      leader.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.startsWith("M")) resolve(Number.parseInt(text.slice(1), 10));
      });
    });
    // Node's startup takes real time under CI load: wait until the member has
    // actually installed its SIGTERM handler before the TERM wave, or it dies
    // mid-exec and the group is empty when verified.
    for (let i = 0; i < 200; i++) {
      if (
        await fs.stat(memberReady).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await fs.stat(memberReady);
    // A verification while the leader is still alive refreshes the recorded
    // member identities — this is what captures the late joiner.
    assert.ok(verifiedAgyOrphanPids().includes(leaderPid));

    // TERM wave: the leader exits, the immune member survives.
    const signalled = signalVerifiedAgyOrphans("SIGTERM");
    assert.ok(signalled >= 1);
    await new Promise((resolve) => leader.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Leader gone, group alive — the recorded member identity still proves
    // it, so the escalation sweep reaches it.
    assert.ok(
      verifiedAgyOrphanPids().includes(leaderPid),
      "a recorded member keeps the leaderless group verifiable",
    );
    assert.ok(signalVerifiedAgyOrphans("SIGKILL") >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    let memberAlive = true;
    try {
      process.kill(memberPid, 0);
    } catch {
      memberAlive = false;
    }
    assert.ok(!memberAlive, "the verified sweep reaps the late member");
  } finally {
    getAgyChildrenRegistry().taskOrphans.delete(leaderPid as number);
    if (leaderPid !== undefined) {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    }
    await fs.rm(readyDir, { recursive: true, force: true });
  }
});

test("an unrecorded member cannot prove a leaderless group", posix, async () => {
  // The mirror of the refresh path: a member whose identity was never
  // captured (it spawned after the last live verification, then the leader
  // died) leaves the group unverifiable — it stays recorded but is never
  // signalled. Conservative, not a leak by accident.
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       process.stdout.write("ready");
       setTimeout(() => {
         const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
           { stdio: "ignore" });
         process.stdout.write("M" + c.pid);
       }, 300);
       setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const leaderPid = leader.pid;
  try {
    assert.ok(leaderPid !== undefined);
    await new Promise((resolve) => leader.stdout?.once("data", resolve));
    recordAgyTaskOrphans(process.pid, "conv-late-neg");
    const memberPid = await new Promise<number>((resolve) => {
      leader.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.startsWith("M")) resolve(Number.parseInt(text.slice(1), 10));
      });
    });
    // Kill the leader WITHOUT an intervening verification — the member was
    // never captured into the record.
    process.kill(leaderPid, "SIGTERM");
    await new Promise((resolve) => leader.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    let memberAlive = true;
    try {
      process.kill(memberPid, 0);
    } catch {
      memberAlive = false;
    }
    assert.ok(memberAlive, "the member survives its leader for this check");
    assert.ok(
      !verifiedAgyOrphanPids().includes(leaderPid),
      "no recorded member identity → the group is unverifiable",
    );
  } finally {
    getAgyChildrenRegistry().taskOrphans.delete(leaderPid as number);
    if (leaderPid !== undefined) {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Group already gone.
      }
    }
  }
});

test(
  "a recorded orphan already claimed by a holder task is never re-attributed",
  posix,
  async () => {
    // The holder is task-1's process (it holds the log open); the same pid is
    // also in the orphan registry. Claimed groups must be excluded before any
    // orphan matching — otherwise task-2 displays it and cleanup paths could
    // reach task-1's process.
    const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-claimed-"));
    const taskDir = path.join(brainDir, "conv-c", ".system_generated", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    const holderLog = path.join(taskDir, "task-1.log");
    await fs.writeFile(holderLog, "holder command\n");
    await fs.writeFile(path.join(taskDir, "task-2.log"), "orphan command\n");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `require('node:fs').openSync(${JSON.stringify(holderLog)}, 'a');` +
          "setInterval(() => {}, 1000)",
      ],
      { detached: true, stdio: "ignore" },
    );
    try {
      assert.ok(holder.pid !== undefined);
      await new Promise((resolve) => setTimeout(resolve, 400));
      recordAgyTaskOrphans(process.pid, "conv-c");
      const tasks = await listAgyTasks("conv-c", { brainDir, agyPids: [process.pid] });
      const first = tasks.find((task) => task.id === "task-1");
      const second = tasks.find((task) => task.id === "task-2");
      assert.ok(first && second);
      assert.ok(first.pids.includes(holder.pid), "the holder is task-1's process");
      for (const bucket of [second.pids, second.orphans, second.ambiguous]) {
        assert.ok(
          !bucket.includes(holder.pid),
          `task-2 must not reference task-1's claimed pid ${holder.pid}`,
        );
      }
    } finally {
      getAgyChildrenRegistry().taskOrphans.delete(holder.pid as number);
      if (holder.pid !== undefined) {
        try {
          process.kill(-holder.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await fs.rm(brainDir, { recursive: true, force: true });
    }
  },
);

test("a cwd+time orphan without recorded provenance is never stoppable", posix, async () => {
  // The agy config cwd is shared across conversations, so a launchd-orphaned
  // process matching cwd+time can name another session's work. Without a
  // recordAgyTaskOrphans entry it must stay out of `orphans` (and thus out of
  // every stop set) — visible at most as ambiguous.
  const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-forph-"));
  const acceptedCwd = path.dirname(brainDir);
  const taskDir = path.join(brainDir, "conv-orphan", ".system_generated", "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, "task-1.log"), "leftover command\n");
  // A real orphan: an intermediate parent spawns a detached group leader
  // inside an accepted cwd, then exits — the grandchild re-parents to
  // launchd (ppid 1), matching the post-agy-death shape exactly.
  const spawner = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
         { detached: true, stdio: "ignore", cwd: ${JSON.stringify(acceptedCwd)} });
       c.unref();
       process.stdout.write(String(c.pid));`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const orphanPid = Number.parseInt(
    (
      await new Promise<Buffer[]>((resolve) => {
        const chunks: Buffer[] = [];
        spawner.stdout.on("data", (c: Buffer) => chunks.push(c));
        spawner.once("close", () => resolve(chunks));
      })
    )
      .map((c) => c.toString())
      .join(""),
    10,
  );
  assert.ok(Number.isInteger(orphanPid), "the orphan grandchild reported its pid");
  try {
    const [task] = await listAgyTasks("conv-orphan", {
      brainDir,
      agyPids: [process.pid],
      sessionCwd: acceptedCwd,
    });
    assert.ok(task);
    assert.deepEqual(task.pids, []);
    assert.deepEqual(task.orphans, [], "heuristic orphans are never stoppable");
    assert.ok(
      task.ambiguous.includes(orphanPid),
      "the plausible orphan still surfaces as ambiguous",
    );
    assert.equal(agyTaskStopPids(task).length, 0);
  } finally {
    try {
      process.kill(-orphanPid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await fs.rm(brainDir, { recursive: true, force: true });
  }
});

test(
  "mixed holder/ancestry detection never reassigns a confirmed task's process",
  posix,
  async () => {
    // task-1 is detected authoritatively (its process holds the log open); task-2
    // has no holder and falls back to ancestry. The ancestry candidate pool must
    // exclude everything already claimed, or task-2 inherits task-1's pid and
    // stopping task-2 kills task-1 (stops signal the whole process group).
    const brainDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-tasks-mixed-"));
    const taskDir = path.join(brainDir, "c-mixed", ".system_generated", "tasks");
    await fs.mkdir(taskDir, { recursive: true });
    const holderLog = path.join(taskDir, "task-1.log");
    const kids: Array<{ pid?: number }> = [];
    try {
      await fs.writeFile(holderLog, "holder command\n");
      // Group-leading child of this process that also holds task-1.log open.
      const holder = spawn(
        process.execPath,
        [
          "-e",
          `require('node:fs').openSync(${JSON.stringify(holderLog)}, 'a');` +
            "setInterval(() => {}, 1000)",
        ],
        { detached: true, stdio: "ignore" },
      );
      kids.push(holder);
      await new Promise((resolve) => setTimeout(resolve, 400));

      await fs.writeFile(path.join(taskDir, "task-2.log"), "ancestry command\n");
      const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      kids.push(other);
      await new Promise((resolve) => setTimeout(resolve, 400));

      const tasks = await listAgyTasks("c-mixed", { brainDir, agyPids: [process.pid] });
      const first = tasks.find((task) => task.id === "task-1");
      const second = tasks.find((task) => task.id === "task-2");
      assert.ok(first && second);

      // The authoritative match stands and stays stoppable.
      assert.deepEqual(first?.pids, [holder.pid]);
      // The ancestry candidate is visible but advisory — never stoppable, and
      // never attributed to the confirmed task's process.
      assert.deepEqual(second?.pids, []);
      assert.deepEqual(second?.ambiguous, [other.pid]);
      for (const bucket of [second?.pids, second?.ambiguous, second?.orphans]) {
        assert.ok(
          !(bucket ?? []).includes(holder.pid as number),
          `task-2 must not reference task-1's pid ${holder.pid}`,
        );
      }
      assert.ok(
        !agyTaskStopPids(second as AgyTask).includes(other.pid as number),
        "stopping task-2 must not signal its ambiguous match",
      );
    } finally {
      for (const kid of kids) {
        if (kid.pid !== undefined) {
          try {
            process.kill(-kid.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      await fs.rm(brainDir, { recursive: true, force: true });
    }
  },
);
