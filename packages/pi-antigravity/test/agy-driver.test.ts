import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AgySpawnError,
  AgyStallError,
  buildDriverAgyArgs,
  type AgyTurnRequest,
} from "../lib/agy-client.ts";
import { AgyDriverSession, AgyOneShotExecutor } from "../lib/agy-driver.ts";
import { getAgyChildrenRegistry, signalVerifiedAgyOrphans } from "../lib/agy-children.ts";

async function driverFixture(): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-driver-"));
  const script = path.join(dir, "driver.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const args = process.argv.slice(2);
let turns = 0;
const conversation = "driver-conversation";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const event = JSON.parse(line);
  if (event.message.content === "finish-late-result") {
    console.log(JSON.stringify({ event: "result", result: {
      status: "SUCCESS", response: "late answer", conversation_id: conversation, num_turns: turns
    } }));
    return;
  }
  turns += 1;
  console.log(JSON.stringify({ event: "init", conversation_id: conversation, init: {} }));
  if (event.message.content === "tool-silent") {
    console.log(JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: conversation,
        step_index: turns,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "sleep 60" } }
      }
    }));
    return;
  }
  if (event.message.content === "schedule-across-print-default") {
    const step = {
      step_index: turns,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "schedule",
      tool_info: { parameters: { DurationSeconds: 45, Prompt: "Checking task status" } }
    };
    console.log(JSON.stringify({ event: "step_update", step_update: step }));
    // Accelerated reproduction of agy's five-minute wait returning SUCCESS
    // while a timer and its final answer are still pending.
    const timeoutIndex = args.indexOf("--print-timeout");
    const waitMs = timeoutIndex < 0 ? 20 : Math.min(5000, parseFloat(args[timeoutIndex + 1]) * 1000);
    const deadline = setTimeout(() => {
      console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } }));
    }, waitMs);
    await new Promise(resolve => setTimeout(resolve, 60));
    clearTimeout(deadline);
    step.state = "DONE";
    step.tool_info.output = "Finished waiting 45 seconds.";
    console.log(JSON.stringify({ event: "step_update", step_update: step }));
    console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Final task summary." } }));
    return;
  }
  if (event.message.content === "silent") return;
  if (event.message.content === "exit-before-result") process.exit(7);
  // Backgrounded long command: the tool step goes ACTIVE and the result still
  // arrives, so the step never reaches DONE/ERROR (issue #43 state).
  const activeToolStep = JSON.stringify({
    event: "step_update",
    step_update: {
      conversation_id: conversation,
      step_index: turns,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "sleep 60" } }
    }
  });
  if (event.message.content === "late-result") {
    console.log(activeToolStep);
    // The test releases the result after its first parked probe, avoiding a
    // timer race with the driver's synchronous process-table scan.
    return;
  }
  if (event.message.content === "background") console.log(activeToolStep);
  if (["background-graceful", "background-stubborn"].includes(event.message.content)) {
    const worker = spawn(process.execPath, ["--input-type=module", "-e", [
      'import { writeFileSync } from "node:fs";',
      'process.on("SIGTERM", () => { writeFileSync("worker-term", "yes");',
      event.message.content === "background-graceful"
        ? 'setTimeout(() => { writeFileSync("worker-cleanup", "yes"); process.exit(0); }, 25);'
        : '',
      '}); process.send("ready"); setInterval(() => {}, 1000);'
    ].join("\\n")], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise(resolve => worker.once("message", resolve));
    process.on("SIGTERM", () => {
      writeFileSync("term-received", "yes");
      if (event.message.content === "background-graceful") {
        setTimeout(() => {
          writeFileSync("cleanup-finished", "yes");
          process.exit(0);
        }, 75);
      }
    });
    console.log(activeToolStep);
  }
  if (event.message.content === "detached-worker-silent") {
    // A background task that outlives agy: its own process group, and it
    // ignores SIGTERM — exactly the leftover the orphan registry exists for.
    const worker = spawn(process.execPath, ["-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
    ], { detached: true, stdio: "ignore" });
    worker.unref();
    console.log(activeToolStep);
    return;
  }
  if (event.message.content === "burst-crash") {
    // Two distinct tool starts in one burst: the first spawns a detached
    // worker, the second arrives while it is alive. A time throttle that
    // skips the second start would leave the worker unrecorded when we die.
    console.log(activeToolStep);
    const worker = spawn(process.execPath, ["-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
    ], { detached: true, stdio: "ignore" });
    worker.unref();
    // Wait until the worker leads its own process group — the scan only
    // records group-leading children, and setsid timing varies under load.
    for (let i = 0; i < 200; i++) {
      const probe = spawnSync("ps", ["-o", "pgid=", "-p", String(worker.pid)]);
      if (probe.status === 0 && probe.stdout.toString().trim() === String(worker.pid)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const second = JSON.parse(activeToolStep);
    second.step_update.step_index = turns + 1000;
    console.log(JSON.stringify(second));
    // Stay alive a beat after the line: exiting immediately re-parents the
    // worker before the driver's line processing can scan our children.
    await new Promise(resolve => setTimeout(resolve, 500));
    process.exit(7);
  }
  if (event.message.content === "completed-tool") {
    console.log(activeToolStep);
    const done = JSON.parse(activeToolStep);
    done.step_update.state = "DONE";
    console.log(JSON.stringify(done));
  }
  if (event.message.content === "background-error") {
    console.log(activeToolStep);
    console.log(JSON.stringify({
      event: "result",
      conversation_id: conversation,
      result: {
        status: "FAILURE",
        response: "",
        error: "timeout waiting for response",
        conversation_id: conversation,
        num_turns: turns
      }
    }));
    return;
  }
  console.log(JSON.stringify({
    event: "result",
    conversation_id: conversation,
    result: {
      status: "SUCCESS",
      response: JSON.stringify({ pid: process.pid, turns, args, event }),
      conversation_id: conversation,
      num_turns: turns
    }
  }));
});
`,
  );
  await chmod(script, 0o755);
  return { dir, script };
}

function fixtureSpawn(script: string): typeof spawn {
  return ((_binary: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
    spawn(process.execPath, [script, ...args], options)) as typeof spawn;
}

test("buildDriverAgyArgs keeps the native print wait beyond Pi's timer budget", () => {
  const args = buildDriverAgyArgs({
    conversationId: "c1",
    model: "gemini-3.7-flash",
    effort: "high",
    cwd: "/repo",
    timeoutMs: 5,
    agent: "reviewer",
    mode: "plan",
    bridgeRevision: "3:7",
  });
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--conversation") + 1], "c1");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--agent") + 1], "reviewer");
  assert.equal(args[args.indexOf("--mode") + 1], "plan");
  assert.ok(!args.includes("--print"));
  assert.equal(args[args.indexOf("--print-timeout") + 1], "2147484s");
  assert.ok(!args.includes("3:7"));
});

test("persistent driver waits through schedules to the final answer across reused turns", async () => {
  const fixture = await driverFixture();
  const driver = new AgyDriverSession();
  try {
    for (const timeoutMs of [1_000, 2_000]) {
      const outcome = await driver.run({
        prompt: "schedule-across-print-default",
        conversationId: "driver-conversation",
        binary: "fixture-agy",
        spawnOverride: fixtureSpawn(fixture.script),
        timeoutMs,
      });
      assert.equal(outcome.status, "OK");
      assert.equal(outcome.response, "Final task summary.");
      assert.ok(
        outcome.activities.some(
          (activity) => activity.type === "tool_done" && activity.name === "schedule",
        ),
      );
    }
    assert.equal(driver.snapshot().stats?.spawnCount, 1);
    assert.equal(driver.snapshot().stats?.recycleCount, 0);
  } finally {
    await driver.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver handles fragmented CRLF and a final unterminated result", async () => {
  const spawnOverride = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      pid?: number;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.once("data", () => {
      queueMicrotask(() => {
        const init = JSON.stringify({ event: "init", conversation_id: "fragmented", init: {} });
        const result = JSON.stringify({
          event: "result",
          conversation_id: "fragmented",
          result: { status: "SUCCESS", response: "ok", conversation_id: "fragmented" },
        });
        child.stdout.write(`{not-json}\r\n${init.slice(0, 10)}`);
        child.stdout.write(`${init.slice(10)}\r\n${result}`);
        child.emit("close", 0, null);
      });
    });
    return child;
  }) as never;
  const executor = new AgyDriverSession();
  try {
    const outcome = await executor.run({
      prompt: "hello",
      binary: "/fake/agy",
      spawnOverride,
      timeoutMs: 1_000,
      inactivityTimeoutMs: 500,
    });
    assert.equal(outcome.status, "OK");
    assert.equal(outcome.response, "ok");
    assert.equal(outcome.conversationId, "fragmented");
  } finally {
    await executor.close("shutdown");
  }
});

test("persistent driver honors stdin backpressure and removes abort listeners", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & {
      write: (line: string, callback: (error?: Error | null) => void) => boolean;
      end: () => void;
    };
    stdout: PassThrough;
    stderr: PassThrough;
    pid?: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let written = "";
  child.stdin = Object.assign(new EventEmitter(), {
    write: (line: string, callback: (error?: Error | null) => void) => {
      written += line;
      queueMicrotask(() => {
        callback();
        child.stdin.emit("drain");
        child.stdout.write(
          `${JSON.stringify({ event: "init", conversation_id: "backpressure", init: {} })}\n${JSON.stringify(
            {
              event: "result",
              conversation_id: "backpressure",
              result: {
                status: "SUCCESS",
                response: "ok",
                conversation_id: "backpressure",
              },
            },
          )}\n`,
        );
      });
      return false;
    },
    end: () => queueMicrotask(() => child.emit("close", 0, null)),
  });
  const signal = new AbortController();
  const executor = new AgyDriverSession();
  try {
    const outcome = await executor.run({
      prompt: "backpressured",
      binary: "/fake/agy",
      spawnOverride: (() => child) as never,
      signal: signal.signal,
    });
    assert.equal(outcome.response, "ok");
    assert.deepEqual(JSON.parse(written), {
      event: "user",
      message: { role: "user", content: "backpressured" },
    });
    assert.equal(getEventListeners(signal.signal, "abort").length, 0);
  } finally {
    await executor.close("shutdown");
  }
});

test("persistent driver turns stdin callback errors into AgySpawnError", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & {
      write: (line: string, callback: (error?: Error | null) => void) => boolean;
      end: () => void;
    };
    stdout: PassThrough;
    stderr: PassThrough;
    pid?: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = Object.assign(new EventEmitter(), {
    write: (_line: string, callback: (error?: Error | null) => void) => {
      queueMicrotask(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
      return true;
    },
    end: () => {},
  });
  const executor = new AgyDriverSession();
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "epipe",
          binary: "/fake/agy",
          spawnOverride: (() => child) as never,
        }),
      (error: unknown) => error instanceof AgySpawnError && /broken pipe/.test(error.message),
    );
  } finally {
    await executor.close("shutdown");
  }
});

test("persistent driver sends exact NDJSON and reuses one PID across idle time", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const spawnOverride = fixtureSpawn(fixture.script);
  try {
    const first = await executor.run({
      prompt: "first",
      binary: fixture.script,
      model: "gemini-3.7-flash",
      effort: "high",
      cwd: fixture.dir,
      inactivityTimeoutMs: 1_000,
      spawnOverride,
    });
    const firstResponse = JSON.parse(first.response) as {
      pid: number;
      turns: number;
      args: string[];
      event: unknown;
    };
    assert.deepEqual(firstResponse.event, {
      event: "user",
      message: { role: "user", content: "first" },
    });
    assert.ok(!firstResponse.args.includes("--print"));
    assert.equal(firstResponse.args[firstResponse.args.indexOf("--print-timeout") + 1], "2147484s");
    assert.equal(executor.snapshot().state, "ready");

    // No watchdog is armed while the process is idle.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    const second = await executor.run({
      prompt: "second",
      conversationId: first.conversationId,
      binary: fixture.script,
      model: "gemini-3.7-flash",
      effort: "high",
      cwd: fixture.dir,
      inactivityTimeoutMs: 1_000,
      spawnOverride,
    });
    const secondResponse = JSON.parse(second.response) as { pid: number; turns: number };
    assert.equal(secondResponse.pid, firstResponse.pid);
    assert.equal(secondResponse.turns, 2);
    const snapshot = executor.snapshot();
    assert.equal(snapshot.pid, firstResponse.pid);
    assert.deepEqual(snapshot.stats, {
      spawnCount: 1,
      submittedTurns: 2,
      reusedTurns: 1,
      recycleCount: 0,
      currentProcessTurns: 2,
      recycleReasons: {},
      lastRecycleReason: undefined,
    });
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver recycles on process fingerprint changes and resumes the conversation", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const spawnOverride = fixtureSpawn(fixture.script);
  try {
    const first = await executor.run({
      prompt: "first",
      binary: fixture.script,
      model: "gemini-3.7-flash",
      effort: "high",
      cwd: fixture.dir,
      bridgeRevision: "1:1",
      spawnOverride,
    });
    const firstResponse = JSON.parse(first.response) as { pid: number };
    const second = await executor.run({
      prompt: "second",
      conversationId: first.conversationId,
      binary: fixture.script,
      model: "gemini-3.7-flash",
      effort: "low",
      cwd: fixture.dir,
      bridgeRevision: "1:2",
      spawnOverride,
    });
    const secondResponse = JSON.parse(second.response) as { pid: number; args: string[] };
    assert.notEqual(secondResponse.pid, firstResponse.pid);
    assert.equal(
      secondResponse.args[secondResponse.args.indexOf("--conversation") + 1],
      first.conversationId,
    );
    assert.equal(secondResponse.args[secondResponse.args.indexOf("--effort") + 1], "low");
    const snapshot = executor.snapshot();
    assert.equal(snapshot.stats?.spawnCount, 2);
    assert.equal(snapshot.stats?.recycleCount, 1);
    assert.equal(snapshot.stats?.lastRecycleReason, "effort");
    assert.deepEqual(snapshot.stats?.recycleReasons, { effort: 1 });
    assert.ok(snapshot.lifecycle.some((entry) => entry.endsWith("close:recycle:effort")));
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver identifies every process reuse mismatch", async () => {
  const fixture = await driverFixture();
  const spawnOverride = fixtureSpawn(fixture.script);
  const cases: Array<{
    cause: string;
    first?: Partial<AgyTurnRequest>;
    second: Partial<AgyTurnRequest>;
  }> = [
    { cause: "binary", first: { binary: "/fake/agy-v1" }, second: { binary: "/fake/agy-v2" } },
    { cause: "cwd", second: { cwd: tmpdir() } },
    { cause: "model", first: { model: "model-a" }, second: { model: "model-b" } },
    { cause: "effort", first: { effort: "high" }, second: { effort: "low" } },
    { cause: "agent", first: { agent: "reviewer" }, second: { agent: "planner" } },
    { cause: "mode", first: { mode: "plan" }, second: { mode: "accept-edits" } },
    {
      cause: "bridge-catalog",
      first: { bridgeRevision: "1:1" },
      second: { bridgeRevision: "1:2" },
    },
    { cause: "conversation", second: { conversationId: "another-conversation" } },
    { cause: "conversation-reset", second: { conversationId: undefined } },
  ];
  try {
    for (const entry of cases) {
      const executor = new AgyDriverSession();
      const base: AgyTurnRequest = {
        prompt: "first",
        conversationId: "driver-conversation",
        binary: fixture.script,
        cwd: fixture.dir,
        spawnOverride,
      };
      try {
        await executor.run({ ...base, ...entry.first });
        await executor.run({ ...base, prompt: "second", ...entry.second });
        const stats = executor.snapshot().stats;
        assert.equal(stats?.recycleCount, 1, entry.cause);
        assert.equal(stats?.lastRecycleReason, entry.cause);
        assert.deepEqual(stats?.recycleReasons, { [entry.cause]: 1 });
      } finally {
        await executor.close("shutdown");
      }
    }
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

for (const mode of ["graceful", "stubborn"] as const) {
  test(`background recycle gives ${mode} processes a grace period before the next spawn`, {
    skip: process.platform === "win32" ? "POSIX signals" : false,
  }, async () => {
    const fixture = await driverFixture();
    const executor = new AgyDriverSession();
    const children: ReturnType<typeof spawn>[] = [];
    const spawnOverride = ((
      _binary: string,
      args: readonly string[],
      options: Parameters<typeof spawn>[2],
    ) => {
      if (children.length) {
        assert.ok(
          children[0].exitCode !== null || children[0].signalCode !== null,
          "the previous leader must exit before its replacement spawns",
        );
      }
      const child = spawn(process.execPath, [fixture.script, ...args], options);
      children.push(child);
      return child;
    }) as typeof spawn;
    const request = {
      binary: fixture.script,
      cwd: fixture.dir,
      spawnOverride,
      inactivityTimeoutMs: 5_000,
    };
    try {
      const first = executor.run({ ...request, prompt: `background-${mode}` });
      const second = executor.run({
        ...request,
        prompt: "second",
        conversationId: "driver-conversation",
      });
      const [outcome] = await Promise.all([first, second]);
      assert.equal(outcome.status, "OK");
      assert.equal(await readFile(path.join(fixture.dir, "term-received"), "utf8"), "yes");
      assert.equal(await readFile(path.join(fixture.dir, "worker-term"), "utf8"), "yes");
      if (mode === "graceful") {
        assert.equal(await readFile(path.join(fixture.dir, "worker-cleanup"), "utf8"), "yes");
        assert.equal(await readFile(path.join(fixture.dir, "cleanup-finished"), "utf8"), "yes");
        assert.equal(children[0].exitCode, 0);
      } else {
        assert.equal(children[0].signalCode, "SIGKILL");
      }
      assert.equal(executor.snapshot().stats?.spawnCount, 2);
      assert.equal(executor.snapshot().stats?.recycleCount, 1);
    } finally {
      await executor.close("shutdown");
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
}

test("shutdown waits for quarantined background cleanup and retains death-hook ownership", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  let pid: number | undefined;
  let receivedResult!: () => void;
  const resultSeen = new Promise<void>((resolve) => {
    receivedResult = resolve;
  });
  try {
    const pending = executor.run({
      binary: fixture.script,
      cwd: fixture.dir,
      prompt: "background",
      inactivityTimeoutMs: 5_000,
      spawnOverride: fixtureSpawn(fixture.script),
      onActivity: (activity) => {
        if (activity.type === "result") {
          pid = executor.snapshot().pid;
          receivedResult();
        }
      },
    });
    await resultSeen;
    assert.equal(executor.snapshot().state, "stopping");
    assert.equal(executor.snapshot().pid, undefined, "quarantined child cannot be reused");
    assert.ok(pid);
    assert.ok(getAgyChildrenRegistry().live.has(pid));
    await executor.close("shutdown");
    assert.equal((await pending).status, "OK");
    assert.equal(executor.snapshot().state, "dead");
    assert.equal(getAgyChildrenRegistry().live.has(pid), false);
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver reuses a process after all tool steps complete", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const request = {
    binary: fixture.script,
    cwd: fixture.dir,
    inactivityTimeoutMs: 5_000,
    spawnOverride: fixtureSpawn(fixture.script),
  };
  try {
    const first = await executor.run({ ...request, prompt: "completed-tool" });
    assert.equal(executor.snapshot().state, "ready");
    const second = await executor.run({
      ...request,
      prompt: "second",
      conversationId: first.conversationId,
    });
    assert.equal(JSON.parse(first.response).pid, JSON.parse(second.response).pid);
    assert.equal(executor.snapshot().stats?.recycleCount, 0);
    assert.equal(executor.snapshot().stats?.reusedTurns, 1);
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver recycles after a turn that backgrounds a tool step", async () => {
  // Issue #43: a turn that ends while a run_command step is still ACTIVE
  // backgrounded a long command; reusing that agy process makes the very
  // next turn exit code 1 with empty stderr. The driver must spawn fresh
  // instead, resuming the same conversation by id.
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const spawnOverride = fixtureSpawn(fixture.script);
  try {
    const first = await executor.run({
      prompt: "background",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      spawnOverride,
    });
    assert.equal(first.status, "OK");
    const firstResponse = JSON.parse(first.response) as { pid: number };
    assert.equal(executor.snapshot().state, "idle", "no live child between turns");

    const second = await executor.run({
      prompt: "second",
      conversationId: first.conversationId,
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      spawnOverride,
    });
    const secondResponse = JSON.parse(second.response) as { pid: number; args: string[] };
    assert.notEqual(secondResponse.pid, firstResponse.pid);
    assert.equal(
      secondResponse.args[secondResponse.args.indexOf("--conversation") + 1],
      first.conversationId,
    );
    const snapshot = executor.snapshot();
    assert.equal(snapshot.stats?.spawnCount, 2);
    assert.equal(snapshot.stats?.recycleCount, 1);
    assert.equal(snapshot.stats?.lastRecycleReason, "background-task");
    assert.deepEqual(snapshot.stats?.recycleReasons, { "background-task": 1 });
    assert.ok(snapshot.lifecycle.some((entry) => entry.includes("recycle:background-task:")));
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver recycles after an ERROR result with a still-ACTIVE tool", async () => {
  // Regression for issue #43: the observed poisoning arrives as a FAILURE
  // result ("timeout waiting for response") while run_command stays ACTIVE,
  // so the recycle must key on the ACTIVE residue, not on result status.
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const spawnOverride = fixtureSpawn(fixture.script);
  try {
    const first = await executor.run({
      prompt: "background-error",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      spawnOverride,
    });
    assert.equal(first.status, "ERROR");
    assert.match(first.error ?? "", /timeout waiting for response/);
    assert.equal(executor.snapshot().state, "idle", "no live child between turns");

    const second = await executor.run({
      prompt: "second",
      conversationId: first.conversationId,
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      spawnOverride,
    });
    assert.equal(second.status, "OK");
    const stats = executor.snapshot().stats;
    assert.equal(stats?.spawnCount, 2);
    assert.equal(stats?.recycleCount, 1);
    assert.equal(stats?.lastRecycleReason, "background-task");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver kills a silent active process with AgyStallError", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "silent",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 30,
          timeoutMs: 5_000,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => error instanceof AgyStallError,
    );
    assert.equal(executor.snapshot().state, "dead");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver enforces the Pi-owned overall turn timeout", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "silent",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 0,
          timeoutMs: 60,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => error instanceof AgySpawnError && /timed out/.test(error.message),
    );
    const snapshot = executor.snapshot();
    assert.equal(snapshot.state, "dead");
    assert.equal(snapshot.stats?.currentProcessTurns, 0);
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver uses the longer watchdog budget for an active tool", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "tool-silent",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 500,
          toolInactivityTimeoutMs: 70,
          timeoutMs: 2_000,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError);
        assert.equal(error.stalledMs, 70);
        assert.equal(error.toolActive, true);
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver aborts an active turn and removes its signal listener", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const abort = new AbortController();
  try {
    const pending = executor.run({
      prompt: "silent",
      binary: fixture.script,
      cwd: fixture.dir,
      signal: abort.signal,
      inactivityTimeoutMs: 0,
      timeoutMs: 5_000,
      spawnOverride: fixtureSpawn(fixture.script),
    });
    setTimeout(() => abort.abort(), 30);
    const outcome = await pending;
    assert.equal(outcome.status, "ERROR");
    assert.match(outcome.error ?? "", /aborted/);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    assert.equal(executor.snapshot().state, "dead");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver serializes concurrent submissions on one process", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const spawnOverride = fixtureSpawn(fixture.script);
  try {
    const request = {
      conversationId: "driver-conversation",
      binary: fixture.script,
      cwd: fixture.dir,
      model: "gemini-3.7-flash",
      effort: "high",
      spawnOverride,
    } as const;
    const [first, second] = await Promise.all([
      executor.run({ ...request, prompt: "first concurrent" }),
      executor.run({ ...request, prompt: "second concurrent" }),
    ]);
    const firstResponse = JSON.parse(first.response) as { pid: number; turns: number };
    const secondResponse = JSON.parse(second.response) as { pid: number; turns: number };
    assert.equal(firstResponse.pid, secondResponse.pid);
    assert.deepEqual([firstResponse.turns, secondResponse.turns], [1, 2]);
    assert.equal(executor.snapshot().stats?.reusedTurns, 1);
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver reports a child close before its terminal result", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "exit-before-result",
          binary: fixture.script,
          cwd: fixture.dir,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) =>
        error instanceof AgySpawnError &&
        /exited with code 7 before producing a result/.test(error.message) &&
        /no stderr/.test(error.message) &&
        /PI_ANTIGRAVITY_DRIVER=0/.test(error.message),
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver wraps synchronous spawn failures and marks itself dead", async () => {
  const executor = new AgyDriverSession();
  await assert.rejects(
    () =>
      executor.run({
        prompt: "hello",
        binary: "/fake/agy",
        spawnOverride: (() => {
          throw new Error("spawn exploded");
        }) as never,
      }),
    (error: unknown) => error instanceof AgySpawnError && /spawn exploded/.test(error.message),
  );
  assert.equal(executor.snapshot().state, "dead");
  await executor.close("shutdown");
});

/**
 * Driver fixture that streams multi-tool step sequences and then goes
 * silent, so the Pi-side stall watchdog is the only thing that can end the
 * turn. Used to pin the ACTIVE-step tracking semantics.
 */
async function stepSequenceFixture(): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-driver-steps-"));
  const script = path.join(dir, "driver-steps.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
const conversation = "driver-steps-conversation";
const send = (obj) => console.log(JSON.stringify(obj));
const toolStep = (index, state, name) => send({
  event: "step_update",
  step_update: {
    conversation_id: conversation,
    step_index: index,
    state,
    step_type: "tool",
    tool_name: name,
    tool_info: { name, parameters: { CommandLine: "sleep 60" } }
  }
});
let initSent = false;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const event = JSON.parse(line);
  if (!initSent) {
    initSent = true;
    send({ event: "init", conversation_id: conversation, init: {} });
  }
  const content = event.message.content;
  if (content === "overlap") {
    toolStep(0, "ACTIVE", "tool_a");
    toolStep(1, "ACTIVE", "tool_b");
    toolStep(1, "DONE", "tool_b");
  }
  if (content === "duplicate") {
    toolStep(0, "ACTIVE", "tool_a");
    toolStep(0, "ACTIVE", "tool_a");
    toolStep(0, "DONE", "tool_a");
  }
  // Every sequence ends silent: the watchdog must decide the budget.
});
`,
  );
  await chmod(script, 0o755);
  return { dir, script };
}

