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
import { DEFAULT_OPENAI_SYSTEM_PROMPT } from "./prompt.ts";

export { DEFAULT_OPENAI_SYSTEM_PROMPT } from "./prompt.ts";

export const PRIMARY_CONFIG_PATH = path.join(
    os.homedir(),
    ".config",
    "pi-web-search",
    "config.json",
);
const LEGACY_CONFIG_PATH = path.join(os.homedir(), ".pi", "web-search.json");
const PI_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_EXA_API_URL = "https://api.exa.ai";
export const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";
export const DEFAULT_TAVILY_API_URL = "https://api.tavily.com";
export const DEFAULT_MONID_API_URL = "https://api.monid.ai";

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

/** Provider ids used for API keys inside pi's ~/.pi/agent/auth.json. */
export const AUTH_IDS = {
    exa: "websearch-exa",
    firecrawl: "websearch-firecrawl",
    tavily: "websearch-tavily",
    ollama: "websearch-ollama",
    monid: "websearch-monid",
} as const;

export type AuthProviderId = (typeof AUTH_IDS)[keyof typeof AUTH_IDS];

function piAuthKey(id: AuthProviderId): string | undefined {
    return readPiAuthData()[id]?.key?.trim() || undefined;
}

/** Stored API key for a provider, read from pi's auth.json. */
export function loadProviderKey(
    name: "exa" | "firecrawl" | "tavily" | "ollama" | "monid",
): string | undefined {
    return piAuthKey(AUTH_IDS[name]);
}

/**
 * Store or remove an API key in pi's auth.json, merging with existing
 * entries. `undefined` removes the entry.
 */
