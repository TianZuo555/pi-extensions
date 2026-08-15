import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./lib/tools.ts";
import { createWebSearchRuntime } from "./src/runtime.ts";

export default function webSearchExtension(pi: ExtensionAPI): void {
  const runtime = createWebSearchRuntime();

  registerTools(pi, runtime);

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
  });
}
