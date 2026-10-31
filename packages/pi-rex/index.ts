// pi-rex — the Rex SessionStart hook for the pi coding agent.
//
// `rex skill setup` installs a SessionStart hook for Claude Code and Codex
// that tells the agent it runs in a Rex terminal and which session and pane
// it is in. Rex has no hook for pi, so this extension runs the same command
// and adds its output to the system prompt as a `<rex>` section.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rexExtension(pi: ExtensionAPI): void {
  let context = "";

  pi.on("session_start", async (_event, ctx) => {
    context = "";
    if (!process.env.REX_SESSION) return;
    const result = await pi.exec("rex", ["__internal", "session-start", "--agent", "pi"], {
      cwd: ctx.cwd,
      timeout: 5000,
    });
    if (result.code !== 0) {
      ctx.ui.notify(
        `rex session-start failed (exit ${result.code}): ${result.stderr.trim()}`,
        "warning",
      );
      return;
    }
    context = result.stdout.trim();
  });

  pi.on("before_agent_start", (event) => {
    if (context) event.systemPromptOptions.sections.rex = context;
  });
}
