import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadStoredConfig,
  PRIMARY_CONFIG_PATH,
  saveStoredConfig,
} from "./lib/config.ts";
import type { WebSearchConfig } from "./lib/types.ts";
import { registerTools } from "./lib/tools.ts";
import { createWebSearchRuntime } from "./src/runtime.ts";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Provider status line in pi's login-list style:
 *   exa       ✓ env: EXA_API_KEY
 *   firecrawl ✓ config: fc-1…ab3d
 *   ollama    • unconfigured
 */
function providerLine(name: "exa" | "firecrawl" | "ollama", config: WebSearchConfig): string {
  const label = name.padEnd(10);
  const envKey =
    name === "exa" ? process.env.EXA_API_KEY?.trim()
    : name === "firecrawl" ? process.env.FIRECRAWL_API_KEY?.trim()
    : (process.env.OLLAMA_HOST?.trim() || process.env.OLLAMA_API_KEY?.trim());
  if (envKey) return `${label}✓ env: ${name === "ollama" ? (process.env.OLLAMA_HOST?.trim() ? "OLLAMA_HOST" : "OLLAMA_API_KEY") : name === "exa" ? "EXA_API_KEY" : "FIRECRAWL_API_KEY"}`;
  if (name === "ollama") {
    if (!config.ollama && !process.env.OLLAMA_HOST?.trim()) {
      return `${label}• unconfigured (default localhost:11434)`;
    }
    const url = config.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL;
    const key = config.ollama?.apiKey ? ` · key: ${maskKey(config.ollama.apiKey)}` : "";
    return `${label}✓ config: ${url}${key}`;
  }
  const stored = config[name]?.apiKey;
  return stored
    ? `${label}✓ config: ${maskKey(stored)}`
    : `${label}• unconfigured`;
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  const runtime = createWebSearchRuntime();

  registerTools(pi, runtime);

  pi.registerCommand("websearch-auth", {
    description:
      "Configure web search providers: Exa / Firecrawl API keys, Ollama URL + key",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/websearch-auth needs an interactive session — edit ~/.config/@tian.zuo/pi-web-search/config.json instead",
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
      const name = provider.split(" ")[0] as "exa" | "firecrawl" | "ollama";

      let next = config;
      if (name === "exa" || name === "firecrawl") {
        const current = config[name]?.apiKey;
        const key = await ctx.ui.input(
          `${name} API key (empty = remove, esc = cancel):`,
          current ? maskKey(current) : undefined,
        );
        if (key === undefined) return; // cancelled
        next = {
          ...config,
          [name]: key.trim() ? { ...config[name], apiKey: key.trim() } : undefined,
        };
      } else {
        const urlInput = (
          await ctx.ui.input(
            "Ollama base URL (empty = localhost:11434, esc = cancel):",
            config.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL,
          )
        )?.trim();
        if (urlInput === undefined) return; // cancelled
        const keyInput = await ctx.ui.input(
          "Ollama API key (empty = none, esc = cancel):",
          config.ollama?.apiKey ? maskKey(config.ollama.apiKey) : undefined,
        );
        if (keyInput === undefined) return; // cancelled
        const baseUrl = urlInput || OLLAMA_DEFAULT_URL;
        const apiKey = keyInput.trim();
        next = {
          ...config,
          ollama:
            baseUrl === OLLAMA_DEFAULT_URL && !apiKey
              ? undefined
              : {
                  ...(config.ollama ?? {}),
                  ...(urlInput ? { baseUrl } : {}),
                  ...(apiKey ? { apiKey } : {}),
                },
        };
      }

      try {
        saveStoredConfig(next);
        const envName =
          name === "exa" ? "EXA_API_KEY"
          : name === "firecrawl" ? "FIRECRAWL_API_KEY"
          : process.env.OLLAMA_HOST?.trim() || process.env.OLLAMA_API_KEY?.trim() ? "OLLAMA_HOST / OLLAMA_API_KEY"
          : undefined;
        if (envName && process.env[envName.split(" /")[0]]?.trim()) {
          ctx.ui.notify(
            `Saved to ${PRIMARY_CONFIG_PATH} — note: ${envName} is set and takes precedence over the config file`,
            "warning",
          );
        } else {
          ctx.ui.notify(`Saved to ${PRIMARY_CONFIG_PATH}`, "info");
        }
      } catch (err) {
        ctx.ui.notify(
          `Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
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
