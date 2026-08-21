import assert from "node:assert/strict";
import { test } from "node:test";
import { AgyReplayStore, summarizeAgyArgs } from "../lib/replay.ts";
import { AgyTurnController } from "../lib/turn.ts";
import type { AgyActivity } from "../lib/reducer.ts";

const start: AgyActivity = { type: "tool_start", name: "search_web", args: { query: "q" } };
const done: AgyActivity = {
  type: "tool_done",
  name: "search_web",
  output: "results",
  durationSeconds: 4.38,
};

test("controller hands events to waiters in order", async () => {
  const c = new AgyTurnController("p");
  const first = c.next();
  const second = c.next();
  c.push(start);
  c.push(done);
  assert.deepEqual(await first, start);
  assert.deepEqual(await second, done);
  assert.equal(c.hasPending(), false);
  assert.equal(c.isClosed(), false);
});

test("controller buffers events until consumed", async () => {
  const c = new AgyTurnController("p");
  c.push(start);
  c.push(done);
  assert.equal(c.hasPending(), true);
  assert.deepEqual(await c.next(), start);
  assert.deepEqual(await c.next(), done);
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

test("summarizeAgyArgs produces a bounded one-line summary", () => {
  assert.equal(summarizeAgyArgs(undefined), "");
  assert.equal(summarizeAgyArgs({}), "");
  assert.equal(summarizeAgyArgs({ query: "why did Intel stock drop" }), '{"query":"why did Intel stock drop"}');
  const long = summarizeAgyArgs({ content: "x".repeat(200) });
  assert.ok(long.length <= 96);
  assert.ok(long.endsWith("…"));
});
