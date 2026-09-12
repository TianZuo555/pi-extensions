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
