/**
 * Model-facing text for the devin extension, kept separate from runtime
 * logic per repo convention.
 */

/**
 * Display-only wrapper tool that replays recorded devin tool results.
 *
 * Intentionally invisible to models: empty description, no parameter
 * descriptions — it must not occupy the system prompt or the API tools
 * payload. The provider synthesizes its toolCalls from ACP tool_call
 * updates; execute() only replays stored output.
 */
export const WRAPPER_TOOL_NAME = "devin";
export const WRAPPER_TOOL_DESCRIPTION = "";

/** Replay text when a devin tool call ended without a terminal update. */
export function devinIncompleteToolError(title: string): string {
  return `devin did not report a result for "${title}". The tool may still have run server-side; verify before retrying.`;
}

/** Replay note when a turn ends while a devin background shell is still open. */
export function devinBackgroundToolNote(shellId: string | undefined): string {
  return `devin detached this command to background shell ${shellId ?? "?"}; it may still be running server-side.`;
}

/** User-confirmed request from the tasks picker. */
export function devinKillShellPrompt(shellId: string): string {
  return `Kill background shell ${shellId} and confirm it stopped.`;
}

/** `devin acp` has no system-role input; relay Pi instructions as a labeled resource. */
export function piSystemInstructionsPrompt(instructions: string): string {
  return [
    "## Current Pi instructions",
    "The following is Pi's current instruction snapshot, relayed as attached context because this ACP channel has no system-prompt role. It replaces any earlier Pi instruction snapshot in this session; your native system instructions still take precedence.",
    "These instructions do not register tools. Use only the tools actually available to you, while respecting applicable project and user guidance.",
    instructions ||
      "Pi's instruction snapshot is now empty. Stop applying earlier relayed Pi instructions.",
    "## End of Pi instructions",
  ].join("\n\n");
}

/** Rehydrate a fresh devin session from the active branch of a pi session. */
export function restoredPiContextPrompt(transcript: string): string {
  return [
    "## Restored pi conversation context",
    "",
    "This session continues the active pi history, including any work done with another provider, session resume, fork, or branch move. Treat the transcript below as prior conversation context, then answer the current user request that follows it.",
    "",
    transcript,
    "",
    "## Current user request",
  ].join("\n");
}

export const HISTORY_RESOURCE_URI = "pi://session/history";
export const INSTRUCTIONS_RESOURCE_URI = "pi://session/instructions";
