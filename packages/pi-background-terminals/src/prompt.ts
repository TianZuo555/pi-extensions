/** Model-facing bash text and bounded result formatting. */

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
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNNING,
  MAX_SLOT_WAIT_MS,
  MAX_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  MAX_TRACKED,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  MAX_SPILL_BYTES_PER_STREAM,
  PLAIN_SLEEP_GUARD_MIN_SECONDS,
  DEFAULT_TERMINAL_WAIT_SECONDS,
  MAX_TERMINAL_WAIT_SECONDS,
  DEFAULT_TERMINAL_LOG_READ_BYTES,
  MAX_TERMINAL_LOG_READ_BYTES,
  TERMINAL_LOG_READ_RUN_BUDGET,
  TERMINAL_LOG_READ_RUN_CALLS,
} from "./constants.ts";
import type { TerminalLogReadResult } from "./manager.ts";

/** Output returned by the initial bash call. */
export const BASH_STDOUT_MAX = 16 * 1024;
export const BASH_STDERR_MAX = 8 * 1024;
/** Partial updates during the initial foreground wait. */
const PROGRESS_STDOUT_MAX = 8 * 1024;
const PROGRESS_STDERR_MAX = 4 * 1024;
/** Completion follow-up output. Keep this concise; /ps has the detailed view. */
export const RESULT_STDOUT_MAX = 8 * 1024;
export const RESULT_STDERR_MAX = 4 * 1024;
/** Aggregate follow-ups retain every terminal summary without flooding context. */
export const MAX_COMPLETION_BATCH_CONTENT_BYTES = 32 * 1024;
const BASH_STDOUT_MAX_LINES = 400;
const BASH_STDERR_MAX_LINES = 200;
const PROGRESS_STDOUT_MAX_LINES = 100;
const PROGRESS_STDERR_MAX_LINES = 50;
const RESULT_STDOUT_MAX_LINES = 40;
const RESULT_STDERR_MAX_LINES = 20;

// State the non-standard shell contract once. Parameter descriptions only
// explain their own values; runtime errors provide detailed recovery on demand.
export const BASH_TOOL_DESCRIPTION =
  "Run Bash in a fresh shell — no interactive stdin; use working_dir, not a standalone cd. " +
  "Returns output within the initial wait, else a background terminal id; its result arrives at a later tool call. " +
  "For tests, builds, or similar tasks, use a short yield_time_ms if independent work remains. " +
  "Continue that work while the command runs. " +
  "Use terminal_wait when you need the result or have no other work. " +
  "Do not use sleep or repeated log reads to wait for completion. " +
  "`cmd &` dies with its shell — give a server its own call instead. " +
  "Wait on CI or deploys with one blocking command (`gh run watch`, an `until` loop). " +
  `yield_time_ms sets the wait; timeout kills the process tree; at most ${MAX_RUNNING} commands run at once; extra calls queue.`;

export const BASH_PROMPT_SNIPPET = "Run Bash; long commands yield and notify on exit";

export const BASH_PARAMETER_DESCRIPTIONS = {
  command: "Shell script to run.",
  title: "/ps label; default derived from command.",
  workingDir:
    "Working directory for the command, relative to session cwd or absolute; default session cwd.",
  yieldTimeMs: `Initial wait in ms; default ${DEFAULT_YIELD_TIME_MS}, clamped to ${MIN_YIELD_TIME_MS}-${MAX_YIELD_TIME_MS}.`,
  timeout: "Hard runtime limit in seconds; no default.",
};

export const TERMINAL_LOG_READ_TOOL_DESCRIPTION =
  "Read a background terminal log by id (stdout; id:stderr for stderr). Default: whole log if it fits limit, else head+tail with the omitted byte range. " +
  "tail: newest bytes. pattern: case-insensitive regex over the whole log; returns matching lines with byte offsets. offset: exact page; continue with next_offset. Read-only.";
export const TERMINAL_LOG_READ_PROMPT_SNIPPET = "Read or search a terminal log";

export const TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS = {
  ref: "Terminal id, or id:stdout / id:stderr.",
  offset: "Start byte for an exact page or search.",
  limit: `Max bytes returned; default ${DEFAULT_TERMINAL_LOG_READ_BYTES}, max ${MAX_TERMINAL_LOG_READ_BYTES}.`,
  tail: "Return the newest limit bytes.",
  pattern: "Case-insensitive regex; returns matching lines.",
};

