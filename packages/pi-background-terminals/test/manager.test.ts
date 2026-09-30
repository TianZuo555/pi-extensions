/**
 * End-to-end tests: manager behavior through a real ManagedRuntime with real
 * child processes, exactly as the tool handlers drive it. Commands use
 * `node -e` one-liners for portability (node exists on any machine running
 * pi). Tests are event-driven (kill()/nextChange/settle hooks), not
 * timing-based.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { TerminalLogUnavailableError, type TerminalSnapshot } from "../src/domain.ts";
import { buildTerminalResultMessage } from "../src/prompt.ts";
import { MAX_RUNNING, MAX_TRACKED, SETTLED_RETAINED_PER_STREAM } from "../src/constants.ts";
import {
  TerminalManager,
  type TerminalManagerShape,
  type TerminalManagerTimings,
} from "../src/manager.ts";
import { createTerminalRuntime, runTool } from "../src/runtime.ts";

const cwd = process.cwd();
const crashExitFixture = fileURLToPath(new URL("./crash-exit.fixture.ts", import.meta.url));

/** Quote a `node -e` script for Bash. */
function nodeCmd(script: string) {
  return `node -e '${script}'`;
}

/** Tests run the same lifecycle on compressed timings — the production
 * defaults spend ~1s on settle grace and 2s on kill escalation each. The
 * invariants under test (escalation order, bounded waits) do not depend on
 * the absolute values. */
const FAST_TIMINGS: TerminalManagerTimings = {
  stopTimeoutMs: 2_000,
  forceKillAfterMs: 250,
  settleGraceMs: 150,
  spillFlushTimeoutMs: 750,
};

async function withManager(
  run: (
    manager: TerminalManagerShape,
    runtime: ReturnType<typeof createTerminalRuntime>,
  ) => Promise<void>,
  timings: Partial<TerminalManagerTimings> = FAST_TIMINGS,
) {
  const runtime = createTerminalRuntime({ timings });
  try {
    const manager = await runtime.runPromise(TerminalManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

/** Resolve when the given terminal settles (via the manager's settle hook). */
function settlement(manager: TerminalManagerShape, id: string) {
  return new Promise<{ snap: TerminalSnapshot; consumed: boolean }>((resolve) => {
    const existing = manager.view.get(id);
    if (existing && existing.status !== "running") {
      resolve({ snap: existing, consumed: false });
      return;
    }
    const unsub = manager.view.subscribeTo(id, () => {
      const snap = manager.view.get(id);
      if (snap && snap.status !== "running") {
        unsub();
        resolve({ snap, consumed: false });
      }
    });
  });
}

function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function forceKillTree(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
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

async function pollUntil(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("process exit safety net kills managed process groups", async () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", crashExitFixture], {
    cwd,
    encoding: "utf8",
    // A fresh Pi package import is materially slower on Windows hosts.
    timeout: process.platform === "win32" ? 45_000 : 15_000,
    windowsHide: true,
  });
  const pid = Number(result.stdout.trim().split(/\s+/).at(-1));

  try {
    assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
    assert.equal(result.status, 23, result.stderr);
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true, result.stdout);
    assert.equal(
      await pollUntil(() => processGone(pid)),
      true,
      `managed process ${pid} survived its parent process exit`,
    );
  } finally {
    if (Number.isSafeInteger(pid) && pid > 0 && !processGone(pid)) {
      forceKillTree(pid);
    }
  }
});

test("Windows job FFI survives Pi-style module reloads", {
  skip: process.platform !== "win32",
}, async () => {
  const firstModuleUrl = new URL(`../src/win32-job.ts?reload=${Date.now()}-first`, import.meta.url);
  const first = await import(firstModuleUrl.href);
  const firstJob = await first.createChildJob();
  assert.ok(firstJob, "first module instance created a job");
  firstJob.close();

  const secondModuleUrl = new URL(
    `../src/win32-job.ts?reload=${Date.now()}-second`,
    import.meta.url,
  );
  const second = await import(secondModuleUrl.href);
  const secondJob = await second.createChildJob();
  assert.ok(secondJob, "reloaded module instance created a job");
  secondJob.close();
});

test("happy path: stdout and stderr captured separately, settles done, hook fires once unconsumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; status: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, status: snap.status, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n");',
        ),
        title: "happy",
        cwd,
      }),
    );
    assert.equal(snap.status, "running");
    assert.ok(snap.pid);
    assert.equal(snap.command.includes("out-line"), true);

    const { snap: done } = await settlement(manager, snap.id);
    assert.equal(done.status, "done");
    assert.equal(done.exitCode, 0);
    assert.equal(done.signal, undefined);
    assert.equal(done.stdout.text, "out-line\n");
    assert.equal(done.stderr.text, "err-line\n");
    assert.ok(done.settledAt);
    assert.deepEqual(settled, [{ id: snap.id, status: "done", consumed: false }]);

    // Spill files hold the full capture.
    if (done.stdout.spillPath) {
      assert.equal(fs.readFileSync(done.stdout.spillPath, "utf8"), "out-line\n");
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(done.stdout.spillPath).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(done.stdout.spillPath)).mode & 0o777, 0o700);
      }
    }
    if (done.stderr.spillPath) {
      assert.equal(fs.readFileSync(done.stderr.spillPath, "utf8"), "err-line\n");
    }
  });
});

