import assert from "node:assert/strict";
import test from "node:test";
import {
  addGoalUsage,
  completionBudgetReport,
  createGoal,
  editGoalObjective,
  formatDuration,
  formatTokenCount,
  normalizeGoal,
  remainingTokens,
  restoreGoal,
  setGoalStatus,
  usageFromUnknown,
} from "../lib/state.ts";

test("goal state resets usage when a new objective is created", () => {
  const goal = createGoal("Run the benchmark and make p95 pass", 1_000, 100, "goal-1");
  assert.deepEqual(goal, {
    goalId: "goal-1",
    objective: "Run the benchmark and make p95 pass",
    status: "active",
    tokenBudget: 1_000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 100,
    updatedAt: 100,
  });
  assert.equal(remainingTokens(goal), 1_000);
});

test("editing an objective preserves identity, accounting, and stopped states", () => {
  const created = createGoal("Original objective", 1_000, 100, "goal-edit");
  const accounted = addGoalUsage(created, { tokens: 250, seconds: 12 }, 150);
  const paused = setGoalStatus(accounted, "paused", 175, "user");
  const edited = editGoalObjective(paused, "  Revised objective  ", 200);

  assert.deepEqual(edited, {
    ...paused,
    objective: "Revised objective",
    updatedAt: 200,
  });
  assert.equal(edited.goalId, "goal-edit");
  assert.equal(edited.tokensUsed, 250);
  assert.equal(edited.timeUsedSeconds, 12);
  assert.equal(edited.tokenBudget, 1_000);
  assert.equal(edited.status, "paused");
  assert.equal(edited.pauseReason, "user");
  assert.equal(
    editGoalObjective(paused, "Another revision", paused.updatedAt).updatedAt,
    paused.updatedAt + 1,
  );

  for (const status of ["blocked", "usage-limited"] as const) {
    assert.equal(editGoalObjective(setGoalStatus(accounted, status), "Revised").status, status);
  }
  for (const status of ["complete", "budget-limited"] as const) {
    assert.equal(editGoalObjective(setGoalStatus(accounted, status), "Revised").status, "active");
  }
});

test("restoreGoal follows only the active branch's latest custom state", () => {
  const goal = createGoal("Check the current branch", undefined, 100, "goal-2");
  const restored = restoreGoal([
    { type: "custom", customType: "other", data: { goal: "ignore" } },
    { type: "custom", customType: "pi-goal", data: { version: 1, goal } },
    { type: "custom", customType: "pi-goal", data: { version: 1, goal: null } },
  ]);
  assert.equal(restored, null);
});

test("usage crosses the budget without overwriting a terminal completion", () => {
  const active = createGoal("Finish the work", 100, 100, "goal-3");
  const limited = addGoalUsage(active, { tokens: 100, seconds: 1.5 }, 200);
  assert.equal(limited.status, "budget-limited");
  assert.equal(limited.tokensUsed, 100);
  assert.equal(limited.timeUsedSeconds, 1.5);

  const complete = setGoalStatus(active, "complete", 150);
  const stillComplete = addGoalUsage(complete, { tokens: 25, seconds: 2 }, 200);
  assert.equal(stillComplete.status, "complete");
  assert.equal(stillComplete.tokensUsed, 25);
  assert.match(completionBudgetReport(stillComplete)!, /25 of 100/);
});

test("normalization rejects malformed persisted data and keeps valid state", () => {
  assert.equal(normalizeGoal({ status: "active" }), undefined);
  const goal = createGoal("Keep valid data", undefined, 100, "goal-4");
  assert.deepEqual(normalizeGoal(goal), goal);
  assert.equal(usageFromUnknown({ input: 10, output: 5 }), 15);
  assert.equal(usageFromUnknown({ totalTokens: 20, input: 10 }), 20);
});

test("zero or invalid totals fall back to component usage; positive totals win", () => {
  assert.equal(usageFromUnknown({ totalTokens: 0, input: 10, output: 5 }), 15);
  assert.equal(usageFromUnknown({ totalTokens: 0, input: 10, cacheRead: 2 }), 12);
  assert.equal(usageFromUnknown({ totalTokens: -3, input: 4 }), 4);
  assert.equal(usageFromUnknown({ totalTokens: Number.NaN, output: 7 }), 7);
  assert.equal(usageFromUnknown({ totalTokens: 0 }), 0);
  assert.equal(usageFromUnknown({ totalTokens: 20, input: 999 }), 20);
});

test("budget-limited without a budget is not a valid persisted combination", () => {
  const limited = {
    ...createGoal("No budget", undefined, 100, "goal-7"),
    status: "budget-limited" as const,
  };
  assert.equal(normalizeGoal(limited), undefined);
  const budgeted = addGoalUsage(
    createGoal("Has budget", 100, 100, "goal-8"),
    { tokens: 100, seconds: 0 },
    200,
  );
  const normalized = normalizeGoal(budgeted);
  assert.equal(normalized?.status, "budget-limited");
  assert.equal(normalized?.tokenBudget, 100);
  assert.equal(normalized?.tokensUsed, 100);
});

test("formatters stay compact", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatDuration(3_661), "1h 1m");
  assert.equal(formatDuration(61), "1m 1s");
});
