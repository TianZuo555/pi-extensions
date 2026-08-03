// compact-output — one-line collapsed tool rows and hidden persisted reasoning.
//
// Presentation-only TUI extension for Pi 0.83.x:
// - Collapsed tool calls render as a single descriptive line.
// - Ctrl+O (app.tools.expand) reveals each tool's original renderer.
// - Persisted thinking blocks are hidden; the live working indicator shows "Thinking".

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installUiPatches, releaseUiPatches, type PatchInstallResult } from "./lib/patch-ui-components.ts";

let installResult: PatchInstallResult | undefined;
let warnedUnsupported = false;

export default function compactOutputExtension(pi: ExtensionAPI): void {
  installResult = installUiPatches();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setWorkingMessage("Thinking");
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