test("lists the newest terminals first", async () => {
  await withManager(async (manager, runtime) => {
    const started: TerminalSnapshot[] = [];
    for (const title of ["first", "second", "third"]) {
      started.push(
        await runTool(
          runtime,
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title,
            cwd,
          }),
        ),
      );
    }

    const expected = started.map((snap) => snap.id).reverse();
    assert.deepEqual(
      manager.view.list().map((snap) => snap.id),
      expected,
    );
  });
});

test("initial wait returns a quick settlement and marks its follow-up consumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

    const started = await runTool(
      runtime,
      manager.start({
        command: nodeCmd('setTimeout(() => console.log("done"), 50)'),
        title: "quick",
        cwd,
      }),
    );
    const result = await runTool(runtime, manager.waitForSettlement(started.id, 1_000));

    assert.equal(result.settled, true);
    assert.equal(result.snapshot.status, "done");
    // Settling inside the wait never makes the entry a background terminal.
    assert.notEqual(result.snapshot.yielded, true);
    assert.match(result.snapshot.stdout.text, /done/);
    assert.deepEqual(settled, [{ id: started.id, consumed: true }]);
  });
});

test("initial wait yields a live process whose later settlement is unconsumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

    const started = await runTool(
      runtime,
      manager.start({
        command: nodeCmd('setTimeout(() => console.log("later"), 500)'),
        title: "yielded",
        cwd,
      }),
    );
    const result = await runTool(runtime, manager.waitForSettlement(started.id, 250));

    assert.equal(result.settled, false);
    assert.equal(result.snapshot.status, "running");
    // Outliving the initial wait is what makes it a background terminal.
    assert.equal(result.snapshot.yielded, true);
    const { snap: done } = await settlement(manager, started.id);
    assert.equal(done.status, "done");
    assert.equal(done.yielded, true);
    assert.deepEqual(settled, [{ id: started.id, consumed: false }]);
  });
});

test("aborting the initial wait leaves the process running and its completion deliverable", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));

    const started = await runTool(
      runtime,
      manager.start({
        command: nodeCmd('setTimeout(() => console.log("after abort"), 500)'),
        title: "aborted-wait",
        cwd,
      }),
    );
    const controller = new AbortController();
    const waiting = runTool(runtime, manager.waitForSettlement(started.id, 30_000), {
      signal: controller.signal,
      interruptMessage: "wait aborted",
    });
    controller.abort();
    await assert.rejects(waiting, /wait aborted/);
    assert.equal(manager.view.get(started.id)?.status, "running");
    // Esc ends the initial wait: from here it counts as a background terminal.
    assert.equal(manager.view.get(started.id)?.yielded, true);

    const { snap: done } = await settlement(manager, started.id);
    assert.equal(done.status, "done");
    assert.deepEqual(settled, [{ id: started.id, consumed: false }]);
  });
});

test("hard runtime timeout terminates the tree and settles timed_out", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ status: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ status: snap.status, consumed }));

    const started = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "deadline",
        cwd,
        timeoutMs: 250,
      }),
    );
    const result = await runTool(runtime, manager.waitForSettlement(started.id, 3_000));

    assert.equal(result.settled, true);
    assert.equal(result.snapshot.status, "timed_out");
    assert.equal(result.snapshot.timeoutMs, 250);
    assert.match(result.snapshot.errorText ?? "", /runtime timeout/);
    assert.deepEqual(settled, [{ status: "timed_out", consumed: true }]);
  });
});

