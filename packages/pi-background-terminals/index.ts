/**
 * Background terminals — execute no-stdin shell commands that automatically
 * yield into the background when they outlive a bounded initial wait.
 *
 * Tools for the LLM:
 * - bash: overrides Pi's built-in bash, returns final output when the command
 *   finishes promptly, otherwise returns a terminal id and notifies exactly
 *   once when it exits.
 * - terminal_log_read: bounded reads over a terminal's complete log.
 * - terminal_wait: blocks until a background terminal exits and returns its
 *   result instead of a later completion message — the sleep replacement.
 * - terminal_stop: stops a running terminal's process tree with a one-line
 *   result and no completion message.
 * The user still owns inspection and termination via /ps.
 *
 * While ≥1 process runs, a one-line widget above the editor shows
 * "N background terminal(s) running • /ps to view". `/ps` opens a two-stage
 * full-screen overlay (list → read-only detail with Info/stdout/stderr tabs).
 * Quick Bash rows show a bounded command/output preview; only commands that
 * actually yield collapse to compact /ps-owned terminal rows.
 *
 * Architecture: Effect v4 core (manager service behind one ManagedRuntime);
 * this file is the async boundary where tool handlers run effects via
 * runTool. Node stream plumbing inside the manager is plain callbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  formatSize,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createCompletionBatchScheduler } from "./src/completion-batcher.ts";
import {
  SpawnError,
  type OutputView,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./src/domain.ts";
import {
  findDuplicateRunning,
  plainSleepSeconds,
  isStateOnlyCommand,
} from "./src/command-shape.ts";
import {
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  PLAIN_SLEEP_GUARD_MIN_SECONDS,
  DEFAULT_TERMINAL_WAIT_SECONDS,
  MAX_TERMINAL_WAIT_SECONDS,
  DEFAULT_TERMINAL_LOG_READ_BYTES,
  MAX_TERMINAL_LOG_READ_BYTES,
  TERMINAL_LOG_READ_RUN_BUDGET,
  TERMINAL_LOG_READ_RUN_CALLS,
  BASH_STRUCTURED_OUTPUT_MAX_BYTES,
} from "./src/constants.ts";
import { readLogHeadTail } from "./src/log-read.ts";
import {
  TerminalManager,
  type SettlementWaitResult,
  type TerminalLogReadResult,
  type TerminalManagerShape,
} from "./src/manager.ts";
import {
  TERMINAL_ERRORS,
  foregroundFallbackWarning,
  formatTerminalLogRead,
  duplicateCommandError,
  sleepWhileRunningError,
  stateOnlyCommandError,
  BASH_PARAMETER_DESCRIPTIONS,
  BASH_PROMPT_SNIPPET,
  BASH_TOOL_DESCRIPTION,
  buildBashProgress,
  buildBashResult,
  buildTerminalResultBatchMessage,
  buildTerminalResultMessage,
  buildTerminalWaitResult,
  deriveCommandTitle,
  describeTerminal,
  TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS,
  TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS,
  TERMINAL_LOG_READ_PROMPT_SNIPPET,
  TERMINAL_LOG_READ_TOOL_DESCRIPTION,
  TERMINAL_STOP_PARAMETER_DESCRIPTIONS,
  TERMINAL_STOP_PROMPT_SNIPPET,
  TERMINAL_STOP_TEXT,
  TERMINAL_STOP_TOOL_DESCRIPTION,
  TERMINAL_WAIT_OUTPUT_FIELD_DESCRIPTIONS,
  BASH_OUTPUT_FIELD_DESCRIPTIONS,
  TERMINAL_WAIT_PARAMETER_DESCRIPTIONS,
  TERMINAL_WAIT_PROMPT_SNIPPET,
  TERMINAL_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { createRunChangeTracker, resolveToolPath } from "./src/run-changes.ts";
import { createTerminalRuntime, runTool, type TerminalRuntime } from "./src/runtime.ts";
import { sanitizeText } from "./src/ui/output-view.ts";

const WIDGET_KEY = "background-terminals";
const UPDATE_THROTTLE_MS = 100;
const SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

const TerminalLogReadOutputSchema = Type.Object({
  id: Type.String({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.id }),
  stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")], {
    description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.stream,
  }),
  mode: Type.Union(
    [Type.Literal("page"), Type.Literal("head_tail"), Type.Literal("tail"), Type.Literal("search")],
    { description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.mode },
  ),
  offset: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.offset }),
  nextOffset: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.nextOffset }),
  bytesRead: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.bytesRead }),
  size: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.size }),
  settled: Type.Boolean({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.settled }),
  complete: Type.Boolean({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.complete }),
  text: Type.String({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.text }),
  omittedStart: Type.Optional(
    Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.omittedStart }),
  ),
  omittedEnd: Type.Optional(
    Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.omittedEnd }),
  ),
  matchCount: Type.Optional(
    Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.matchCount }),
  ),
  matches: Type.Optional(
    Type.Array(
      Type.Object({
        offset: Type.Integer(),
        text: Type.String(),
      }),
      { description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.matches },
    ),
  ),
  pattern: Type.Optional(
    Type.String({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.pattern }),
  ),
});

const TERMINAL_WAIT_OUTPUT_SCHEMA = Type.Object({
  settled: Type.Array(
    Type.Object({
      id: Type.String(),
      status: Type.Union([
        Type.Literal("done"),
        Type.Literal("failed"),
        Type.Literal("timed_out"),
        Type.Literal("killed"),
      ]),
      exitCode: Type.Optional(Type.Integer()),
      signal: Type.Optional(Type.String()),
    }),
    { description: TERMINAL_WAIT_OUTPUT_FIELD_DESCRIPTIONS.settled },
  ),
  running: Type.Array(Type.String(), {
    description: TERMINAL_WAIT_OUTPUT_FIELD_DESCRIPTIONS.running,
  }),
  alreadyReported: Type.Array(Type.String(), {
    description: TERMINAL_WAIT_OUTPUT_FIELD_DESCRIPTIONS.alreadyReported,
  }),
  text: Type.String({ description: TERMINAL_WAIT_OUTPUT_FIELD_DESCRIPTIONS.text }),
});

const BASH_OUTPUT_SCHEMA = Type.Object({
  output: Type.String({ description: BASH_OUTPUT_FIELD_DESCRIPTIONS.output }),
  truncated: Type.Boolean({ description: BASH_OUTPUT_FIELD_DESCRIPTIONS.truncated }),
  exit_code: Type.Optional(Type.Integer({ description: BASH_OUTPUT_FIELD_DESCRIPTIONS.exit_code })),
  wall_time_seconds: Type.Number({
    description: BASH_OUTPUT_FIELD_DESCRIPTIONS.wall_time_seconds,
  }),
  terminal_id: Type.Optional(
    Type.String({ description: BASH_OUTPUT_FIELD_DESCRIPTIONS.terminal_id }),
  ),
  status: Type.Optional(
    Type.Union(
      [
        Type.Literal("running"),
        Type.Literal("done"),
        Type.Literal("failed"),
        Type.Literal("timed_out"),
        Type.Literal("killed"),
      ],
      { description: BASH_OUTPUT_FIELD_DESCRIPTIONS.status },
    ),
  ),
});

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "done",
  "failed",
  "timed_out",
  "killed",
]);

/** Structured state carried on every managed bash result. The renderer reads
 * this instead of parsing the model-facing text (which mislabels an Esc-
 * aborted wait as a failure, or a cwd named "killed" as a kill). */
