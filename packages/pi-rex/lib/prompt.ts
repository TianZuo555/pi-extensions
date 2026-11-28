// Model-facing text for pi-rex. Keep every prompt string here, apart from the
// runtime that injects it.

/** System prompt section name. */
export const REX_SECTION = "rex";

/**
 * Replaces the Rex session-naming paragraph when automatic naming is on.
 * The extension does the naming, so the agent must not compete with it.
 */
export const AUTO_NAME_INSTRUCTION = `The session and tab names are set automatically. Do not run \`rex session rename\` or \`rex window rename\` unless the user asks.`;

/** Description of the `rex_worktree_move` tool. */
export const WORKTREE_MOVE_DESCRIPTION = `Move this pi agent into a git worktree, with the conversation. The tool opens a Rex session for the worktree, moves this Rex tab into it, and switches pi to the worktree when the current turn ends. After the switch, the tools, the system prompt, and the context files are for the worktree.`;

/** Rules for the `rex_worktree_move` tool. */
export const WORKTREE_MOVE_GUIDELINES = [
  "Call rex_worktree_move immediately after you create a git worktree for a task, instead of `rex new` and `rex window move`.",
  "After rex_worktree_move succeeds, end your turn with one short status line. Do not run more commands in the old folder. The next turn starts in the worktree.",
];

/** Description of the `path` parameter. */
export const WORKTREE_PATH_DESCRIPTION =
  "Path of the worktree folder. A leading ~ is the home folder. The folder must exist.";

/** Tool result after the tab moved. */
export function moveResult(
  target: string,
  moved: { sessionLabel: string; followed: readonly string[]; refused: readonly string[] },
  oldCwd: string,
): string {
  const lines = [`Moved this tab to the Rex session "${moved.sessionLabel}".`];
  if (moved.followed.length > 0) {
    lines.push(`These Rex apps now show the moved tab: ${moved.followed.join(", ")}.`);
  }
  if (moved.refused.length > 0) {
    lines.push(
      `These Rex apps still show the old session: ${moved.refused.join("; ")}. Tell the user to select the session "${moved.sessionLabel}" in Rex. To make Rex follow the tab next time, the user turns on Remote Control in Rex Settings > General.`,
    );
  }
  lines.push(
    `Pi switches to ${target} when this turn ends. End your turn now with one short status line. Do not run more commands in ${oldCwd}.`,
  );
  return lines.join("\n");
}

/** First user message in the worktree session. */
export function continuePrompt(target: string, session: string): string {
  return `Pi now works in the worktree ${target}, in the Rex session "${session}". Continue the task from where you stopped. Do all work in this worktree.`;
}

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
