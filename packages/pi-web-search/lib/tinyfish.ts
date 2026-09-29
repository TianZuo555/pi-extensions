import { resolveTinyfishConfig, resolveTinyfishFetchUrl } from "./config.ts";
import { splitDomainFilter } from "./domain-filter.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Per-page budget sent to TinyFish. A slower page falls through to the next
 * provider instead of holding the chain; Monid's TinyFish fetch uses the same.
 */
const PER_URL_TIMEOUT_MS = 30_000;
/**
 * Oldest cached page, in seconds, TinyFish may return. Omitting `ttl` accepts a
 * cache entry of any age; two days is Firecrawl's default `maxAge`, so the
 * fetch chain shares one freshness bound.
 */
const CACHE_TTL_SECONDS = 172_800;

interface TinyfishSearchResponse {
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
}

/** Direct TinyFish Search API; independent of the Monid TinyFish proxy. */
export async function searchTinyfish(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveTinyfishConfig();
  if (!config)
    throw new Error("TinyFish API key not found. Set TINYFISH_API_KEY or run /websearch-auth");

  const url = new URL(config.baseUrl);
  url.searchParams.set("query", query);
  const { include, exclude } = splitDomainFilter(options.domainFilter);
  if (include.length) url.searchParams.set("include_domains", include.join(","));
  if (exclude.length) url.searchParams.set("exclude_domains", exclude.join(","));

  const timeout = AbortSignal.timeout(60_000);
  const res = await fetch(url, {
    headers: { "X-API-Key": config.apiKey, Accept: "application/json" },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `TinyFish search failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as TinyfishSearchResponse;
  // TinyFish has no results-count parameter; cap the response locally.
  const results: SearchResult[] = (data.results ?? [])
    .flatMap((item) =>
      item.url
        ? [{ title: item.title || item.url, url: item.url, snippet: item.snippet ?? "" }]
        : [],
    )
    .slice(0, options.numResults ?? 8);
  return { query, results, provider: "tinyfish" };
}

interface TinyfishFetchResponse {
  results?: Array<{
    url: string;
    title?: string | null;
    text?: string | null;
  }>;
  errors?: Array<{ url: string; error: string; status?: number }>;
}

export async function fetchTinyfish(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const config = resolveTinyfishConfig();
  if (!config)
    throw new Error("TinyFish API key not found. Set TINYFISH_API_KEY or run /websearch-auth");

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const res = await fetch(resolveTinyfishFetchUrl(), {
    method: "POST",
    headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: [url],
      format: options.raw ? "html" : "markdown",
      ttl: CACHE_TTL_SECONDS,
      per_url_timeout_ms: PER_URL_TIMEOUT_MS,
    }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `TinyFish fetch failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as TinyfishFetchResponse;
  const error = data.errors?.find((item) => item.url === url);
  if (error) {
    // `error.error` is TinyFish's own code (target_http_error, bot_blocked, ...).
    // The target's HTTP status stays out of the message: the runtime reads
    // 402/403/429 in an error as this provider's quota or rate limit.
    throw new Error(`TinyFish could not fetch ${url}: ${error.error}`);
  }
  const item = data.results?.find((result) => result.url === url);
  if (!item?.text?.trim()) {
    throw new Error(`TinyFish returned no readable content for ${url}`);
  }
  return {
    url,
    title: item.title ?? undefined,
    text: item.text,
    provider: "tinyfish",
    contentType: options.raw ? "text/html" : "text/markdown",
  };
}