test("Windows timeout force-kills detached descendants before losing the shell root", {
  skip: process.platform !== "win32",
}, async () => {
  let parent: number | undefined;
  let descendant: number | undefined;
  try {
    await withManager(async (manager, runtime) => {
      const started = await runTool(
        runtime,
        manager.start({
          command: nodeCmd(
            'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true }); child.unref(); console.log("parent:" + process.pid + " descendant:" + child.pid); setInterval(() => {}, 1000);',
          ),
          title: "windows-detached-deadline",
          cwd,
          timeoutMs: 1_000,
        }),
      );

      assert.ok(
        await pollUntil(() =>
          (manager.view.get(started.id)?.stdout.text ?? "").includes("descendant:"),
        ),
        "detached descendant pid was printed",
      );
      const output = manager.view.get(started.id)?.stdout.text ?? "";
      const match = /parent:(\d+) descendant:(\d+)/.exec(output);
      assert.ok(match, "parsed parent and detached descendant pids");
      parent = Number(match[1]);
      descendant = Number(match[2]);
      assert.equal(processGone(parent), false);
      assert.equal(processGone(descendant), false);

      const { snap: timedOut } = await settlement(manager, started.id);
      assert.equal(timedOut.status, "timed_out");
      assert.ok(await pollUntil(() => processGone(parent!)), "command process is gone");
      assert.ok(
        await pollUntil(() => processGone(descendant!)),
        "detached descendant is gone after timeout",
      );
    });
  } finally {
    if (parent && !processGone(parent)) forceKillTree(parent);
    if (descendant && !processGone(descendant)) forceKillTree(descendant);
  }
});

test("manager invokes Bash syntax and passes the requested environment", async () => {
  await withManager(async (manager, runtime) => {
    const started = await runTool(
      runtime,
      manager.start({
        command: '[[ -n "$BASH_VERSION" ]] && printf "%s" "$PI_TEST_VALUE"',
        title: "bash env",
        cwd,
        env: { ...process.env, PI_TEST_VALUE: "bash-ok" },
      }),
    );
    const { snap: done } = await settlement(manager, started.id);
    assert.equal(done.status, "done");
    assert.equal(done.stdout.text, "bash-ok");
  });
});

test("non-zero exit settles as failed with the exit code", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("process.exit(3)"),
        title: "fails",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 3);
  });
});

test("requestKill settles a never-exiting process as killed; a repeat request is a no-op", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "immortal",
        cwd,
      }),
    );
    assert.equal(snap.status, "running");

    manager.view.requestKill(snap.id);
    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    if (process.platform === "win32") {
      // Windows TerminateProcess reports an exit code instead of a POSIX signal.
      assert.equal(after.exitCode, 1);
      assert.equal(after.signal, undefined);
    } else {
      assert.match(after.signal ?? "", /^SIG/);
    }
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);

    // A second request against a settled entry settles nothing new.
    manager.view.requestKill(snap.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled.length, 1);
    assert.equal(manager.view.get(snap.id)?.status, "killed");
  });
});

test("a SIGTERM-resistant child is escalated to SIGKILL within the teardown bound", {
  skip: process.platform === "win32",
}, async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: `exec ${nodeCmd(
          'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
        )}`,
        title: "term-resistant",
        cwd,
      }),
    );
    assert.ok(
      await pollUntil(() => (manager.view.get(snap.id)?.stdout.text ?? "").includes("ready")),
      "child installed its SIGTERM handler",
    );

    const startedAt = Date.now();
    manager.view.requestKill(snap.id);
    const { snap: after } = await settlement(manager, snap.id);
    const elapsed = Date.now() - startedAt;

    assert.equal(after.status, "killed");
    assert.equal(manager.view.get(snap.id)?.signal, "SIGKILL");
    assert.match(manager.view.get(snap.id)?.stdout.text ?? "", /term/);
    // Injected forceKillAfterMs=250: SIGTERM gets its grace window, then the
    // wedged child is escalated to SIGKILL well inside the stop bound.
    assert.ok(elapsed >= 200, `SIGKILL was not immediate (${elapsed}ms)`);
    assert.ok(elapsed < 4_000, `termination exceeded its bound (${elapsed}ms)`);
  });
});

