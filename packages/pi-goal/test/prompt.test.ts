import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContinuationPrompt,
  buildGoalContextMessage,
  buildGoalSystemGuidance,
  CREATE_GOAL_DESCRIPTION,
  UPDATE_GOAL_DESCRIPTION,
} from "../lib/prompt.ts";
import { createGoal } from "../lib/state.ts";

test("goal tools keep lifecycle authority asymmetric", () => {
  assert.match(CREATE_GOAL_DESCRIPTION, /explicitly requested/);
  assert.match(CREATE_GOAL_DESCRIPTION, /unfinished goal/);
  assert.match(UPDATE_GOAL_DESCRIPTION, /complete/);
  assert.match(UPDATE_GOAL_DESCRIPTION, /blocked/);
  assert.match(UPDATE_GOAL_DESCRIPTION, /Pause, resume/);
});

test("continuation prompt preserves objective and evidence audit", () => {
  const goal = createGoal("Reduce p95 latency below 120 ms", 5_000, 1, "goal-5");
  const prompt = buildContinuationPrompt(goal);
  assert.match(prompt, /<objective>/);
  assert.match(prompt, /Reduce p95 latency below 120 ms/);
  assert.match(prompt, /concrete evidence/);
  assert.match(prompt, /update_goal with status "complete"/);
  assert.match(prompt, /three consecutive goal turns/);
});

test("system guidance stays trusted extension text without the objective", () => {
  const goal = createGoal("Audit the generated artifact", undefined, 1, "goal-6");
  const guidance = buildGoalSystemGuidance(goal);
  assert.match(guidance, /evidence/);
  assert.match(guidance, /user-role message/);
  assert.ok(!guidance.includes("Audit the generated artifact"));

  const context = buildGoalContextMessage(goal);
  assert.match(context, /Audit the generated artifact/);
  assert.match(context, /user authority/);
});
