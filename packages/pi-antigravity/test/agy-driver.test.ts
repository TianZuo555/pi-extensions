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
import { getAgyChildrenRegistry } from "../lib/agy-children.ts";

async function driverFixture(): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-driver-"));
  const script = path.join(dir, "driver.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
let turns = 0;
const conversation = "driver-conversation";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const event = JSON.parse(line);
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

test("buildDriverAgyArgs uses stream input and omits print deadlines", () => {
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
  assert.ok(!args.includes("--print-timeout"));
  assert.ok(!args.includes("3:7"));
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
    assert.ok(!firstResponse.args.includes("--print-timeout"));
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
