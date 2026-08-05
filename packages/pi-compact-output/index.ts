// compact-output — grouped collapsed tool calls and one-line reasoning summaries.
//
// Presentation-only TUI extension for Pi 0.83.x:
// - Consecutive collapsed tool calls share one padded area, newest first.
// - Ctrl+O (app.tools.expand) reveals each tool's original renderer in execution order.
// - The working indicator shows a one-line reasoning preview; Ctrl+O reveals full reasoning.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatThinkingWorkingMessage,
  installUiPatches,
  releaseUiPatches,
  type PatchInstallResult,
} from "./lib/patch-ui-components.ts";

let installResult: PatchInstallResult | undefined;
let warnedUnsupported = false;

function setWorkingReasoning(ctx: ExtensionContext, message?: AssistantMessage): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWorkingMessage(message ? formatThinkingWorkingMessage(message) : "Thinking");
}

export default function compactOutputExtension(pi: ExtensionAPI): void {
  installResult = installUiPatches();

  pi.on("session_start", (_event, ctx) => {
    setWorkingReasoning(ctx);
    if (
      installResult &&
      !installResult.installed &&
      installResult.reason &&
      ctx.mode === "tui" &&
      !warnedUnsupported
    ) {
      warnedUnsupported = true;
      ctx.ui.notify(installResult.reason, "warning");
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    setWorkingReasoning(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") {
      setWorkingReasoning(ctx, event.message);
    }
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role === "assistant") {
      setWorkingReasoning(ctx, event.message);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setWorkingMessage();
    }
    releaseUiPatches();
    warnedUnsupported = false;
  });
}

export { buildCompactToolLine, fallbackToolSummary } from "./lib/compact-tool-line.ts";
export {
  getPatchDiagnostics,
  installUiPatches,
  isSupportedPiVersion,
  releaseUiPatches,
} from "./lib/patch-ui-components.ts";
