/** Model-facing strings and bounded output formatting for the bash override. */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatExit, type TerminalSnapshot } from "./domain.ts";
import {
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNNING,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  MAX_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
} from "./manager.ts";

/** Output returned by the initial bash call. */
export const BASH_STDOUT_MAX = 16 * 1024;
export const BASH_STDERR_MAX = 8 * 1024;
/** Partial updates during the initial foreground wait. */
const PROGRESS_STDOUT_MAX = 8 * 1024;
const PROGRESS_STDERR_MAX = 4 * 1024;
/** Completion follow-up output. Keep this concise; /ps has the detailed view. */
export const RESULT_STDOUT_MAX = 8 * 1024;
export const RESULT_STDERR_MAX = 4 * 1024;
const BASH_STDOUT_MAX_LINES = 400;
const BASH_STDERR_MAX_LINES = 200;
const PROGRESS_STDOUT_MAX_LINES = 100;
const PROGRESS_STDERR_MAX_LINES = 50;
const RESULT_STDOUT_MAX_LINES = 40;
const RESULT_STDERR_MAX_LINES = 20;

export const BASH_TOOL_DESCRIPTION =
  "Execute a Bash command with no interactive stdin through one managed execution path. " +
  `Waits up to ${DEFAULT_YIELD_TIME_MS} ms by default: commands that finish return their final output; commands still running continue as a session-scoped background terminal and return an id. ` +
  "A yielded command notifies you automatically exactly once when it exits; do not poll it. The user can inspect or stop it in /ps. " +
  `Output is bounded head+tail with full private spill logs. Max ${MAX_RUNNING} commands can remain running at once.`;

export const BASH_PROMPT_SNIPPET =
  "Execute Bash commands; long-running commands automatically continue in the background and notify on exit";

export const BASH_PROMPT_GUIDELINES = [
  "Use bash for all shell commands; it automatically yields long-running commands instead of requiring a separate background tool.",
  "bash processes receive no interactive stdin — never use bash for commands requiring prompts or terminal interaction.",
  "When bash returns a background terminal id, keep working instead of polling; its final result arrives automatically, and the user manages it with /ps.",
  "Inspect PI_* environment variables for current model and session details.",
];

export const BASH_PARAMETER_DESCRIPTIONS = {
  command:
    "Bash command to execute. It receives no interactive stdin; commands that prompt for input will see EOF.",
  title:
    "Optional short name shown in /ps. Defaults to a bounded one-line form of the command.",
  workingDir: "Working directory relative to the current directory, or an absolute path (default: current working directory)",
  yieldTimeMs:
    `How long to wait for completion before returning a background terminal id (default ${DEFAULT_YIELD_TIME_MS} ms; values are clamped to ${MIN_YIELD_TIME_MS}-${MAX_YIELD_TIME_MS} ms).`,
  timeout:
    `Optional hard total runtime timeout in seconds (no default, maximum ${MAX_RUNTIME_TIMEOUT_SECONDS}). Unlike yield_time_ms, this terminates the process tree.`,
};

