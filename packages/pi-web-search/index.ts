import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AUTH_IDS,
  SEARCH_PROVIDER_ORDER,
  getProviderStatuses,
  inspectOpenAICodexAuth,
  loadProviderKey,
  loadStoredConfig,
  resolveExaConfig,
  resolveFetchChain,
  resolveFirecrawlConfig,
  resolveMonidConfig,
  resolveOllamaConfig,
  resolveOpenAIConfig,
  resolveSearchChain,
  resolveTavilyConfig,
  saveStoredConfig,
  writePiAuthKey,
} from "./lib/config.ts";
import { getMonidWallet, listMonidRuns } from "./lib/monid.ts";
import type { WebSearchConfig, SearchProviderName } from "./lib/types.ts";
import { registerTools } from "./lib/tools.ts";
import { promptProviderOrder } from "./src/order-ui.ts";
import {
  createWebSearchRuntime,
  runWebSearch,
  WebSearchRuntime,
  type WebSearchRuntimeInstance,
} from "./src/runtime.ts";

const OLLAMA_DEFAULT_URL = "http://localhost:11434";
const PI_AUTH_FILE = "~/.pi/agent/auth.json";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Providers whose only credential is a single API key + its env var. */
const KEY_PROVIDERS = {
  exa: "EXA_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  tavily: "TAVILY_API_KEY",
  monid: "MONID_API_KEY",
} as const;

type KeyProvider = keyof typeof KEY_PROVIDERS;

/**
 * Provider status line in pi's login-list style:
 *   exa       ✓ env: EXA_API_KEY
 *   firecrawl ✓ auth: fc-1…ab3d
 *   ollama    • unconfigured
 * Configured providers are rendered green.
 */
function providerLine(name: KeyProvider | "ollama", config: WebSearchConfig): string {
  const label = name.padEnd(10);
  if (name !== "ollama") {
    const envName = KEY_PROVIDERS[name];
    const envKey = process.env[envName]?.trim();
    const stored = loadProviderKey(name);
    const key = envKey || stored;
    if (name === "firecrawl") {
      const keylessDisabled =
        /^(0|false|off)$/i.test(process.env.FIRECRAWL_KEYLESS?.trim() ?? "") ||
        config.firecrawl?.keyless === false;
      const masked = key ? maskKey(key) : undefined;
      if (keylessDisabled) {
        return masked
          ? `${GREEN}${label}✓ auth: ${masked}${RESET}`
          : `${label}• unconfigured (keyless disabled)`;
      }
      return masked
        ? `${GREEN}${label}✓ keyless (1k/mo) → key ${masked}${RESET}`
        : `${GREEN}${label}✓ keyless (1,000 free credits/mo)${RESET}`;
    }
    if (envKey) {
      return `${GREEN}${label}✓ env: ${envName}${RESET}`;
    }
    if (stored) {
      return `${GREEN}${label}✓ auth: ${maskKey(stored)}${RESET}`;
    }
    return `${label}• unconfigured`;
  }
  const envKey = process.env.OLLAMA_HOST?.trim() || process.env.OLLAMA_API_KEY?.trim();
  if (envKey) {
    const envName = process.env.OLLAMA_HOST?.trim() ? "OLLAMA_HOST" : "OLLAMA_API_KEY";
    return `${GREEN}${label}✓ env: ${envName}${RESET}`;
  }
  const stored = loadProviderKey(name);
  if (!stored && !config.ollama?.baseUrl) {
    return `${label}• unconfigured (default localhost:11434)`;
  }
  const url = config.ollama?.baseUrl ?? OLLAMA_DEFAULT_URL;
  const key = stored ? ` · key: ${maskKey(stored)}` : "";
  return `${GREEN}${label}✓ auth: ${url}${key}${RESET}`;
}

/** Read-only openai row: credentials are auto-detected (pi /login codex,
 * OPENAI_API_KEY, config file) and never configured through this command. */
