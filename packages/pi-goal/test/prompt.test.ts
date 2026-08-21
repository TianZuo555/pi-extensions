import assert from "node:assert/strict";
import test from "node:test";
import {
  EmptyGoalParams,
  UpdateGoalParams,
} from "../index.ts";
import {
  buildContinuationPrompt,
  buildGoalContextMessage,
  buildGoalSystemGuidance,
  buildObjectiveUpdatedPrompt,
  GET_GOAL_DESCRIPTION,
  GOAL_PARAMETER_DESCRIPTIONS,
  GOAL_PROMPT_SNIPPET,
  UPDATE_GOAL_DESCRIPTION,
} from "../lib/prompt.ts";
import { createGoal } from "../lib/state.ts";

type SchemaNode = {
  description?: string;
  enum?: string[];
  properties?: Record<string, SchemaNode>;
};

test("goal tool metadata stays concise and non-redundant", () => {
  assert.doesNotMatch(UPDATE_GOAL_DESCRIPTION, /evidence|three goal turns/);
  assert.ok(GET_GOAL_DESCRIPTION.length <= 70);
  assert.ok(UPDATE_GOAL_DESCRIPTION.length <= 50);
  assert.ok(GOAL_PROMPT_SNIPPET.length <= 36);

  const metadataChars = JSON.stringify([
    {
      name: "get_goal",
      description: GET_GOAL_DESCRIPTION,
      parameters: EmptyGoalParams,
      promptSnippet: GOAL_PROMPT_SNIPPET,
    },
    {
      name: "update_goal",
      description: UPDATE_GOAL_DESCRIPTION,
      parameters: UpdateGoalParams,
    },
  ]).length;
  assert.ok(
    metadataChars <= 500,
    `goal metadata budget exceeded: ${metadataChars} chars`,
  );
});

test("update_goal schema carries localized guidance", () => {
  const empty = JSON.parse(JSON.stringify(EmptyGoalParams)) as SchemaNode;
  const update = JSON.parse(JSON.stringify(UpdateGoalParams)) as SchemaNode;
  const status = update.properties?.status;

  assert.deepEqual(empty.properties, {});
  assert.deepEqual(status?.enum, ["complete", "blocked"]);
  assert.ok(status?.description, "status has no description");
  assert.doesNotMatch(GOAL_PARAMETER_DESCRIPTIONS.status, /complete|blocked/i);
  assert.ok(JSON.stringify(UpdateGoalParams).length <= 180);
});

test("continuation and edit prompts preserve objective authority", () => {
  const goal = createGoal("Reduce p95 latency below 120 ms", 5_000, 1, "goal-5");
  const continuation = buildContinuationPrompt(goal);
  assert.match(continuation, /<objective>/);
  assert.match(continuation, /Reduce p95 latency below 120 ms/);
  assert.match(continuation, /concrete evidence/);
  assert.match(continuation, /update_goal with status "complete"/);
  assert.match(continuation, /three consecutive goal turns/);

  const updated = buildObjectiveUpdatedPrompt({
    ...goal,
    objective: "Keep p95 below 100 ms",
  });
  assert.match(updated, /user-provided data/);
  assert.match(updated, /Keep p95 below 100 ms/);
  assert.match(updated, /revised objective/);
});

test("system guidance stays trusted extension text without the objective", () => {
  const goal = createGoal("Audit the generated artifact", undefined, 1, "goal-6");
  const guidance = buildGoalSystemGuidance(goal);
  assert.match(guidance, /evidence/);
  assert.match(guidance, /three goal turns/);
  assert.match(guidance, /user-role message/);
  assert.ok(!guidance.includes("Audit the generated artifact"));

  const context = buildGoalContextMessage(goal);
  assert.match(context, /Audit the generated artifact/);
  assert.match(context, /user authority/);
});
