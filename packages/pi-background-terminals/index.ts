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
 * full-screen overlay (list → read-only detail with stdout/stderr toggle).
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
  getAgentDir,
  getMarkdownTheme,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SpawnError, type TerminalSnapshot } from "./src/domain.ts";
import {
  DEFAULT_YIELD_TIME_MS,
  MAX_RUNTIME_TIMEOUT_SECONDS,
  TerminalManager,
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
  describeTerminal,
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
  const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();

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
        return { render: () => [line], invalidate: () => {} };
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
    if (ctx.hasUI) ui = ctx.ui;
  });

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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Preserve the exact command text. Trimming here can break heredocs and
      // multiline scripts; trim only for validation and the display title.
      const command = params.command;
      if (!command.trim()) throw new Error("command must not be empty.");

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

      // Collapse whitespace before bounding: titles render in one-line rows.
      const title =
        (params.title ?? command).replace(/\s+/g, " ").trim().slice(0, 80) ||
        "command";

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
          `[Managed bash unavailable before spawn; using Pi's foreground bash fallback. ` +
          `Automatic yielding and /ps tracking are unavailable for this call. Reason: ${reasonText.slice(0, 500)}]`;
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

      const text = buildBashResult(snap);
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
        // Exact BashToolDetails-compatible shape. Paths remain in bounded text
        // because stdout and stderr have separate complete spill files.
        details: undefined,
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "background-terminal-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
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
        theme.fg("muted", ` · ${details.title ?? ""} · ${how}`);

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line; the Error line (when present) is part
      // of the actual result and must remain visible. The body carries raw
      // process output — sanitize ANSI/control chars or the transcript smears.
      const body = sanitizeText(content.split("\n").slice(1).join("\n").trim());

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
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
