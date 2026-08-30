import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function driverFixture(): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-driver-"));
  const script = path.join(dir, "driver.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import readline from "node:readline";
const args = process.argv.slice(2);
let turns = 0;
const conversation = "driver-conversation";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
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
        /exited with code 7 before producing a result/.test(error.message),
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

test("one-shot executor exposes rollback mode and abortable close", async () => {
  const executor = new AgyOneShotExecutor();
  assert.equal(executor.snapshot().mode, "one-shot");
  await executor.close("shutdown");
  assert.equal(executor.snapshot().state, "dead");
});