interface BashResultDetails {
  readonly id: string;
  readonly status: TerminalStatus;
  /** True once the command outlived its initial wait and became a background
   * terminal — only then does the result collapse to the compact /ps row. */
  readonly yielded: boolean;
}

function bashDetails(value: unknown): BashResultDetails | undefined {
  const candidate = value as Partial<BashResultDetails> | undefined;
  if (
    typeof candidate?.id === "string" &&
    typeof candidate.status === "string" &&
    TERMINAL_STATUSES.has(candidate.status)
  ) {
    return {
      id: candidate.id,
      status: candidate.status as TerminalStatus,
      yielded: candidate.yielded === true,
    };
  }
  return undefined;
}

function parseTerminalLogRef(ref: string) {
  const match = /^(bt-[a-f0-9]{16}-\d+)(?::(stdout|stderr))?$/.exec(ref);
  if (!match) return undefined;
  return {
    id: match[1],
    stream: (match[2] ?? "stdout") as "stdout" | "stderr",
  };
}

/**
 * One stream's contribution to `structuredContent.output`, at the Code Mode
 * budget rather than the model-facing one, bounded by the `budget` the caller
 * still has left. The schema promises one 1 MiB `output`, not 1 MiB per
 * stream, so stdout and stderr share it.
 *
 * The in-memory view is compacted to `SETTLED_RETAINED_PER_STREAM` (64 KiB)
 * once the archive is on disk, which is far below what Pi's built-in bash
 * promises scripts, so a settled stream reads its archive instead. A live
 * stream has no complete archive yet: its view already is the bounded
 * head+tail, and it carries the omission marker.
 */
function structuredStream(
  view: OutputView,
  budget: number,
): { text: string; truncated: boolean; spent: number } {
  const { spillPath, archiveComplete } = view;
  let text = view.text;
  let truncated = view.truncatedBytes > 0;
  if (spillPath !== undefined && archiveComplete === true && budget > 0) {
    try {
      const read = readLogHeadTail(spillPath, budget);
      text = read.text;
      // From the read's metadata, not the text: output that literally
      // contains "bytes omitted" would otherwise read as incomplete.
      truncated = read.omittedStart !== undefined;
    } catch {
      // The archive vanished (pruned, or a spill that failed after settling):
      // fall back to what memory still holds instead of failing the result.
    }
  }
  if (truncated && budget <= 0) {
    // No budget left for this stream at all: name what was dropped instead of
    // appending an unbounded in-memory view to an already-full output.
    const bytes = view.totalBytes;
    return {
      text: bytes > 0 ? `[... ${bytes} bytes omitted ...]` : "",
      truncated: true,
      spent: 0,
    };
  }
  return { text, truncated, spent: Math.min(Buffer.byteLength(text, "utf8"), budget) };
}

/** Strict-JSON structured bash result for Code Mode scripts: optional keys
 * are absent rather than undefined. `exit_code` is reported only for a
 * natural exit (status done/failed) — never for running/timed_out/killed,
 * where a forced kill reports platform-specific codes (taskkill exit 1 on
 * Windows) — so the field means the same thing on every platform. */
function bashStructuredContent(snap: TerminalSnapshot) {
  const stdout = structuredStream(snap.stdout, BASH_STRUCTURED_OUTPUT_MAX_BYTES);
  const stderr = structuredStream(snap.stderr, BASH_STRUCTURED_OUTPUT_MAX_BYTES - stdout.spent);
  let output = stdout.text;
  if (stderr.text.length > 0) {
    output += (output.length > 0 && !output.endsWith("\n") ? "\n" : "") + stderr.text;
  }
  return {
    output,
    truncated: stdout.truncated || stderr.truncated,
    ...((snap.status === "done" || snap.status === "failed") && snap.exitCode !== undefined
      ? { exit_code: snap.exitCode }
      : {}),
    wall_time_seconds: Math.round(((snap.settledAt ?? Date.now()) - snap.createdAt) / 100) / 10,
    terminal_id: snap.id,
    status: snap.status,
  };
}

/** Deep-enough copy of a settled snapshot: live output views keep mutating
 * (late flushes) after settle. Same shape onSettled defers. */
function copySettled(snap: TerminalSnapshot): TerminalSnapshot {
  return { ...snap, stdout: { ...snap.stdout }, stderr: { ...snap.stderr } };
}

function quickOutputPreview(text: string, maxLines: number, full = false) {
  const stdoutAt = text.indexOf("\n\nstdout:");
  const stderrAt = text.indexOf("\n\nstderr:");
  const starts = [stdoutAt, stderrAt].filter((at) => at >= 0);
  if (starts.length === 0) return [];

  const output = sanitizeText(text.slice(Math.min(...starts) + 2));
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        !/^\[(?:stdout|stderr) bounded head\+tail:/i.test(line) && line !== "stdout: (empty)",
    )
    .map((line) => (full || line.length <= 240 ? line : `${line.slice(0, 237)}...`));
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  if (lines.length <= maxLines) return lines;

  const headCount = Math.min(2, Math.floor(maxLines / 2));
  const tailCount = Math.max(1, maxLines - headCount - 1);
  return [
    ...lines.slice(0, headCount),
    `... ${lines.length - headCount - tailCount} preview lines omitted ...`,
    ...lines.slice(-tailCount),
  ];
}

