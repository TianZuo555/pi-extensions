// pi-rex — the Rex SessionStart hook for the pi coding agent.
//
// `rex skill setup` writes a SessionStart hook for Claude Code and Codex that
// tells the agent it runs in a Rex terminal and which session and pane it is
// in. Rex has no hook for pi, so this extension runs the same command and adds
// its output to the system prompt as a `<rex>` section.
//
// Two additions on top of the Rex output:
// - When the session has more than one tab, the session label is kept. A tab
//   must not rename its parent session.
// - Set `rex.renameTab` to true in the pi settings to also tell pi to name the
//   Rex tab. Tab naming is off by default.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { countWindows, stripSessionNaming } from "./lib/rex-output.ts";
import { KEEP_SESSION_INSTRUCTION, REX_SECTION, TAB_RENAME_INSTRUCTION } from "./lib/prompt.ts";

interface RexSettings {
  renameTab?: boolean;
}

/** Read `rex.renameTab`. Anything other than `true` keeps tab naming off. */
function renameTabEnabled(pi: ExtensionAPI): boolean {
  const rex = (pi.getSettings() as { rex?: unknown }).rex;
  if (typeof rex !== "object" || rex === null) return false;
  return (rex as RexSettings).renameTab === true;
}

/**
 * Count the tabs of the session. A missing answer keeps the Rex behavior, so a
 * failure never hides the session-naming instructions.
 */
async function countSessionWindows(
  pi: ExtensionAPI,
  session: string,
  cwd: string,
): Promise<number | undefined> {
  const result = await pi.exec("rex", ["session", "inspect", session, "--json"], {
    cwd,
    timeout: 5000,
  });
  if (result.code !== 0) return undefined;
  return countWindows(result.stdout);
}

export default function rexExtension(pi: ExtensionAPI): void {
  let context = "";

  pi.on("session_start", async (_event, ctx) => {
    context = "";
    const session = process.env.REX_SESSION;
    if (!session) return;
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
    let output = result.stdout.trim();
    if (!output) return;
    const windows = await countSessionWindows(pi, session, ctx.cwd);
    if (windows !== undefined && windows > 1) {
      output = `${stripSessionNaming(output)}\n\n${KEEP_SESSION_INSTRUCTION}`;
    }
    if (renameTabEnabled(pi)) output = `${output}\n\n${TAB_RENAME_INSTRUCTION}`;
    context = output;
  });

  pi.on("before_agent_start", (event) => {
    if (context) event.systemPromptOptions.sections[REX_SECTION] = context;
  });
}
