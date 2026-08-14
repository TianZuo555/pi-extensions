import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getProviderStatuses,
  loadStoredConfig,
  resolveFetchProvider,
  resolveSearchProvider,
  saveStoredConfig,
} from "./config.ts";
import type { FetchProviderName, SearchProviderName } from "./types.ts";
import {
  runWebSearch,
  WebSearchRuntime,
  type WebSearchRuntimeInstance,
} from "../src/runtime.ts";

export function registerWebSearchCommand(
  pi: ExtensionAPI,
  runtime?: WebSearchRuntimeInstance,
): void {
  const handler = async (args: string | undefined, ctx: ExtensionContext) => {
    const raw = args?.trim() || "";
    const [subcommand, ...rest] = raw.split(/\s+/);
    const config = loadStoredConfig();

    if (subcommand === "set") {
      const target = rest[0]?.toLowerCase();
      const value = rest[1]?.toLowerCase();

      if (target === "search" && value) {
        if (!["openai", "exa", "firecrawl", "ollama"].includes(value)) {
          ctx.ui.notify(
            `Invalid search provider: ${value}. Choose openai, exa, firecrawl, or ollama.`,
            "error",
          );
          return;
        }
        config.searchProvider = value as SearchProviderName;
        saveStoredConfig(config);
        ctx.ui.notify(`Default search provider set to ${value}.`, "info");
        return;
      }

      if (target === "fetch" && value) {
        if (!["firecrawl", "exa", "ollama", "direct"].includes(value)) {
          ctx.ui.notify(
            `Invalid fetch provider: ${value}. Choose firecrawl, exa, ollama, or direct.`,
            "error",
          );
          return;
        }
        config.fetchProvider = value as FetchProviderName;
        saveStoredConfig(config);
        ctx.ui.notify(`Default fetch provider set to ${value}.`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /web-search set search <openai|exa|firecrawl|ollama> OR /web-search set fetch <firecrawl|exa|ollama|direct>",
        "warning",
      );
      return;
    }

    if (subcommand === "key") {
      const provider = rest[0]?.toLowerCase();
      const key = rest[1];

      if (!provider || !key) {
        ctx.ui.notify("Usage: /web-search key <openai|exa|firecrawl> <api-key>", "warning");
        return;
      }

      if (provider === "openai") {
        config.openai = { ...config.openai, apiKey: key };
      } else if (provider === "exa") {
        config.exa = { ...config.exa, apiKey: key };
      } else if (provider === "firecrawl") {
        config.firecrawl = { ...config.firecrawl, apiKey: key };
      } else {
        ctx.ui.notify(`Unknown provider for API key: ${provider}`, "error");
        return;
      }

      saveStoredConfig(config);
      ctx.ui.notify(`Saved API key for ${provider}.`, "info");
      return;
    }

    if (subcommand === "ollama") {
      const host = rest[0];
      if (!host) {
        ctx.ui.notify("Usage: /web-search ollama <url> (e.g. http://localhost:11434)", "warning");
        return;
      }
      config.ollama = { ...config.ollama, baseUrl: host };
      saveStoredConfig(config);
      ctx.ui.notify(`Saved Ollama host as ${host}.`, "info");
      return;
    }

    // Default: Show status of all providers
    const statuses = getProviderStatuses(ctx);
    const activeSearch = resolveSearchProvider(ctx);
    const activeFetch = resolveFetchProvider();

    let healthLines: string[] = [];
    if (runtime) {
      const health = await runWebSearch(
        runtime,
        runtime.runSync(WebSearchRuntime).providerHealth,
      );
      healthLines = health.map((h) => {
        const scope =
          h.msLeft === null
            ? "skipped for this session"
            : `skipped for ${Math.ceil(h.msLeft / 1000)}s more`;
        return `  ⚠ ${h.provider}: ${scope} — ${h.reason.slice(0, 80)}`;
      });
    }

    const lines = [
      "Web Search & Fetch Status:",
      `• Active Search: ${activeSearch.toUpperCase()}`,
      `• Active Fetch:  ${activeFetch.toUpperCase()}`,
      "",
      "Providers:",
      ...statuses.map((s) => {
        const check = s.configured ? "✓" : "✗";
        const extra = [s.source, s.model, s.baseUrl].filter(Boolean).join(", ");
        return `  ${check} ${s.label}: ${s.configured ? "ready" : "not configured"}${extra ? ` (${extra})` : ""}`;
      }),
      ...(healthLines.length > 0
        ? ["", "Session fallbacks (failed providers are skipped):", ...healthLines]
        : []),
      "",
      "Commands:",
      "  /web-search set search <openai|exa|firecrawl|ollama>",
      "  /web-search set fetch <firecrawl|exa|ollama|direct>",
      "  /web-search key <openai|exa|firecrawl> <key>",
      "  /web-search ollama <url>",
    ];

    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("web-search", {
    description: "View and configure web search & fetch providers (OpenAI, Exa, Firecrawl, Ollama)",
    handler: handler,
  });

  pi.registerCommand("web-tools", {
    description: "Alias for /web-search",
    handler: handler,
  });
}
