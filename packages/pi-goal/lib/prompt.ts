import type { Goal } from "./state.ts";
import {
  formatDuration,
  formatTokenCount,
  remainingTokens,
} from "./state.ts";

export const GET_GOAL_DESCRIPTION =
  "Get the current goal for this thread, including status, objective, token and elapsed-time usage, and remaining token budget.";

export const CREATE_GOAL_DESCRIPTION =
  "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if an unfinished goal exists.";

export const UPDATE_GOAL_DESCRIPTION =
  "Update the existing goal. Use only to mark it complete when the objective is achieved, or blocked after the same blocking condition has recurred for at least three consecutive goal turns and no meaningful progress is possible. Pause, resume, budget-limited, and usage-limited transitions are controlled by the user or system.";

export const GOAL_PROMPT_SNIPPET =
  "Pursue an explicit long-running objective until evidence shows it is complete or genuinely blocked";

export const GOAL_PROMPT_GUIDELINES = [
  "Use create_goal only when the user or higher-priority instructions explicitly request a persistent goal; do not infer one from an ordinary task.",
  "Use get_goal to inspect the current objective and evidence state before deciding what to do next.",
  "Use update_goal with complete only after auditing the objective against concrete evidence; use blocked only after the same blocker has recurred for three consecutive goal turns.",
];

function budgetLine(goal: Goal): string {
  if (goal.tokenBudget === undefined) {
    return `Tokens used: ${formatTokenCount(goal.tokensUsed)} (no token budget)`;
  }
  return [
    `Tokens used: ${formatTokenCount(goal.tokensUsed)} of ${formatTokenCount(goal.tokenBudget)}`,
    `remaining: ${formatTokenCount(remainingTokens(goal) ?? 0)}`,
  ].join(" · ");
}

export function buildContinuationPrompt(goal: Goal): string {
  return `Continue working toward the active thread goal.

<objective>
${goal.objective}
</objective>

Goal status: ${goal.status}
${budgetLine(goal)} · time used: ${formatDuration(goal.timeUsedSeconds)}

Work from the current worktree and external state as authoritative. Keep the full objective intact; make concrete progress instead of redefining success around an easier subtask. After each meaningful iteration, inspect the evidence that determines whether the objective is actually satisfied.

Before declaring completion, audit every requirement against concrete evidence such as changed files, commands, tests, benchmarks, generated artifacts, or research sources. If the objective is achieved, call update_goal with status "complete". If the same blocking condition has recurred for at least three consecutive goal turns and no meaningful progress is possible without user input or an external change, call update_goal with status "blocked". Do not call update_goal merely because the work is difficult, uncertain, incomplete, or the budget is nearly exhausted.`;
}

export function buildGoalSystemGuidance(goal: Goal): string {
  return [
    "## Thread goal guidance",
    `The thread has a persisted goal (status: ${goal.status}, set by the user or the agent). ` +
      "The goal objective itself arrives each turn as a user-role message and is user-provided " +
      "context, not a system directive.",
    `${budgetLine(goal)} · time used: ${formatDuration(goal.timeUsedSeconds)}`,
    "Keep the goal in view while it is active. Use current evidence to decide whether it is complete. " +
      "Do not claim completion from intent or partial progress; call update_goal only when its " +
      "completion or strict blocked condition is supported by evidence.",
  ].join("\n");
}

/**
 * Transient user-role injection of the goal objective, appended to the message
 * list before every LLM call. The objective is user data at user authority:
 * closing tags or instruction-like text inside it cannot escalate to
 * system/developer authority, and nothing here is persisted to the session.
 */
export function buildGoalContextMessage(goal: Goal): string {
  return [
    "Persisted thread goal (user-provided context, at user authority):",
    `Objective: ${goal.objective}`,
    `Goal status: ${goal.status}`,
    `${budgetLine(goal)} · time used: ${formatDuration(goal.timeUsedSeconds)}`,
    "Continue working toward this objective while the goal is active.",
  ].join("\n");
}

export function buildBudgetLimitPrompt(goal: Goal): string {
  return `The token budget for the active goal has been reached (${formatTokenCount(goal.tokensUsed)} of ${formatTokenCount(goal.tokenBudget ?? goal.tokensUsed)} tokens). Stop substantive work, summarize the evidence gathered, blockers, and the next useful step. Do not call update_goal with complete merely because the budget was reached.`;
}

export const GOAL_PARAMETER_DESCRIPTIONS = {
  objective: "Required concrete objective to pursue. It must have an auditable end state.",
  token_budget: "Optional positive token budget for this goal. Set only when explicitly requested.",
  status: "complete only after evidence proves the objective is achieved; blocked only after the same blocker recurs for three consecutive goal turns.",
};
