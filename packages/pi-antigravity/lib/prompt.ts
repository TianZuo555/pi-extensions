/**
 * Model-facing text for the antigravity extension, kept separate from
 * runtime logic per repo convention.
 */

/**
 * Display-only wrapper tool that replays recorded agy tool results.
 *
 * Intentionally invisible to models: empty description, no parameter
 * descriptions, no promptSnippet, no promptGuidelines — it must not occupy
 * the system prompt or the API tools payload. No model should ever call it:
 * the provider synthesizes its toolCalls from recorded agy activity, and
 * execute() only replays stored output. See README "Why the antigravity
 * tool exists".
 */
export const WRAPPER_TOOL_NAME = "antigravity";
export const WRAPPER_TOOL_DESCRIPTION = "";

export function omittedImagesPrompt(images: number): string {
  return `(${images} image(s) omitted — the agy print interface is text-only)`;
}

/** agy's CLI has no system-role input; relay Pi instructions explicitly as prompt text. */
export function piSystemInstructionsPrompt(instructions: string): string {
  return [
    "## Current Pi instructions",
    "The following is Pi's current instruction snapshot, relayed as user-prompt text because this CLI has no system-prompt channel. It replaces any earlier Pi instruction snapshot in this conversation; native system instructions still take precedence.",
    "These instructions do not register tools. Use only the actual agy or Pi bridge tool schemas available to you, while respecting applicable project and user guidance.",
    instructions ||
      "Pi's instruction snapshot is now empty. Stop applying earlier relayed Pi instructions.",
    "## End of Pi instructions",
  ].join("\n\n");
}

/** Rehydrate a fresh agy conversation from the active branch of a pi session. */
export function restoredPiContextPrompt(transcript: string): string {
  return [
    "## Restored pi conversation context",
    "",
    "This fresh agy conversation is continuing the active pi history, including any work with another provider, session resume, fork, or branch move. Treat the transcript below as prior conversation context, then answer the current user request that follows it.",
    "",
    transcript,
    "",
    "## Current user request",
  ].join("\n");
}

/**
 * Prompt for resuming a conversation whose turn stalled: the stream died
 * mid-turn, the client killed the process, and this follow-up runs against
 * the same `--conversation` id where agy still holds the full history.
 */
export function stallContinuationPrompt(): string {
  return (
    "The stream was interrupted before your previous turn completed. " +
    "Continue the task you were working on from where it stopped. " +
    "Tool calls that already reported a result are done — do not repeat them; " +
    "re-run only work whose result you never received."
  );
}
