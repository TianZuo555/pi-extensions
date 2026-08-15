/** Model-facing strings and bounded output formatting for the bash override. */

import { existsSync } from "node:fs";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatExit, type TerminalSnapshot } from "./domain.ts";
import {
  EXPLORATION_LIMIT,
  EXPLORATION_WARNING_AT,
} from "./exploration-budget.ts";
import {
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNNING,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  MAX_TERMINAL_LOG_READ_BYTES,
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

// Scope: the CALL CONTRACT only — what the model cannot infer from a plain
// bash prior (fresh shell, no stdin, yield-to-id return type) plus the hard
// caps. Behavioural advice and the exploration budget live in
// BASH_PROMPT_GUIDELINES, which pi always injects into the system prompt
// alongside this description whenever the tool is active, so restating them
// here only buys tokens. Two facts are deliberately kept in BOTH places:
// yielding and shell-freshness, whose violations are silent or irreversible
// (a re-run command repeats its side effects; a lost `cd` silently runs in the
// wrong directory and still reports success).
export const BASH_TOOL_DESCRIPTION =
  "Run a Bash command in a fresh, non-persistent shell with no interactive stdin — use working_dir instead of a standalone cd. " +
  `Waits up to ${DEFAULT_YIELD_TIME_MS / 1000} s (yield_time_ms): if the command finishes you get its final output; otherwise it keeps running as a background terminal, returns an id, and notifies you exactly once when it exits — do not poll it. ` +
  "yield_time_ms only changes that wait; timeout kills the command. " +
  `Output is bounded head+tail. Max ${MAX_RUNNING} background commands at once.`;

export const BASH_PROMPT_SNIPPET =
  "Execute Bash commands; long-running commands automatically continue in the background and notify on exit";

// Kept deliberately short: these bullets are merged flat into the system prompt
// alongside every other tool's guidelines, so each one has to earn its line by
// describing behaviour that differs from a plain bash tool.
export const BASH_PROMPT_GUIDELINES = [
  "bash auto-yields long-running commands as background terminals instead of needing a separate tool; when it returns a terminal id, keep working — the final result arrives automatically and the user manages it with /ps.",
  "Every bash call starts a fresh, non-persistent shell in ctx.cwd. A standalone cd, export, or variable assignment does not affect later calls; use working_dir or combine setup and execution in one command.",
  "bash has no interactive stdin — never use it for commands that prompt or need terminal interaction.",
  `bash warns after ${EXPLORATION_WARNING_AT} and blocks after ${EXPLORATION_LIMIT} read-only shell inspection calls in one agent run; prefer dedicated read, grep, and find tools for file inspection instead of cat, sed, rg, or grep -r, and when warned, stop exploring and synthesize instead of recursively searching.`,
];

export const BASH_PARAMETER_DESCRIPTIONS = {
  command:
    "Bash command to execute in one fresh, non-persistent shell. It receives no interactive stdin; commands that prompt for input will see EOF.",
  title:
    "Optional short name shown in /ps. Defaults to a bounded one-line form of the command.",
  workingDir:
    "Directory for this invocation, relative to the session cwd or absolute. Each bash call uses a fresh shell, so use this instead of a standalone cd when later calls need another directory (default: session cwd)",
  yieldTimeMs:
    `How long to wait for completion before returning a background terminal id (default ${DEFAULT_YIELD_TIME_MS} ms; values are clamped to ${MIN_YIELD_TIME_MS}-${MAX_YIELD_TIME_MS} ms).`,
  timeout:
    `Optional hard total runtime timeout in seconds (no default, maximum ${MAX_RUNTIME_TIMEOUT_SECONDS}). Unlike yield_time_ms, this terminates the process tree.`,
};

export const TERMINAL_LOG_READ_TOOL_DESCRIPTION =
  "Read one bounded page from a background terminal's archived stdout or stderr using the opaque ref emitted by bash. This is read-only and never polls, kills, or reports status. Maximum 64 KiB per page; use next_offset to page through a settled archive.";

export const TERMINAL_LOG_READ_PROMPT_SNIPPET =
  "Read one bounded page of a background terminal's archived output";

export const TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS = {
  ref: "Opaque archive ref from bash, for example bt-3:stdout.",
  offset: "Byte offset to begin reading (default 0).",
  limit: `Maximum bytes to return (default ${MAX_TERMINAL_LOG_READ_BYTES}).`,
};

const LEADING_SETUP =
  /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^;\s]+)\s*;\s*)+/;
const LEADING_CD =
  /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