test("overlapping requestKill calls observe each settlement exactly once", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) => settled.push({ id: snap.id, consumed }));
    const [first, second] = await runTool(
      runtime,
      Effect.forEach(
        ["first", "second"],
        (title) =>
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title,
            cwd,
          }),
        { concurrency: "unbounded" },
      ),
    );

    // Interleaved duplicate requests: the detached teardown is idempotent.
    manager.view.requestKill(first.id);
    manager.view.requestKill(second.id);
    manager.view.requestKill(first.id);
    manager.view.requestKill(second.id);
    const [firstDone, secondDone] = await Promise.all([
      settlement(manager, first.id),
      settlement(manager, second.id),
    ]);

    assert.equal(firstDone.snap.status, "killed");
    assert.equal(secondDone.snap.status, "killed");
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: first.id, consumed: false },
        { id: second.id, consumed: false },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("requestKill terminates the whole process tree (grandchildren die)", async () => {
  await withManager(async (manager, runtime) => {
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-tree-test-"));
    const sentinel = path.join(sentinelDir, "heartbeat");
    const snap = await runTool(
      runtime,
      manager.start({
        // The child prints its own native pid (Bash's $! is an MSYS pid on
        // Windows), then the shell waits forever so the tree stays alive.
        command:
          'node -e \'const fs = require("node:fs"); const file = process.env.BT_TREE_SENTINEL; let n = 0; fs.writeFileSync(file, String(n)); console.log("child:" + process.pid); setInterval(() => fs.writeFileSync(file, String(++n)), 25)\' & wait',
        title: "tree",
        cwd,
        env: { ...process.env, BT_TREE_SENTINEL: sentinel },
      }),
    );

    // Wait for the grandchild pid line.
    assert.ok(
      await pollUntil(() => (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:")),
      "grandchild pid was printed",
    );
    const text = manager.view.get(snap.id)?.stdout.text ?? "";
    const match = /child:(\d+)/.exec(text);
    assert.ok(match, "parsed grandchild pid");
    const grandchild = Number(match[1]);
    assert.equal(processGone(grandchild), false);
    assert.ok(await pollUntil(() => fs.existsSync(sentinel)), "heartbeat exists");
    const heartbeatBefore = fs.readFileSync(sentinel, "utf8");
    assert.ok(
      await pollUntil(() => fs.readFileSync(sentinel, "utf8") !== heartbeatBefore),
      "heartbeat belongs to the live grandchild",
    );

    manager.view.requestKill(snap.id);
    await settlement(manager, snap.id);
    assert.ok(
      await pollUntil(() => processGone(grandchild)),
      "grandchild process is gone after group kill",
    );
    const stoppedAt = fs.readFileSync(sentinel, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      fs.readFileSync(sentinel, "utf8"),
      stoppedAt,
      "the unique grandchild heartbeat stopped",
    );
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  });
});

test("a shell exit with inherited pipes open settles naturally and reaps descendants", async (t) => {
  await withManager(async (manager, runtime) => {
    if (process.platform === "win32" && !manager.windowsJobSupport.available) {
      t.skip(manager.windowsJobSupport.reason);
      return;
    }
    const snap = await runTool(
      runtime,
      manager.start({
        command: `node -e "console.log('child:' + process.pid); setInterval(()=>{},1e3)" & exit 0`,
        title: "exited-shell",
        cwd,
      }),
    );
    assert.ok(
      await pollUntil(() => (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:")),
      "descendant pid was printed",
    );
    const match = /child:(\d+)/.exec(manager.view.get(snap.id)?.stdout.text ?? "");
    assert.ok(match);
    const grandchild = Number(match[1]);
    assert.ok(snap.pid);
    assert.ok(await pollUntil(() => processGone(snap.pid!)), "shell exited");
    assert.equal(manager.view.get(snap.id)?.status, "running");

    assert.ok(
      await pollUntil(() => manager.view.get(snap.id)?.status !== "running", 7_000),
      "entry settled after the bounded post-exit grace",
    );
    assert.equal(manager.view.get(snap.id)?.status, "done");
    assert.equal(manager.view.get(snap.id)?.exitCode, 0);
    assert.ok(
      await pollUntil(() => processGone(grandchild)),
      "surviving process-group descendant was reaped",
    );
  });
});

test("requestKill preserves a natural exit observed before the signal point", async (t) => {
  await withManager(async (manager, runtime) => {
    if (process.platform === "win32" && !manager.windowsJobSupport.available) {
      t.skip(manager.windowsJobSupport.reason);
      return;
    }
    const snap = await runTool(
      runtime,
      manager.start({
        command: `node -e "console.log('child:' + process.pid); setInterval(()=>{},1e3)" & exit 0`,
        title: "natural-race",
        cwd,
      }),
    );
    assert.ok(
      await pollUntil(() => (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:")),
    );
    const match = /child:(\d+)/.exec(manager.view.get(snap.id)?.stdout.text ?? "");
    assert.ok(match);
    const grandchild = Number(match[1]);
    assert.ok(snap.pid);
    assert.ok(await pollUntil(() => processGone(snap.pid!)));
    assert.equal(manager.view.get(snap.id)?.status, "running");

    manager.view.requestKill(snap.id);
    const { snap: after } = await settlement(manager, snap.id);
    // The shell's own exit was already observed, so the result stays a
    // natural exit even though teardown now reaps the surviving grandchild.
    assert.equal(after.status, "done");
    assert.equal(after.exitCode, 0);
    assert.ok(await pollUntil(() => processGone(grandchild)));
  });
});

test("concurrency cap rejects an extra start; a failed spawn releases its slot", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: MAX_RUNNING }, (_, n) => n),
        (n) =>
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title: `filler-${n}`,
            cwd,
          }),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, MAX_RUNNING);
    await assert.rejects(
      runTool(runtime, manager.start({ command: "true", title: "extra", cwd })),
      new RegExp(`Max ${MAX_RUNNING} background terminals`),
    );

    // Free one slot; a bogus binary settles as failed near-instantly (the
    // 'error'/'exit' path), leaving the slot free again.
    manager.view.requestKill(spawns[0].id);
    await settlement(manager, spawns[0].id);
    const bogus = await runTool(
      runtime,
      manager.start({
        command: "definitely-not-a-real-binary-12345",
        title: "bogus",
        cwd,
      }),
    );
    const { snap: settled } = await settlement(manager, bogus.id);
    assert.equal(settled.status, "failed");
    // The settled bogus entry does not occupy a running slot.
    const again = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "refill",
        cwd,
      }),
    );
    assert.equal(again.status, "running");
  });
});

