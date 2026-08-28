import { resolveMonidConfig } from "./config.ts";
import type {
    FetchOptions,
    FetchResponse,
    SearchOptions,
    SearchResponse,
    SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Monid (https://monid.ai) — TinyFish endpoints via the Monid run API.
 * Both endpoints execute synchronously: POST /v1/run returns the completed
 * run with `output` (no polling). TinyFish /search is $0/call, /fetch is
 * $0/call, billed against the Monid workspace balance.
 */

interface MonidRunResponse {
    runId?: string;
    status?: string;
    output?: unknown;
    providerResponse?: {
        httpStatus?: number;
        error?: { message?: string } | null;
    };
}

async function runMonid(
    apiKey: string,
    baseUrl: string,
    endpoint: "/search" | "/fetch",
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
): Promise<MonidRunResponse> {
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/run`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            provider: "tinyfish",
            endpoint,
            input,
        }),
        signal: combinedSignal,
    });

    const data = (await res.json().catch(() => ({}))) as MonidRunResponse;

    if (res.status === 202 || data.status && !["COMPLETED", "READY"].includes(data.status)) {
        // TinyFish endpoints are synchronous; anything else is unexpected.
        throw new Error(
            `Monid ${endpoint} returned unexpected run status ${data.status ?? res.status}`,
        );
    }
    const providerStatus = data.providerResponse?.httpStatus ?? res.status;
    if (providerStatus >= 400) {
        const detail = data.providerResponse?.error?.message ?? "";
        throw new Error(
            `Monid ${endpoint} failed (${providerStatus}): ${detail || res.statusText}`.slice(0, 300),
        );
    }
    return data;
}

interface TinyFishSearchResult {
    position?: number;
    title?: string;
    url?: string;
    site_name?: string;
    snippet?: string;
    date?: string;
}

export interface MonidWallet {
    balance: { value: number; currency: string };
    held: { value: number; currency: string };
}

export interface MonidRunSummary {
    runId: string;
    provider: string;
    endpoint: string;
    status: string;
    cost?: { value: number; currency: string };
    createdAt?: string;
}

async function monidGet<T>(
    path: string,
    signal: AbortSignal | undefined,
): Promise<T> {
    const config = resolveMonidConfig();
    if (!config) {
        throw new Error("Monid API key not found (MONID_API_KEY or /websearch-auth)");
    }
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: combinedSignal,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Monid ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
}

/** Workspace wallet balance. TinyFish runs are $0/call, so this mostly
 * reflects top-ups and any non-TinyFish usage. */
export async function getMonidWallet(
    options: { signal?: AbortSignal } = {},
): Promise<MonidWallet | null> {
    if (!resolveMonidConfig()) return null;
    const data = await monidGet<MonidWallet>("/v1/wallet/balance", options.signal);
    return data;
}

/** Recent runs in the workspace, newest first (per-run cost included). */
export async function listMonidRuns(
    limit = 5,
    options: { signal?: AbortSignal } = {},
): Promise<MonidRunSummary[] | null> {
    if (!resolveMonidConfig()) return null;
    const data = await monidGet<{ items?: MonidRunSummary[] }>(
        `/v1/runs?limit=${Math.min(Math.max(limit, 1), 25)}`,
        options.signal,
    );
    return data.items ?? [];
}

export async function searchMonid(
    query: string,
    options: SearchOptions = {},
): Promise<SearchResponse> {
    const config = resolveMonidConfig();
    if (!config) {
        throw new Error(
            "Monid API key not found. Set MONID_API_KEY or run /websearch-auth",
        );
    }

    const queryParams: Record<string, string> = { query };
    if (options.domainFilter?.length) {
        const includes = options.domainFilter.filter((d) => !d.startsWith("-"));
        const excludes = options.domainFilter
            .filter((d) => d.startsWith("-"))
            .map((d) => d.slice(1).trim());
        if (includes.length > 0) queryParams.include_domains = includes.join(",");
        if (excludes.length > 0) queryParams.exclude_domains = excludes.join(",");
    }

    const data = await runMonid(config.apiKey, config.baseUrl, "/search", { queryParams }, options.signal);

    const raw = (data.output as { results?: TinyFishSearchResult[] } | null)?.results ?? [];
    // TinyFish has no limit parameter; cap client-side.
    const capped = options.numResults && options.numResults > 0
        ? raw.slice(0, options.numResults)
        : raw;

    const results: SearchResult[] = capped
        .filter((item) => item.url)
        .map((item) => ({
            title: item.title || item.url || "",
            url: item.url!,
            snippet: item.snippet ?? "",
        }));

    return { query, results, provider: "monid" };
}

interface TinyFishFetchResult {
    url?: string;
    title?: string;
    text?: string;
    not_modified?: boolean;
    error?: string | null;
}

export async function fetchMonid(
    url: string,
    options: FetchOptions = {},
): Promise<FetchResponse> {
    const config = resolveMonidConfig();
    if (!config) {
        throw new Error(
            "Monid API key not found. Set MONID_API_KEY or run /websearch-auth",
        );
    }

    const data = await runMonid(
        config.apiKey,
        config.baseUrl,
        "/fetch",
        {
            body: {
                urls: [url],
                format: options.raw ? "html" : "markdown",
                per_url_timeout_ms: 30_000,
            },
        },
        options.signal,
    );

    const output = data.output as
        | { results?: TinyFishFetchResult[]; errors?: Array<{ url: string; error: string }> }
        | null;
    const failed = output?.errors?.[0];
    const item = output?.results?.[0];

    if (failed) {
        throw new Error(`Monid fetch failed for ${url}: ${failed.error}`);
    }
    if (!item || item.not_modified || !item.text) {
        throw new Error(`Monid returned no readable content for ${url}`);
    }

    return {
        url,
        title: item.title,
        text: item.text,
        provider: "monid",
        contentType: options.raw ? "text/html" : "text/markdown",
    };
}
