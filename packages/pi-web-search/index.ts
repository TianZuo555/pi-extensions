import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadProviderKey,
  loadStoredConfig,
  saveStoredConfig,
  writePiAuthKey,
} from "./lib/config.ts";
import type { WebSearchConfig } from "./lib/types.ts";
import { registerTools } from "./lib/tools.ts";
import { createWebSearchRuntime } from "./src/runtime.ts";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const PI_AUTH_FILE = "~/.pi/agent/auth.json";

const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Provider status line in pi's login-list style:
 *   exa       ✓ env: EXA_API_KEY
 *   firecrawl ✓ auth: fc-1…ab3d
 *   ollama    • unconfigured
 * Configured providers are rendered green.
 */
function providerLine(
  name: "exa" | "firecrawl" | "ollama",
  config: WebSearchConfig,
): string {
  const label = name.padEnd(10);
  const envKey =
    name === "exa" ? process.env.EXA_API_KEY?.trim()
    : name === "firecrawl" ? process.env.FIRECRAWL_API_KEY?.trim()
    : (process.env.OLLAMA_HOST?.trim() || process.env.OLLAMA_API_KEY?.trim());
  if (envKey) {
    const envName =
      name === "exa" ? "EXA_API_KEY"
      : name === "firecrawl" ? "FIRECRAWL_API_KEY"
      : process.env.OLLAMA_HOST?.trim() ? "OLLAMA_HOST" : "OLLAMA_API_KEY";
    return GREEN + `${label}✓ env: ${envName}` + RESET;
  }
  const stored = loadProviderKey(name);
  if (name === "ollama") {
    if (!stored && !config.ollama?.baseUrl) {
      return `${label}• unconfigured (default localhost:11434)`;
    }
    const url = config.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL;
    const key = stored ? ` · key: ${maskKey(stored)}` : "";
    return GREEN + `${label}✓ auth: ${url}${key}` + RESET;
  }
  return stored
    ? GREEN + `${label}✓ auth: ${maskKey(stored)}` + RESET
    : `${label}• unconfigured`;
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  const runtime = createWebSearchRuntime();

  registerTools(pi, runtime);

  pi.registerCommand("websearch-auth", {
    description:
      "Configure web search providers: Exa / Firecrawl / Ollama API keys (stored in pi auth)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/websearch-auth needs an interactive session — set EXA_API_KEY / FIRECRAWL_API_KEY / OLLAMA_API_KEY instead",
          "warning",
        );
        return;
      }

      const config = loadStoredConfig();
      const provider = await ctx.ui.select("Configure provider:", [
        providerLine("exa", config),
        providerLine("firecrawl", config),
        providerLine("ollama", config),
      ]);
      if (!provider) return;
      // Lines may start with a green ANSI code; match on the provider name.
      const name = (["exa", "firecrawl", "ollama"] as const).find((n) =>
        provider.includes(n),
      )!;

      if (name === "exa" || name === "firecrawl") {
        const key = await ctx.ui.input(
          `${name} API key (empty = remove, esc = cancel):`,
          maskKey(loadProviderKey(name)),
        );
        if (key === undefined) return; // cancelled
        writePiAuthKey(name === "exa" ? "websearch-exa" : "websearch-firecrawl", key.trim() || undefined);
      } else {
        const urlInput = (
          await ctx.ui.input(
            "Ollama base URL (empty = localhost:11434, esc = cancel):",
            config.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL,
          )
        )?.trim();
        if (urlInput === undefined) return; // cancelled
        const key = await ctx.ui.input(
          "Ollama API key (empty = remove, esc = cancel):",
          maskKey(loadProviderKey("ollama")),
        );
        if (key === undefined) return; // cancelled
        const baseUrl = urlInput || OLLAMA_DEFAULT_URL;
        saveStoredConfig({
          ...config,
          ollama: baseUrl === OLLAMA_DEFAULT_URL ? undefined : { baseUrl },
        });
        writePiAuthKey("websearch-ollama", key.trim() || undefined);
      }

      try {
        ctx.ui.notify(`Saved to ${PI_AUTH_FILE}`, "info");
      } catch (err) {
        ctx.ui.notify(
          `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
  });
}