/** Field text on `terminal_log_read` `outputSchema` (code-mode scripts, not the model). */
export const TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS = {
  id: "Background terminal id.",
  stream: "stdout or stderr.",
  mode: "page, head_tail, tail, or search.",
  offset: "Start byte of this page.",
  nextOffset: "Byte to pass as offset for the next page.",
  bytesRead: "Bytes in this page.",
  size: "Total archive size in bytes.",
  settled: "True when the command has exited.",
  complete: "True when the archive has the full stream.",
  text: "Page text. Empty when this range has no output.",
  omittedStart: "First omitted byte (head_tail).",
  omittedEnd: "Byte after the omitted range (head_tail).",
  matchCount: "Matching lines from offset to the end of the log, shown or not (search).",
  matches: "Shown matching lines with line-start byte offsets (search).",
  pattern: "Search regex source (search).",
};

export const TERMINAL_WAIT_TOOL_DESCRIPTION =
  "Block until a background terminal exits and return its result (it is not delivered again). Use instead of sleep when nothing else is left to do. " +
  "In codemode, call it instead of sleep to use a yielded command's result in the same script. " +
  "Returns as soon as any listed terminal exits; the timeout or Esc ends the wait without stopping anything.";

/** Field text on `terminal_wait` `outputSchema` (code-mode scripts, not the model). */
export const TERMINAL_WAIT_OUTPUT_FIELD_DESCRIPTIONS = {
  settled: "Terminals that exited, with status and exit code; their results are in text.",
  running: "Ids still running.",
  alreadyReported: "Ids whose results were delivered earlier.",
  text: "The same result text the model sees.",
};

/** Field text on `bash` `outputSchema` (code-mode scripts, not the model). */
export const BASH_OUTPUT_FIELD_DESCRIPTIONS = {
  output:
    "stdout, then stderr. Holds up to 1 MiB; longer output keeps its first and last 512 KiB around an omitted-bytes marker.",
  truncated:
    "True when output omits bytes. Read the full log with terminal_log_read and terminal_id.",
  exit_code:
    "Process exit code. Absent while the command runs, or when a signal or timeout stopped it.",
  wall_time_seconds: "Seconds since the command started.",
  terminal_id: "Terminal id for terminal_wait, terminal_stop, and terminal_log_read.",
  status: "running (moved to the background), done, failed, timed_out, or killed.",
};
export const TERMINAL_WAIT_PROMPT_SNIPPET = "Wait for a background terminal instead of sleeping";
export const TERMINAL_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: "Terminal ids; default all running background terminals.",
  timeout: `Max wait in seconds; default ${DEFAULT_TERMINAL_WAIT_SECONDS}, clamped to 1-${MAX_TERMINAL_WAIT_SECONDS}.`,
};

export const TERMINAL_STOP_TOOL_DESCRIPTION =
  "Stop a running background terminal and its process tree. Returns one status line; no completion message follows. Use it to restart a server or end work no longer needed.";
export const TERMINAL_STOP_PROMPT_SNIPPET = "Stop a background terminal";
export const TERMINAL_STOP_PARAMETER_DESCRIPTIONS = { id: "Terminal id." };

export const TERMINAL_STOP_TEXT = {
  stopped: (snap: TerminalSnapshot) => `Stopped ${describeTerminal(snap)}.`,
  stillTerminating: (id: string) =>
    `Stop requested for ${id}; it is still terminating and will report when it exits.`,
  alreadyExited: (snap: TerminalSnapshot) => `${snap.id} ${terminalHow(snap)}; nothing to stop.`,
};

