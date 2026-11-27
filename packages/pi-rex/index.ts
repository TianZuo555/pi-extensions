// pi-rex — the Rex SessionStart hook for the pi coding agent.
//
// `rex skill setup` writes a SessionStart hook for Claude Code and Codex that
// tells the agent it runs in a Rex terminal and which session and pane it is
// in. Rex has no hook for pi, so this extension runs the same command and adds
// its output to the system prompt as a `<rex>` section.
//
// The extension also names the Rex session and tab. The session takes its name
// from the project folder, or from the worktree and branch. On the first user
// prompt of a pi session it asks the current model for one short tab label,
// then runs `rex window rename` and, for the first tab of a session,
// `rex session rename`. Naming runs in the background, so the first response is
// not delayed. Set `rex.autoName` to false to turn it off.
//
// The extension also gives the agent one tool, `rex_worktree_move`, that moves
// this Rex tab and the pi session into a git worktree. See
// `lib/worktree-move.ts`.
//
// Rex starts pi again in a restored pane by itself. The extension removes the
// resume hook that version 0.4 installed. See `lib/cleanup.ts`.

import {
  getAgentDir,
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createRexActivityReporter, summarizeActivity } from "./lib/activity.ts";
import { removeLegacyResume } from "./lib/cleanup.ts";
import { nameSession, REX_TIMEOUT_MS, type ExecResult } from "./lib/naming.ts";
import { AUTO_NAME_INSTRUCTION, REX_SECTION } from "./lib/prompt.ts";
import { stripSessionNaming } from "./lib/rex-output.ts";
import { rexSetting } from "./lib/settings.ts";
import { registerWorktreeMove } from "./lib/worktree-move.ts";

/** Timeout for the naming model call. */
const NAMING_TIMEOUT_MS = 15000;

/**
 * Ask the session model for one label. Returns an empty string when the model
 * is missing or the request fails.
 */
async function askModel(ctx: ExtensionContext, prompt: string): Promise<string> {
  const model = ctx.model;
  if (!model) return "";
  try {
    const message = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 200,
        reasoning: "minimal",
        timeoutMs: NAMING_TIMEOUT_MS,
        maxRetries: 0,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (message.stopReason === "error") return "";
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

function rexSessionSelector(): string | undefined {
  return process.env.REX_SESSION || process.env.REX_BLOCK;
}

function latestAssistantError(messages: AgentEndEvent["messages"]): string | undefined {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (assistant?.stopReason !== "error") return undefined;
  return summarizeActivity(assistant.errorMessage ?? "Pi request failed");
}

export default function rexExtension(pi: ExtensionAPI): void {
  const activity = createRexActivityReporter();
  let context = "";
  let autoName = true;
  let naming: Promise<void> | undefined;
  let activityEnabled = false;
  let activityRunning = false;
  let activityTask = "pi";
  let activityError: string | undefined;
  let openPrompts = 0;
  let cleaned = false;

  const reportWorking = (): void => {
    if (activityRunning && openPrompts === 0) activity.working(activityTask);
  };

  registerWorktreeMove(pi);

  pi.on("session_start", async (_event, ctx) => {
    context = "";
    autoName = true;
    naming = undefined;
    activityRunning = false;
    activityTask = "pi";
    activityError = undefined;
    openPrompts = 0;
    const session = rexSessionSelector();
    activityEnabled = Boolean(session) && ctx.mode === "tui";
    if (!session) return;
    // Once per process, in the TUI only: a print run must not change files.
    if (!cleaned && ctx.mode === "tui") {
      cleaned = true;
      for (const file of removeLegacyResume({ agentDir: getAgentDir() })) {
        ctx.ui.notify(`pi-rex: removed the old resume hook from ${file}`, "info");
      }
    }
    const result = await pi.exec("rex", ["__internal", "session-start", "--agent", "pi"], {
      cwd: ctx.cwd,
      timeout: REX_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      ctx.ui.notify(
        `rex session-start failed (exit ${result.code}): ${result.stderr.trim()}`,
        "warning",
      );
      return;
    }
    let output = result.stdout.trim();
    if (!output) return;
    autoName = rexSetting(pi, "autoName");
    if (autoName) output = `${stripSessionNaming(output)}\n\n${AUTO_NAME_INSTRUCTION}`;
    context = output;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (activityEnabled) {
      const prompt = event.messageType === "user" ? summarizeActivity(event.prompt) : "";
      activityTask = prompt || ctx.sessionManager.getSessionName() || "pi";
      activityError = undefined;
      activityRunning = true;
      reportWorking();
    }

    if (context) event.systemPromptOptions.sections[REX_SECTION] = context;
    const session = rexSessionSelector();
    if (!context || !autoName || naming || !session) return;
    if (event.messageType !== "user" || event.prompt.trim().length === 0) return;
    naming = nameSession({
      session,
      cwd: ctx.cwd,
      task: event.prompt,
      exec: async (command, args, options): Promise<ExecResult> => {
        const result = await pi.exec(command, args, options);
        return { code: result.code, stdout: result.stdout };
      },
      ask: (prompt) => askModel(ctx, prompt),
    }).catch(() => undefined);
  });

  pi.on("agent_start", () => {
    activityError = undefined;
    reportWorking();
  });

  pi.on("agent_end", (event) => {
    if (activityRunning) activityError = latestAssistantError(event.messages);
  });

  pi.on("ui_prompt_start", () => {
    if (!activityEnabled) return;
    openPrompts += 1;
    if (activityRunning) activity.clear();
  });

  pi.on("ui_prompt_end", () => {
    if (openPrompts === 0) return;
    openPrompts -= 1;
    reportWorking();
  });

  pi.on("agent_settled", (event) => {
    if (!activityRunning) return;
    activityRunning = false;
    if (event.aborted) {
      activity.idle();
    } else if (activityError) {
      activity.error(activityError);
    } else {
      activity.done(activityTask);
    }
  });

  pi.on("session_shutdown", (event) => {
    activityEnabled = false;
    activityRunning = false;
    openPrompts = 0;
    if (event.reason !== "quit") activity.clear();
  });
}
