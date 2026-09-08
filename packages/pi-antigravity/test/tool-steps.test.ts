import assert from "node:assert/strict";
import { test } from "node:test";
import { agyToolStepKey, trackActiveToolStep } from "../lib/tool-steps.ts";

test("active-step tracking shares replay keys and treats step zero as an ID", () => {
  assert.equal(agyToolStepKey({ stepId: 0, name: "run_command" }), "step:0");
  assert.equal(agyToolStepKey({ name: "run_command" }), "name:run_command");
});

test("duplicate starts and errors affect only their own step", () => {
  const active = new Set<string>();
  for (const stepId of [0, 0, 1]) {
    trackActiveToolStep(active, { type: "tool_start", stepId, name: "same", args: {} });
  }
  assert.equal(active.size, 2);
  trackActiveToolStep(active, {
    type: "tool_error",
    stepId: 1,
    name: "same",
    args: {},
    message: "failed",
  });
  assert.deepEqual([...active], ["step:0"]);
  trackActiveToolStep(active, { type: "tool_done", stepId: 0, name: "same", args: {} });
  assert.equal(active.size, 0);
});

test("missing IDs fall back to tool names without clearing unrelated tools", () => {
  const active = new Set<string>();
  for (const name of ["one", "one", "two"]) {
    trackActiveToolStep(active, { type: "tool_start", name, args: {} });
  }
  trackActiveToolStep(active, { type: "tool_done", name: "two", args: {} });
  assert.deepEqual([...active], ["name:one"]);
  trackActiveToolStep(active, { type: "tool_done", name: "one", args: {} });
  assert.equal(active.size, 0);
});
