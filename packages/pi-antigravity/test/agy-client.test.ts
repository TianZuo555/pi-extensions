import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgyArgs, runAgyTurn } from "../lib/agy-client.ts";
import { OK_CAPTURE, REAL_CAPTURE } from "./fixtures.ts";

type FakeChild = {
  stdout: { setEncoding: (e: string) => void; on: (ev: string, fn: (c: string) => void) => void };
  stderr: { setEncoding: (e: string) => void; on: (ev: string, fn: (c: string) => void) => void };
  on: (ev: string, fn: (arg?: unknown) => void) => void;
  kill: (sig: string) => void;
};

function fakeSpawn(output: string, code = 0) {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const stream = () => {
    const data: Array<(c: string) => void> = [];
    return {
      setEncoding: () => {},
      on: (_ev: string, fn: (c: string) => void) => {
        data.push(fn);
      },
      emit: (c: string) => {
        for (const fn of data) fn(c);
      },
    };
  };
  const stdout = stream();
  const stderr = stream();
  const child: FakeChild = {
    stdout,
    stderr,
    on: (ev, fn) => {
      listeners[ev] = listeners[ev] ?? [];
      listeners[ev].push(fn);
    },
    kill: () => {},
  };
  queueMicrotask(() => {
    stdout.emit(output);
    listeners.data ??= [];
    (listeners.close ?? []).forEach((fn) => fn(code));
  });
  return child as unknown as never;
}

test("buildAgyArgs always skips permissions and puts the prompt directly after --print", () => {
  const base = buildAgyArgs({ prompt: "hi" });
  assert.equal(base[0], "--print");
  assert.equal(base[1], "hi");
  assert.ok(base.includes("--dangerously-skip-permissions"));
  assert.ok(base.includes("--disable-slash-commands"));
  assert.ok(base.includes("--output-format"));
  assert.equal(base[base.indexOf("--output-format") + 1], "stream-json");
  assert.ok(!base.includes("--conversation"));
  assert.ok(!base.includes("--effort"));
  assert.ok(!base.includes("--add-dir"));

  const full = buildAgyArgs({ prompt: "hi", conversationId: "c1", model: "m1", effort: "medium", cwd: "/tmp/w", timeoutMs: 90_000 });
  assert.equal(full[full.indexOf("--conversation") + 1], "c1");
  assert.equal(full[full.indexOf("--model") + 1], "m1");
  assert.equal(full[full.indexOf("--effort") + 1], "medium");
  assert.equal(full[full.indexOf("--add-dir") + 1], "/tmp/w");
  assert.equal(full[full.indexOf("--print-timeout") + 1], "90s");
});

test("runAgyTurn reduces a successful stream", async () => {
  const outcome = await runAgyTurn({
    prompt: "hi",
    spawnOverride: (() => fakeSpawn(`${OK_CAPTURE}\n`)) as never,
  });
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.response, "Hello from agy!");
  assert.equal(outcome.conversationId, "c-ok-1");
});

test("runAgyTurn resolves an error result and reports activity live", async () => {
  const activity: string[] = [];
  const outcome = await runAgyTurn({
    prompt: "hi",
    onActivity: (event) => activity.push(event.type),
    spawnOverride: (() => fakeSpawn(`${REAL_CAPTURE}\n`)) as never,
  });
  assert.equal(outcome.status, "ERROR");
  assert.ok(outcome.error?.includes("permission check failed"));
  assert.ok(activity.length > 0);
  assert.ok(activity.includes("tool_start"));
});

test("runAgyTurn rejects when the process dies before a result event", async () => {
  await assert.rejects(
    () =>
      runAgyTurn({
        prompt: "hi",
        spawnOverride: (() => fakeSpawn("jetski: no output produced\n", 1)) as never,
      }),
    /exited with code 1/,
  );
});
