// pi-find — ripgrep/fd-backed search tools for the pi coding agent.
//
// Registers grep and find under pi's built-in tool names so they
// replace the built-ins rather than sitting alongside them. What they add over
// the built-ins: a path-constraint DSL, exclude filters, smart-case, automatic
// regex/literal detection, multi-pattern support, whole-path matching, and
// bounded output.
//
// Quick try:  pi -e ./packages/pi-find

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./lib/tools.ts";
import { promptAndInstallMissingBinaries } from "./src/installer.ts";
import { createSearchRuntime } from "./src/runtime.ts";

export default function searchExtension(pi: ExtensionAPI): void {
  const runtime = createSearchRuntime();

  registerTools(pi, runtime);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      await promptAndInstallMissingBinaries(ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Already disposed; nothing to clean up.
    }
  });
}