function getPiShellEnv(): NodeJS.ProcessEnv {
  // Mirrors Pi's internal getShellEnv(), which is not exported from the
  // package root. Keep Pi-managed tools such as fd and rg visible to Bash.
  const binDir = path.join(getAgentDir(), "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const hasBinDir = currentPath.split(path.delimiter).filter(Boolean).includes(binDir);

  return {
    ...process.env,
    [pathKey]: hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(path.delimiter),
  };
}

export interface BackgroundTerminalsDependencies {
  readonly createRuntime?: typeof createTerminalRuntime;
  readonly createForegroundBash?: typeof createBashToolDefinition;
  readonly resolveShellSettings?: (ctx: ExtensionContext) => {
    readonly shellPath?: string;
    readonly commandPrefix?: string;
  };
}

/** Dependency injection is public only so the pre-spawn fallback is testable. */
export function createBackgroundTerminalsExtension(
  dependencies: BackgroundTerminalsDependencies = {},
) {
  const makeRuntime = dependencies.createRuntime ?? createTerminalRuntime;
  const makeForegroundBash = dependencies.createForegroundBash ?? createBashToolDefinition;
  const resolveShellSettings =
    dependencies.resolveShellSettings ??
    ((ctx: ExtensionContext) => {
      const settings = SettingsManager.create(ctx.cwd, undefined, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      return {
        shellPath: settings.getShellPath(),
        commandPrefix: settings.getShellCommandPrefix(),
      };
    });

  return function backgroundTerminals(pi: ExtensionAPI) {
    let runtime: TerminalRuntime | undefined;
    let managerPromise:
      | Promise<{ runtime: TerminalRuntime; manager: TerminalManagerShape }>
      | undefined;
    let sessionContext: ExtensionContext | undefined;
    let ui: ExtensionUIContext | undefined;
    let unsubStatus: (() => void) | undefined;
    let terminalLogReadBytes = 0;
    let terminalLogReadCalls = 0;
    const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();
    /** Paths the model wrote with edit/write while commands ran, so a
     * result can say it may predate them. */
    const runChanges = createRunChangeTracker();
    const changedFilesFor = (snaps: readonly TerminalSnapshot[]) => {
      const map = new Map<string, readonly string[]>();
      for (const snap of snaps) {
        const changed = runChanges.changedDuring(snap.id);
        if (changed.length > 0) map.set(snap.id, changed);
      }
      return map;
    };
    /** Ids of tool calls made by a Code Mode script (any call whose
     * `tool_call` event carried a `parentToolCallId`). Nested results reach
     * the script, not the model — budgets and result text adapt accordingly. */
    const nestedCallIds = new Set<string>();
    /** Consumes the nested marker so a stale id can never mark a later call. */
    const takeNested = (toolCallId: string) => nestedCallIds.delete(toolCallId);

    const resetTerminalLogBudget = () => {
      terminalLogReadBytes = 0;
      terminalLogReadCalls = 0;
    };

    const getRuntime = () => (runtime ??= makeRuntime());

    /** Resolve the manager service once per runtime and wire the extension
     * hooks. Returns the runtime it was built on so callers keep using THAT
     * instance — a session_shutdown arriving between `await getManager()` and
     * the next `getRuntime()` must not silently create a runtime that nothing
     * will ever dispose. */
    const getManager = () => {
      managerPromise ??= (() => {
        const bound = getRuntime();
        return bound.runPromise(TerminalManager).then((manager) => {
          manager.view.setOnSettled(onSettled);
          unsubStatus?.();
          unsubStatus = manager.view.subscribe(() => updateWidget(manager));
          updateWidget(manager);
          return { runtime: bound, manager };
        });
      })();
      return managerPromise;
    };

    /** One-line widget directly above the editor, only while ≥1 yielded
     * terminal runs. A command still inside its initial wait is foreground
     * work — counting it would flash the widget on every quick bash call.
     * Called on every manager notification (including per-output-chunk), so it
     * only touches setWidget when the running count actually changes —
     * replacing the widget factory hundreds of times a second would churn
     * component creation for no visible difference. */
    let widgetRunning = 0;
    const updateWidget = (manager: TerminalManagerShape) => {
      if (!ui) return;
      try {
        const running = manager.view
          .list()
          .filter((snap) => snap.status === "running" && snap.yielded === true).length;
        if (running === widgetRunning) return;
        widgetRunning = running;
        if (running === 0) {
          ui.setWidget(WIDGET_KEY, undefined);
          return;
        }
        ui.setWidget(WIDGET_KEY, (_tui, theme) => {
          const line =
            theme.fg("warning", "■ ") +
            theme.fg("text", `${running} background terminal${running === 1 ? "" : "s"} running`) +
            theme.fg("dim", " • ") +
            theme.fg("accent", "/ps") +
            theme.fg("dim", " to view");
          return {
            render: (width: number) => [truncateToWidth(line, width, "")],
            invalidate: () => {},
          };
        });
      } catch {
        // UI may be unavailable (print/RPC modes or teardown).
      }
    };

    const deliverResults = (snaps: readonly TerminalSnapshot[]) => {
      if (snaps.length === 0) return true;
      try {
        const results = snaps.map((snap) => ({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          exitCode: snap.exitCode,
          signal: snap.signal,
        }));
        pi.sendMessage(
          {
            customType: "background-terminal-result",
            content: buildTerminalResultBatchMessage(snaps, changedFilesFor(snaps)),
            display: true,
            details:
              results.length === 1
                ? results[0]
                : {
                    count: results.length,
                    ids: results.map((result) => result.id),
                    results,
                  },
          },
          // steer: delivered at the next turn boundary — after the current tool
          // batch, never mid-stream — so a model that keeps working sees the
          // result as soon as it lands instead of only after it writes a final
          // answer (followUp). triggerTurn wakes an idle model. Each terminal is
          // still delivered exactly once, nearby settlements sharing a message.
          // An all-killed batch is a /ps stop the user already saw; delivering
          // it with the next user turn reports it without waking an idle model.
          snaps.every((snap) => snap.status === "killed")
            ? { deliverAs: "nextTurn" }
            : { deliverAs: "steer", triggerTurn: true },
        );
        return true;
      } catch (error) {
        // Session may be shutting down, but retain every snapshot so any later
        // agent-settled flush can retry instead of silently dropping the batch.
        if (sessionContext?.mode !== "tui") {
          console.error("background-terminals: failed to deliver results", error);
        }
        return false;
      }
    };

    const deliverPending = () => {
      const snaps = resultDelivery.drain();
      if (!deliverResults(snaps)) {
        for (const snap of snaps) resultDelivery.defer(snap);
      }
    };
    // Pi adds a steer to the context only after the current tool batch. A
    // steer sent during the batch hides the result from a terminal_wait in
    // that batch: the queue is empty, but the model has not seen the result.
    // So while a run is active, results stay queued until turn_end.
    let agentRunning = false;
    const flushResults = () => {
      if (!agentRunning) deliverPending();
    };
    const resultBatchScheduler = createCompletionBatchScheduler(flushResults);
    const scheduleResultFlush = () => {
      if (resultDelivery.size() > 0) resultBatchScheduler.schedule();
    };

    const onSettled = (snap: TerminalSnapshot, consumed: boolean) => {
      if (consumed) {
        // The initial bash wait is returning this settlement itself.
        resultDelivery.consume([snap.id]);
        if (resultDelivery.size() === 0) resultBatchScheduler.clear();
        return;
      }
      // Defer a deep-enough copy: the live snapshot's output views keep
      // mutating (late flushes) after settle.
      resultDelivery.defer(copySettled(snap));
      scheduleResultFlush();
    };

    pi.on("session_start", (_event, ctx) => {
      sessionContext = ctx;
      resetTerminalLogBudget();
      if (ctx.hasUI) ui = ctx.ui;
    });

    // Code Mode scripts call tools via ctx.executeTool; those calls fire
    // tool_call with parentToolCallId and get ids like "<parent>/<n>".
    // Returning nothing — detection must never block a call.
    pi.on("tool_call", (event) => {
      if (event.parentToolCallId) nestedCallIds.add(event.toolCallId);
    });

    // A completion can describe code that no longer exists: a test that
    // finishes after the model edited the code under test still reports the
    // old result. Record only successful edit/write calls (a blocked or
    // failed one changed nothing) and state the fact in the result. Before
    // the first bash call there is no manager and nothing running to note.
    pi.on("tool_result", async (event, ctx) => {
      if (event.isError) return;
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const target = event.input?.path;
      if (typeof target !== "string" || !managerPromise) return;
      const bound = await managerPromise.catch(() => undefined);
      if (!bound) return;
      runChanges.record(resolveToolPath(target, ctx.cwd), bound.manager.view.list());
    });

    // One agent run can contain many model/tool turns. The terminal_log_read
    // byte/call budget spans the whole run, then resets for the next
    // user/follow-up run rather than per turn.
    pi.on("agent_start", () => {
      agentRunning = true;
      resetTerminalLogBudget();
      nestedCallIds.clear();
    });

    // A result still inside its quiet window when the model ends its turn
    // would otherwise settle the run and wake a new one moments later — or be
    // lost when print/json mode exits on settlement. Deliver it now: the steer
    // is queued before settlement, so pi continues this same run with it.
    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "completed" || resultDelivery.size() === 0) return;
      resultBatchScheduler.clear();
      deliverPending();
    });

    // Pi drains steers right after turn_end handlers, before the next model
    // request. An aborted or failed turn ends the run, so its results wait
    // for agent_settled instead.
    pi.on("turn_end", (event) => {
      const stop = event.message.role === "assistant" ? event.message.stopReason : undefined;
      if (stop === "aborted" || stop === "error" || resultDelivery.size() === 0) return;
      resultBatchScheduler.clear();
      deliverPending();
    });

    // Deliver results held during the run, and retry a failed batch.
    pi.on("agent_settled", () => {
      agentRunning = false;
      scheduleResultFlush();
    });

    // /new, /resume, /fork, /reload, and quit all emit session_shutdown for
    // the old extension instance. Processes never survive a session
    // transition: disposing the runtime runs the manager finalizer →
    // disposeAll → every entry scope → SIGTERM→SIGKILL tree kill, each close
    // bounded so a wedged process cannot hang shutdown.
    pi.on("session_shutdown", async () => {
      sessionContext = undefined;
      agentRunning = false;
      resetTerminalLogBudget();
      nestedCallIds.clear();
      runChanges.clear();
      resultBatchScheduler.clear();
      resultDelivery.clear();
      unsubStatus?.();
      unsubStatus = undefined;
      try {
        ui?.setWidget(WIDGET_KEY, undefined);
      } catch {
        // UI may already be gone.
      }
      widgetRunning = 0;
      ui = undefined;
      const closing = runtime;
      runtime = undefined;
      managerPromise = undefined;
      await closing?.dispose();
    });

    // --- Tool --------------------------------------------------------------

    pi.registerTool({
      // Registering the built-in name is Pi's supported override mechanism.
      // The model sees one canonical shell tool, not a second execution lane.
      name: "bash",
      label: "bash",
      description: BASH_TOOL_DESCRIPTION,
      promptSnippet: BASH_PROMPT_SNIPPET,
      parameters: Type.Object({
        command: Type.String({
          description: BASH_PARAMETER_DESCRIPTIONS.command,
        }),
        timeout: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            maximum: MAX_RUNTIME_TIMEOUT_SECONDS,
            description: BASH_PARAMETER_DESCRIPTIONS.timeout,
          }),
        ),
        title: Type.Optional(
          Type.String({
            description: BASH_PARAMETER_DESCRIPTIONS.title,
          }),
        ),
        working_dir: Type.Optional(
          Type.String({
            description: BASH_PARAMETER_DESCRIPTIONS.workingDir,
          }),
        ),
        yield_time_ms: Type.Optional(
          Type.Integer({
            description: BASH_PARAMETER_DESCRIPTIONS.yieldTimeMs,
          }),
        ),
      }),
      // Code Mode scripts resolve this schema to structured fields — including
      // on isError, where a text-only tool result would reject instead.
      outputSchema: BASH_OUTPUT_SCHEMA,
      // Quick commands show their useful title and a bounded output preview.
      // Commands that actually yield collapse to one compact terminal row; /ps
      // remains the complete invocation/output viewer for every managed process.
      renderCall(args, theme, context) {
        const command = typeof args?.command === "string" ? args.command : "";
        const explicitTitle = typeof args?.title === "string" ? args.title : undefined;
        // Expanded (Ctrl+O): the full command, wrapping; collapsed: the title.
        const label = command
          ? context.expanded === true
            ? command
            : deriveCommandTitle(command, explicitTitle)
          : "...";
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(theme.fg("toolTitle", theme.bold(`$ ${label}`)));
        return text;
      },
      renderResult(result, { isPartial, expanded }, theme, context) {
        const rawText = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        // Status comes from structured details, never from parsing the text:
        // an aborted wait reads as a live running terminal, and content like a
        // "killed" directory name cannot masquerade as a status.
        const details = bashDetails(result.details);
        const status =
          details?.status ?? (context.isError ? "failed" : isPartial ? "starting" : "done");
        const terminalRow = details?.yielded === true;
        const word = status === "timed_out" ? "timed out" : status;
        const icon =
          status === "failed" || status === "timed_out"
            ? theme.fg("error", "x")
            : status === "done"
              ? theme.fg("success", "■")
              : status === "killed"
                ? theme.fg("muted", "■")
                : theme.fg("warning", "■");
        const statusColor =
          status === "failed" || status === "timed_out"
            ? "error"
            : status === "done"
              ? "success"
              : status === "killed"
                ? "muted"
                : "warning";
        let body =
          terminalRow && details
            ? `${icon} ${theme.fg("accent", theme.bold(`terminal ${details.id}`))} ${theme.fg(statusColor, word)}${theme.fg("dim", " · ")}${theme.fg("accent", "/ps")}${theme.fg("dim", " to inspect")}`
            : `${icon} ${theme.fg(statusColor, `bash ${word}`)}${theme.fg("dim", " · ")}${theme.fg("accent", "/ps")}${theme.fg("dim", " for details")}`;
        // Quick foreground completions and initial-wait progress show a small
        // human-facing preview (everything when expanded). Once a command
        // actually yields, its row returns to one compact /ps-owned line.
        if (!terminalRow) {
          const preview = quickOutputPreview(
            rawText,
            expanded ? Number.MAX_SAFE_INTEGER : isPartial ? 4 : 6,
            expanded,
          );
          if (preview.length > 0) {
            body += `\n${preview.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
          }
        }
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(body);
        return text;
      },
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        signal?.throwIfAborted();
        const nested = takeNested(toolCallId);
        // Preserve the exact command text. Trimming here can break heredocs and
        // multiline scripts; trim only for validation and the display title.
        const command = params.command;
        if (!command.trim()) throw new Error(TERMINAL_ERRORS.emptyCommand);

        // The shell is discarded at exit, so a command that only mutates shell
        // state cannot affect anything. Left to run it would exit 0 and let the
        // model believe the directory or variable persists into the next call.
        if (isStateOnlyCommand(command)) throw new Error(stateOnlyCommandError());

        if (
          params.timeout !== undefined &&
          (!Number.isFinite(params.timeout) ||
            params.timeout <= 0 ||
            params.timeout > MAX_RUNTIME_TIMEOUT_SECONDS)
        ) {
          throw new Error(TERMINAL_ERRORS.invalidTimeout);
        }

        const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
        try {
          if (!fs.statSync(cwd).isDirectory()) {
            throw new Error("not a directory");
          }
        } catch {
          throw new Error(TERMINAL_ERRORS.invalidDirectory(cwd));
        }

        // Preserve Pi's built-in shellPath and shellCommandPrefix settings even
        // though this extension replaces the built-in definition.
        const { shellPath, commandPrefix } = resolveShellSettings(ctx);
        const executionCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;

        // Keep the work-bearing part visible when a model prefixes every call
        // with the same long D=/path assignment or `cd ... &&`.
        const title = deriveCommandTitle(command, params.title);

        const runForegroundFallback = async (reason: unknown, resetManagedRuntime: boolean) => {
          signal?.throwIfAborted();
          if (resetManagedRuntime) {
            const brokenRuntime = runtime;
            runtime = undefined;
            managerPromise = undefined;
            await brokenRuntime?.dispose().catch(() => {});
          }
          signal?.throwIfAborted();
          const reasonText = reason instanceof Error ? reason.message : String(reason);
          const warning = foregroundFallbackWarning(reasonText);
          if (ctx.hasUI) ctx.ui.notify(warning, "warning");

          const fallback = makeForegroundBash(cwd, {
            shellPath,
            commandPrefix,
          });
          try {
            const result = await fallback.execute(
              toolCallId,
              { command, timeout: params.timeout },
              signal,
              onUpdate,
              ctx,
            );
            return {
              ...result,
              content: [{ type: "text" as const, text: warning }, ...result.content],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${warning}\n\n${message}`);
          }
        };

        let manager: TerminalManagerShape;
        let toolRuntime: TerminalRuntime;
        try {
          const bound = await getManager();
          manager = bound.manager;
          // Use the runtime the manager was built on — never a fresh
          // getRuntime() after an interleaved session_shutdown.
          toolRuntime = bound.runtime;
        } catch (managerError) {
          // Manager resolution precedes start(), so no child can exist yet.
          return await runForegroundFallback(managerError, true);
        }

        signal?.throwIfAborted();

        // Re-issuing a command that is still running is the one mistake the model
        // gets no feedback on: the duplicate repeats every side effect and both
        // copies report success. Refuse instead of spawning it twice.
        const duplicate = findDuplicateRunning(manager.view.list(), command, cwd);
        if (duplicate) throw new Error(duplicateCommandError(duplicate));

        // A long bare `sleep N` while a background terminal runs is the model
        // re-inventing polling: results are pushed, so the sleep only wastes a
        // turn. Point it at terminal_wait instead. Short sleeps are legitimate
        // work (readiness polls, pacing) and run normally, as does any sleep
        // while nothing runs.
        const sleepSeconds = plainSleepSeconds(command);
        if (sleepSeconds !== undefined && sleepSeconds >= PLAIN_SLEEP_GUARD_MIN_SECONDS) {
          const blocking = manager.view
            .list()
            .filter((snap) => snap.status === "running" && snap.yielded === true);
          if (blocking.length > 0) throw new Error(sleepWhileRunningError(blocking));
        }

        const env = getPiShellEnv();
        for (const key of SESSION_ENV_KEYS) delete env[key];
        env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (sessionFile) env.PI_SESSION_FILE = sessionFile;
        if (ctx.model) {
          env.PI_PROVIDER = ctx.model.provider;
          env.PI_MODEL = ctx.model.id;
        }
        const thinkingLevel = pi.getThinkingLevel();
        if (thinkingLevel) env.PI_REASONING_LEVEL = thinkingLevel;

        let started: TerminalSnapshot;
        signal?.throwIfAborted();
        try {
          started = await runTool(
            toolRuntime,
            manager.start({
              command,
              executionCommand,
              shellPath,
              title,
              cwd,
              env,
              signal,
              timeoutMs: params.timeout === undefined ? undefined : params.timeout * 1000,
            }),
          );
        } catch (error) {
          if (error instanceof SpawnError && error.fallbackSafe) {
            return await runForegroundFallback(error, false);
          }
          // Concurrency, shutdown, asynchronous spawn failure, non-zero exit,
          // timeout, and abort are never retried.
          throw error;
        }

        let updateTimer: NodeJS.Timeout | undefined;
        let updateDirty = false;
        let lastUpdateAt = 0;
        const emitUpdate = () => {
          if (!onUpdate || !updateDirty) return;
          updateDirty = false;
          lastUpdateAt = Date.now();
          const snap = manager.view.get(started.id);
          if (snap?.status !== "running") return;
          try {
            onUpdate({
              content: [{ type: "text", text: buildBashProgress(snap) }],
              details: { id: snap.id, status: "running", yielded: false },
            });
          } catch {
            // A display update must never affect command execution.
          }
        };
        const scheduleUpdate = () => {
          if (!onUpdate) return;
          updateDirty = true;
          const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
          if (delay <= 0) {
            if (updateTimer) clearTimeout(updateTimer);
            updateTimer = undefined;
            emitUpdate();
            return;
          }
          updateTimer ??= setTimeout(() => {
            updateTimer = undefined;
            emitUpdate();
          }, delay);
        };
        const unsubscribe = manager.view.subscribeTo(started.id, scheduleUpdate);
        if (onUpdate) {
          try {
            onUpdate({ content: [], details: undefined });
          } catch {
            // Same display-only boundary.
          }
        }

        // A Code Mode script has no other work and gets no follow-up, so its
        // call waits for the exit. Esc or the script timeout still stops only
        // this wait.
        const waitForSettlement = () =>
          manager.waitForSettlement(
            started.id,
            nested ? undefined : (params.yield_time_ms ?? DEFAULT_YIELD_TIME_MS),
          );
        let waited: SettlementWaitResult | undefined;
        try {
          waited = await runTool(toolRuntime, waitForSettlement(), {
            signal,
            interruptMessage: TERMINAL_ERRORS.initialWaitAborted(started.id),
          });
        } catch (error) {
          // The user interrupted the initial wait (Esc): the process keeps
          // running and now counts as a yielded background terminal — return
          // that truth instead of a bare failure row.
          if (!signal?.aborted) throw error;
          const live = manager.view.get(started.id);
          if (live === undefined || live.status === "running") {
            return {
              content: [{ type: "text", text: TERMINAL_ERRORS.initialWaitAborted(started.id) }],
              details: { id: started.id, status: "running", yielded: true },
              structuredContent: bashStructuredContent(
                live ?? manager.view.get(started.id) ?? started,
              ),
              isError: true,
            };
          }
          // It settled in the same instant as the abort. The waiter may already
          // have consumed that settlement, so no follow-up would report it and
          // "continues in the background" would be false: return the final
          // result here. The path below consumes any deferred copy, keeping
          // delivery exactly-once.
          waited = { snapshot: live, settled: true };
        } finally {
          unsubscribe();
          if (updateTimer) clearTimeout(updateTimer);
        }
        const snap = waited.snapshot;

        // A quick completion is returned by this tool call. Remove any already
        // deferred result from the tiny start→wait registration race.
        if (waited.settled || snap.status !== "running") {
          resultDelivery.consume([snap.id]);
        }

        const text = buildBashResult(snap, {
          changedFiles: runChanges.changedDuring(snap.id),
        });
        const details: BashResultDetails = {
          id: snap.id,
          status: snap.status,
          yielded: snap.yielded === true,
        };
        if (snap.status === "failed" || snap.status === "timed_out" || snap.status === "killed") {
          // Match Pi's built-in bash contract: unsuccessful foreground results
          // are tool errors. Returned rather than thrown so the structured
          // status reaches the renderer. Yielded failures arrive later as
          // completion messages.
          return {
            content: [{ type: "text", text }],
            details,
            structuredContent: bashStructuredContent(snap),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text }],
          details,
          structuredContent: bashStructuredContent(snap),
        };
      },
    });

    pi.registerTool({
      name: "terminal_log_read",
      label: "terminal_log_read",
      description: TERMINAL_LOG_READ_TOOL_DESCRIPTION,
      promptSnippet: TERMINAL_LOG_READ_PROMPT_SNIPPET,
      parameters: Type.Object({
        ref: Type.String({
          description: TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS.ref,
        }),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS.offset,
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_TERMINAL_LOG_READ_BYTES,
            description: TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS.limit,
          }),
        ),
        tail: Type.Optional(
          Type.Boolean({
            description: TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS.tail,
          }),
        ),
        pattern: Type.Optional(
          Type.String({
            description: TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS.pattern,
          }),
        ),
      }),
      outputSchema: TerminalLogReadOutputSchema,
      executionMode: "sequential",
      // One compact row: the page itself is for the model, and /ps remains the
      // human viewer. Rendering a 64 KiB page into the transcript would bury it.
      renderCall(args, theme, context) {
        const ref = typeof args?.ref === "string" ? args.ref : "...";
        const suffix =
          typeof args?.pattern === "string"
            ? ` /${args.pattern}/`
            : args?.tail === true
              ? " tail"
              : typeof args?.offset === "number"
                ? ` @${args.offset}`
                : "";
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(
          `${theme.fg("toolTitle", theme.bold("terminal_log_read"))} ${theme.fg("accent", ref)}${theme.fg("dim", suffix)}`,
        );
        return text;
      },
      renderResult(result, _options, theme, context) {
        const details = result.details as TerminalLogReadResult | undefined;
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        if (!details) {
          // Show the actual failure (budget exhausted, unknown ref, expired
          // archive), not a blanket "archive unavailable".
          const message = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .split("\n")[0]
            ?.trim();
          text.setText(
            `${theme.fg("error", "x")} ${theme.fg("error", message || "archive unavailable")}`,
          );
          return text;
        }
        const summary =
          details.mode === "search"
            ? `${details.matchCount ?? 0} matches`
            : details.mode === "head_tail"
              ? `head+tail of ${formatSize(details.size)}`
              : `bytes ${details.offset}-${Math.max(details.offset, details.nextOffset - 1)} of ${formatSize(details.size)}`;
        text.setText(
          `${theme.fg("success", "■")} ${theme.fg("accent", `${details.id}:${details.stream}`)} ${theme.fg("muted", summary)}`,
        );
        return text;
      },
      async execute(toolCallId, params, signal) {
        // Nested (Code Mode) calls are exempt: their output reaches the
        // script, not the model context, so the run budgets do not apply.
        const nested = takeNested(toolCallId);
        const parsed = parseTerminalLogRef(params.ref);
        if (!parsed) {
          throw new Error(TERMINAL_ERRORS.invalidRef(params.ref));
        }
        const hasTail = params.tail === true;
        const hasPattern = params.pattern !== undefined;
        if (hasTail && (params.offset !== undefined || hasPattern)) {
          throw new Error(TERMINAL_ERRORS.tailConflict);
        }
        let pattern: RegExp | undefined;
        if (hasPattern) {
          try {
            pattern = new RegExp(params.pattern ?? "", "i");
          } catch (error) {
            throw new Error(
              TERMINAL_ERRORS.invalidPattern(
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        }
        // Two budgets, because either one alone is escapable: bytes bound a
        // firehose of full pages, calls bound a tiny-limit polling loop.
        if (!nested && terminalLogReadCalls >= TERMINAL_LOG_READ_RUN_CALLS) {
          throw new Error(TERMINAL_ERRORS.readCalls);
        }
        const remainingBytes = TERMINAL_LOG_READ_RUN_BUDGET - terminalLogReadBytes;
        if (!nested && remainingBytes <= 0) {
          throw new Error(TERMINAL_ERRORS.readBytes);
        }
        // Clamp to what is left rather than rejecting a request that exceeds
        // it — a page read short of the cap is still useful to the model.
        const limit = Math.min(
          MAX_TERMINAL_LOG_READ_BYTES,
          nested ? Number.POSITIVE_INFINITY : remainingBytes,
          Math.max(1, Math.floor(params.limit ?? DEFAULT_TERMINAL_LOG_READ_BYTES)),
        );
        if (!nested) terminalLogReadCalls++;
        const { runtime: toolRuntime, manager } = await getManager();
        const request = pattern
          ? { ...parsed, mode: "search" as const, pattern, offset: params.offset ?? 0, limit }
          : hasTail
            ? { ...parsed, mode: "tail" as const, limit }
            : params.offset !== undefined
              ? { ...parsed, mode: "page" as const, offset: params.offset, limit }
              : { ...parsed, mode: "auto" as const, limit };
        const result = await runTool(toolRuntime, manager.readLog(request), { signal });
        if (!nested) terminalLogReadBytes += result.bytesRead;
        return {
          content: [{ type: "text", text: formatTerminalLogRead(result) }],
          // The page text is already in content; repeating it here would store
          // every read twice in the session file. Code-mode scripts read
          // structuredContent instead of content, so the page lives there.
          details: { ...result, text: undefined },
          structuredContent: {
            id: result.id,
            stream: result.stream,
            mode: result.mode,
            offset: result.offset,
            nextOffset: result.nextOffset,
            bytesRead: result.bytesRead,
            size: result.size,
            settled: result.settled,
            complete: result.complete,
            text: result.text,
            // Mode-specific fields are absent rather than undefined so the
            // structured payload stays strict JSON.
            ...(result.omittedStart !== undefined
              ? { omittedStart: result.omittedStart, omittedEnd: result.omittedEnd }
              : {}),
            ...(result.matchCount !== undefined
              ? {
                  matchCount: result.matchCount,
                  matches: result.matches ? [...result.matches] : [],
                  pattern: result.pattern,
                }
              : {}),
          },
        };
      },
    });

    pi.registerTool({
      name: "terminal_wait",
      label: "terminal_wait",
      description: TERMINAL_WAIT_TOOL_DESCRIPTION,
      promptSnippet: TERMINAL_WAIT_PROMPT_SNIPPET,
      parameters: Type.Object({
        ids: Type.Optional(
          Type.Array(Type.String(), {
            description: TERMINAL_WAIT_PARAMETER_DESCRIPTIONS.ids,
          }),
        ),
        timeout: Type.Optional(
          Type.Integer({
            description: TERMINAL_WAIT_PARAMETER_DESCRIPTIONS.timeout,
          }),
        ),
      }),
      // Code Mode scripts resolve this schema to structured fields — including
      // on isError, where a text-only tool result would reject instead.
      outputSchema: TERMINAL_WAIT_OUTPUT_SCHEMA,
      renderCall(args, theme, context) {
        const ids = Array.isArray(args?.ids)
          ? (args.ids as unknown[]).filter((id) => typeof id === "string")
          : [];
        const label = ids.length > 0 ? ids.join(" ") : "all";
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(
          `${theme.fg("toolTitle", theme.bold("terminal_wait"))} ${theme.fg("accent", label)}`,
        );
        return text;
      },
      renderResult(result, _options, theme, context) {
        const details = result.details as
          | {
              settled?: Array<{ id: string; status: string; exitCode?: number; signal?: string }>;
              running?: string[];
              alreadyReported?: string[];
            }
          | undefined;
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        if (!details) {
          const message = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .split("\n")[0]
            ?.trim();
          text.setText(`${theme.fg("error", "x")} ${theme.fg("error", message || "wait failed")}`);
          return text;
        }
        const settled = details.settled ?? [];
        const running = details.running ?? [];
        let summary: string;
        if (settled.length > 0) {
          const first = settled[0];
          const word =
            first.status === "timed_out"
              ? "timed out"
              : first.status === "killed"
                ? "killed"
                : (first.signal ?? `exit ${first.exitCode ?? "?"}`);
          summary = `${first.id} ${word}${settled.length > 1 ? ` +${settled.length - 1} more` : ""}`;
        } else if (running.length > 0) {
          summary = `${running.length} still running`;
        } else {
          summary = "nothing pending";
        }
        const icon =
          context.isError || settled.some((s) => s.status === "failed" || s.status === "timed_out")
            ? theme.fg("error", "x")
            : theme.fg("success", "■");
        text.setText(
          `${icon} ${theme.fg("toolTitle", theme.bold("terminal_wait"))} ${theme.fg("muted", "·")} ${theme.fg("accent", summary)}`,
        );
        return text;
      },
      async execute(_toolCallId, params, signal) {
        const { runtime: toolRuntime, manager } = await getManager();
        const timeoutSeconds = Math.max(
          1,
          Math.min(
            MAX_TERMINAL_WAIT_SECONDS,
            Number.isFinite(params.timeout)
              ? Math.floor(params.timeout as number)
              : DEFAULT_TERMINAL_WAIT_SECONDS,
          ),
        );

        const clearSchedulerIfDrained = () => {
          if (resultDelivery.size() === 0) resultBatchScheduler.clear();
        };
        const respond = (
          settled: TerminalSnapshot[],
          alreadyReported: TerminalSnapshot[],
          running: TerminalSnapshot[],
        ) => {
          const text = buildTerminalWaitResult({
            settled,
            alreadyReported,
            running,
            timeoutSeconds,
            changedFiles: changedFilesFor(settled),
          });
          // Absent rather than undefined: structuredContent must be strict
          // JSON for code-mode consumers.
          const settledFields = settled.map((snap) => ({
            id: snap.id,
            status: snap.status,
            ...(snap.exitCode !== undefined ? { exitCode: snap.exitCode } : {}),
            ...(snap.signal !== undefined ? { signal: snap.signal } : {}),
          }));
          return {
            content: [{ type: "text" as const, text }],
            details: {
              settled: settledFields,
              running: running.map((snap) => snap.id),
              alreadyReported: alreadyReported.map((snap) => snap.id),
            },
            structuredContent: {
              settled: settledFields,
              running: running.map((snap) => snap.id),
              alreadyReported: alreadyReported.map((snap) => snap.id),
              text,
            },
            isError:
              settled.some((snap) => snap.status === "failed" || snap.status === "timed_out") ||
              undefined,
          };
        };

        const dedupedIds =
          params.ids === undefined
            ? undefined
            : [...new Set(params.ids.filter((id): id is string => typeof id === "string"))];
        // An empty list after filtering means "all running", like omission.
        const explicitIds =
          dedupedIds !== undefined && dedupedIds.length > 0 ? dedupedIds : undefined;

        if (explicitIds === undefined) {
          // Results already queued for delivery are returned by the wait
          // itself rather than also arriving as a follow-up message.
          const pending = resultDelivery.drain();
          clearSchedulerIfDrained();
          if (pending.length > 0) {
            // The default target set is every running background terminal, so
            // a queued result does not mean nothing is left: report what is
            // still running, or the script reads "nothing pending" and stops
            // waiting while a terminal it never asked about keeps going.
            const taken = new Set(pending.map((snap) => snap.id));
            const stillRunning = manager.view
              .list()
              .filter(
                (snap) => snap.status === "running" && snap.yielded === true && !taken.has(snap.id),
              );
            return respond(pending, [], stillRunning);
          }
          const targets = manager.view
            .list()
            .filter((snap) => snap.status === "running" && snap.yielded === true);
          if (targets.length === 0) throw new Error(TERMINAL_ERRORS.waitNothing);
          return await runWait(
            targets.map((snap) => snap.id),
            [],
          );
        }

        const pendingTaken = resultDelivery.take(explicitIds);
        const unknown = explicitIds.find(
          (id) =>
            manager.view.get(id) === undefined && pendingTaken.every((snap) => snap.id !== id),
        );
        if (unknown !== undefined) {
          for (const snap of pendingTaken) resultDelivery.defer(snap);
          throw new Error(
            TERMINAL_ERRORS.unknownTerminal(
              unknown,
              manager.view.list().map((snap) => snap.id),
            ),
          );
        }
        clearSchedulerIfDrained();
        const seen = manager.view.list();
        const targets = explicitIds
          .map((id) => seen.find((snap) => snap.id === id))
          .filter((snap): snap is TerminalSnapshot => snap !== undefined);
        const running = targets.filter((snap) => snap.status === "running");
        // A target returned from the pending queue is "settled", not
        // "already reported" — don't classify it twice.
        const pendingIds = new Set(pendingTaken.map((snap) => snap.id));
        const alreadyReported = targets.filter(
          (snap) => snap.status !== "running" && !pendingIds.has(snap.id),
        );
        if (pendingTaken.length > 0) {
          return respond(pendingTaken, alreadyReported, running);
        }
        if (running.length === 0) {
          return respond([], alreadyReported, []);
        }
        return await runWait(
          running.map((snap) => snap.id),
          alreadyReported,
        );

        async function runWait(runningIds: string[], reported: TerminalSnapshot[]) {
          let snapshots: ReadonlyArray<TerminalSnapshot>;
          try {
            snapshots = await runTool(
              toolRuntime,
              manager.waitForAny(runningIds, timeoutSeconds * 1000),
              { signal, interruptMessage: TERMINAL_ERRORS.waitAborted },
            );
          } catch (error) {
            // A registered waiter marks its settlement consumed *before*
            // onSettled runs, so an Esc that lands in that window suppresses
            // the follow-up while this await throws — the result would be lost
            // with nothing left to deliver it. Nothing was returned to the
            // model, so a follow-up is the only way it can still arrive.
            //
            // The re-defer is deferred one turn on purpose: onSettled for the
            // very settlement that triggered this abort may still be ahead of
            // us, and its `consumed` branch clears the queue entry we would
            // just have added. Letting that hook finish first makes the
            // re-defer the last word.
            queueMicrotask(() => {
              for (const id of runningIds) {
                const live = manager.view.get(id);
                if (live !== undefined && live.status !== "running") {
                  resultDelivery.defer(copySettled(live));
                }
              }
              scheduleResultFlush();
            });
            throw error;
          }
          const settled = snapshots.filter((snap) => snap.status !== "running");
          // Race guard: a consumed settle must never also sit in the
          // delivery queue.
          resultDelivery.take(settled.map((snap) => snap.id));
          clearSchedulerIfDrained();
          const stillRunning = snapshots.filter((snap) => snap.status === "running");
          return respond(settled.map(copySettled), reported, stillRunning);
        }
      },
    });

    pi.registerTool({
      name: "terminal_stop",
      label: "terminal_stop",
      description: TERMINAL_STOP_TOOL_DESCRIPTION,
      promptSnippet: TERMINAL_STOP_PROMPT_SNIPPET,
      parameters: Type.Object({
        id: Type.String({
          description: TERMINAL_STOP_PARAMETER_DESCRIPTIONS.id,
        }),
      }),
      renderCall(args, theme, context) {
        const id = typeof args?.id === "string" ? args.id : "...";
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(
          `${theme.fg("toolTitle", theme.bold("terminal_stop"))} ${theme.fg("accent", id)}`,
        );
        return text;
      },
      renderResult(result, _options, theme, context) {
        const details = result.details as { id?: string; status?: string } | undefined;
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        if (!details) {
          const message = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .split("\n")[0]
            ?.trim();
          text.setText(`${theme.fg("error", "x")} ${theme.fg("error", message || "stop failed")}`);
          return text;
        }
        text.setText(
          `${theme.fg("muted", "■")} ${theme.fg("toolTitle", theme.bold("terminal_stop"))} ${theme.fg("muted", "·")} ${theme.fg("accent", `${details.id ?? "?"} ${details.status ?? ""}`)}`,
        );
        return text;
      },
      async execute(_toolCallId, params, signal) {
        const { runtime: toolRuntime, manager } = await getManager();
        const existing = manager.view.get(params.id);
        if (!existing) {
          throw new Error(
            TERMINAL_ERRORS.unknownTerminal(
              params.id,
              manager.view.list().map((snap) => snap.id),
            ),
          );
        }
        const done = (snap: TerminalSnapshot, text: string) => ({
          content: [{ type: "text" as const, text }],
          details: { id: snap.id, status: snap.status },
        });
        if (existing.status !== "running") {
          // A result still queued for delivery is returned here; nothing may
          // report it twice.
          const pending = resultDelivery.take([params.id]);
          if (resultDelivery.size() === 0) resultBatchScheduler.clear();
          if (pending.length > 0) {
            return done(
              pending[0],
              buildTerminalResultMessage(
                pending[0],
                Number.POSITIVE_INFINITY,
                runChanges.changedDuring(pending[0].id),
              ),
            );
          }
          return done(existing, TERMINAL_STOP_TEXT.alreadyExited(existing));
        }
        let snap: TerminalSnapshot;
        try {
          snap = await runTool(toolRuntime, manager.stop(params.id), {
            signal,
            interruptMessage: TERMINAL_ERRORS.stopInterrupted,
          });
        } catch (error) {
          // `stop` registers a consumed waiter before starting the detached
          // kill, so an Esc that lands after the terminal settled would
          // otherwise discard a result nothing else can deliver. Termination
          // itself continues either way; only delivery needs reconciling.
          // Deferred one turn so the settle hook's own `consumed` clear cannot
          // wipe the entry we add here (see runWait above).
          queueMicrotask(() => {
            const live = manager.view.get(params.id);
            if (live !== undefined && live.status !== "running") {
              resultDelivery.defer(copySettled(live));
              scheduleResultFlush();
            }
          });
          throw error;
        }
        // Same race guard as terminal_wait: the consumed settle owns the result.
        resultDelivery.take([params.id]);
        if (resultDelivery.size() === 0) resultBatchScheduler.clear();
        if (snap.status === "running") {
          return done(snap, TERMINAL_STOP_TEXT.stillTerminating(snap.id));
        }
        return done(snap, TERMINAL_STOP_TEXT.stopped(snap));
      },
    });

    // --- Result message rendering ------------------------------------------

    pi.registerMessageRenderer("background-terminal-result", (message, _options, theme) => {
      interface ResultDetails {
        readonly id?: string;
        readonly status?: string;
        readonly exitCode?: number;
        readonly signal?: string;
      }
      const details = (message.details ?? {}) as ResultDetails & {
        readonly results?: readonly ResultDetails[];
      };
      const results = details.results?.length ? details.results : [details];
      const failedCount = results.filter((result) => result.status === "failed").length;
      const timedOutCount = results.filter((result) => result.status === "timed_out").length;
      const killedCount = results.filter((result) => result.status === "killed").length;
      const icon =
        failedCount > 0 || timedOutCount > 0
          ? theme.fg("error", "x")
          : killedCount === results.length
            ? theme.fg("muted", "■")
            : theme.fg("success", "■");

      let label: string;
      let how: string;
      if (results.length > 1) {
        label = `${results.length} terminals`;
        const outcomes = [
          failedCount > 0 ? `${failedCount} failed` : undefined,
          timedOutCount > 0 ? `${timedOutCount} timed out` : undefined,
          killedCount > 0 ? `${killedCount} killed` : undefined,
        ].filter(Boolean);
        how = outcomes.length > 0 ? outcomes.join(", ") : "completed";
      } else {
        const result = results[0];
        label = `terminal ${result.id ?? "?"}`;
        how =
          result.status === "killed"
            ? "killed"
            : result.status === "timed_out"
              ? "timed out"
              : (result.signal ?? `exit ${result.exitCode ?? "?"}`);
      }
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(label)) +
        theme.fg("muted", ` · ${how} · `) +
        theme.fg("accent", "/ps") +
        theme.fg("dim", " to inspect");

      // The message still carries bounded stdout/stderr for the model, but its
      // TUI renderer is always one line, including in expanded transcript mode.
      return new Text(header, 0, 0);
    });

    // --- Command ------------------------------------------------------------

    pi.registerCommand("ps", {
      description: "List and inspect background terminals",
      handler: async (_args, ctx) => {
        const { manager } = await getManager();
        if (ctx.mode !== "tui") {
          if (ctx.hasUI) {
            const terminals = manager.view.list();
            ctx.ui.notify(
              terminals.length === 0
                ? "No background terminals."
                : terminals.map((snap) => describeTerminal(snap)).join("\n"),
              "info",
            );
          }
          return;
        }
        if (manager.view.size() === 0) {
          ctx.ui.notify("No terminals yet — every bash call in this session appears here.", "info");
          return;
        }
        const { openTerminalPicker } = await import("./src/ui/ps.ts");
        await openTerminalPicker(ctx, manager.view);
      },
    });
  };
}

export default createBackgroundTerminalsExtension();
