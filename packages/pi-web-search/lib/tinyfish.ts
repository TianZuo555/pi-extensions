import { resolveTinyfishConfig, resolveTinyfishFetchUrl } from "./config.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

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
  const includes = options.domainFilter?.filter((d) => !d.startsWith("-")) ?? [];
  const excludes =
    options.domainFilter?.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()) ?? [];
  if (includes.length) url.searchParams.set("include_domains", includes.join(","));
  if (excludes.length) url.searchParams.set("exclude_domains", excludes.join(","));

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
    not_modified?: boolean;
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

  // TinyFish allows up to 110s per URL and recommends a 150s client timeout.
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 150_000);
  const res = await fetch(resolveTinyfishFetchUrl(), {
    method: "POST",
    headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url], format: "markdown", per_url_timeout_ms: 110_000 }),
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
    throw new Error(
      `TinyFish could not fetch ${url}: ${error.error}${error.status ? ` (target HTTP ${error.status})` : ""}`,
    );
  }
  const item = data.results?.find((result) => result.url === url);
  if (!item?.text?.trim() || item.not_modified) {
    throw new Error(`TinyFish returned no readable content for ${url}`);
  }
  return {
    url,
    title: item.title ?? undefined,
    text: item.text,
    provider: "tinyfish",
    contentType: "text/markdown",
  };
}
