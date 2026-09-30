/**
 * Background terminals — execute no-stdin shell commands that automatically
 * yield into the background when they outlive a bounded initial wait.
 *
 * One tool for the LLM:
 * - bash: overrides Pi's built-in bash, returns final output when the command
 *   finishes promptly, otherwise returns a terminal id and notifies exactly
 *   once when it exits. Inspection and termination remain user-owned via /ps.
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
import { SpawnError, type TerminalSnapshot, type TerminalStatus } from "./src/domain.ts";
import { findDuplicateRunning, isStateOnlyCommand } from "./src/command-shape.ts";
import {
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  MAX_TERMINAL_LOG_READ_BYTES,
  TERMINAL_LOG_READ_RUN_BUDGET,
  TERMINAL_LOG_READ_RUN_CALLS,
} from "./src/constants.ts";
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
  stateOnlyCommandError,
  BASH_PARAMETER_DESCRIPTIONS,
  BASH_PROMPT_SNIPPET,
  BASH_TOOL_DESCRIPTION,
  buildBashProgress,
  buildBashResult,
  buildTerminalResultBatchMessage,
  deriveCommandTitle,
  describeTerminal,
  TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS,
  TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS,
  TERMINAL_LOG_READ_PROMPT_SNIPPET,
  TERMINAL_LOG_READ_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
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
  offset: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.offset }),
  nextOffset: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.nextOffset }),
  bytesRead: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.bytesRead }),
  size: Type.Integer({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.size }),
  settled: Type.Boolean({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.settled }),
  complete: Type.Boolean({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.complete }),
  text: Type.String({ description: TERMINAL_LOG_READ_OUTPUT_FIELD_DESCRIPTIONS.text }),
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
  const match = /^(bt-[a-f0-9]{16}-\d+):(stdout|stderr)$/.exec(ref);
  if (!match) return undefined;
  return {
    id: match[1],
    stream: match[2] as "stdout" | "stderr",
  };
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
            content: buildTerminalResultBatchMessage(snaps),
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
          { deliverAs: "steer", triggerTurn: true },
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

    const flushResults = () => {
      const snaps = resultDelivery.drain();
      if (!deliverResults(snaps)) {
        for (const snap of snaps) resultDelivery.defer(snap);
      }
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
      resultDelivery.defer({
        ...snap,
        stdout: { ...snap.stdout },
        stderr: { ...snap.stderr },
      });
      scheduleResultFlush();
    };

    pi.on("session_start", (_event, ctx) => {
      sessionContext = ctx;
      resetTerminalLogBudget();
      if (ctx.hasUI) ui = ctx.ui;
    });

    // One agent run can contain many model/tool turns. The terminal_log_read
    // byte/call budget spans the whole run, then resets for the next
    // user/follow-up run rather than per turn.
    pi.on("agent_start", resetTerminalLogBudget);

    // A result still inside its quiet window when the model ends its turn
    // would otherwise settle the run and wake a new one moments later — or be
    // lost when print/json mode exits on settlement. Deliver it now: the steer
    // is queued before settlement, so pi continues this same run with it.
    pi.on("agent_before_settle", (event) => {
      if (event.outcome !== "completed" || resultDelivery.size() === 0) return;
      resultBatchScheduler.clear();
      flushResults();
    });

    // Retry a batch whose delivery failed (results were re-deferred).
    pi.on("agent_settled", scheduleResultFlush);

    // /new, /resume, /fork, /reload, and quit all emit session_shutdown for
    // the old extension instance. Processes never survive a session
    // transition: disposing the runtime runs the manager finalizer →
    // disposeAll → every entry scope → SIGTERM→SIGKILL tree kill, each close
    // bounded so a wedged process cannot hang shutdown.
    pi.on("session_shutdown", async () => {
      sessionContext = undefined;
      resetTerminalLogBudget();
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

        const waitForSettlement = () =>
          manager.waitForSettlement(started.id, params.yield_time_ms ?? DEFAULT_YIELD_TIME_MS);
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

        const text = buildBashResult(snap);
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
          return { content: [{ type: "text", text }], details, isError: true };
        }
        return { content: [{ type: "text", text }], details };
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
      }),
      outputSchema: TerminalLogReadOutputSchema,
      executionMode: "sequential",
      // One compact row: the page itself is for the model, and /ps remains the
      // human viewer. Rendering a 64 KiB page into the transcript would bury it.
      renderCall(args, theme, context) {
        const ref = typeof args?.ref === "string" ? args.ref : "...";
        const offset = typeof args?.offset === "number" ? args.offset : 0;
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(
          `${theme.fg("toolTitle", theme.bold("terminal_log_read"))} ${theme.fg("accent", ref)}${theme.fg("dim", ` @${offset}`)}`,
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
        text.setText(
          `${theme.fg("success", "■")} ${theme.fg("accent", `${details.id}:${details.stream}`)} ${theme.fg(
            "muted",
            `bytes ${details.offset}-${Math.max(details.offset, details.nextOffset - 1)} of ${formatSize(details.size)}`,
          )}`,
        );
        return text;
      },
      async execute(_toolCallId, params) {
        const parsed = parseTerminalLogRef(params.ref);
        if (!parsed) {
          throw new Error(TERMINAL_ERRORS.invalidRef(params.ref));
        }
        // Two budgets, because either one alone is escapable: bytes bound a
        // firehose of full pages, calls bound a tiny-limit polling loop.
        if (terminalLogReadCalls >= TERMINAL_LOG_READ_RUN_CALLS) {
          throw new Error(TERMINAL_ERRORS.readCalls);
        }
        const remainingBytes = TERMINAL_LOG_READ_RUN_BUDGET - terminalLogReadBytes;
        if (remainingBytes <= 0) {
          throw new Error(TERMINAL_ERRORS.readBytes);
        }
        // Clamp to what is left rather than rejecting a request that exceeds
        // it — a page read short of the cap is still useful to the model.
        const limit = Math.min(
          MAX_TERMINAL_LOG_READ_BYTES,
          remainingBytes,
          Math.max(1, Math.floor(params.limit ?? MAX_TERMINAL_LOG_READ_BYTES)),
        );
        terminalLogReadCalls++;
        const { runtime: toolRuntime, manager } = await getManager();
        const result = await runTool(
          toolRuntime,
          manager.readLog({
            ...parsed,
            offset: params.offset ?? 0,
            limit,
          }),
        );
        terminalLogReadBytes += result.bytesRead;
        return {
          content: [{ type: "text", text: formatTerminalLogRead(result) }],
          // The page text is already in content; repeating it here would store
          // every read twice in the session file. Code-mode scripts read
          // structuredContent instead of content, so the page lives there.
          details: { ...result, text: undefined },
          structuredContent: {
            id: result.id,
            stream: result.stream,
            offset: result.offset,
            nextOffset: result.nextOffset,
            bytesRead: result.bytesRead,
            size: result.size,
            settled: result.settled,
            complete: result.complete,
            text: result.text,
          },
        };
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