test("UI requestKill settles as killed and is NOT consumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; status: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, status: snap.status, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "ui-kill",
        cwd,
      }),
    );
    manager.view.requestKill(snap.id);
    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    assert.deepEqual(settled, [{ id: snap.id, status: "killed", consumed: false }]);
  });
});

test("runtime.dispose kills running processes; no settle hook fires after dispose", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  const settled: string[] = [];
  manager.view.setOnSettled((snap) => settled.push(snap.id));

  const snap = await runTool(
    runtime,
    manager.start({
      command: nodeCmd("setInterval(() => {}, 1000)"),
      title: "disposed",
      cwd,
    }),
  );
  const pid = snap.pid;
  assert.ok(pid);

  await runtime.dispose();
  assert.ok(await pollUntil(() => processGone(pid)), "process killed");
  // The disposed guard suppressed the hook.
  assert.deepEqual(settled, []);
  // start after dispose is rejected (by the runtime itself, or by the
  // manager's disposed guard if the effect still runs).
  await assert.rejects(
    runTool(runtime, manager.start({ command: "true", title: "late", cwd })),
    /shutting down|disposed/,
  );
});

test("pruning drops the oldest settled entries past MAX_TRACKED, never running ones", async () => {
  await withManager(async (manager, runtime) => {
    const keeper = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "keeper",
        cwd,
      }),
    );

    const settledIds: string[] = [];
    let earliestSpillPaths: string[] = [];
    let latestSpillPaths: string[] = [];
    for (let i = 0; i < MAX_TRACKED + 4; i++) {
      const snap = await runTool(
        runtime,
        manager.start({ command: "true", title: `quick-${i}`, cwd }),
      );
      settledIds.push(snap.id);
      const { snap: done } = await settlement(manager, snap.id);
      const spillPaths = [done.stdout.spillPath, done.stderr.spillPath].filter(
        (spillPath): spillPath is string => spillPath !== undefined,
      );
      if (i === 0) earliestSpillPaths = spillPaths;
      if (i === MAX_TRACKED + 3) latestSpillPaths = spillPaths;
    }

    const remaining = manager.view.list().map((snap) => snap.id);
    assert.equal(remaining.length <= MAX_TRACKED, true);
    // The running entry survived pruning.
    assert.equal(remaining.includes(keeper.id), true);
    // The earliest settled entries were pruned first.
    assert.equal(remaining.includes(settledIds[0]), false);
    // The latest settled entries survive.
    assert.equal(remaining.includes(settledIds[settledIds.length - 1]), true);
    assert.ok(earliestSpillPaths.length > 0, "earliest archive was created");
    assert.equal(
      await pollUntil(() => earliestSpillPaths.every((spillPath) => !fs.existsSync(spillPath))),
      true,
      "pruning removed the earliest terminal's spill files",
    );
    await assert.rejects(
      runTool(
        runtime,
        manager.readLog({
          id: settledIds[0],
          stream: "stdout",
          offset: 0,
          limit: 1,
        }),
      ),
      (error: unknown) => {
        assert.equal(error instanceof TerminalLogUnavailableError, true);
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /32-entry retention cap/);
        assert.match(message, /cannot be recovered/);
        assert.match(message, /re-run the command/);
        assert.doesNotMatch(message, /ENOENT/);
        assert.doesNotMatch(message, /Unknown terminal id/);
        return true;
      },
    );
    await assert.rejects(
      runTool(
        runtime,
        manager.readLog({
          id: "bt-9999",
          stream: "stdout",
          offset: 0,
          limit: 1,
        }),
      ),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match(
          error instanceof Error ? error.message : String(error),
          /Unknown terminal id "bt-9999"; no terminal with that id is tracked in this session\./,
        );
        assert.equal(error instanceof TerminalLogUnavailableError, false);
        return true;
      },
    );
    if (latestSpillPaths.length > 0) {
      assert.equal(
        latestSpillPaths.every((spillPath) => fs.existsSync(spillPath)),
        true,
        "still-tracked terminal spill files remain available",
      );
    }
  });
});