/** One metadata line: `bt-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path)`. */
export function describeTerminal(snap: TerminalSnapshot) {
  const details = [
    `pid ${snap.pid ?? "?"}`,
    formatElapsed(snap),
    snap.status === "running" ? "exit -" : formatExit(snap),
    snap.cwd,
    `stdout ${formatSize(snap.stdout.totalBytes)}, stderr ${formatSize(snap.stderr.totalBytes)}`,
  ];
  if (snap.timeoutMs !== undefined) {
    details.push(`timeout ${snap.timeoutMs / 1000}s`);
  }
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

/**
 * Bounded model-facing view that preserves both startup context and recent
 * output. The retained in-memory middle may already be omitted; spillPath is
 * the authoritative complete stream whenever spilling succeeded.
 */
function outputSection(
  label: string,
  view: TerminalSnapshot["stdout"],
  maxBytes: number,
  maxLines: number,
) {
  if (view.totalBytes === 0) return `${label}: (empty)`;

  const byteLimit = Math.min(maxBytes, DEFAULT_MAX_BYTES);
  const lineLimit = Math.min(maxLines, DEFAULT_MAX_LINES);
  if (view.truncatedBytes === 0) {
    const completeCheck = truncateTail(view.text, {
      maxBytes: byteLimit,
      maxLines: lineLimit,
    });
    if (!completeCheck.truncated) {
      return `${label}:\n${completeCheck.content}`;
    }
  }

  const headBytes = Math.max(1, Math.floor(byteLimit / 4));
  const tailBytes = Math.max(1, byteLimit - headBytes);
  const headLines = Math.max(1, Math.floor(lineLimit / 4));
  const tailLines = Math.max(1, lineLimit - headLines);
  const start = truncateHead(view.head, {
    maxBytes: headBytes,
    maxLines: headLines,
  });
  const endSource = view.tail || view.head;
  const end = truncateTail(endSource, {
    maxBytes: tailBytes,
    maxLines: tailLines,
  });
  const shownBytes = start.outputBytes + end.outputBytes;
  const omittedBytes = Math.max(0, view.totalBytes - shownBytes);
  const parts = [start.content];
  if (omittedBytes > 0) {
    parts.push(`... ${formatSize(omittedBytes)} omitted ...`);
  }
  if (end.content && end.content !== start.content) parts.push(end.content);

  const where = view.spillPath
    ? `Full log: ${view.spillPath}`
    : "Retained output is available in the /ps viewer";
  return `${label}:\n${parts.filter(Boolean).join("\n")}\n[${label} bounded head+tail: showing ${formatSize(shownBytes)} of ${formatSize(view.totalBytes)}. ${where}]`;
}

function appendOutput(
  text: string,
  snap: TerminalSnapshot,
  stdoutBytes: number,
  stdoutLines: number,
  stderrBytes: number,
  stderrLines: number,
) {
  text += `\n\n${outputSection("stdout", snap.stdout, stdoutBytes, stdoutLines)}`;
  if (snap.stderr.totalBytes > 0) {
    text += `\n\n${outputSection("stderr", snap.stderr, stderrBytes, stderrLines)}`;
  }
  return text;
}

/** Streaming tool-row update while bash is still in its initial wait. */
export function buildBashProgress(snap: TerminalSnapshot) {
  return appendOutput(
    `Running as terminal ${snap.id} "${snap.title}" (pid ${snap.pid ?? "?"}, ${formatElapsed(snap)}). It will automatically yield if it outlives the initial wait.`,
    snap,
    PROGRESS_STDOUT_MAX,
    PROGRESS_STDOUT_MAX_LINES,
    PROGRESS_STDERR_MAX,
    PROGRESS_STDERR_MAX_LINES,
  );
}

/** Result of the initial bash wait, whether final or yielded. */
export function buildBashResult(snap: TerminalSnapshot) {
  let text =
    snap.status === "running"
      ? `Command is still running as background terminal ${snap.id} "${snap.title}" (pid ${snap.pid ?? "?"}). It has no interactive stdin; do not poll it. The final result will arrive automatically, and the user can inspect or stop it with /ps.`
      : snap.status === "timed_out"
        ? `Command timed out after ${formatElapsed(snap)}.`
        : `Command finished in ${formatElapsed(snap)} (${formatExit(snap)}).`;
  text += `\n${describeTerminal(snap)}`;
  if (snap.errorText) text += `\nError: ${snap.errorText}`;
  return appendOutput(
    text,
    snap,
    BASH_STDOUT_MAX,
    BASH_STDOUT_MAX_LINES,
    BASH_STDERR_MAX,
    BASH_STDERR_MAX_LINES,
  );
}

/** Async completion follow-up injected only after bash yielded. */
export function buildTerminalResultMessage(snap: TerminalSnapshot) {
  const how =
    snap.status === "killed"
      ? "was killed"
      : snap.status === "timed_out"
        ? "timed out"
        : `exited (${formatExit(snap)})`;
  let text = `Background terminal ${snap.id} "${snap.title}" ${how} after ${formatElapsed(snap)}.`;
  if (snap.errorText) text += `\nError: ${snap.errorText}`;
  return appendOutput(
    text,
    snap,
    RESULT_STDOUT_MAX,
    RESULT_STDOUT_MAX_LINES,
    RESULT_STDERR_MAX,
    RESULT_STDERR_MAX_LINES,
  );
}
