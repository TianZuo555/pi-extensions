import { CONTEXT_MAX_LENGTH, TASK_MAX_LENGTH, truncateText, type ProfileDefinition } from "./domain.ts";
import { buildHandoffInstructions } from "./report-file.ts";

export const SUBAGENT_TOOL_DESCRIPTION = `Delegate a bounded task to a subagent in an isolated Pi RPC child process.

Built-in profiles: scout, planner, reviewer, oracle (read-only), worker (git worktree + writes).

Parallel work: call this tool multiple times in one turn (sibling calls run concurrently).

Capabilities (model, tools, workspace) come from the profile — not from tool arguments.

Use mode=background to continue without blocking; completion arrives as a follow-up notification.

Children finish with report_result when possible. Worker runs keep a durable branch and private patch artifact under ~/.pi/agent/subagents/runs/<runId>/; apply with subagent_apply after explicit confirmation.`;

export const SUBAGENT_STATUS_TOOL_DESCRIPTION = "Check a background subagent run by run_id.";

export const SUBAGENT_CANCEL_TOOL_DESCRIPTION = "Cancel a running subagent by run_id.";

export const SUBAGENT_APPLY_TOOL_DESCRIPTION =
  "Apply the verified patch artifact from a completed worker run to the current checkout. Requires interactive confirmation; never runs automatically.";

export const SUBAGENT_PARAMETER_DESCRIPTIONS = {
  profile: "Profile short name or qualified id (e.g. scout, builtin/reviewer, project/my-agent).",
  task: "Objective plus expected deliverable.",
  context: "Facts the child cannot cheaply rediscover — not parent transcript history.",
  mode: "foreground (default) blocks until complete; background returns a run id immediately.",
  runId: "Subagent run id (e.g. sa-a13f9c2b).",
  applyRunId: "Completed worker run id with a patch artifact.",
  cancelRunId: "Subagent run id to cancel.",
  cancelReason: "Optional reason for cancellation.",
};

export const REPORT_RESULT_TOOL_DESCRIPTION =
  "Return the final structured run report. Call this alone as your last action when the task is finished, blocked, or failed.";

export const REPORT_RESULT_PROMPT_SNIPPET = "Emit the final structured run report as report_result";

export const REPORT_RESULT_PROMPT_GUIDELINES = [
  "Call report_result alone as your final action when you are done, blocked, or failed.",
  "After calling report_result, do not emit another assistant response in the same turn.",
];

export function buildTaskPrompt(profile: string, task: string, context?: string): string {
  const parts: string[] = [
    `# Subagent task (${profile})`,
    "",
    truncateText(task.trim(), TASK_MAX_LENGTH),
  ];
  if (context?.trim()) {
    parts.push("", "## Context from parent", truncateText(context.trim(), CONTEXT_MAX_LENGTH));
  }
  parts.push(
    "",
    "Finish by calling report_result alone with your final structured report.",
    "If report_result is unavailable, respond with your final answer as assistant text.",
  );
  return parts.join("\n");
}

export function buildInteractivePrompt(
  profile: ProfileDefinition,
  task: string,
  context: string | undefined,
  reportPath: string,
): string {
  const parts: string[] = [];
  if (profile.systemPrompt.trim()) {
    parts.push(profile.systemPrompt.trim());
  }
  parts.push(
    `# Subagent task (${profile.name})`,
    "",
    truncateText(task.trim(), TASK_MAX_LENGTH),
  );
  if (context?.trim()) {
    parts.push("", "## Context from parent", truncateText(context.trim(), CONTEXT_MAX_LENGTH));
  }
  parts.push("", buildHandoffInstructions(reportPath));
  return parts.join("\n");
}
