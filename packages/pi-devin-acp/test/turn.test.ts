import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinTurnController } from "../src/turn.ts";
import type { DevinToolView } from "../lib/tool-content.ts";

const view = (id: string, status?: string): DevinToolView => ({
  id,
  title: `tool ${id}`,
  status,
});

test("controller queues activities and resolves waiters in order", async () => {
  const c = new DevinTurnController("p", "s1");
  const first = c.next();
  c.push({ type: "text", delta: "a" });
  assert.deepEqual(await first, { type: "text", delta: "a" });
  c.push({ type: "text", delta: "b" });
  c.close();
  assert.deepEqual(await c.next(), { type: "text", delta: "b" });
  assert.equal(await c.next(), null);
});

test("incomplete tools are tracked until terminal updates", () => {
  const c = new DevinTurnController("p", "s1");
  c.push({ type: "tool_start", view: view("t1", "in_progress") });
  c.push({ type: "tool_start", view: view("t2", "in_progress") });
  c.push({ type: "tool_update", view: view("t1", "completed") });
  assert.deepEqual(
    c.takeIncompleteTools().map((v) => v.id),
    ["t2"],
  );
  assert.deepEqual(c.takeIncompleteTools(), []);
});

for (const status of ["completed", "failed"]) {
  test(`initial ${status} tool calls are not incomplete`, () => {
    const c = new DevinTurnController("p", "s1");
    c.push({ type: "tool_start", view: view("t1", status) });
    c.close();
    assert.deepEqual(c.takeIncompleteTools(), []);
  });
}

test("deferResult keeps a result pending for re-entry after close", async () => {
  const c = new DevinTurnController("p", "s1");
  c.push({ type: "result", stopReason: "end_turn" });
  c.close();
  assert.equal(c.isClosed(), true);
  const result = await c.next();
  assert.deepEqual(result, { type: "result", stopReason: "end_turn" });
  assert.equal(c.hasPending(), false);
  c.deferResult(result as never);
  assert.equal(c.hasPending(), true);
  assert.deepEqual(await c.next(), { type: "result", stopReason: "end_turn" });
  assert.equal(await c.next(), null);
});

test("fail rejects pending and future next() calls", async () => {
  const c = new DevinTurnController("p", "s1");
  const pending = c.next();
  c.fail(new Error("boom"));
  await assert.rejects(pending, /boom/);
  await assert.rejects(c.next(), /boom/);
});

test("request usage snapshots dedup consecutive repeats and accumulate", () => {
  const c = new DevinTurnController("p", "s1");
  // Devin emits every request's update twice — identical repeats count once.
  c.recordUsage({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 });
  c.recordUsage({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 });
  // A second request's snapshot accumulates on top.
  c.recordUsage({ inputTokens: 12, outputTokens: 6, cachedReadTokens: 3 });
  // The prompt response echoes the last request — deduped.
  c.recordUsage({ inputTokens: 12, outputTokens: 6, cachedReadTokens: 3 });
  assert.deepEqual(c.takeBillableUsage(), {
    inputTokens: 22,
    outputTokens: 11,
    cachedReadTokens: 6,
  });
});

test("context-only usage updates are not billable and keep the dedup baseline", () => {
  const c = new DevinTurnController("p", "s1");
  c.recordUsage({ inputTokens: 10, outputTokens: 5 });
  // No token counters — ignored without touching the dedup baseline.
  c.recordUsage({ contextUsed: 15, contextSize: 262000 });
  // The request's duplicate still dedups past the context-only update.
  c.recordUsage({ inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(c.takeBillableUsage(), { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(c.takeBillableUsage(), {});
});

test("cumulative turn_stats usage replaces accumulation and blocks snapshots", () => {
  const c = new DevinTurnController("p", "s1");
  c.recordUsage({ inputTokens: 10, outputTokens: 5 });
  // turn_stats' cumulative sums are authoritative — they replace the
  // accumulated request total.
  c.recordUsage({ inputTokens: 20, outputTokens: 8, cachedReadTokens: 4, cumulative: true });
  // Later request snapshots (e.g. the prompt response echo) are already
  // inside the cumulative sum and must not add to it.
  c.recordUsage({ inputTokens: 12, outputTokens: 6 });
  assert.deepEqual(c.takeBillableUsage(), {
    inputTokens: 20,
    outputTokens: 8,
    cachedReadTokens: 4,
  });
});

test("takeBillableUsage returns the not-yet-billed delta across messages", () => {
  const c = new DevinTurnController("p", "s1");
  c.recordUsage({ inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(c.takeBillableUsage(), { inputTokens: 100, outputTokens: 20 });
  // A later request's snapshot bills only its own share.
  c.recordUsage({ inputTokens: 150, outputTokens: 35, cachedReadTokens: 90 });
  assert.deepEqual(c.takeBillableUsage(), {
    inputTokens: 150,
    outputTokens: 35,
    cachedReadTokens: 90,
  });
  // Nothing new observed — the terminal message bills nothing.
  assert.deepEqual(c.takeBillableUsage(), {});
});

test("a cumulative set below already-billed totals bills no negative correction", () => {
  const c = new DevinTurnController("p", "s1");
  c.recordUsage({ inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(c.takeBillableUsage(), { inputTokens: 100, outputTokens: 20 });
  // The authoritative total arrived lower than what was billed — the
  // excess stays in the log; nothing is clawed back.
  c.recordUsage({ inputTokens: 80, outputTokens: 15, cumulative: true });
  assert.deepEqual(c.takeBillableUsage(), {});
});
