import { CONTEXT_MAX_LENGTH, TASK_MAX_LENGTH, truncateText, type ProfileDefinition } from "./domain.ts";
import { buildHandoffInstructions } from "./report-file.ts";

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
