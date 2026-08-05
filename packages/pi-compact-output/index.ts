// compact-output — grouped collapsed tool calls and compact reasoning summaries.
//
// Presentation-only TUI extension for Pi 0.83.x:
// - Consecutive collapsed tool calls share one padded area with up to three lines.
// - Reasoning appears in-sequence as compact blocks; Pi's default thinking UI stays hidden.
// - Ctrl+O (app.tools.expand) reveals each tool's original renderer and full reasoning.
//
// Maximum collapsed lines are configurable via settings.json:
//   { "compactOutput": { "toolLines": 3, "reasoningLines": 5 } }
// Project .pi/settings.json overrides the global setting when the project is trusted.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  installUiPatches,
  releaseUiPatches,
  setCompactOutputLimits,
  setReasoningStreaming,
  type PatchInstallResult,
} from "./lib/patch-ui-components.ts";

const DEFAULT_TOOL_LINES = 3;
const DEFAULT_REASONING_LINES = 5;

interface CompactOutputSettings {
  toolLines?: number;
  reasoningLines?: number;
}

function readSettingsFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function resolveCompactOutputLimits(
  cwd: string,
  projectTrusted: boolean,
): { toolLines: number; reasoningLines: number } {
  const globalSettings = readSettingsFile(path.join(getAgentDir(), "settings.json"));
  const projectSettings = projectTrusted
    ? readSettingsFile(path.join(cwd, CONFIG_DIR_NAME, "settings.json"))
    : undefined;
  const merged: CompactOutputSettings = {
    ...(globalSettings?.compactOutput as CompactOutputSettings | undefined),
    ...(projectSettings?.compactOutput as CompactOutputSettings | undefined),
  };
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return {
    toolLines: numberOr(merged.toolLines, DEFAULT_TOOL_LINES),
    reasoningLines: numberOr(merged.reasoningLines, DEFAULT_REASONING_LINES),
  };
}

function applyCompactOutputLimits(ctx: ExtensionContext): void {
  const limits = resolveCompactOutputLimits(ctx.cwd, ctx.isProjectTrusted());
  setCompactOutputLimits(limits.toolLines, limits.reasoningLines);
}

let installResult: PatchInstallResult | undefined;
let warnedUnsupported = false;

export default function compactOutputExtension(pi: ExtensionAPI): void {
  installResult = installUiPatches();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") {
      applyCompactOutputLimits(ctx);
      setReasoningStreaming(false);
    }
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
    if (ctx.mode === "tui") {
      setReasoningStreaming(true);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") {
      setReasoningStreaming(false);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") {
      setReasoningStreaming(false);
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