function openaiLine(config: WebSearchConfig): string {
  const label = "openai".padEnd(10);
  const codex = inspectOpenAICodexAuth();
  if (codex.state === "fresh") {
    return `${GREEN}${label}✓ auto: pi login (openai-codex)${RESET}`;
  }
  const resolved = resolveOpenAIConfig(undefined, config);
  if (resolved) {
    return `${GREEN}${label}✓ auto: ${resolved.source}${RESET}`;
  }
  if (codex.state === "expired") {
    return `${YELLOW}${label}• codex login expired — re-run /login${RESET}`;
  }
  return `${label}• auto: /login with OpenAI or set OPENAI_API_KEY`;
}

function codexExpiryHint(): string[] {
  return inspectOpenAICodexAuth().state === "expired"
    ? [
        "",
        "⚠ your openai-codex token in ~/.pi/agent/auth.json is expired —",
        "  re-run /login (OpenAI Codex) to refresh it.",
      ]
    : [];
}

/** One-line credential/config summary for the order dialog. */
function searchProviderDetail(id: SearchProviderName, config: WebSearchConfig): string {
  switch (id) {
    case "openai": {
      const resolved = resolveOpenAIConfig(undefined, config);
      if (resolved) return resolved.source;
      return inspectOpenAICodexAuth().state === "expired"
        ? "codex login expired — re-run /login"
        : "not detected (/login or OPENAI_API_KEY)";
    }
    case "exa":
      return resolveExaConfig(config)?.source ?? "unconfigured";
    case "tavily":
      return resolveTavilyConfig(config)?.source ?? "unconfigured";
    case "firecrawl":
      return resolveFirecrawlConfig(config)?.source ?? "unconfigured";
    case "monid":
      return resolveMonidConfig(config)?.source ?? "unconfigured";
    case "ollama":
      return resolveOllamaConfig(config).source;
  }
}