export const TERMINAL_ERRORS = {
  emptyCommand: "command must not be empty.",
  invalidTimeout: `timeout must be a finite number of seconds in (0, ${MAX_RUNTIME_TIMEOUT_SECONDS}].`,
  invalidDirectory: (cwd: string) => `working_dir is not a directory: ${cwd}`,
  shuttingDown: "Background terminal manager is shutting down.",
  shutDownDuringStart: "Background terminal manager shut down while starting.",
  concurrency: `${MAX_RUNNING} commands are already running and none exited within ${MAX_SLOT_WAIT_MS / 1000}s. Stop one with terminal_stop or wait with terminal_wait, then retry.`,
  spillFlush: "Full-log spill flush timed out; full output may be incomplete",
  spillFailed: (error: string) => `Full-log spill failed: ${error}`,
  spillCapped: (stream: string) =>
    `${stream} full-log spill reached the ${MAX_SPILL_BYTES_PER_STREAM}-byte safety limit`,
  incompleteStdio: "stdio did not close after termination; output may be incomplete",
  runtimeTimeout: (ms: number) => `Command exceeded its ${ms}-ms runtime timeout`,
  unknownTerminal: (id: string, known: readonly string[]) =>
    `Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
  expiredArchive: (ref: string) =>
    `Archive ${ref} expired when the terminal was pruned from the ${MAX_TRACKED}-entry retention cap. ` +
    "It cannot be recovered. Work with the output already available or re-run the command.",
  smallArchive: (ref: string) =>
    `Archive ${ref} is unavailable; its output was small enough that the terminal result already contains all of it.`,
  unknownArchive: (id: string) =>
    `Unknown terminal id "${id}"; no terminal with that id is tracked in this session.`,
  unavailableArchive: (ref: string) => `Archive ${ref} is unavailable.`,
  unreadableArchive: (ref: string) => `Archive ${ref} could not be read.`,
  invalidRef: (ref: string) =>
    `Invalid terminal log ref "${ref}"; pass a terminal id (bt-<id>-<n>), optionally with :stdout or :stderr.`,
  tailConflict: "tail cannot be combined with offset or pattern.",
  invalidPattern: (message: string) => `Invalid pattern: ${message}`,
  waitNothing:
    "No background terminal is running and no result is pending; there is nothing to wait for.",
  waitAborted:
    "Wait interrupted; background terminals keep running and will report when they exit.",
  stopInterrupted: "Stop interrupted; termination continues in the background.",
  readCalls: `terminal_log_read budget exhausted for this agent run (maximum ${TERMINAL_LOG_READ_RUN_CALLS} reads). Work with the output you already have; the user can inspect the full log with /ps.`,
  readBytes: `terminal_log_read budget exhausted for this agent run (maximum ${TERMINAL_LOG_READ_RUN_BUDGET} bytes). Work with the output you already have; the user can inspect the full log with /ps.`,
  interrupted: "Operation was aborted.",
  initialWaitAborted: (id: string) =>
    `Initial wait aborted; ${id} continues in the background and will report when it exits.`,
};

/** At most this many changed paths are named; the rest collapse into a count. */
export const MAX_CHANGED_PATHS = 8;

/**
 * One line naming files the model changed while a command ran (see
 * run-changes.ts), or undefined when none changed. States the fact and leaves
 * the decision to the model: a re-run is often right, but not always (a docs
 * edit beside a lint run changes nothing).
 */
export function changedFilesNote(relativePaths: readonly string[]) {
  if (relativePaths.length === 0) return undefined;
  const shown = relativePaths.slice(0, MAX_CHANGED_PATHS);
  const hidden = relativePaths.length - shown.length;
  const list = hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
  return (
    `Changed while this command ran: ${list}. ` +
    "The result may not reflect those changes; run the command again if they matter to it."
  );
}

export function foregroundFallbackWarning(reason: string) {
  return `[Managed bash unavailable before spawn; using Pi's foreground bash fallback — no auto-yield or /ps tracking for this call. Reason: ${reason.slice(0, 500)}]`;
}

export function formatTerminalLogRead(result: TerminalLogReadResult) {
  const tail = `settled: ${result.settled ? "yes" : "no"}; complete: ${result.complete ? "yes" : "no"}; next_offset: ${result.nextOffset}`;
  let header: string;
  if (result.mode === "search") {
    const shown = result.matches?.length ?? 0;
    const total = result.matchCount ?? 0;
    header =
      `${result.id}:${result.stream} ${total} matches for /${result.pattern ?? ""}/` +
      (shown < total ? ` (showing first ${shown})` : "") +
      `; ${tail}`;
  } else if (result.mode === "head_tail") {
    header =
      `${result.id}:${result.stream} head+tail of ${result.size} ` +
      `(bytes ${result.omittedStart ?? 0}-${(result.omittedEnd ?? 0) - 1} omitted); ${tail}`;
  } else {
    const range = result.bytesRead === 0 ? "empty" : `${result.offset}-${result.nextOffset - 1}`;
    header = `${result.id}:${result.stream} bytes ${range} of ${result.size}; ${tail}`;
  }
  return [header, result.text || "(empty)"].join("\n");
}

export function stateOnlyCommandError() {
  return (
    "This command only changes shell state (cd/export/assignment) in a shell discarded on exit, " +
    "so it cannot affect any later call; it was not executed. Use working_dir to choose the " +
    "directory, or combine setup and work in one command: `cd packages/x && npm test`."
  );
}

export function duplicateCommandError(snap: TerminalSnapshot) {
  return (
    `This exact command is already running as background terminal ${snap.id} ` +
    `(started ${formatElapsed(snap)} ago, pid ${snap.pid ?? "?"}). It has not failed: yielded commands ` +
    "keep running and report back on exit. This second copy was not executed — re-running it would " +
    "repeat its side effects. Wait for it with terminal_wait, or terminal_stop it and run it again " +
    "to restart. To run a second copy on purpose, " +
    "change the command text or use a different working_dir."
  );
}

export function sleepWhileRunningError(snaps: readonly TerminalSnapshot[]) {
  const ids = snaps.map((snap) => snap.id).join(", ");
  return (
    `Not executed: a sleep of ${PLAIN_SLEEP_GUARD_MIN_SECONDS}s or more does not make background results arrive sooner. ` +
    `To get the result of ${ids}, call terminal_wait; it returns as soon as one exits. ` +
    "To wait until a server is ready, poll it in one command: `until curl -fs <url>; do sleep 1; done`. " +
    "Shorter sleeps, and sleeps while no background terminal runs, are allowed."
  );
}

const LEADING_SETUP =
  /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^;\s]+)\s*;\s*)+/;
