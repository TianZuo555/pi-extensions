// Model-facing text for pi-rex. Keep every prompt string here, apart from the
// runtime that injects it.

/** System prompt section name. */
export const REX_SECTION = "rex";

/**
 * Replaces the Rex session-naming paragraph when automatic naming is on.
 * The extension does the naming, so the agent must not compete with it.
 */
export const AUTO_NAME_INSTRUCTION = `The session and tab names are set automatically. Do not run \`rex session rename\` or \`rex window rename\` unless the user asks.`;

/**
 * Asks the naming model for one tab label. The task text is the user's first
 * prompt, trimmed by the caller.
 */
export function namingPrompt(task: string): string {
  return `Name the coding task below for a terminal label.

Rules:
- Reply with the label only. No quotes, no punctuation, no explanation.
- Use 2 to 4 English words in lowercase, joined by hyphens.
- Use ASCII letters and digits only.
- Name the task or project, not the tool or the agent.

Task:
<task>
${task}
</task>`;
}
