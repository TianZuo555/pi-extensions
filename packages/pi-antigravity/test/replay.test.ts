import assert from "node:assert/strict";
import { test } from "node:test";
import { AgyReplayStore } from "../lib/replay.ts";
import { AgyTurnController } from "../lib/turn.ts";
import type { AgyActivity } from "../lib/reducer.ts";

const start: AgyActivity = { type: "tool_start", name: "search_web", args: { query: "q" } };
const done: AgyActivity = {
  type: "tool_done",
  name: "search_web",
  args: {},
  output: "results",
  durationSeconds: 4.38,
};
const deliveredDone: AgyActivity = { ...done, args: { query: "q" } };

test("controller hands events to waiters in order", async () => {
  const c = new AgyTurnController("p");
  const first = c.next();
  const second = c.next();
  c.push(start);
  c.push(done);
  assert.deepEqual(await first, start);
  assert.deepEqual(await second, deliveredDone);
  assert.equal(c.hasPending(), false);
  assert.equal(c.isClosed(), false);
});

test("controller buffers events until consumed", async () => {
  const c = new AgyTurnController("p");
  c.push(start);
  c.push(done);
  assert.equal(c.hasPending(), true);
  assert.deepEqual(await c.next(), start);
  assert.deepEqual(await c.next(), deliveredDone);
});

test("controller close resolves pending waiters with null", async () => {
  const c = new AgyTurnController("p");
  const pending = c.next();
  c.push(start);
  c.close();
  assert.deepEqual(await pending, start);
  assert.equal(await c.next(), null);
  assert.equal(await c.next(), null);
});

test("controller fail rejects subsequent reads", async () => {
  const c = new AgyTurnController("p");
  c.fail(new Error("boom"));
  await assert.rejects(() => c.next(), /boom/);
});

test("controller ignores pushes after close", () => {
  const c = new AgyTurnController("p");
  c.close();
  c.push(start);
  assert.equal(c.hasPending(), false);
});

test("controller tracks incomplete tools by step id", () => {
  const c = new AgyTurnController("p");
  c.push({ type: "tool_start", stepId: 1, name: "view_file", args: { path: "a" } });
  c.push({ type: "tool_start", stepId: 2, name: "view_file", args: { path: "b" } });
  c.push({ type: "tool_done", stepId: 1, name: "view_file", args: { path: "a" } });
  assert.deepEqual(c.takeIncompleteTools(), [
    { type: "tool_start", stepId: 2, name: "view_file", args: { path: "b" } },
  ]);
  assert.deepEqual(c.takeIncompleteTools(), []);
});

test("controller carries start arguments into terminal tool events", async () => {
  const controller = new AgyTurnController("go");
  controller.push({
    type: "tool_start",
    stepId: 4,
    name: "view_file",
    args: { AbsolutePath: "/tmp/a.ts", StartLine: 3 },
  });
  controller.push({
    type: "tool_done",
    stepId: 4,
    name: "view_file",
    args: { EndLine: 8 },
    output: "done",
  });
  await controller.next();
  const done = await controller.next();
  assert.deepEqual(done, {
    type: "tool_done",
    stepId: 4,
    name: "view_file",
    args: { AbsolutePath: "/tmp/a.ts", StartLine: 3, EndLine: 8 },
    output: "done",
  });
});

test("controller attributes step usage once and subtracts it from final totals", () => {
  const c = new AgyTurnController("p");
  assert.deepEqual(
    c.claimUsage({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }, false),
    { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  );
  assert.deepEqual(
    c.claimUsage({ input_tokens: 260, output_tokens: 40, total_tokens: 300 }, true),
    { input_tokens: 160, output_tokens: 20, total_tokens: 180 },
  );
});

test("replay store records and consumes results by call id", () => {
  const store = new AgyReplayStore();
  assert.equal(store.size, 0);
  store.record("c1", { agyTool: "search_web", output: "r", durationSeconds: 1 });
  assert.equal(store.size, 1);
  const rec = store.take("c1");
  assert.equal(rec?.agyTool, "search_web");
  assert.equal(rec?.durationSeconds, 1);
  assert.equal(store.take("c1"), undefined);
  assert.equal(store.size, 0);
});
