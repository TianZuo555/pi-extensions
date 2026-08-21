import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateGoalParams,
  EmptyGoalParams,
  UpdateGoalParams,
} from "../index.ts";
import {
  buildContinuationPrompt,
  buildGoalContextMessage,
  buildGoalSystemGuidance,
  CREATE_GOAL_DESCRIPTION,
  GET_GOAL_DESCRIPTION,
  GOAL_PARAMETER_DESCRIPTIONS,
  GOAL_PROMPT_GUIDELINES,
  GOAL_PROMPT_SNIPPET,
  UPDATE_GOAL_DESCRIPTION,
} from "../lib/prompt.ts";
import { MAX_OBJECTIVE_LENGTH, createGoal } from "../lib/state.ts";

type SchemaNode = {
  type?: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
};

test("goal tool metadata stays concise and non-redundant", () => {
  assert.equal(GOAL_PROMPT_GUIDELINES.length, 1);
  assert.match(GOAL_PROMPT_GUIDELINES[0]!, /explicitly request/);

  assert.match(CREATE_GOAL_DESCRIPTION, /unfinished goal/);
  assert.doesNotMatch(CREATE_GOAL_DESCRIPTION, /explicitly requested/);
  assert.doesNotMatch(UPDATE_GOAL_DESCRIPTION, /evidence|three goal turns/);
  assert.ok(GET_GOAL_DESCRIPTION.length <= 70);
  assert.ok(CREATE_GOAL_DESCRIPTION.length <= 70);
  assert.ok(UPDATE_GOAL_DESCRIPTION.length <= 50);
  assert.ok(GOAL_PROMPT_SNIPPET.length <= 36);

  const metadataChars = JSON.stringify([
    {
      name: "get_goal",
      description: GET_GOAL_DESCRIPTION,
      parameters: EmptyGoalParams,
      promptSnippet: GOAL_PROMPT_SNIPPET,
      promptGuidelines: GOAL_PROMPT_GUIDELINES,
    },
    {
      name: "create_goal",
      description: CREATE_GOAL_DESCRIPTION,
      parameters: CreateGoalParams,
    },
    {
      name: "update_goal",
      description: UPDATE_GOAL_DESCRIPTION,
      parameters: UpdateGoalParams,
    },
  ]).length;
  assert.ok(
    metadataChars <= 1_050,
    `goal metadata budget exceeded: ${metadataChars} chars`,
  );
});

test("goal schemas carry bounds and localized guidance", () => {
  const empty = JSON.parse(JSON.stringify(EmptyGoalParams)) as SchemaNode;
  const create = JSON.parse(JSON.stringify(CreateGoalParams)) as SchemaNode;
  const update = JSON.parse(JSON.stringify(UpdateGoalParams)) as SchemaNode;
  const objective = create.properties?.objective;
  const tokenBudget = create.properties?.token_budget;
  const status = update.properties?.status;

  assert.deepEqual(empty.properties, {});
  assert.equal(objective?.type, "string");
  assert.equal(objective?.minLength, 1);
  assert.equal(objective?.maxLength, MAX_OBJECTIVE_LENGTH);
  assert.equal(objective?.pattern, "\\S");
  assert.equal(tokenBudget?.type, "integer");
  assert.equal(tokenBudget?.minimum, 1);
  assert.equal(tokenBudget?.maximum, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(status?.enum, ["complete", "blocked"]);

  for (const [name, node] of [
    ["objective", objective],
    ["token_budget", tokenBudget],
    ["status", status],
  ] as const) {
    assert.ok(node?.description, `${name} has no description`);
  }

  assert.match(GOAL_PARAMETER_DESCRIPTIONS.objective, /auditable end state/);
  assert.match(GOAL_PARAMETER_DESCRIPTIONS.token_budget, /explicitly requested/);
  assert.doesNotMatch(GOAL_PARAMETER_DESCRIPTIONS.objective, /4,?000|required/i);
  assert.doesNotMatch(GOAL_PARAMETER_DESCRIPTIONS.token_budget, /optional|positive/i);
  assert.doesNotMatch(GOAL_PARAMETER_DESCRIPTIONS.status, /complete|blocked/i);
  assert.ok(JSON.stringify(CreateGoalParams).length <= 350);
  assert.ok(JSON.stringify(UpdateGoalParams).length <= 180);
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
  assert.match(guidance, /three goal turns/);
  assert.match(guidance, /user-role message/);
  assert.ok(!guidance.includes("Audit the generated artifact"));

  const context = buildGoalContextMessage(goal);
  assert.match(context, /Audit the generated artifact/);
  assert.match(context, /user authority/);
});
