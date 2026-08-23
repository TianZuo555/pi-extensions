// pi-find — ripgrep/fd-backed search tools for the pi coding agent.
//
// Registers grep and find under pi's built-in tool names so they
// replace the built-ins rather than sitting alongside them. The interface stays
// deliberately small while search output remains bounded.
//
// Quick try:  pi -e ./packages/pi-find

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./lib/tools.ts";
import { createSearchRuntime } from "./src/runtime.ts";

export default function searchExtension(pi: ExtensionAPI): void {
  const runtime = createSearchRuntime();

  registerTools(pi, runtime);

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Already disposed; nothing to clean up.
    }
  });
}