function truncateTitle(text: string, maxLength = 80) {
  if (text.length <= maxLength) return text;
  const marker = " … ";
  const available = maxLength - marker.length;
  const head = Math.floor(available * 0.4);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

/** Derive a useful one-line label without letting a long setup prefix hide the
 * command that actually does the work. */
export function deriveCommandTitle(command: string, explicitTitle?: string) {
  const normalized = (explicitTitle ?? command).replace(/\s+/g, " ").trim();
  if (explicitTitle !== undefined) {
    return truncateTitle(normalized || "command");
  }
  const withoutSetup = normalized
    .replace(LEADING_SETUP, "")
    .replace(LEADING_CD, "")
    .trim();
  return truncateTitle(withoutSetup || normalized || "command");
}

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
 * output. The retained in-memory middle may already be omitted; an existing
 * spill file can be referred to through an opaque session-scoped archive id.
 */
/**
 * Return a model-safe, session-scoped reference without exposing the private
 * spill path. The existence check matters for deferred follow-ups: a settled
 * snapshot can outlive its entry in the manager's bounded history.
 */
function archiveReference(
  terminalId: string,
  stream: "stdout" | "stderr",
  view: TerminalSnapshot["stdout"],
) {
  if (!view.spillPath) return undefined;
  try {
    return existsSync(view.spillPath) ? `${terminalId}:${stream}` : undefined;
  } catch {
    return undefined;
  }
}

function outputSection(
  label: string,
  terminalId: string,
  stream: "stdout" | "stderr",
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
  const omittedStart = Math.min(view.totalBytes, start.outputBytes);
  const tailSourceStart =
    view.totalBytes - Buffer.byteLength(endSource, "utf8");
  let tailOffset = endSource.length - end.content.length;
  while (
    tailOffset > 0 &&
    !endSource.startsWith(end.content, tailOffset)
  ) {
    tailOffset--;
  }
  const omittedEnd = end.content
    ? tailSourceStart +
      Buffer.byteLength(endSource.slice(0, tailOffset), "utf8")
    : view.totalBytes;
  const parts = [start.content];
  if (omittedBytes > 0) {
    parts.push(`... ${formatSize(omittedBytes)} omitted ...`);
  }
  if (end.content) parts.push(end.content);

  const archiveRef = archiveReference(terminalId, stream, view);
  const omittedRange = omittedBytes > 0
    ? `${omittedStart}-${omittedEnd - 1}`
    : "none";
  const archive = archiveRef
    ? `archive ref ${archiveRef}; complete: ${view.archiveComplete === true ? "yes" : "no"}; omitted bytes ${omittedRange}; use terminal_log_read with this ref after settlement to recover it`
    : "complete archive unavailable to the model";
  return `${label}:\n${parts.filter(Boolean).join("\n")}\n[${label} bounded head+tail: showing ${formatSize(shownBytes)} of ${formatSize(view.totalBytes)}. ${archive}]`;
}

function appendOutput(
  text: string,
  snap: TerminalSnapshot,
  stdoutBytes: number,
  stdoutLines: number,
  stderrBytes: number,
  stderrLines: number,
) {
  text += `\n\n${outputSection("stdout", snap.id, "stdout", snap.stdout, stdoutBytes, stdoutLines)}`;
  if (snap.stderr.totalBytes > 0) {
    text += `\n\n${outputSection("stderr", snap.id, "stderr", snap.stderr, stderrBytes, stderrLines)}`;
  }
  return text;
}

/** Streaming tool-row update while bash is still in its initial wait. */
export function buildBashProgress(snap: TerminalSnapshot) {
  return appendOutput(
    `Command is still running during the initial wait (pid ${snap.pid ?? "?"}, ${formatElapsed(snap)}). It will become a background terminal only if it outlives that wait.`,
    snap,
    PROGRESS_STDOUT_MAX,
    PROGRESS_STDOUT_MAX_LINES,
    PROGRESS_STDERR_MAX,
    PROGRESS_STDERR_MAX_LINES,
  );
}

/** Result of the initial bash wait, whether final or yielded. */
export function buildBashResult(snap: TerminalSnapshot) {
  // Always name the directory. A command sent to the wrong one usually still
  // exits 0, and the common mistake is assuming a cwd that was never set, so
  // the model must see where it actually ran even when that is the session cwd.
  // Running terminals carry it via describeTerminal() instead.
  let text =
    snap.status === "running"
      ? `Command is still running as background terminal ${snap.id} "${snap.title}" (pid ${snap.pid ?? "?"}). It has no interactive stdin; do not poll it. The final result will arrive automatically, and the user can inspect or stop it with /ps.\n${describeTerminal(snap)}`
      : snap.status === "timed_out"
        ? `Command timed out after ${formatElapsed(snap)} in ${snap.cwd}.`
        : `Command finished in ${formatElapsed(snap)} (${formatExit(snap)}) in ${snap.cwd}.`;
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
  // Failures need the initial diagnostic budget: the useful error often sits
  // outside the compact success follow-up window. A killed process remains
  // intentionally concise because /ps is the user-facing inspection path.
  const diagnostic = snap.status === "failed" || snap.status === "timed_out";
  return appendOutput(
    text,
    snap,
    diagnostic ? BASH_STDOUT_MAX : RESULT_STDOUT_MAX,
    diagnostic ? BASH_STDOUT_MAX_LINES : RESULT_STDOUT_MAX_LINES,
    diagnostic ? BASH_STDERR_MAX : RESULT_STDERR_MAX,
    diagnostic ? BASH_STDERR_MAX_LINES : RESULT_STDERR_MAX_LINES,
  );
}
