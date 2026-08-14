import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
    FetchProviderName,
    ProviderStatus,
    SearchProviderName,
    WebSearchConfig,
} from "./types.ts";

const PRIMARY_CONFIG_PATH = path.join(
    os.homedir(),
    ".config",
    "pi-tian-web-search",
    "config.json",
);
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".pi", "web-search.json");
const PI_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");

export const DEFAULT_OPENAI_SYSTEM_PROMPT =
    "Search the web and provide a concise, accurate answer grounded in the web sources. Cite sources with markdown links where appropriate.";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_EXA_API_URL = "https://api.exa.ai";
export const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1";

interface PiAuthEntry {
    type?: string;
    access?: string;
    refresh?: string;
    key?: string;
    expires?: number;
}

interface PiAuthData {
    [providerId: string]: PiAuthEntry | undefined;
}

export function loadStoredConfig(): WebSearchConfig {
    for (const filePath of [PRIMARY_CONFIG_PATH, LEGACY_CONFIG_PATH]) {
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, "utf-8");
                return JSON.parse(raw) as WebSearchConfig;
            }
        } catch {
            // Ignore parse/read errors and try next
        }
    }
    return {};
}

export function saveStoredConfig(config: WebSearchConfig): void {
    const dir = path.dirname(PRIMARY_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
        PRIMARY_CONFIG_PATH,
        JSON.stringify(config, null, 2),
        "utf-8",
    );
}

export function readPiAuthData(): PiAuthData {
    try {
        if (fs.existsSync(PI_AUTH_FILE)) {
            const raw = fs.readFileSync(PI_AUTH_FILE, "utf-8");
            return JSON.parse(raw) as PiAuthData;
        }
    } catch {
        // Ignore read errors
    }
    return {};
}

