import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadStoredConfig,
  PRIMARY_CONFIG_PATH,
  saveStoredConfig,
} from "./lib/config.ts";
import { registerTools } from "./lib/tools.ts";
import { createWebSearchRuntime } from "./src/runtime.ts";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
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
        `exa       (key: ${maskKey(config.exa?.apiKey)})`,
        `firecrawl (key: ${maskKey(config.firecrawl?.apiKey)})`,
        `ollama    (url: ${config.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL}, key: ${maskKey(config.ollama?.apiKey)})`,
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
        ctx.ui.notify(`Saved to ${PRIMARY_CONFIG_PATH}`, "info");
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
