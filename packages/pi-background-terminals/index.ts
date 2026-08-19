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
import {
  SpawnError,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./src/domain.ts";
import {
  duplicateCommandError,
  findDuplicateRunning,
  isStateOnlyCommand,
  stateOnlyCommandError,
} from "./src/command-shape.ts";
import {
  EXPLORATION_LIMIT,
  explorationLimitError,
  explorationWarning,
  isExploratoryBashCommand,
} from "./src/exploration-budget.ts";
import {
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  MAX_TERMINAL_LOG_READ_BYTES,
  TerminalManager,
  type TerminalLogReadResult,
  type TerminalManagerShape,
} from "./src/manager.ts";
import {
  BASH_PARAMETER_DESCRIPTIONS,
  BASH_PROMPT_GUIDELINES,
  BASH_PROMPT_SNIPPET,
  BASH_TOOL_DESCRIPTION,
  buildBashProgress,
  buildBashResult,
  buildTerminalResultMessage,
  deriveCommandTitle,
  describeTerminal,
  TERMINAL_LOG_READ_PARAMETER_DESCRIPTIONS,
  TERMINAL_LOG_READ_PROMPT_SNIPPET,
  TERMINAL_LOG_READ_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createTerminalRuntime,
  runTool,
  type TerminalRuntime,
} from "./src/runtime.ts";
import { sanitizeText } from "./src/ui/output-view.ts";
import { openTerminalPicker } from "./src/ui/ps.ts";

const WIDGET_KEY = "background-terminals";
const UPDATE_THROTTLE_MS = 100;
const SESSION_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

type CompactTerminalStatus = TerminalStatus | "starting";

const TERMINAL_LOG_READ_RUN_BUDGET = MAX_TERMINAL_LOG_READ_BYTES * 4;
/** A byte budget alone cannot stop `limit: 1` polling; bound the calls too. */
const TERMINAL_LOG_READ_RUN_CALLS = 8;

function parseTerminalLogRef(ref: string) {
  const match = /^(bt-\d+):(stdout|stderr)$/.exec(ref);
  if (!match) return undefined;
  return {
    id: match[1],
    stream: match[2] as "stdout" | "stderr",
  };
}

function formatTerminalLogRead(result: TerminalLogReadResult) {
  const range = result.bytesRead === 0
    ? "empty"
    : `${result.offset}-${result.nextOffset - 1}`;
  return [
    `${result.id}:${result.stream} bytes ${range} of ${result.size}; ` +
      `settled: ${result.settled ? "yes" : "no"}; complete: ${result.complete ? "yes" : "no"}; next_offset: ${result.nextOffset}`,
    result.text || "(empty)",
  ].join("\n");
}

/** Extract manager-owned status from a model-facing Bash result. Output is
 * parsed separately only for the bounded quick-command preview. */
function compactTerminalState(
  text: string,
  isPartial: boolean,
  isError: boolean,
): { readonly id?: string; readonly status: CompactTerminalStatus } {
  const metadata = text.split("\n\nstdout:", 1)[0] ?? "";
  const described = metadata.match(
    /\b(bt-\d+) \[(running|done|failed|timed_out|killed)\]/,
  );
  const id = described?.[1] ?? metadata.match(/\bterminal (bt-\d+)\b/i)?.[1];
  const describedStatus = described?.[2] as TerminalStatus | undefined;

  if (describedStatus) return { id, status: describedStatus };
  if (/timed out/i.test(metadata)) return { id, status: "timed_out" };
  if (/\b(killed|SIGKILL|SIGTERM)\b/i.test(metadata)) {
    return { id, status: "killed" };
  }
  if (/still running|running as terminal/i.test(metadata)) {
    return { id, status: "running" };
  }
  if (isError) return { id, status: "failed" };
  if (isPartial) return { id, status: id ? "running" : "starting" };
  return { id, status: "done" };
}

function quickOutputPreview(text: string, maxLines: number) {
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
        !/^\[(?:stdout|stderr) bounded head\+tail:/i.test(line) &&
        line !== "stdout: (empty)",
    )
    .map((line) =>
      line.length <= 240 ? line : `${line.slice(0, 237)}...`,
    );
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
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const hasBinDir = currentPath
    .split(path.delimiter)
    .filter(Boolean)
    .includes(binDir);

  return {
    ...process.env,
    [pathKey]: hasBinDir
      ? currentPath
      : [binDir, currentPath].filter(Boolean).join(path.delimiter),
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
  const makeForegroundBash =
    dependencies.createForegroundBash ?? createBashToolDefinition;
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
  let managerPromise: Promise<TerminalManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let exploratoryCallCount = 0;
  const exploratoryToolCalls = new Set<string>();
  let terminalLogReadBytes = 0;
  let terminalLogReadCalls = 0;
  const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();

  const resetExplorationBudget = () => {
    exploratoryCallCount = 0;
    exploratoryToolCalls.clear();
    terminalLogReadBytes = 0;
    terminalLogReadCalls = 0;
  };

  const getRuntime = () => (runtime ??= makeRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(TerminalManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateWidget(manager));
        updateWidget(manager);
        return manager;
      });
    return managerPromise;
  };

  /** One-line widget directly above the editor, only while ≥1 is running.
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
        .filter((snap) => snap.status === "running").length;
      if (running === widgetRunning) return;
      widgetRunning = running;
      if (running === 0) {
        ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("warning", "■ ") +
          theme.fg(
            "text",
            `${running} background terminal${running === 1 ? "" : "s"} running`,
          ) +
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

  const deliverResult = (snap: TerminalSnapshot) => {
    try {
      pi.sendMessage(
        {
          customType: "background-terminal-result",
          content: buildTerminalResultMessage(snap),
          display: true,
          details: {
            id: snap.id,
            title: snap.title,
            status: snap.status,
            exitCode: snap.exitCode,
            signal: snap.signal,
          },
        },
        // followUp: queued until the agent has no more tool calls — never
        // interrupts a mid-turn stream. triggerTurn: wakes the model
        // immediately iff idle; if busy, the queued follow-up is delivered
        // when the current run settles. Either way exactly one delivery.
        { deliverAs: "followUp", triggerTurn: true },
      );
      return true;
    } catch (error) {
      // Session may be shutting down, but retain the snapshot so any later
      // agent-settled flush can retry instead of silently dropping it.
      if (sessionContext?.mode !== "tui") {
        console.error("background-terminals: failed to deliver result", error);
      }
      return false;
    }
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) {
      if (!deliverResult(snap)) resultDelivery.defer(snap);
    }
  };

  const onSettled = (snap: TerminalSnapshot, consumed: boolean) => {
    if (consumed) {
      // The initial bash wait is returning this settlement itself.
      resultDelivery.consume([snap.id]);
      return;
    }
    // Defer a deep-enough copy: the live snapshot's output views keep
    // mutating (late flushes) after settle.
    resultDelivery.defer({
      ...snap,
      stdout: { ...snap.stdout },
      stderr: { ...snap.stderr },
    });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    resetExplorationBudget();
    if (ctx.hasUI) ui = ctx.ui;
  });

  // One agent run can contain many model/tool turns. Bound repeated shell-based
  // inspection across that whole run, then reset for the next user/follow-up
  // run rather than per turn (which would let a two-calls-per-turn loop evade
  // the guardrail indefinitely).
  pi.on("agent_start", resetExplorationBudget);

  // Drain deferred results when the agent settles: together with the
  // isIdle() fast path above and the Map-keyed delivery (drain clears),
  // double delivery is structurally impossible — whoever drains first wins.
  pi.on("agent_settled", flushResults);

  // /new, /resume, /fork, /reload, and quit all emit session_shutdown for
  // the old extension instance. Processes never survive a session
  // transition: disposing the runtime runs the manager finalizer →
  // disposeAll → every entry scope → SIGTERM→SIGKILL tree kill, each close
  // bounded so a wedged process cannot hang shutdown.
  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resetExplorationBudget();
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
    promptGuidelines: BASH_PROMPT_GUIDELINES,
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
      const explicitTitle =
        typeof args?.title === "string" ? args.title : undefined;
      const title = command
        ? deriveCommandTitle(command, explicitTitle)
        : "...";
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`$ ${title}`)));
      return text;
    },
    renderResult(result, { isPartial }, theme, context) {
      const rawText = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const summary = compactTerminalState(
        rawText,
        isPartial,
        context.isError,
      );
      const word = summary.status === "timed_out"
        ? "timed out"
        : summary.status;
      const icon = summary.status === "failed" || summary.status === "timed_out"
        ? theme.fg("error", "x")
        : summary.status === "done"
          ? theme.fg("success", "■")
          : summary.status === "killed"
            ? theme.fg("muted", "■")
            : theme.fg("warning", "■");
      const statusColor = summary.status === "failed" || summary.status === "timed_out"
        ? "error"
        : summary.status === "done"
          ? "success"
          : summary.status === "killed"
            ? "muted"
            : "warning";
      let body = summary.id
        ? `${icon} ${theme.fg("accent", theme.bold(`terminal ${summary.id}`))} ${theme.fg(statusColor, word)}${theme.fg("dim", " · ")}${theme.fg("accent", "/ps")}${theme.fg("dim", " to inspect")}`
        : `${icon} ${theme.fg(statusColor, `bash ${word}`)}${theme.fg("dim", " · ")}${theme.fg("accent", "/ps")}${theme.fg("dim", " for details")}`;
      // Quick foreground completions and initial-wait progress show a small
      // human-facing preview. Once a command actually yields, its transcript
      // row returns to one compact /ps-owned background-terminal line.
      if (!summary.id) {
        const preview = quickOutputPreview(rawText, isPartial ? 4 : 6);
        if (preview.length > 0) {
          body += `\n${preview
            .map((line) => theme.fg("toolOutput", line))
            .join("\n")}`;
        }
      }
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(body);
      return text;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Preserve the exact command text. Trimming here can break heredocs and
      // multiline scripts; trim only for validation and the display title.
      const command = params.command;
      if (!command.trim()) throw new Error("command must not be empty.");

      // The shell is discarded at exit, so a command that only mutates shell
      // state cannot affect anything. Left to run it would exit 0 and let the
      // model believe the directory or variable persists into the next call.
      if (isStateOnlyCommand(command)) throw new Error(stateOnlyCommandError());

      let explorationNote: string | undefined;
      if (isExploratoryBashCommand(command)) {
        if (!exploratoryToolCalls.has(toolCallId)) {
          exploratoryToolCalls.add(toolCallId);
          exploratoryCallCount++;
        }
        if (exploratoryCallCount > EXPLORATION_LIMIT) {
          throw new Error(explorationLimitError());
        }
        explorationNote = explorationWarning(exploratoryCallCount);
      }

      if (
        params.timeout !== undefined &&
        (!Number.isFinite(params.timeout) ||
          params.timeout <= 0 ||
          params.timeout > MAX_RUNTIME_TIMEOUT_SECONDS)
      ) {
        throw new Error(
          `timeout must be a finite number of seconds in (0, ${MAX_RUNTIME_TIMEOUT_SECONDS}].`,
        );
      }

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      try {
        if (!fs.statSync(cwd).isDirectory()) {
          throw new Error("not a directory");
        }
      } catch {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      // Preserve Pi's built-in shellPath and shellCommandPrefix settings even
      // though this extension replaces the built-in definition.
      const { shellPath, commandPrefix } = resolveShellSettings(ctx);
      const executionCommand = commandPrefix
        ? `${commandPrefix}\n${command}`
        : command;

      // Keep the work-bearing part visible when a model prefixes every call
      // with the same long D=/path assignment or `cd ... &&`.
      const title = deriveCommandTitle(command, params.title);

      const runForegroundFallback = async (
        reason: unknown,
        resetManagedRuntime: boolean,
      ) => {
        if (resetManagedRuntime) {
          const brokenRuntime = runtime;
          runtime = undefined;
          managerPromise = undefined;
          await brokenRuntime?.dispose().catch(() => {});
        }
        const reasonText = reason instanceof Error ? reason.message : String(reason);
        const warning =
          `[Managed bash unavailable before spawn; using Pi's foreground bash fallback — ` +
          `no auto-yield or /ps tracking for this call. Reason: ${reasonText.slice(0, 500)}]`;
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
            content: [
              { type: "text" as const, text: warning },
              ...(explorationNote
                ? [{ type: "text" as const, text: explorationNote }]
                : []),
              ...result.content,
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${warning}\n\n${message}`);
        }
      };

      let manager: TerminalManagerShape;
      try {
        manager = await getManager();
      } catch (managerError) {
        // Manager resolution precedes start(), so no child can exist yet.
        return await runForegroundFallback(managerError, true);
      }

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
      try {
        started = await runTool(
          getRuntime(),
          manager.start({
            command,
            executionCommand,
            shellPath,
            title,
            cwd,
            env,
            timeoutMs:
              params.timeout === undefined ? undefined : params.timeout * 1000,
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
        if (!snap || snap.status !== "running") return;
        try {
          onUpdate({
            content: [{ type: "text", text: buildBashProgress(snap) }],
            details: undefined,
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

      let waited;
      try {
        waited = await runTool(
          getRuntime(),
          manager.waitForSettlement(
            started.id,
            params.yield_time_ms ?? DEFAULT_YIELD_TIME_MS,
          ),
          {
            signal,
            interruptMessage: `Initial wait aborted; ${started.id} continues in the background and will report when it exits.`,
          },
        );
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

      let text = buildBashResult(snap);
      if (explorationNote) text += `\n\n${explorationNote}`;
      if (
        snap.status === "failed" ||
        snap.status === "timed_out" ||
        snap.status === "killed"
      ) {
        // Match Pi's built-in bash contract: unsuccessful foreground results
        // are tool errors. Yielded failures arrive later as completion messages.
        throw new Error(text);
      }
      return {
        content: [{ type: "text", text }],
        // Exact BashToolDetails-compatible shape. Model-facing output uses
        // opaque archive references rather than private spill paths.
        details: undefined,
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
    }),
    executionMode: "sequential",
    // One compact row: the page itself is for the model, and /ps remains the
    // human viewer. Rendering a 64 KiB page into the transcript would bury it.
    renderCall(args, theme, context) {
      const ref = typeof args?.ref === "string" ? args.ref : "...";
      const offset = typeof args?.offset === "number" ? args.offset : 0;
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        `${theme.fg("toolTitle", theme.bold("terminal_log_read"))} ${theme.fg("accent", ref)}${theme.fg("dim", ` @${offset}`)}`,
      );
      return text;
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as TerminalLogReadResult | undefined;
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (!details) {
        text.setText(
          `${theme.fg("error", "x")} ${theme.fg("error", "archive unavailable")}`,
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
        throw new Error(
          `Invalid terminal log ref "${params.ref}"; expected bt-N:stdout or bt-N:stderr.`,
        );
      }
      const limit = Math.min(
        MAX_TERMINAL_LOG_READ_BYTES,
        Math.max(1, Math.floor(params.limit ?? MAX_TERMINAL_LOG_READ_BYTES)),
      );
      // Two budgets, because either one alone is escapable: bytes bound a
      // firehose of full pages, calls bound a tiny-limit polling loop.
      if (terminalLogReadCalls >= TERMINAL_LOG_READ_RUN_CALLS) {
        throw new Error(
          `terminal_log_read budget exhausted for this agent run (maximum ${TERMINAL_LOG_READ_RUN_CALLS} reads). ` +
            "Work with the output you already have; the user can inspect the full log with /ps.",
        );
      }
      if (terminalLogReadBytes + limit > TERMINAL_LOG_READ_RUN_BUDGET) {
        throw new Error(
          `terminal_log_read budget exhausted for this agent run (maximum ${TERMINAL_LOG_READ_RUN_BUDGET} bytes). ` +
            "Work with the output you already have; the user can inspect the full log with /ps.",
        );
      }
      terminalLogReadCalls++;
      const manager = await getManager();
      const result = await runTool(
        getRuntime(),
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
        // every read twice in the session file.
        details: { ...result, text: undefined },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "background-terminal-result",
    (message, _options, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        status?: string;
        exitCode?: number;
        signal?: string;
      };
      const failed = details.status === "failed";
      const timedOut = details.status === "timed_out";
      const killed = details.status === "killed";
      const icon = failed || timedOut
        ? theme.fg("error", "x")
        : killed
          ? theme.fg("muted", "■")
          : theme.fg("success", "■");
      const how = killed
        ? "killed"
        : timedOut
          ? "timed out"
          : (details.signal ?? `exit ${details.exitCode ?? "?"}`);
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`terminal ${details.id ?? "?"}`)) +
        theme.fg("muted", ` · ${how} · `) +
        theme.fg("accent", "/ps") +
        theme.fg("dim", " to inspect");

      // The message still carries bounded stdout/stderr for the model, but its
      // TUI renderer is always one line, including in expanded transcript mode.
      return new Text(header, 0, 0);
    },
  );

  // --- Command ------------------------------------------------------------

  pi.registerCommand("ps", {
    description: "List and inspect background terminals",
    handler: async (_args, ctx) => {
      const manager = await getManager();
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
        ctx.ui.notify(
          "No background terminals yet. Long bash runs appear here.",
          "info",
        );
        return;
      }
      await openTerminalPicker(ctx, manager.view);
    },
  });
  };
}

export default createBackgroundTerminalsExtension();
