import { CONTEXT_MAX_LENGTH, TASK_MAX_LENGTH, truncateText } from "./domain.ts";

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
    "Respond with your final answer as assistant text when done. Do not delegate to other agents.",
  );
  return parts.join("\n");
}
