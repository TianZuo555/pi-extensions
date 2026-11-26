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
// The extension also records the pi session of each Rex pane, so a shell hook
// can resume pi in that pane after a Rex restart. See `lib/resume.ts`.

import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createRexActivityReporter, summarizeActivity } from "./lib/activity.ts";
import { nameSession, REX_TIMEOUT_MS, type ExecResult } from "./lib/naming.ts";
import { AUTO_NAME_INSTRUCTION, REX_SECTION } from "./lib/prompt.ts";
import { registerResume } from "./lib/resume.ts";
import { stripSessionNaming } from "./lib/rex-output.ts";
import { rexSetting } from "./lib/settings.ts";

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
  let activityTask = "";
  let activityError: string | undefined;

  const sessionName = (ctx: ExtensionContext): string =>
    ctx.sessionManager.getSessionName() ?? "pi";
  const reportWorking = (ctx: ExtensionContext): void => {
    activity.working(activityTask || sessionName(ctx));
  };

  registerResume(pi);

  pi.on("session_start", async (_event, ctx) => {
    context = "";
    autoName = true;
    naming = undefined;
    activityTask = "";
    activityError = undefined;
    activity.reset();
    const session = process.env.REX_SESSION;
    if (!session) return;
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
    if (event.messageType === "user" && event.prompt.trim().length > 0) {
      activityTask = summarizeActivity(event.prompt) || sessionName(ctx);
      activityError = undefined;
      reportWorking(ctx);
    }

    if (context) event.systemPromptOptions.sections[REX_SECTION] = context;
    const session = process.env.REX_SESSION;
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

  pi.on("agent_start", (_event, ctx) => {
    activityError = undefined;
    reportWorking(ctx);
  });

  pi.on("agent_end", (event) => {
    activityError = latestAssistantError(event.messages);
  });

  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!ctx.isIdle()) reportWorking(ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) {
      activity.idle();
    } else if (activityError) {
      activity.error(activityError);
    } else {
      activity.done(activityTask || sessionName(ctx));
    }
  });
}