export default function webSearchExtension(pi: ExtensionAPI): void {
  let runtime: WebSearchRuntimeInstance | undefined;
  const getRuntime = () => (runtime ??= createWebSearchRuntime());

  registerTools(pi, getRuntime);

  pi.registerCommand("websearch-usage", {
    description:
      "Show web search/fetch usage: this session's per-provider stats, provider health, and Monid wallet",
    handler: async (_args, ctx) => {
      const activeRuntime = getRuntime();
      const service = activeRuntime.runSync(WebSearchRuntime);

      const lines: string[] = ["Web usage\n", "— This session —"];
      const usage = await runWebSearch(activeRuntime, service.usage);
      if (usage.length === 0) {
        lines.push("no web_search / web_fetch calls yet");
      } else {
        for (const u of usage) {
          const avg = u.ok + u.fail > 0 ? Math.round(u.totalMs / (u.ok + u.fail)) : 0;
          lines.push(`${u.kind}: ${u.provider} — ${u.ok} ok, ${u.fail} failed, ~${avg}ms/call`);
        }
      }

      const health = await runWebSearch(activeRuntime, service.providerHealth);
      if (health.length > 0) {
        lines.push("", "— Providers on cooldown / blocked —");
        for (const h of health) {
          const scope =
            h.msLeft === null ? "rest of session" : `retry in ~${Math.ceil(h.msLeft / 1000)}s`;
          lines.push(`${h.provider}: ${h.reason} (${scope})`);
        }
      }

      lines.push("", "— Monid wallet —");
      try {
        const wallet = await getMonidWallet();
        if (wallet) {
          lines.push(
            `balance: $${wallet.balance.value.toFixed(2)} ${wallet.balance.currency}` +
              (wallet.held.value > 0 ? ` (held: $${wallet.held.value.toFixed(2)})` : ""),
          );
          const runs = await listMonidRuns(5);
          if (runs && runs.length > 0) {
            const total = runs.reduce((sum, r) => sum + (r.cost?.value ?? 0), 0);
            lines.push(
              `recent ${runs.length} run(s): $${total.toFixed(4)} total (TinyFish endpoints are $0/call)`,
            );
            for (const r of runs.slice(0, 5)) {
              lines.push(`  ${r.provider} ${r.endpoint} — ${r.status}`);
            }
          } else {
            lines.push("no Monid runs yet");
          }
        } else {
          lines.push("not configured (set MONID_API_KEY or /websearch-auth)");
        }
      } catch (err) {
        lines.push(`unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("web-search", {
    description:
      "Show web search provider status: detected credentials and the active search/fetch chains",
    handler: async (_args, ctx) => {
      const config = loadStoredConfig();
      const lines: string[] = [
        "Web search providers",
        "",
        `search chain: ${resolveSearchChain(undefined, config).join(" → ")}`,
        `fetch chain:  ${resolveFetchChain(undefined, config).join(" → ")}`,
        "",
      ];
      for (const s of getProviderStatuses(ctx)) {
        const label = s.name.padEnd(10);
        if (s.configured) {
          const model = s.model ? ` · ${s.model}` : "";
          lines.push(`${GREEN}${label}✓ ${s.source ?? "configured"}${model}${RESET}`);
        } else {
          lines.push(`${label}• unconfigured`);
        }
      }
      lines.push(...codexExpiryHint());
      lines.push(
        "",
        "openai is auto-detected (pi /login with OpenAI, or OPENAI_API_KEY) — it is not",
        "listed as configurable in /websearch-auth. It ranks after keyless Firecrawl by",
        'default; reorder the chain with /websearch-order, or set "searchProvider": "openai" in',
        "~/.pi/web-search.json.",
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("websearch-order", {
    description:
      "Reorder the web search fallback chain (enter grab • ↑↓ move • enter save • esc cancel)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          '/websearch-order needs an interactive session — edit "searchOrder" in ~/.pi/web-search.json instead',
          "warning",
        );
        return;
      }

      const config = loadStoredConfig();
      const chain = resolveSearchChain(undefined, config);
      const list = [...chain, ...SEARCH_PROVIDER_ORDER.filter((p) => !chain.includes(p))];

      const order = await promptProviderOrder(
        ctx,
        "Search provider order",
        list.map((id) => ({
          id,
          detail: searchProviderDetail(id, config),
          active: chain.includes(id),
        })),
      );
      if (!order) return; // cancelled
      if (order.every((id, index) => id === list[index])) {
        ctx.ui.notify("Order unchanged", "info");
        return;
      }

      saveStoredConfig({
        ...config,
        searchProvider: order[0] as SearchProviderName,
        searchOrder: order.slice(1) as SearchProviderName[],
      });
      ctx.ui.notify(`search chain saved: ${order.join(" → ")}\n(~/.pi/web-search.json)`, "info");
    },
  });

  pi.registerCommand("websearch-auth", {
    description:
      "Configure web search providers: Exa / Firecrawl / Tavily / Monid / Ollama API keys (stored in pi auth); openai is auto-detected — see /web-search",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/websearch-auth needs an interactive session — set EXA_API_KEY / FIRECRAWL_API_KEY / TAVILY_API_KEY / MONID_API_KEY / OLLAMA_API_KEY instead",
          "warning",
        );
        return;
      }

      const config = loadStoredConfig();
      const provider = await ctx.ui.select("Configure provider:", [
        openaiLine(config),
        providerLine("exa", config),
        providerLine("firecrawl", config),
        providerLine("tavily", config),
        providerLine("monid", config),
        providerLine("ollama", config),
      ]);
      if (!provider) return;
      // Lines may start with an ANSI code; match on the provider name.
      const name = (["openai", "exa", "firecrawl", "tavily", "monid", "ollama"] as const).find(
        (n) => provider.includes(n),
      );
      if (!name) return;

      if (name === "openai") {
        ctx.ui.notify(
          [
            "openai is auto-detected — there is no key to configure here:",
            "  1. /login → OpenAI (ChatGPT Plus/Pro Codex) — used automatically",
            '  2. OPENAI_API_KEY env, or "openai": { "apiKey": … } in',
            "     ~/.pi/web-search.json",
            ...codexExpiryHint(),
            "",
            "It ranks after keyless Firecrawl by default; reorder with /websearch-order",
            'or set "searchProvider": "openai" in ~/.pi/web-search.json.',
          ].join("\n"),
          "info",
        );
        return;
      }

      if (name !== "ollama") {
        const key = await ctx.ui.input(
          `${name} API key (empty = remove, esc = cancel):`,
          maskKey(loadProviderKey(name)),
        );
        if (key === undefined) return; // cancelled
        writePiAuthKey(AUTH_IDS[name], key.trim() || undefined);
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
      await runtime?.dispose();
    } catch {
      // Disposed gracefully
    }
  });
}