export function writePiAuthKey(
    id: AuthProviderId,
    key: string | undefined,
): void {
    const data = readPiAuthData();
    if (key === undefined) {
        delete data[id];
    } else {
        data[id] = { type: "api_key", key };
    }
    fs.mkdirSync(path.dirname(PI_AUTH_FILE), { recursive: true });
    fs.writeFileSync(PI_AUTH_FILE, JSON.stringify(data, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
    });
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

/**
 * Auth-entry expiry check. `expires` may be epoch ms (as pi writes today)
 * or legacy epoch seconds; both must still be in the future. Missing or
 * zero means no known expiry.
 */
function isFreshTimestamp(expires: number | undefined): boolean {
    if (!expires) return true;
    const ms = expires > 1e12 ? expires : expires * 1000;
    return ms > Date.now();
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

    const customBaseUrl =
        process.env.OPENAI_BASE_URL?.trim() ||
        config.openai?.baseUrl?.trim() ||
        undefined;

    const fromKey = (
        apiKey: string,
        source: string,
    ): ResolvedOpenAIConfig => {
        const isCodex = isCodexJwt(apiKey);
        return {
            apiKey,
            baseUrl:
                customBaseUrl ??
                (isCodex
                    ? "https://chatgpt.com/backend-api/codex/responses"
                    : "https://api.openai.com/v1/responses"),
            model,
            systemPrompt,
            source,
            isCodexOAuth: isCodex,
            accountId: extractAccountId(apiKey),
        };
    };

    // 1. Pi's own logins take priority — reuse the session you already have.
    const authData = readPiAuthData();
    const codexEntry = authData["openai-codex"];
    if (codexEntry?.access && isFreshTimestamp(codexEntry.expires)) {
        return fromKey(codexEntry.access, "~/.pi/agent/auth.json (openai-codex)");
    }

    const openaiEntry = authData["openai"];
    if (openaiEntry?.key?.trim()) {
        return fromKey(openaiEntry.key.trim(), "~/.pi/agent/auth.json (openai)");
    }

    // 2. Env vars
    if (process.env.OPENAI_API_KEY?.trim()) {
        return fromKey(
            process.env.OPENAI_API_KEY.trim(),
            "OPENAI_API_KEY env",
        );
    }

    // 3. Config file
    if (config.openai?.apiKey?.trim()) {
        return fromKey(config.openai.apiKey.trim(), "config file");
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
    const authKey = piAuthKey(AUTH_IDS.exa);
    const key = envKey || authKey;
    if (!key) return null;
    return {
        apiKey: key,
        baseUrl:
            process.env.EXA_BASE_URL?.trim() ||
            config.exa?.baseUrl?.trim() ||
            DEFAULT_EXA_API_URL,
        source: envKey ? "EXA_API_KEY env" : "~/.pi/agent/auth.json",
    };
}

export interface ResolvedFirecrawlConfig {
    /** API key for the current primary mode: undefined in keyless mode. */
    apiKey: string | undefined;
    baseUrl: string;
    source: string;
    /** True when the keyless tier (1,000 free credits/month, no account) is
     * the primary mode; requests omit Authorization. */
    keyless: boolean;
    /** When keyless is primary and the user also has a key, it is used as
     * overflow once the free monthly credits run out. */
    overflowApiKey?: string;
}

export function resolveFirecrawlConfig(
    config = loadStoredConfig(),
): ResolvedFirecrawlConfig | null {
    const envKey = process.env.FIRECRAWL_API_KEY?.trim();
    const authKey = piAuthKey(AUTH_IDS.firecrawl);
    const key = envKey || authKey;
    const keySource = envKey ? "FIRECRAWL_API_KEY env" : "~/.pi/agent/auth.json";
    const baseUrl =
        process.env.FIRECRAWL_BASE_URL?.trim() ||
        config.firecrawl?.baseUrl?.trim() ||
        DEFAULT_FIRECRAWL_API_URL;

    const optOut = /^(0|false|off)$/i.test(
        process.env.FIRECRAWL_KEYLESS?.trim() ?? "",
    );
    const keylessDisabled = optOut || config.firecrawl?.keyless === false;

    if (keylessDisabled) {
        if (!key) return null;
        return {
            apiKey: key,
            baseUrl,
            source: keySource,
            keyless: false,
        };
    }

    if (key) {
        // Keyless first (free), the user's key takes over once the monthly
        // credits are used up.
        return {
            apiKey: undefined,
            baseUrl,
            source: `${keySource} (overflow after keyless credits)`,
            keyless: true,
            overflowApiKey: key,
        };
    }

    return {
        apiKey: undefined,
        baseUrl,
        source: "Firecrawl Keyless (no key; 1,000 credits/mo)",
        keyless: true,
    };
}

export interface ResolvedTavilyConfig {
    apiKey: string;
    baseUrl: string;
    source: string;
}

export function resolveTavilyConfig(
    config = loadStoredConfig(),
): ResolvedTavilyConfig | null {
    const envKey = process.env.TAVILY_API_KEY?.trim();
    const authKey = piAuthKey(AUTH_IDS.tavily);
    const key = envKey || authKey;
    if (!key) return null;
    return {
        apiKey: key,
        baseUrl:
            process.env.TAVILY_BASE_URL?.trim() ||
            config.tavily?.baseUrl?.trim() ||
            DEFAULT_TAVILY_API_URL,
        source: envKey ? "TAVILY_API_KEY env" : "~/.pi/agent/auth.json",
    };
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
    const apiKey = envKey || piAuthKey(AUTH_IDS.ollama) || undefined;
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

export interface ResolvedMonidConfig {
    apiKey: string;
    baseUrl: string;
    source: string;
}

export function resolveMonidConfig(
    config = loadStoredConfig(),
): ResolvedMonidConfig | null {
    const envKey = process.env.MONID_API_KEY?.trim();
    const authKey = piAuthKey(AUTH_IDS.monid);
    const key = envKey || authKey;
    if (!key) return null;
    return {
        apiKey: key,
        baseUrl:
            process.env.MONID_BASE_URL?.trim() ||
            config.monid?.baseUrl?.trim() ||
            DEFAULT_MONID_API_URL,
        source: envKey ? "MONID_API_KEY env" : "~/.pi/agent/auth.json",
    };
}

export function getProviderStatuses(ctx?: ExtensionContext): ProviderStatus[] {
    const config = loadStoredConfig();
    const openai = resolveOpenAIConfig(ctx, config);
    const exa = resolveExaConfig(config);
    const firecrawl = resolveFirecrawlConfig(config);
    const tavily = resolveTavilyConfig(config);
    const ollama = resolveOllamaConfig(config);
    const monid = resolveMonidConfig(config);

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
            name: "tavily",
            label: "Tavily",
            configured: !!tavily,
            source: tavily?.source,
            baseUrl: tavily?.baseUrl,
        },
        {
            name: "firecrawl",
            label: "Firecrawl",
            configured: !!firecrawl,
            source: firecrawl?.source,
            baseUrl: firecrawl?.baseUrl,
        },
        {
            name: "monid",
            label: "Monid (TinyFish)",
            configured: !!monid,
            source: monid?.source,
            baseUrl: monid?.baseUrl,
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
    config = loadStoredConfig(),
): SearchProviderName {
    return resolveSearchChain(requested, config)[0];
}

export function resolveFetchProvider(
    requested?: FetchProviderName,
    config = loadStoredConfig(),
): FetchProviderName {
    return resolveFetchChain(requested, config)[0];
}

/** Canonical fallback order for search providers. Keyless Firecrawl (real
 * browser, never cached) is the zero-config default head; Monid (TinyFish
 * via api.monid.ai, $0/call) is the last credentialed resort. */
export const SEARCH_PROVIDER_ORDER: readonly SearchProviderName[] = [
    "firecrawl",
    "openai",
    "exa",
    "tavily",
    "ollama",
    "monid",
];

/** Canonical fallback order for fetch providers. Keyless Firecrawl leads;
 * keyless `direct` stays the absolute last resort. */
export const FETCH_PROVIDER_ORDER: readonly FetchProviderName[] = [
    "firecrawl",
    "exa",
    "tavily",
    "ollama",
    "monid",
    "direct",
];

/** Search providers that currently have resolvable credentials, in preference order. */
export function availableSearchProviders(
    config = loadStoredConfig(),
): SearchProviderName[] {
    const list: SearchProviderName[] = [];
    if (resolveFirecrawlConfig(config)) list.push("firecrawl");
    if (resolveOpenAIConfig(undefined, config)) list.push("openai");
    if (resolveExaConfig(config)) list.push("exa");
    if (resolveTavilyConfig(config)) list.push("tavily");
    list.push("ollama");
    if (resolveMonidConfig(config)) list.push("monid");
    return list;
}

/** Fetch providers that currently have resolvable credentials, in preference order. */
export function availableFetchProviders(
    config = loadStoredConfig(),
): FetchProviderName[] {
    const list: FetchProviderName[] = [];
    if (resolveFirecrawlConfig(config)) list.push("firecrawl");
    if (resolveExaConfig(config)) list.push("exa");
    if (resolveTavilyConfig(config)) list.push("tavily");
    if (config.ollama || process.env.OLLAMA_HOST?.trim()) list.push("ollama");
    if (resolveMonidConfig(config)) list.push("monid");
    list.push("direct");
    return list;
}

function dedupe<T>(items: readonly T[]): T[] {
    return [...new Set(items)];
}

/** Keep only known provider names from a configured order list. */
function filterOrder<P extends string>(
    order: readonly P[] | undefined,
    valid: readonly P[],
): P[] {
    return Array.isArray(order) ? order.filter((p) => valid.includes(p)) : [];
}

/**
 * Ordered fallback chain for search: the requested/configured provider first,
 * then the configured `searchOrder` (if any), then every other available
 * provider in canonical order. A call walks this list until one provider
 * succeeds.
 */
export function resolveSearchChain(
    requested?: SearchProviderName,
    config = loadStoredConfig(),
): SearchProviderName[] {
    const available = availableSearchProviders(config);
    const head = requested ?? config.searchProvider;
    const order = filterOrder(config.searchOrder, SEARCH_PROVIDER_ORDER).filter(
        (p) => available.includes(p),
    );
    return dedupe([...(head ? [head] : []), ...order, ...available]);
}

/** Ordered fallback chain for fetch (see resolveSearchChain). */
export function resolveFetchChain(
    requested?: FetchProviderName,
    config = loadStoredConfig(),
): FetchProviderName[] {
    const available = availableFetchProviders(config);
    const head = requested ?? config.fetchProvider;
    const order = filterOrder(config.fetchOrder, FETCH_PROVIDER_ORDER).filter(
        (p) => available.includes(p),
    );
    return dedupe([...(head ? [head] : []), ...order, ...available]);
}
