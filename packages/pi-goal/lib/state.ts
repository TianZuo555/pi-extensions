import { randomUUID } from "node:crypto";

export const GOAL_ENTRY_TYPE = "pi-goal";
export const MAX_OBJECTIVE_LENGTH = 4_000;

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage-limited"
  | "budget-limited"
  | "complete";

export type GoalPauseReason = "user" | "interrupt";

export interface Goal {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  pauseReason?: GoalPauseReason;
}

export interface GoalEntryData {
  version: 1;
  goal: Goal | null;
}

export interface GoalUsage {
  tokens: number;
  seconds: number;
}

const TERMINAL_STATUSES = new Set<GoalStatus>([
  "blocked",
  "usage-limited",
  "budget-limited",
  "complete",
]);

export function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usage-limited" ||
    value === "budget-limited" ||
    value === "complete"
  );
}

export function isGoalPauseReason(value: unknown): value is GoalPauseReason {
  return value === "user" || value === "interrupt";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

/**
 * Normalize persisted state instead of trusting arbitrary custom-entry data.
 * Older entries may omit fields added later; those fields get safe defaults.
 */
export function normalizeGoal(value: unknown): Goal | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.goalId !== "string" || value.goalId.length === 0) return undefined;
  if (typeof value.objective !== "string" || value.objective.trim().length === 0) {
    return undefined;
  }
  if (!isGoalStatus(value.status)) return undefined;
  if (!finiteNonNegative(value.tokensUsed)) return undefined;
  if (!finiteNonNegative(value.timeUsedSeconds)) return undefined;
  if (!finiteNonNegative(value.createdAt) || !finiteNonNegative(value.updatedAt)) {
    return undefined;
  }

  const tokenBudget = value.tokenBudget;
  if (tokenBudget !== undefined && !finitePositiveInteger(tokenBudget)) {
    return undefined;
  }
  // A budget-limited goal always has a budget; the combination is otherwise
  // impossible to recover from (nothing can lift the limit).
  if (value.status === "budget-limited" && tokenBudget === undefined) {
    return undefined;
  }
  const pauseReason = value.pauseReason;
  if (pauseReason !== undefined && !isGoalPauseReason(pauseReason)) {
    return undefined;
  }

  return {
    goalId: value.goalId,
    objective: value.objective,
    status: value.status,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(pauseReason === undefined ? {} : { pauseReason }),
  };
}

export function cloneGoal(goal: Goal | null): Goal | null {
  return goal ? { ...goal } : null;
}

/** Return the most recent goal state on the active session branch. */
export function restoreGoal(entries: readonly unknown[]): Goal | null {
  let goal: Goal | null = null;

  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data;
    if (!isRecord(data) || data.version !== 1 || !("goal" in data)) continue;
    if (data.goal === null) {
      goal = null;
      continue;
    }
    const normalized = normalizeGoal(data.goal);
    if (normalized) goal = normalized;
  }

  return goal;
}

export function validateObjective(objective: string): string | undefined {
  const trimmed = objective.trim();
  if (trimmed.length === 0) return "Objective must not be empty.";
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    return `Objective must be ${MAX_OBJECTIVE_LENGTH} characters or fewer.`;
  }
  return undefined;
}

export function validateTokenBudget(tokenBudget: number | undefined): string | undefined {
  if (tokenBudget === undefined) return undefined;
  if (!finitePositiveInteger(tokenBudget)) {
    return "Token budget must be a positive safe integer.";
  }
  return undefined;
}

export function createGoal(
  objective: string,
  tokenBudget?: number,
  now = Date.now(),
  goalId: string = randomUUID(),
): Goal {
  const normalizedObjective = objective.trim();
  const objectiveError = validateObjective(normalizedObjective);
  if (objectiveError) throw new Error(objectiveError);
  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) throw new Error(budgetError);

  return {
    goalId,
    objective: normalizedObjective,
    status: "active",
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function isTerminalGoal(goal: Goal): boolean {
  return TERMINAL_STATUSES.has(goal.status);
}

export function canCreateOver(goal: Goal | null): boolean {
  return goal === null || goal.status === "complete";
}

export function setGoalStatus(
  goal: Goal,
  status: GoalStatus,
  now = Date.now(),
  pauseReason?: GoalPauseReason,
): Goal {
  return {
    ...goal,
    status,
    updatedAt: now,
    ...(status === "paused"
      ? { pauseReason: pauseReason ?? goal.pauseReason ?? "user" }
      : { pauseReason: undefined }),
  };
}

/**
 * Account a turn that started while this goal was active. The goal id is
 * checked by the caller so an old turn cannot charge a replacement goal.
 */
export function addGoalUsage(goal: Goal, usage: GoalUsage, now = Date.now()): Goal {
  const nextTokens = goal.tokensUsed + Math.max(0, usage.tokens);
  const nextSeconds = goal.timeUsedSeconds + Math.max(0, usage.seconds);
  const budgetReached =
    goal.status === "active" &&
    goal.tokenBudget !== undefined &&
    nextTokens >= goal.tokenBudget;

  return {
    ...goal,
    tokensUsed: nextTokens,
    timeUsedSeconds: nextSeconds,
    status: budgetReached ? "budget-limited" : goal.status,
    updatedAt: now,
    ...(budgetReached ? { pauseReason: undefined } : {}),
  };
}

export function remainingTokens(goal: Goal | null): number | undefined {
  if (!goal || goal.tokenBudget === undefined) return undefined;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainder = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export function formatGoalStatus(status: GoalStatus): string {
  return status;
}

export function formatGoalSummary(goal: Goal | null): string {
  if (!goal) return "No goal is active for this thread.";

  const budget =
    goal.tokenBudget === undefined
      ? `${formatTokenCount(goal.tokensUsed)} tokens used`
      : `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)} tokens`;
  return [
    `Goal: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Usage: ${budget} · ${formatDuration(goal.timeUsedSeconds)}`,
  ].join("\n");
}

export function completionBudgetReport(goal: Goal): string | undefined {
  if (goal.tokenBudget === undefined) return undefined;
  return (
    `Goal achieved. Report final budget usage to the user: tokens used: ` +
    `${Math.round(goal.tokensUsed)} of ${goal.tokenBudget}; time used: ` +
    `${formatDuration(goal.timeUsedSeconds)}.`
  );
}

export function usageFromUnknown(value: unknown): number {
  if (!isRecord(value)) return 0;
  const totalTokens = value.totalTokens;
  // A positive authoritative total wins over component fields.
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    return totalTokens;
  }
  // Absent, invalid, or zero totals fall back to the component sum so that a
  // legitimate "0 total" payload does not erase real component usage.
  const fields = ["input", "output", "cacheRead", "cacheWrite"];
  return fields.reduce((sum, field) => {
    const amount = value[field];
    return sum + (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : 0);
  }, 0);
}