test("persistent driver keeps the longer tool budget while another step is still ACTIVE", async () => {
  // Regression: ACTIVE A, ACTIVE B, DONE B — B completing must not clear the
  // active-tool state while A is still running, so the stall watchdog must
  // fire on the tool budget, not the short base budget.
  // Use a long base / short tool budget so fixture startup cannot race the
  // initial stall arm under full-suite load (same pattern as the single-tool
  // active-budget test above).
  const fixture = await stepSequenceFixture();
  const executor = new AgyDriverSession();
  const seen: string[] = [];
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "overlap",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 500,
          toolInactivityTimeoutMs: 80,
          timeoutMs: 5_000,
          spawnOverride: fixtureSpawn(fixture.script),
          onActivity: (activity) => seen.push(activity.type),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError, `expected AgyStallError, got ${error}`);
        assert.ok(
          seen.filter((type) => type === "tool_start").length >= 2 && seen.includes("tool_done"),
          "fixture steps must arrive before the stall fires",
        );
        assert.equal(error.toolActive, true, "step A is still ACTIVE after B finished");
        assert.equal(error.stalledMs, 80, "fired on the tool budget, not the base budget");
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver treats a duplicate ACTIVE id as one step for the watchdog", async () => {
  // Regression: a repeated ACTIVE for the same step id must not wedge the
  // watchdog in the tool budget — one DONE closes the step and the base
  // budget applies again once no other step is ACTIVE.
  const fixture = await stepSequenceFixture();
  const executor = new AgyDriverSession();
  const seen: string[] = [];
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "duplicate",
          binary: fixture.script,
          cwd: fixture.dir,
          // Match the startup headroom of other driver stall fixtures; keep
          // the tool budget much longer so a wedged ACTIVE would miss this.
          inactivityTimeoutMs: 500,
          toolInactivityTimeoutMs: 2_000,
          timeoutMs: 5_000,
          spawnOverride: fixtureSpawn(fixture.script),
          onActivity: (activity) => seen.push(activity.type),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError, `expected AgyStallError, got ${error}`);
        assert.ok(
          seen.includes("tool_start") && seen.includes("tool_done"),
          "fixture steps must arrive before the stall fires",
        );
        assert.equal(error.toolActive, false, "the step is closed by its DONE event");
        assert.equal(error.stalledMs, 500, "fired on the base budget");
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("persistent driver abort during startup never submits the prompt to stdin", async () => {
  // Regression: the signal can fire while the executor is still inside the
  // spawn/start path (binary check, recycle, child start). The turn must be
  // settled with the abort outcome BEFORE the user event is written, and no
  // abort listener may be registered after the signal already fired.
  const signal = new AbortController();
  let written = "";
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & {
      write: (line: string, callback: (error?: Error | null) => void) => boolean;
      end: () => void;
    };
    stdout: PassThrough;
    stderr: PassThrough;
    pid?: number;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = Object.assign(new EventEmitter(), {
    write: (line: string, callback: (error?: Error | null) => void) => {
      written += line;
      queueMicrotask(() => callback());
      return true;
    },
    end: () => {},
  });
  const spawnOverride = ((_binary: string, _args: readonly string[], _options: unknown) => {
    // Abort mid-startup: after run()'s entry check, while the driver is
    // starting the child process.
    signal.abort();
    return child;
  }) as never;
  const executor = new AgyDriverSession();
  try {
    const message = await executor
      .run({
        prompt: "must never be submitted",
        binary: "/fake/agy",
        spawnOverride,
        signal: signal.signal,
        timeoutMs: 2_000,
        inactivityTimeoutMs: 0,
      })
      .then(
        (outcome) => outcome.error ?? "",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    assert.match(message, /aborted/i);
    assert.equal(written, "", "no user event may reach the agy stdin after abort");
    assert.equal(getEventListeners(signal.signal, "abort").length, 0);
  } finally {
    await executor.close("shutdown");
  }
});

test("one-shot executor exposes rollback mode and abortable close", async () => {
  const executor = new AgyOneShotExecutor();
  assert.equal(executor.snapshot().mode, "one-shot");
  await executor.close("shutdown");
  assert.equal(executor.snapshot().state, "dead");
});

test("a verifiably working tool process extends the stall budget instead of dying", async () => {
  // agy emits no stdout while a tool step is ACTIVE, so a quiet slow command
  // (cold `cargo build`) is indistinguishable from a hang by timing alone.
  // While a group-leading child proves work is happening, the turn survives.
  const fixture = await stepSequenceFixture();
  const executor = new AgyDriverSession();
  let probes = 0;
  let parkedProbes = 0;
  // Report "working" twice, then stop: the turn must outlive the first two
  // budgets and only fail once the evidence of progress disappears.
  executor.setStallLivenessProbe(async () => ++probes <= 2);
  executor.setTurnParkedProbe(async () => {
    parkedProbes += 1;
    return { finished: false };
  });
  const start = Date.now();
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "overlap",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 2_000,
          toolInactivityTimeoutMs: 120,
          timeoutMs: 10_000,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError, `expected AgyStallError, got ${error}`);
        assert.equal(error.toolActive, true);
        assert.equal(probes, 3, "probed once per expiry until evidence vanished");
        assert.equal(parkedProbes, 3, "the transcript check runs before each liveness verdict");
        // Two forgiven budgets means it survived well past a single 120ms one,
        // and the reported stall covers the whole silence, not one budget.
        assert.equal(error.stalledMs, 360);
        assert.ok(
          Date.now() - start >= 360,
          `expected at least three tool budgets to elapse, got ${Date.now() - start}ms`,
        );
        return true;
      },
    );
    assert.ok(
      executor.snapshot().lifecycle.some((line) => line.includes("stall:tool-alive:2")),
      "grace extensions are recorded in the lifecycle log",
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("the stall grace ceiling still ends a silent turn with no tool process", async () => {
  // In-process agy tools (schedule, search_web) spawn nothing, so absence of a
  // child is not proof of a hang — but it must not grant unlimited grace.
  const fixture = await stepSequenceFixture();
  const executor = new AgyDriverSession();
  let probes = 0;
  // Always "working", but the ceiling is 2: the turn must still fail.
  executor.setStallLivenessProbe(async () => {
    probes += 1;
    return true;
  }, 2);
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "overlap",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 2_000,
          toolInactivityTimeoutMs: 120,
          timeoutMs: 10_000,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError, `expected AgyStallError, got ${error}`);
        assert.equal(probes, 2, "probing stops once the grace ceiling is reached");
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a stalled turn with no active tool fails immediately without probing", async () => {
  // The base budget covers silence between steps, where no tool is running and
  // process evidence is meaningless. That path must not pay for a `ps` scan.
  const fixture = await stepSequenceFixture();
  const executor = new AgyDriverSession();
  let probes = 0;
  executor.setStallLivenessProbe(async () => {
    probes += 1;
    return true;
  });
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "no-tools",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 400,
          toolInactivityTimeoutMs: 5_000,
          timeoutMs: 10_000,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError, `expected AgyStallError, got ${error}`);
        assert.equal(error.toolActive, false);
        assert.equal(probes, 0, "no tool active means no liveness probe");
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a liveness probe in flight cannot kill a turn that resumed and completed", async () => {
  // The probe is async. If stream activity rearms the watchdog while a probe is
  // in flight, that probe's verdict describes a superseded window: acting on it
  // would kill a demonstrably healthy turn.
  const dir = await mkdtemp(path.join(tmpdir(), "agy-driver-staleprobe-"));
  const script = path.join(dir, "driver-stale.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
const send = (o) => console.log(JSON.stringify(o));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", () => {
  send({ event: "init", conversation_id: "c", init: {} });
  send({ event: "step_update", step_update: { conversation_id: "c", step_index: 0,
    state: "ACTIVE", step_type: "tool", tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "build" } } } });
  // Silent past the tool budget so a probe starts, then resume steadily and
  // finish while that probe is still pending.
  setTimeout(() => {
    let n = 0;
    const iv = setInterval(() => {
      send({ event: "step_update", step_update: { conversation_id: "c", step_index: 0,
        state: "ACTIVE", step_type: "agent_response", text_delta: "tick" + (++n) } });
      if (n >= 15) { clearInterval(iv);
        send({ event: "step_update", step_update: { conversation_id: "c", step_index: 0,
          state: "DONE", step_type: "tool", tool_name: "run_command",
          tool_info: { name: "run_command", parameters: {}, output: "built" } } });
        send({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "built ok" } });
      }
    }, 30);
  }, 150);
});
`,
  );
  await chmod(script, 0o755);
  const executor = new AgyDriverSession();
  let probes = 0;
  // Slow negative probe: resolves long after output resumed.
  executor.setStallLivenessProbe(async () => {
    probes += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return false;
  });
  try {
    const outcome = await executor.run({
      prompt: "resume",
      binary: script,
      cwd: dir,
      inactivityTimeoutMs: 5_000,
      toolInactivityTimeoutMs: 100,
      timeoutMs: 8_000,
      spawnOverride: fixtureSpawn(script),
    });
    assert.ok(probes >= 1, "the scenario must actually put a probe in flight");
    assert.equal(outcome.status, "OK", "a resumed turn must not be killed by a stale probe");
    assert.equal(outcome.response, "built ok");
  } finally {
    await executor.close("shutdown");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn parked on a background task ends gracefully instead of stalling", async () => {
  // agy >= 1.2.0 holds the result event while a backgrounded command runs
  // (bounded by the ~25d print timeout), but its transcript already shows the
  // agent's answer is final. Waiting for the task is not an option — end the
  // turn so the still-ACTIVE tool step replays as an incomplete-tool card and
  // the parked agy child is recycled like any backgrounded turn.
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  let probes = 0;
  const parkedCalls: Array<{ conversationId: string | undefined; indexes: number[] }> = [];
  executor.setStallLivenessProbe(async () => {
    probes += 1;
    return true;
  });
  executor.setTurnParkedProbe(
    async (conversationId, activeStepIndexes) => {
      parkedCalls.push({ conversationId, indexes: activeStepIndexes });
      return { finished: true, response: "the withheld answer" };
    },
    { pollMs: 25, limit: 1 },
  );
  const activities: Array<{ type: string; response?: string }> = [];
  const start = Date.now();
  try {
    const outcome = await executor.run({
      prompt: "tool-silent",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      toolInactivityTimeoutMs: 60,
      timeoutMs: 10_000,
      spawnOverride: fixtureSpawn(fixture.script),
      onActivity: (activity) =>
        activities.push({
          type: activity.type,
          response: activity.type === "result" ? activity.response : undefined,
        }),
    });
    assert.equal(outcome.status, "OK");
    assert.match(outcome.error ?? "", /background task/);
    // The transcript recovered the withheld answer — it lands on both the
    // outcome and the synthetic result activity the provider renders.
    assert.equal(outcome.response, "the withheld answer");
    assert.ok(
      Date.now() - start < 5_000,
      "a parked turn must end near the tool budget, not the overall deadline",
    );
    assert.equal(probes, 0, "parked detection pre-empts the liveness probe");
    // The probe sees the conversation id and the ACTIVE step's index.
    assert.deepEqual(parkedCalls[0], {
      conversationId: "driver-conversation",
      indexes: [1],
    });
    assert.ok(parkedCalls.length >= 2, "the parked grace polls at least once before settling");
    assert.ok(activities.some((a) => a.type === "tool_start"));
    const result = activities.find((a) => a.type === "result");
    assert.ok(result, "a synthetic result closes the turn");
    assert.equal(result.response, "the withheld answer");
    const snapshot = executor.snapshot();
    assert.ok(snapshot.lifecycle.some((line) => line.includes("stall:task-parked")));
    assert.equal(snapshot.stats?.lastRecycleReason, "background-task");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a final answer appearing during liveness grace is recovered before the deadline", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  let transcriptProbes = 0;
  let livenessProbes = 0;
  executor.setStallLivenessProbe(async () => {
    livenessProbes += 1;
    return true;
  });
  executor.setTurnParkedProbe(
    async () => ({ finished: ++transcriptProbes > 1, response: "late final answer" }),
    { pollMs: 50, limit: 1 },
  );
  try {
    const outcome = await executor.run({
      prompt: "tool-silent",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      toolInactivityTimeoutMs: 800,
      timeoutMs: 1_500,
      spawnOverride: fixtureSpawn(fixture.script),
    });
    assert.equal(outcome.status, "OK");
    assert.equal(outcome.response, "late final answer");
    assert.equal(livenessProbes, 1, "the renewed 800ms budget has not expired");
    assert.equal(transcriptProbes, 3, "finality is checked inside that renewed budget");
    assert.equal(executor.snapshot().stats?.lastRecycleReason, "background-task");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("short finality polls do not consume the liveness grace ceiling", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  let livenessProbes = 0;
  let transcriptProbes = 0;
  executor.setStallLivenessProbe(async () => {
    livenessProbes += 1;
    return true;
  }, 2);
  executor.setTurnParkedProbe(
    async () => {
      transcriptProbes += 1;
      return { finished: false };
    },
    { pollMs: 20 },
  );
  try {
    await assert.rejects(
      executor.run({
        prompt: "tool-silent",
        binary: fixture.script,
        cwd: fixture.dir,
        inactivityTimeoutMs: 5_000,
        toolInactivityTimeoutMs: 120,
        timeoutMs: 5_000,
        spawnOverride: fixtureSpawn(fixture.script),
      }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError);
        assert.equal(error.stalledMs, 360);
        assert.equal(livenessProbes, 2);
        assert.ok(transcriptProbes > 3, "transcript polling is independent of grace accounting");
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a known final answer skips parked grace that would cross the deadline", async () => {
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  executor.setTurnParkedProbe(async () => ({ finished: true, response: "ready" }), {
    pollMs: 1_000,
  });
  try {
    const outcome = await executor.run({
      prompt: "tool-silent",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      toolInactivityTimeoutMs: 100,
      timeoutMs: 900,
      spawnOverride: fixtureSpawn(fixture.script),
    });
    assert.equal(outcome.status, "OK");
    assert.equal(outcome.response, "ready");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a real result arriving inside the parked grace wins over the synthetic end", async () => {
  // The task finished just after the first expiry marked the turn parked:
  // stream activity clears the parked rearm, so the genuine result (not the
  // synthesized one) settles the turn.
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  let parkedCalls = 0;
  let child: ReturnType<typeof spawn> | undefined;
  executor.setTurnParkedProbe(
    async () => {
      parkedCalls += 1;
      assert.ok(child?.stdin);
      child.stdin.write(
        `${JSON.stringify({ event: "user", message: { content: "finish-late-result" } })}\n`,
      );
      return { finished: true, response: "ignored — the real result wins" };
    },
    { pollMs: 120 },
  );
  try {
    const outcome = await executor.run({
      prompt: "late-result",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      toolInactivityTimeoutMs: 40,
      timeoutMs: 10_000,
      spawnOverride: ((
        _binary: string,
        args: readonly string[],
        options: Parameters<typeof spawn>[2],
      ) => {
        child = spawn(process.execPath, [fixture.script, ...args], options);
        return child;
      }) as typeof spawn,
    });
    assert.equal(outcome.status, "OK");
    assert.equal(outcome.response, "late answer");
    assert.equal(parkedCalls, 1, "the result lands before the parked rearm fires");
    assert.equal(outcome.error, undefined, "a real result carries no synthetic error");
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a cleared parked state falls back to liveness probing and the stall kill", async () => {
  // The transcript said "finished" at the first expiry, but the next poll no
  // longer does — the turn must return to the normal liveness-grace path and
  // still die once that evidence disappears.
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  let parkedCalls = 0;
  let livenessProbes = 0;
  executor.setTurnParkedProbe(async () => ({ finished: ++parkedCalls <= 1 }), {
    pollMs: 30,
  });
  executor.setStallLivenessProbe(async () => ++livenessProbes <= 2);
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "tool-silent",
          binary: fixture.script,
          cwd: fixture.dir,
          inactivityTimeoutMs: 5_000,
          toolInactivityTimeoutMs: 60,
          timeoutMs: 10_000,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => {
        assert.ok(error instanceof AgyStallError, `expected AgyStallError, got ${error}`);
        assert.equal(error.toolActive, true);
        // Silence accumulates across the tool budget, the parked poll, and
        // each forgiven liveness budget: 60 + 30 + 60 + 60 = 210.
        assert.equal(error.stalledMs, 210);
        // Finality is also checked halfway through each 60ms liveness grace.
        // These extra polls do not consume either of the two graces.
        assert.equal(parkedCalls, 6);
        assert.equal(livenessProbes, 3);
        return true;
      },
    );
  } finally {
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("recycling a parked child records its detached task as a proven orphan", async () => {
  // The SIGTERM-ignoring detached worker outlives the recycled agy child —
  // but it was recorded as this conversation's orphan while ancestry could
  // still prove it, so /agy-tasks and shutdown can stop it afterwards.
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  executor.setTurnParkedProbe(async () => ({ finished: true }), { pollMs: 25, limit: 1 });
  let orphanPid: number | undefined;
  try {
    const outcome = await executor.run({
      prompt: "detached-worker-silent",
      binary: fixture.script,
      cwd: fixture.dir,
      inactivityTimeoutMs: 5_000,
      toolInactivityTimeoutMs: 60,
      timeoutMs: 10_000,
      spawnOverride: fixtureSpawn(fixture.script),
    });
    assert.equal(outcome.status, "OK");
    const recorded = [...getAgyChildrenRegistry().taskOrphans.entries()].filter(
      ([, rec]) => rec.conversationId === "driver-conversation",
    );
    assert.equal(recorded.length, 1, "the detached worker was recorded as a proven orphan");
    orphanPid = recorded[0][0];
    // It survived the recycle's SIGTERM — that is the orphan case.
    try {
      process.kill(orphanPid, 0);
    } catch {
      assert.fail("the SIGTERM-ignoring worker must still be alive");
    }
  } finally {
    if (orphanPid !== undefined) {
      getAgyChildrenRegistry().taskOrphans.delete(orphanPid);
      try {
        process.kill(-orphanPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("a new tool start in a burst is still snapshotted before agy crashes", {
  skip: process.platform === "win32" ? "POSIX process groups" : false,
}, async () => {
  // The fixture emits two DISTINCT tool starts back-to-back and dies right
  // after — the worker spawned between them is only recoverable if the
  // second start's scan actually ran (a time throttle would skip it).
  const fixture = await driverFixture();
  const executor = new AgyDriverSession();
  const registry = getAgyChildrenRegistry();
  const before = new Set(registry.taskOrphans.keys());
  const recorded: number[] = [];
  try {
    await assert.rejects(
      () =>
        executor.run({
          prompt: "burst-crash",
          binary: fixture.script,
          cwd: fixture.dir,
          spawnOverride: fixtureSpawn(fixture.script),
        }),
      (error: unknown) => error instanceof AgySpawnError,
    );
    recorded.push(...[...registry.taskOrphans.keys()].filter((pid) => !before.has(pid)));
    assert.ok(
      recorded.length >= 1,
      "the worker spawned between the burst's tool starts was recorded",
    );
    for (const pid of recorded) process.kill(pid, 0); // still alive post-crash
    // And the verified sweep can clean it — the whole point of the record.
    const signaled = signalVerifiedAgyOrphans("SIGKILL");
    assert.ok(signaled >= 1, "the recorded worker was signalled");
    for (const pid of recorded) {
      await new Promise<void>((resolve) => {
        const check = () => {
          try {
            process.kill(pid, 0);
            setTimeout(check, 25);
          } catch {
            resolve();
          }
        };
        check();
      });
    }
  } finally {
    for (const pid of recorded) {
      registry.taskOrphans.delete(pid);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await executor.close("shutdown");
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