const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

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
  const withoutSetup = normalized.replace(LEADING_SETUP, "").replace(LEADING_CD, "").trim();
  return truncateTitle(withoutSetup || normalized || "command");
}

/** One metadata line: `bt-<runtime-id>-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path)`. */
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
  const tailSourceStart = view.totalBytes - Buffer.byteLength(endSource, "utf8");
  let tailOffset = endSource.length - end.content.length;
  while (tailOffset > 0 && !endSource.startsWith(end.content, tailOffset)) {
    tailOffset--;
  }
  const omittedEnd = end.content
    ? tailSourceStart + Buffer.byteLength(endSource.slice(0, tailOffset), "utf8")
    : view.totalBytes;
  const parts = [start.content];
  if (omittedBytes > 0) {
    parts.push(`... ${formatSize(omittedBytes)} omitted ...`);
  }
  if (end.content) parts.push(end.content);

  const archiveRef = archiveReference(terminalId, stream, view);
  const omittedRange = omittedBytes > 0 ? `${omittedStart}-${omittedEnd - 1}` : "none";
  const archive = archiveRef
    ? `archive ref ${archiveRef} (complete: ${view.archiveComplete === true ? "yes" : "no"}, omitted bytes ${omittedRange}); recover via terminal_log_read(ref)`
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

/** Marker-room estimate: the section's trailing bounded/archive line. */
const SECTION_OVERHEAD_BYTES = 320;
/** Below this a section cannot show content; degrade to the archive pointer. */
const MIN_SECTION_CONTENT_BYTES = 128;

/** One output section hard-capped to a byte budget — degrades to the archive
 * ref rather than letting batch truncation cut it. */