test("runtime disposal removes the private spill directory", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  const snap = await runTool(
    runtime,
    manager.start({ command: "node --version", title: "cleanup", cwd }),
  );
  const { snap: done } = await settlement(manager, snap.id);
  assert.ok(done.stdout.spillPath);
  const spillDir = path.dirname(done.stdout.spillPath);
  assert.equal(fs.existsSync(spillDir), true);

  await runtime.dispose();

  assert.equal(fs.existsSync(spillDir), false);
});

test("an unknown command settles failed with the platform shell's non-zero exit", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: "definitely-not-a-real-binary-12345",
        title: "bogus",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    // The platform shell reports a non-zero exit and explains the failure.
    assert.notEqual(failed.exitCode, 0);
    assert.ok(failed.stderr.text.length > 0, "stderr explains the failure");
  });
});

test("a process 'error' event settles failed with errorText and no bogus exit code", async () => {
  await withManager(async (manager, runtime) => {
    // spawn() with a nonexistent cwd emits ENOENT via the 'error' event
    // (the tool layer validates cwd; the manager must still be correct).
    const snap = await runTool(
      runtime,
      manager.start({
        command: "true",
        title: "bad-cwd",
        cwd: "/definitely/not/a/real/dir-12345",
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.errorText ?? "", /ENOENT/);
    // Node's 'close' after a spawn 'error' reports the errno (e.g. -2) as
    // its code; that must not leak into exitCode.
    assert.equal(failed.exitCode, undefined);
    assert.equal(failed.signal, undefined);
  });
});

test("the spill file holds the complete capture when the settle hook fires, beyond the in-memory cap", async () => {
  await withManager(async (manager, runtime) => {
    const chunk = 1 << 16; // 64 KiB per write
    const writes = 48; // 3 MiB total > 2 MiB RETAINED_PER_STREAM
    const totalBytes = chunk * writes;

    let spillSizeAtSettle = -1;
    const settledOnce = new Promise<TerminalSnapshot>((resolve) => {
      manager.view.setOnSettled((snap) => {
        // Measured inside the hook: the full capture must already be on disk
        // before the completion follow-up is queued.
        if (snap.stdout.spillPath) {
          spillSizeAtSettle = fs.statSync(snap.stdout.spillPath).size;
        }
        resolve(snap);
      });
    });

    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          `const s = "x".repeat(${chunk}); for (let i = 0; i < ${writes}; i++) process.stdout.write(s);`,
        ),
        title: "firehose",
        cwd,
      }),
    );
    const done = await settledOnce;
    assert.equal(done.id, snap.id);
    assert.equal(done.status, "done");
    assert.equal(done.stdout.totalBytes, totalBytes);
    // After settle the complete capture lives on disk, so the in-memory copy
    // is compacted to the settled retention: a short startup head prefix and
    // a bounded recent tail.
    assert.ok(done.stdout.truncatedBytes > 0, "middle was omitted in memory");
    assert.ok(
      Buffer.byteLength(done.stdout.head) + Buffer.byteLength(done.stdout.tail) <=
        SETTLED_RETAINED_PER_STREAM,
      "settled head and tail stay within the compacted cap",
    );
    assert.equal(done.stdout.head, "x".repeat(Math.floor(SETTLED_RETAINED_PER_STREAM / 8)));
    assert.ok(done.stdout.tail.endsWith("x".repeat(32 * 1024)));
    if (done.stdout.spillPath) {
      assert.equal(
        spillSizeAtSettle,
        totalBytes,
        "spill file was fully flushed before the settle hook",
      );
    }
  });
});