export interface ResolvedOpenAIConfig {
    apiKey: string;
    baseUrl: string;
    model: string;
    systemPrompt: string;
    source: string;
    isCodexOAuth: boolean;
    accountId?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    try {
        const padded = parts[1]
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
        const parsed = JSON.parse(
            Buffer.from(padded, "base64").toString("utf8"),
        );
        return parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function extractAccountId(token: string): string | undefined {
    const payload = decodeJwtPayload(token);
    const auth = payload?.["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object") return undefined;
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof id === "string" && id.trim().length > 0
        ? id.trim()
        : undefined;
}

function isCodexJwt(token: string): boolean {
    const payload = decodeJwtPayload(token);
    return !!payload?.["https://api.openai.com/auth"];
}

export function resolveOpenAIConfig(
    ctx?: ExtensionContext,
    config = loadStoredConfig(),
): ResolvedOpenAIConfig | null {
    const systemPrompt =
        config.openai?.systemPrompt?.trim() ||
        process.env.OPENAI_SEARCH_SYSTEM_PROMPT?.trim() ||
        DEFAULT_OPENAI_SYSTEM_PROMPT;

    const model =
        process.env.OPENAI_SEARCH_MODEL?.trim() ||
        config.openai?.model?.trim() ||
        DEFAULT_OPENAI_MODEL;

    // 1. Env vars
    if (process.env.OPENAI_API_KEY?.trim()) {
        const apiKey = process.env.OPENAI_API_KEY.trim();
        const isCodex = isCodexJwt(apiKey);
        const baseUrl =
            process.env.OPENAI_BASE_URL?.trim() ||
            config.openai?.baseUrl?.trim() ||
            (isCodex
                ? "https://chatgpt.com/backend-api/codex/responses"
                : "https://api.openai.com/v1/responses");
        return {
            apiKey,
            baseUrl,
            model,
            systemPrompt,
            source: "OPENAI_API_KEY env",
            isCodexOAuth: isCodex,
            accountId: extractAccountId(apiKey),
        };
    }

    // 2. Config file
    if (config.openai?.apiKey?.trim()) {
        const apiKey = config.openai.apiKey.trim();
        const isCodex = isCodexJwt(apiKey);
        const baseUrl =
            config.openai.baseUrl?.trim() ||
            (isCodex
                ? "https://chatgpt.com/backend-api/codex/responses"
                : "https://api.openai.com/v1/responses");
        return {
            apiKey,
            baseUrl,
            model,
            systemPrompt,
            source: "config file",
            isCodexOAuth: isCodex,
            accountId: extractAccountId(apiKey),
        };
    }

    // 3. Pi's auth.json or modelRegistry
    const authData = readPiAuthData();
    const codexEntry = authData["openai-codex"];
    if (
        codexEntry?.access &&
        (!codexEntry.expires || codexEntry.expires * 1000 > Date.now())
    ) {
        const token = codexEntry.access;
        return {
            apiKey: token,
            baseUrl:
                config.openai?.baseUrl?.trim() ||
                "https://chatgpt.com/backend-api/codex/responses",
            model,
            systemPrompt,
            source: "~/.pi/agent/auth.json (openai-codex)",
            isCodexOAuth: true,
            accountId: extractAccountId(token),
        };
    }

    const openaiEntry = authData["openai"];
    if (openaiEntry?.key?.trim()) {
        const apiKey = openaiEntry.key.trim();
        const isCodex = isCodexJwt(apiKey);
        return {
            apiKey,
            baseUrl:
                config.openai?.baseUrl?.trim() ||
                (isCodex
                    ? "https://chatgpt.com/backend-api/codex/responses"
                    : "https://api.openai.com/v1/responses"),
            model,
            systemPrompt,
            source: "~/.pi/agent/auth.json (openai)",
            isCodexOAuth: isCodex,
            accountId: extractAccountId(apiKey),
        };
    }

    return null;
}

export interface ResolvedExaConfig {
    apiKey: string;
    baseUrl: string;
    source: string;
}

export function resolveExaConfig(
    config = loadStoredConfig(),
): ResolvedExaConfig | null {
    const envKey = process.env.EXA_API_KEY?.trim();
    if (envKey) {
        return {
            apiKey: envKey,
            baseUrl:
                process.env.EXA_BASE_URL?.trim() ||
                config.exa?.baseUrl?.trim() ||
                DEFAULT_EXA_API_URL,
            source: "EXA_API_KEY env",
        };
    }

    if (config.exa?.apiKey?.trim()) {
        return {
            apiKey: config.exa.apiKey.trim(),
            baseUrl: config.exa.baseUrl?.trim() || DEFAULT_EXA_API_URL,
            source: "config file",
        };
    }

    return null;
}

export interface ResolvedFirecrawlConfig {
    apiKey: string;
    baseUrl: string;
    source: string;
}

export function resolveFirecrawlConfig(
    config = loadStoredConfig(),
): ResolvedFirecrawlConfig | null {
    const envKey = process.env.FIRECRAWL_API_KEY?.trim();
    if (envKey) {
        return {
            apiKey: envKey,
            baseUrl:
                process.env.FIRECRAWL_BASE_URL?.trim() ||
                config.firecrawl?.baseUrl?.trim() ||
                DEFAULT_FIRECRAWL_API_URL,
            source: "FIRECRAWL_API_KEY env",
        };
    }

    if (config.firecrawl?.apiKey?.trim()) {
        return {
            apiKey: config.firecrawl.apiKey.trim(),
            baseUrl:
                config.firecrawl.baseUrl?.trim() || DEFAULT_FIRECRAWL_API_URL,
            source: "config file",
        };
    }

    return null;
}

export interface ResolvedOllamaConfig {
    baseUrl: string;
    apiKey?: string;
    source: string;
}

export function resolveOllamaConfig(
    config = loadStoredConfig(),
): ResolvedOllamaConfig {
    const envHost = process.env.OLLAMA_HOST?.trim();
    const envKey = process.env.OLLAMA_API_KEY?.trim();
    const baseUrl = (
        envHost ||
        config.ollama?.baseUrl?.trim() ||
        DEFAULT_OLLAMA_HOST
    ).replace(/\/+$/, "");
    const apiKey = envKey || config.ollama?.apiKey?.trim() || undefined;
    const source = envHost
        ? "OLLAMA_HOST env"
        : config.ollama?.baseUrl
          ? "config file"
          : "default localhost";

    return {
        baseUrl,
        apiKey,
        source,
    };
}

export function getProviderStatuses(ctx?: ExtensionContext): ProviderStatus[] {
    const config = loadStoredConfig();
    const openai = resolveOpenAIConfig(ctx, config);
    const exa = resolveExaConfig(config);
    const firecrawl = resolveFirecrawlConfig(config);
    const ollama = resolveOllamaConfig(config);

    return [
        {
            name: "openai",
            label: "OpenAI Responses",
            configured: !!openai,
            source: openai?.source,
            baseUrl: openai?.baseUrl,
            model: openai?.model,
        },
        {
            name: "exa",
            label: "Exa AI",
            configured: !!exa,
            source: exa?.source,
            baseUrl: exa?.baseUrl,
        },
        {
            name: "firecrawl",
            label: "Firecrawl",
            configured: !!firecrawl,
            source: firecrawl?.source,
            baseUrl: firecrawl?.baseUrl,
        },
        {
            name: "ollama",
            label: "Ollama (Local/Cloud)",
            configured: true,
            source: ollama.source,
            baseUrl: ollama.baseUrl,
        },
        {
            name: "direct",
            label: "Direct HTTP Fetch",
            configured: true,
            source: "built-in fallback",
        },
    ];
}

export function resolveSearchProvider(
    ctx?: ExtensionContext,
    requested?: SearchProviderName,
): SearchProviderName {
    return resolveSearchChain(requested)[0];
}

export function resolveFetchProvider(
    requested?: FetchProviderName,
): FetchProviderName {
    return resolveFetchChain(requested)[0];
}

/** Canonical fallback order for search providers. */
export const SEARCH_PROVIDER_ORDER: readonly SearchProviderName[] = [
    "openai",
    "exa",
    "firecrawl",
    "ollama",
];

/** Canonical fallback order for fetch providers. */
export const FETCH_PROVIDER_ORDER: readonly FetchProviderName[] = [
    "firecrawl",
    "exa",
    "ollama",
    "direct",
];

/** Search providers that currently have resolvable credentials, in preference order. */
export function availableSearchProviders(
    config = loadStoredConfig(),
): SearchProviderName[] {
    const list: SearchProviderName[] = [];
    if (resolveOpenAIConfig(undefined, config)) list.push("openai");
    if (resolveExaConfig(config)) list.push("exa");
    if (resolveFirecrawlConfig(config)) list.push("firecrawl");
    list.push("ollama");
    return list;
}

/** Fetch providers that currently have resolvable credentials, in preference order. */
export function availableFetchProviders(
    config = loadStoredConfig(),
): FetchProviderName[] {
    const list: FetchProviderName[] = [];
    if (resolveFirecrawlConfig(config)) list.push("firecrawl");
    if (resolveExaConfig(config)) list.push("exa");
    if (config.ollama || process.env.OLLAMA_HOST?.trim()) list.push("ollama");
    list.push("direct");
    return list;
}

function dedupe<T>(items: readonly T[]): T[] {
    return [...new Set(items)];
}

/**
 * Ordered fallback chain for search: the requested/configured provider first,
 * then every other available provider in canonical order. A call walks this
 * list until one provider succeeds.
 */
export function resolveSearchChain(
    requested?: SearchProviderName,
    config = loadStoredConfig(),
): SearchProviderName[] {
    const available = availableSearchProviders(config);
    const preferred = requested ?? config.searchProvider ?? available[0];
    return dedupe([preferred, ...available]);
}

/** Ordered fallback chain for fetch (see resolveSearchChain). */
export function resolveFetchChain(
    requested?: FetchProviderName,
    config = loadStoredConfig(),
): FetchProviderName[] {
    const available = availableFetchProviders(config);
    const preferred = requested ?? config.fetchProvider ?? available[0];
    return dedupe([preferred, ...available]);
}