function budgetedSection(
  label: string,
  terminalId: string,
  stream: "stdout" | "stderr",
  view: TerminalSnapshot["stdout"],
  maxBytes: number,
  maxLines: number,
  sectionBudgetBytes: number,
) {
  const contentBudget = sectionBudgetBytes - SECTION_OVERHEAD_BYTES;
  if (contentBudget < MIN_SECTION_CONTENT_BYTES) {
    const archiveRef = archiveReference(terminalId, stream, view);
    const pointer = archiveRef
      ? `archive ref ${archiveRef} (complete: ${view.archiveComplete === true ? "yes" : "no"}); recover via terminal_log_read(ref)`
      : "complete archive unavailable to the model";
    return `${label}: (${formatSize(view.totalBytes)} omitted — ${pointer})`;
  }
  return outputSection(
    label,
    terminalId,
    stream,
    view,
    Math.min(maxBytes, contentBudget),
    maxLines,
  );
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

/** Result of the initial bash wait, whether final or yielded. `nested` marks a
 * call made by a Code Mode script: its follow-up cannot interrupt the script,
 * so the guidance points at collecting the result inside the script.
 * `changedFiles` qualifies a final result only: a running command has none. */
export function buildBashResult(
  snap: TerminalSnapshot,
  options?: { nested?: boolean; changedFiles?: readonly string[] },
) {
  // Always name the directory. A command sent to the wrong one usually still
  // exits 0, and the common mistake is assuming a cwd that was never set, so
  // the model must see where it actually ran even when that is the session cwd.
  // Running terminals carry it via describeTerminal() instead.
  let text =
    snap.status === "running"
      ? options?.nested === true
        ? `Command is still running as background terminal ${snap.id}. Its result arrives after the calling script ends. To use it inside the script, call terminal_wait({ ids: ["${snap.id}"] }). Stop it with terminal_stop.\n${describeTerminal(snap)}`
        : `Command is still running as background terminal ${snap.id}. Its result arrives automatically after a later tool call — keep working. If nothing else is left to do, call terminal_wait; never sleep or poll. Stop it with terminal_stop.\n${describeTerminal(snap)}`
      : snap.status === "timed_out"
        ? `Command timed out after ${formatElapsed(snap)} in ${snap.cwd}.`
        : `Command finished in ${formatElapsed(snap)} (${formatExit(snap)}) in ${snap.cwd}.`;
  if (snap.errorText) text += `\nError: ${snap.errorText}`;
  if (snap.status !== "running") {
    const note = changedFilesNote(options?.changedFiles ?? []);
    if (note) text += `\n${note}`;
  }
  return appendOutput(
    text,
    snap,
    BASH_STDOUT_MAX,
    BASH_STDOUT_MAX_LINES,
    BASH_STDERR_MAX,
    BASH_STDERR_MAX_LINES,
  );
}

/** The "how it ended" wording shared by completion and wait/stop results. */
function terminalHow(snap: TerminalSnapshot) {
  return snap.status === "killed"
    ? "was killed"
    : snap.status === "timed_out"
      ? "timed out"
      : `exited (${formatExit(snap)})`;
}

/** Async completion follow-up injected only after bash yielded. A finite
 * `budgetBytes` (batched completions share one message) shrinks the output
 * windows inside outputSection so the summary and archive refs survive —
 * truncating a fully assembled message would cut exactly those lines. */
export function buildTerminalResultMessage(
  snap: TerminalSnapshot,
  budgetBytes = Number.POSITIVE_INFINITY,
  changedFiles: readonly string[] = [],
) {
  const how = terminalHow(snap);
  let text = `Background terminal ${snap.id} "${snap.title}" ${how} after ${formatElapsed(snap)}.`;
  if (snap.errorText) text += `\nError: ${snap.errorText}`;
  // Sits before the output: it changes how the output should be read.
  const note = changedFilesNote(changedFiles);
  if (note) text += `\n${note}`;
  // Failures need the initial diagnostic budget: the useful error often sits
  // outside the compact success follow-up window. A killed process remains
  // intentionally concise because /ps is the user-facing inspection path.
  const diagnostic = snap.status === "failed" || snap.status === "timed_out";
  const stdoutBytes = diagnostic ? BASH_STDOUT_MAX : RESULT_STDOUT_MAX;
  const stdoutLines = diagnostic ? BASH_STDOUT_MAX_LINES : RESULT_STDOUT_MAX_LINES;
  const stderrBytes = diagnostic ? BASH_STDERR_MAX : RESULT_STDERR_MAX;
  const stderrLines = diagnostic ? BASH_STDERR_MAX_LINES : RESULT_STDERR_MAX_LINES;

  if (!Number.isFinite(budgetBytes)) {
    return appendOutput(text, snap, stdoutBytes, stdoutLines, stderrBytes, stderrLines);
  }

  const remaining = Math.max(0, budgetBytes - Buffer.byteLength(text));
  const streamCount = 1 + (snap.stderr.totalBytes > 0 ? 1 : 0);
  if (remaining < SECTION_OVERHEAD_BYTES + MIN_SECTION_CONTENT_BYTES) {
    // Not enough room for even one bounded window; keep the recovery pointer.
    const refs = (["stdout", "stderr"] as const)
      .map((stream) => archiveReference(snap.id, stream, snap[stream]))
      .filter((ref): ref is string => ref !== undefined);
    if (refs.length > 0) {
      text += `\n\nOutput omitted; archive ref ${refs.join(", ")} — recover via terminal_log_read(ref).`;
    }
    return truncateUtf8WithMarker(text, budgetBytes);
  }
  const perStream = Math.floor(remaining / streamCount);
  text += `\n\n${budgetedSection("stdout", snap.id, "stdout", snap.stdout, stdoutBytes, stdoutLines, perStream)}`;
  if (snap.stderr.totalBytes > 0) {
    text += `\n\n${budgetedSection("stderr", snap.id, "stderr", snap.stderr, stderrBytes, stderrLines, perStream)}`;
  }
  // Last-resort guard for accounting drift (marker line length varies).
  return truncateUtf8WithMarker(text, budgetBytes);
}

function truncateUtf8(value: string, maximumBytes: number) {
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (usedBytes + characterBytes > maximumBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

export function truncateUtf8WithMarker(value: string, maximumBytes: number) {
  const byteLimit = Math.max(0, maximumBytes);
  if (Buffer.byteLength(value) <= byteLimit) return value;
  // The model cannot run /ps — point it at the tool it can call.
  const marker = truncateUtf8(
    "\n[output truncated; read the full log via terminal_log_read(ref)]",
    byteLimit,
  );
  const contentBudget = byteLimit - Buffer.byteLength(marker);
  return truncateUtf8(value, contentBudget) + marker;
}

/** One follow-up for terminal completions that settle in the same quiet
 * window. Each terminal's share of the byte budget is enforced while its
 * message is built, so summaries and archive refs survive truncation.
 * `changedFiles` maps a terminal id to the files written while it ran. */
export function buildTerminalResultBatchMessage(
  snaps: readonly TerminalSnapshot[],
  changedFiles: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  if (snaps.length === 0) return "";
  const noteFor = (snap: TerminalSnapshot) => changedFiles.get(snap.id) ?? [];
  if (snaps.length === 1) {
    return buildTerminalResultMessage(snaps[0], Number.POSITIVE_INFINITY, noteFor(snaps[0]));
  }

  const header = `${snaps.length} background terminals completed.`;
  const separator = "\n\n";
  const fixedBytes = Buffer.byteLength(header) + Buffer.byteLength(separator) * snaps.length;
  const perMessageBytes = Math.max(
    0,
    Math.floor((MAX_COMPLETION_BATCH_CONTENT_BYTES - fixedBytes) / snaps.length),
  );
  const boundedMessages = snaps.map((snap) =>
    buildTerminalResultMessage(snap, perMessageBytes, noteFor(snap)),
  );
  return [header, ...boundedMessages].join(separator);
}

/** Model-facing text for `terminal_wait`: settled results first (full
 * completion shape), then previously reported exits, then what still runs. */
export function buildTerminalWaitResult(input: {
  readonly settled: readonly TerminalSnapshot[];
  readonly alreadyReported: readonly TerminalSnapshot[];
  readonly running: readonly TerminalSnapshot[];
  readonly timeoutSeconds: number;
  readonly changedFiles?: ReadonlyMap<string, readonly string[]>;
}) {
  const sections: string[] = [];
  if (input.settled.length > 0) {
    sections.push(buildTerminalResultBatchMessage(input.settled, input.changedFiles));
  }
  if (input.alreadyReported.length > 0) {
    sections.push(
      input.alreadyReported
        .map((snap) => `${snap.id} ${terminalHow(snap)}; its result was delivered earlier.`)
        .join("\n"),
    );
  }
  if (input.running.length > 0) {
    const lines: string[] = [];
    if (sections.length === 0) {
      lines.push(`No background terminal exited within ${input.timeoutSeconds}s.`);
    }
    for (const snap of input.running) {
      lines.push(`Still running: ${describeTerminal(snap)}`);
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}