test("advertised omitted byte ranges align with the displayed output", async () => {
  await withManager(async (manager, runtime) => {
    const lineCount = 120_000;
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(`
const filler = "x".repeat(40);
for (let i = 0; i < ${lineCount}; i++) {
  process.stdout.write(
    "line-" + String(i).padStart(6, "0") + "-" + filler +
    (i + 1 === ${lineCount} ? "" : "\\n")
  );
}
process.exitCode = 1;
`),
        title: "range-firehose",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.ok(failed.stdout.spillPath);

    const message = buildTerminalResultMessage(failed);
    const range = /omitted bytes (\d+)-(\d+)/.exec(message);
    assert.ok(range, "model output contains an omitted byte range");
    const omittedStart = Number(range[1]);
    const omittedEnd = Number(range[2]);
    assert.ok(omittedEnd >= omittedStart);

    const section = /stdout:\n([\s\S]*?)\n\[stdout bounded head\+tail:/.exec(message);
    assert.ok(section, "model output contains a bounded stdout section");
    const omitted = /\n\.\.\. [^\n]* omitted \.\.\.\n/.exec(section[1]);
    assert.ok(omitted, "bounded stdout contains its omission marker");
    const shownHead = section[1].slice(0, omitted.index);
    const shownTail = section[1].slice(omitted.index + omitted[0].length);

    const file = fs.readFileSync(failed.stdout.spillPath);
    assert.equal(
      file.subarray(omittedEnd + 1).toString("utf8"),
      shownTail,
      "advertised range ends immediately before the displayed tail",
    );
    assert.equal(
      file.subarray(0, omittedStart).toString("utf8").startsWith(shownHead),
      true,
      "displayed head is a prefix of the complete spill",
    );
  });
});

test("terminal_log_read pages a multi-byte archive without corrupting it", async () => {
  await withManager(async (manager, runtime) => {
    // Every line mixes 3-byte and 4-byte code points, so almost any byte
    // offset a model picks lands inside a character.
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholders are evaluated by the child node process, not here
          'for (let i = 0; i < 4000; i++) console.log(`行${i}:${"漢".repeat(20)}🚀`);',
        ),
        title: "utf8-archive",
        cwd,
      }),
    );
    const { snap: done } = await settlement(manager, snap.id);
    assert.ok(done.stdout.spillPath);
    const file = fs.readFileSync(done.stdout.spillPath);
    const read = (offset: number, limit: number) =>
      runTool(runtime, manager.readLog({ id: snap.id, stream: "stdout", offset, limit }));

    const emoji = file.indexOf(Buffer.from("🚀", "utf8"), 500);
    assert.ok(emoji > 0);

    // An offset inside a code point advances to the next boundary instead of
    // decoding leading continuation bytes as replacement characters.
    const midStart = await read(emoji + 1, 256);
    assert.equal(midStart.offset, emoji + 4);
    assert.equal(midStart.text.includes("\ufffd"), false);

    // A window ending inside a code point stops at its lead byte.
    const midEnd = await read(emoji - 60, 62);
    assert.equal(midEnd.nextOffset, emoji);
    assert.equal(midEnd.text.includes("\ufffd"), false);

    // Paging with next_offset must be lossless across that boundary.
    const next = await read(midEnd.nextOffset, 62);
    assert.equal(
      midEnd.text + next.text,
      file.subarray(midEnd.offset, next.nextOffset).toString("utf8"),
    );

    // A longer run with a page size coprime to the code-point widths must
    // reassemble the archive byte for byte.
    let cursor = 300;
    let reassembled = "";
    for (let page = 0; page < 20; page++) {
      const chunk = await read(cursor, 997);
      assert.notEqual(chunk.nextOffset, cursor, "every page must advance the cursor");
      reassembled += chunk.text;
      cursor = chunk.nextOffset;
    }
    assert.equal(reassembled, file.subarray(300, cursor).toString("utf8"));
    assert.equal(reassembled.includes("\ufffd"), false);

    // A limit too small to hold one code point must still make progress
    // rather than stall the model on a window it can never complete.
    let tiny = emoji;
    for (let step = 0; step < 4; step++) {
      const chunk = await read(tiny, 1);
      assert.notEqual(chunk.nextOffset, tiny);
      tiny = chunk.nextOffset;
    }

    const eof = await read(file.length, 4_096);
    assert.equal(eof.bytesRead, 0);
    assert.equal(eof.size, file.length);
    const beyond = await read(file.length + 5_000, 4_096);
    assert.equal(beyond.offset, file.length);
    assert.equal(beyond.bytesRead, 0);
  });
});

