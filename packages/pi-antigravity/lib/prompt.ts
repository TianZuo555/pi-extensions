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
export const BRIDGE_PENDING_TOOL_MESSAGE =
  "Started and still running at tool handoff. Unfinished commands may be cancelled when " +
  "the agy turn ends. Refresh /agy-tasks to check current process status and partial output.";

/** Replay diagnostics must not promise that an unobserved task survived or stopped. */
export function agyIncompleteToolError(tool: string, resultError?: string): string {
  if (tool === "schedule") {
    // agy runs schedule timers inside the agent process, so they own no OS
    // process and never appear as live in /agy-tasks — do not send the model
    // there. The timer log records the intended firing time instead.
    return (
      "agy stopped reporting before the scheduled wait completed. The timer's final state " +
      "is unknown and it may still fire. Do not reschedule it blindly: confirm the work it " +
      "was waiting on instead, using pi's own tools."
    );
  }
  if (
    tool === "run_command" &&
    (!resultError || /timeout waiting for response/i.test(resultError))
  ) {
    return (
      "agy did not report this command completing. It may have become a background task " +
      '(headless agy can report "timeout waiting for response"). Its current process state ' +
      "is unknown: persistent-driver cleanup cancels unfinished work with SIGTERM, then " +
      "force-kills surviving processes after a short grace period, while " +
      "one-shot mode may leave it running. Check /agy-tasks and verify whether the command " +
      "is still running before retrying; use pi's own bash for long-lived commands."
    );
  }
  return "agy tool call did not complete.";
}

export function omittedImagesPrompt(images: number): string {
  return `(${images} image(s) omitted — the agy print interface is text-only)`;
}

/**
 * Drop Pi's own tool inventory from an instruction snapshot.
 *
 * The snapshot is written for a model holding Pi's tools, but agy runs its own
 * native tool set (`run_command`, `view_file`, `replace_file_content`, …) and
 * reaches Pi only through bridged MCP tools — `selectBridgedTools` never
 * exposes a Pi builtin. Relaying the builtin inventory therefore spends
 * prompt tokens describing tools agy cannot call.
 *
 * Only Pi's own validated top-level block is removed. "Available tools:" is
 * ordinary prose that project instructions may also use (a deployment section
 * listing terraform/kubectl, say), and deleting user guidance would be far
 * worse than relaying a few redundant lines. Three conditions must all hold:
 * the block appears before any project-context section, every line in it is a
 * `- name: description` bullet, and it ends with Pi's own trailing caveat.
 */
export function stripPiToolInventory(instructions: string): string {
  const lines = instructions.split("\n");
  const start = lines.findIndex((line) => /^Available tools:\s*$/.test(line));
  if (start < 0) return instructions;

  // Project instructions are relayed verbatim; never edit inside them.
  const projectStart = lines.findIndex((line) =>
    /^\s*<(project_context|project_instructions)\b/.test(line),
  );
  if (projectStart >= 0 && start > projectStart) return instructions;

  let end = start + 1;
  let bullets = 0;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (line.trim() === "") continue;
    // Pi renders each builtin as "- name: description".
    if (/^-\s+\w[\w.[\]]*:\s+\S/.test(line)) {
      bullets += 1;
      continue;
    }
    break;
  }
  // The block must be closed by Pi's own caveat, and must have listed tools.
  if (bullets === 0 || !/^In addition to the tools above/.test(lines[end] ?? "")) {
    return instructions;
  }

  const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** agy's CLI has no system-role input; relay Pi instructions explicitly as prompt text. */
export function piSystemInstructionsPrompt(instructions: string): string {
  const relayed = stripPiToolInventory(instructions);
  return [
    "## Current Pi instructions",
    "The following is Pi's current instruction snapshot, relayed as user-prompt text because this CLI has no system-prompt channel. It replaces any earlier Pi instruction snapshot in this conversation; native system instructions still take precedence.",
    "Pi's own tool inventory is omitted because you cannot call it, and any tool guidance below describes Pi's tools rather than yours. Use only the actual agy or Pi bridge tool schemas available to you, while respecting applicable project and user guidance.",
    relayed ||
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
