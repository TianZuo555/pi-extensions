// pi-rex — the Rex SessionStart hook for the pi coding agent.
//
// `rex skill setup` writes a SessionStart hook for Claude Code and Codex that
// tells the agent it runs in a Rex terminal and which session and pane it is
// in. Rex has no hook for pi, so this extension runs the same command and adds
// its output to the system prompt as a `<rex>` section.
//
// The extension also names the Rex tab and session. On the first user prompt of
// a pi session it asks the current model for one short label, then runs
// `rex window rename` and, for the first tab of a session, `rex session
// rename`. Naming runs in the background, so the first response is not delayed.
// Set `rex.autoName` to false to turn it off.
//
// The extension also records the pi session of each Rex pane, so a shell hook
// can resume pi in that pane after a Rex restart. See `lib/resume.ts`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nameSession, REX_TIMEOUT_MS, type ExecResult } from "./lib/naming.ts";
import { AUTO_NAME_INSTRUCTION, REX_SECTION } from "./lib/prompt.ts";
import { registerResume } from "./lib/resume.ts";
import { stripSessionNaming } from "./lib/rex-output.ts";

/** Timeout for the naming model call. */
const NAMING_TIMEOUT_MS = 15000;

/** Name one session and tab. `true` unless the user turns it off. */
function autoNameEnabled(pi: ExtensionAPI): boolean {
  const rex = (pi.getSettings() as { rex?: unknown }).rex;
  if (typeof rex !== "object" || rex === null) return true;
  return (rex as { autoName?: unknown }).autoName !== false;
}

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

export default function rexExtension(pi: ExtensionAPI): void {
  let context = "";
  let autoName = true;
  let naming: Promise<void> | undefined;

  registerResume(pi);

  pi.on("session_start", async (_event, ctx) => {
    context = "";
    autoName = true;
    naming = undefined;
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
    autoName = autoNameEnabled(pi);
    if (autoName) output = `${stripSessionNaming(output)}\n\n${AUTO_NAME_INSTRUCTION}`;
    context = output;
  });

  pi.on("before_agent_start", (event, ctx) => {
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
}