test("requestKill teardown is detached from any caller", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command:
          process.platform === "win32"
            ? nodeCmd("setInterval(() => {}, 1000)")
            : `exec ${nodeCmd(
                'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
              )}`,
        title: "detached-kill",
        cwd,
      }),
    );
    const pid = snap.pid;
    assert.ok(pid);
    if (process.platform !== "win32") {
      assert.ok(
        await pollUntil(() => (manager.view.get(snap.id)?.stdout.text ?? "").includes("ready")),
        "child installed its SIGTERM handler",
      );
    }

    // requestKill returns synchronously: the SIGTERM→SIGKILL teardown runs
    // detached in a scoped fiber, so nothing the caller does can cancel it.
    manager.view.requestKill(snap.id);

    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    if (process.platform !== "win32") assert.equal(after.signal, "SIGKILL");
    assert.ok(await pollUntil(() => processGone(pid)), "process is gone");
  });
});

test("view.get returns the snapshot and undefined for unknown ids", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.start({ command: "true", title: "status", cwd }));
    assert.equal(manager.view.get(snap.id)?.id, snap.id);
    assert.equal(manager.view.get("bt-999"), undefined);
  });
});

test("pruning evicts quick non-yielded entries before yielded terminals", async () => {
  await withManager(async (manager, runtime) => {
    // One real background terminal — outlives its initial wait, then settles
    // EARLY so its settledAt is the oldest in the map.
    const keeper = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setTimeout(() => {}, 400)"),
        title: "yielded-keeper",
        cwd,
      }),
    );
    const yielded = await runTool(runtime, manager.waitForSettlement(keeper.id, 250));
    assert.equal(yielded.settled, false);
    const { snap: keeperDone } = await settlement(manager, keeper.id);
    assert.equal(keeperDone.yielded, true);

    // Fill the retention cap with quick commands; none ever yields.
    const quickIds: string[] = [];
    for (let index = 0; index < MAX_TRACKED; index++) {
      const snap = await runTool(
        runtime,
        manager.start({ command: "true", title: `quick-${index}`, cwd }),
      );
      quickIds.push(snap.id);
      await settlement(manager, snap.id);
    }

    // 1 yielded + 32 quick > 32: the overflow comes out of the quick entries
    // even though they all settled *later* than the background terminal.
    const remaining = new Set(manager.view.list().map((snap) => snap.id));
    assert.equal(remaining.size, MAX_TRACKED);
    assert.equal(remaining.has(keeper.id), true, "yielded terminal survived pruning");
    const evicted = quickIds.filter((id) => !remaining.has(id));
    assert.deepEqual(evicted, [quickIds[0]]);
  });
});

test("settled entries compact their buffers once the archive is complete", async () => {
  await withManager(async (manager, runtime) => {
    // Larger than the settled retention cap but smaller than the live cap:
    // fully retained while running, shrunk after settle + flush.
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(`process.stdout.write("x".repeat(${256 * 1024}))`),
        title: "compaction",
        cwd,
      }),
    );
    const { snap: done } = await settlement(manager, snap.id);
    assert.equal(done.stdout.archiveComplete, true);
    assert.ok(done.stdout.spillPath);
    const retained = Buffer.byteLength(done.stdout.head) + Buffer.byteLength(done.stdout.tail);
    assert.ok(
      retained <= SETTLED_RETAINED_PER_STREAM,
      `settled view retains ${retained} bytes > ${SETTLED_RETAINED_PER_STREAM}`,
    );
    assert.ok(done.stdout.truncatedBytes > 0, "compaction is reflected in the view");
    // The complete capture remains on disk for terminal_log_read.
    assert.equal(fs.statSync(done.stdout.spillPath).size, 256 * 1024);
  });
});

test("manager startup sweeps session dirs whose owner pid is gone", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bt-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const base = path.join(agentDir, "background-terminals");
    fs.mkdirSync(base, { recursive: true });
    // A stale dir from a crashed pi: owned by a pid we know just exited.
    const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    const stale = path.join(base, `session-${dead.pid}-crashed`);
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "bt-old.stdout.log"), "old");
    // A dir owned by a live process (this one) must be kept.
    const live = path.join(base, `session-${process.pid}-live`);
    fs.mkdirSync(live);

    await withManager(async (manager, runtime) => {
      const snap = await runTool(runtime, manager.start({ command: "true", title: "sweep", cwd }));
      await settlement(manager, snap.id);
    });

    assert.equal(fs.existsSync(stale), false, "dead-pid session dir swept");
    assert.equal(fs.existsSync(live), true, "live-pid session dir preserved");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
