// compact-output — grouped collapsed tool calls and compact reasoning summaries.
//
// Presentation-only TUI extension for Pi 0.83.x:
// - Consecutive collapsed tool calls share one padded area with up to three lines.
// - Reasoning appears in-sequence as compact blocks; Pi's default thinking UI stays hidden.
// - Ctrl+O (app.tools.expand) reveals each tool's original renderer and full reasoning.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  installUiPatches,
  releaseUiPatches,
  type PatchInstallResult,
} from "./lib/patch-ui-components.ts";

let installResult: PatchInstallResult | undefined;
let warnedUnsupported = false;

export default function compactOutputExtension(pi: ExtensionAPI): void {
  installResult = installUiPatches();

  pi.on("session_start", (_event, ctx) => {
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

  pi.on("session_shutdown", (_event, ctx) => {
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
