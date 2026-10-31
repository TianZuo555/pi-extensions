// pi-beautify-style — Claude Code-style TUI for pi.
//
// The rendering stack under `extensions/` is vendored from
// minuque/pi-cc-extensions (MIT, see ATTRIBUTION.md) so this repo owns it.
// The small patches applied to the vendored sources adapt it to the sibling
// packages here:
//
//   ask_user                 → the upstream `ask_user_question` card (answer
//                              tree, question count, custom answers)
//   bash, terminal_wait,     → the same beautify card as every other tool,
//   terminal_stop,             with the terminal id and a live duration
//   terminal_log_read          (pi-background-terminals)
//   setStatus("usage")       → the footer usage chip (upstream only knew
//                              `pi-usage`/`localUsage`)
//   setStatus("token-speed") → the footer rate chip instead of a second chip
//
// In TUI sessions the package also overrides the `write` tool so rich diffs
// can show the previous file content — it is not presentation only.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./extensions/config/config.ts";

// shell
import { registerFlushDockedBash } from "./extensions/feature/shell/flush-docked-bash.ts";
import customFooter from "./extensions/feature/shell/footer.ts";
import { applyPromptEditor } from "./extensions/feature/shell/prompt-editor.ts";
import workingMessage from "./extensions/feature/shell/working-message.ts";

// feature
import agentAutocomplete from "./extensions/feature/reference/subagent.ts";
import agentSummary from "./extensions/feature/agent-summary/index.ts";
import context from "./extensions/feature/context.ts";
import sessionReference from "./extensions/feature/reference/index.ts";
import { installCompactThinking } from "./extensions/feature/compact-thinking.ts";

// renderer
import claudeCodeStyle, { getCompactThinkingConfig } from "./extensions/renderer/index.ts";
import markdownEnhance from "./extensions/renderer/markdown-enhance.ts";

export default function beautifyStyle(pi: ExtensionAPI): void {
  // shell chrome
  registerFlushDockedBash(pi);
  if (config.enableWorkingMessage) workingMessage(pi);
  customFooter(pi);

  // `❯` prompt prefix: applied on session_start; setEditorComponent is a
  // one-shot replacement, so it cannot be installed at load time.
  pi.on("session_start", (_event, ctx) => {
    applyPromptEditor(ctx);
  });

  // Render stack: the thinking controller is handed to the style as a query.
  // markdownEnhance has its own switch because other extensions that register
  // transformers would otherwise rewrite each other's output.
  if (config.enableMarkdownEnhance) markdownEnhance(pi);
  claudeCodeStyle(pi, installCompactThinking(pi, getCompactThinkingConfig()));

  // features
  if (config.enableContextCommand) context(pi);
  if (config.enableSessionReference) sessionReference(pi);
  if (config.enableSubagentAutocomplete) agentAutocomplete(pi);
  if (config.enableAgentSummary) agentSummary(pi);
}

// Public surface for tests and for anyone composing this with another TUI.
export { config, DEFAULT_CONFIG } from "./extensions/config/config.ts";
export { isAskUserTool } from "./extensions/renderer/tool/ask-user-question.ts";
