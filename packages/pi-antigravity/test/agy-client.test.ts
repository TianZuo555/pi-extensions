import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgyArgs, runAgyTurn } from "../lib/agy-client.ts";
import { agyIncompleteToolError } from "../src/provider.ts";
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
    (listeners.close ?? []).forEach((fn) => {
      fn(code);
    });
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

  const full = buildAgyArgs({
    prompt: "hi",
    conversationId: "c1",
    model: "m1",
    effort: "medium",
    cwd: "/tmp/w",
    timeoutMs: 90_000,
  });
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

/**
 * Composite regression: a background-task turn — agy starts run_command as a
 * background task, the tool step stays ACTIVE forever, the process exits
 * without a result event, and a later result-style ERROR arrives. Verifies
 * the error surface the provider turns into the background-task hint
 * (agyIncompleteToolError) plus the activity sequence the widget refresh
 * keys off (onSettled fires after controller failure).
 */
test("runAgyTurn surfaces a background-task timeout with a stuck ACTIVE tool step", async () => {
  const activities: Array<{ type: string; name?: string }> = [];
  const pushActivity = (event: { type: string; name?: string }) =>
    activities.push({ type: event.type, name: event.name });
  const promise = runAgyTurn({
    prompt: "start a dev server",
    onActivity: pushActivity as never,
    spawnOverride: (() =>
      fakeSpawn(
        `${[
          JSON.stringify({
            event: "init",
            conversation_id: "c-bg-1",
            init: { cwd: "/tmp", tools: [], permission_mode: "auto" },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              conversation_id: "c-bg-1",
              step_index: 0,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "npm run dev" } },
            },
          }),
          // No DONE, no result: the turn dies while the step is still ACTIVE,
          // exactly like a command agy backgrounded.
        ].join("\n")}\n`,
        1,
      )) as never,
  });
  await assert.rejects(promise, /exited with code 1/);

  // The stuck step produced exactly one tool_start, nothing else.
  assert.deepEqual(activities, [{ type: "tool_start", name: "run_command" }]);

  // The provider's incomplete-tool translation recognizes this shape.
  assert.match(
    agyIncompleteToolError("run_command", "timeout waiting for response"),
    /background task/,
  );
});

/**
 * Controller-level lifecycle: a failed turn must reject waiters (the
 * provider re-attach path) so the next request starts fresh instead of
 * hanging on a dead background-task turn.
 */
test("controller rejects waiters after a failed turn", async () => {
  const { AgyTurnController } = await import("../lib/turn.ts");
  const controller = new AgyTurnController("p");
  controller.push({ type: "tool_start", name: "run_command", args: {} });
  controller.fail(new Error("agy turn failed"));
  const first = await controller.next();
  assert.equal(first?.type, "tool_start");
  await assert.rejects(() => controller.next(), /agy turn failed/);
  // Post-failure pushes are dropped; next() keeps rejecting.
  controller.push({ type: "text", delta: "late" });
  await assert.rejects(() => controller.next(), /agy turn failed/);
});
