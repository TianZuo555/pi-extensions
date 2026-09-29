import { resolveParallelConfig } from "./config.ts";
import { splitDomainFilter } from "./domain-filter.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

/**
 * Search mode. `fast` answers within about a second at the lowest price. The
 * API default, `advanced`, is a slower multi-hop mode meant for background
 * agents, which is the wrong trade for an interactive search tool.
 */
const SEARCH_MODE = "fast";

interface ParallelSearchResponse {
  results?: Array<{ title?: string | null; url: string; excerpts?: string[] }>;
}

export async function searchParallel(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveParallelConfig();
  if (!config)
    throw new Error("Parallel API key not found. Set PARALLEL_API_KEY or run /websearch-auth");

  const { include, exclude } = splitDomainFilter(options.domainFilter);
  const sourcePolicy = {
    ...(include.length ? { include_domains: include } : {}),
    ...(exclude.length ? { exclude_domains: exclude } : {}),
  };
  const advancedSettings = {
    ...(options.numResults ? { max_results: Math.min(options.numResults, 20) } : {}),
    ...(Object.keys(sourcePolicy).length ? { source_policy: sourcePolicy } : {}),
  };
  const timeout = AbortSignal.timeout(60_000);
  const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/v1/search`, {
    method: "POST",
    headers: { "x-api-key": config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      objective: query,
      search_queries: [query],
      mode: SEARCH_MODE,
      ...(Object.keys(advancedSettings).length ? { advanced_settings: advancedSettings } : {}),
    }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Parallel search failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as ParallelSearchResponse;
  const results: SearchResult[] = (data.results ?? [])
    .flatMap((item) =>
      item.url
        ? [
            {
              title: item.title || item.url,
              url: item.url,
              snippet: (item.excerpts ?? []).join(" ... ").slice(0, 400),
            },
          ]
        : [],
    )
    .slice(0, options.numResults ?? 8);
  return { query, results, provider: "parallel" };
}

interface ParallelExtractResponse {
  results?: Array<{ url: string; title?: string | null; full_content?: string | null }>;
  errors?: Array<{
    url: string;
    error_type: string;
    http_status_code?: number | null;
    content?: string | null;
  }>;
}

export async function fetchParallel(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const config = resolveParallelConfig();
  if (!config)
    throw new Error("Parallel API key not found. Set PARALLEL_API_KEY or run /websearch-auth");

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/v1/extract`, {
    method: "POST",
    headers: { "x-api-key": config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url], advanced_settings: { full_content: true } }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Parallel extract failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as ParallelExtractResponse;
  const error = data.errors?.find((item) => item.url === url);
  if (error) {
    // The target's own HTTP status stays out of the message: the runtime reads
    // 402/403/429 in an error as this provider's quota or rate limit.
    throw new Error(`Parallel could not extract ${url}: ${error.error_type}`);
  }
  const item = data.results?.find((result) => result.url === url);
  if (!item?.full_content?.trim()) {
    throw new Error(`Parallel returned no full content for ${url}`);
  }
  return {
    url,
    title: item.title ?? undefined,
    text: item.full_content,
    provider: "parallel",
    contentType: "text/markdown",
  };
}
