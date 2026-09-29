import { resolveTinyfishConfig } from "./config.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

interface TinyfishSearchResponse {
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
}

/** Direct TinyFish Search API; independent of the Monid TinyFish proxy. */
export async function searchTinyfish(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const config = resolveTinyfishConfig();
  if (!config) throw new Error("TinyFish API key not found. Set TINYFISH_API_KEY or run /websearch-auth");

  const url = new URL(config.baseUrl);
  url.searchParams.set("query", query);
  const includes = options.domainFilter?.filter((d) => !d.startsWith("-")) ?? [];
  const excludes = options.domainFilter?.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()) ?? [];
  if (includes.length) url.searchParams.set("include_domains", includes.join(","));
  if (excludes.length) url.searchParams.set("exclude_domains", excludes.join(","));

  const timeout = AbortSignal.timeout(60_000);
  const res = await fetch(url, {
    headers: { "X-API-Key": config.apiKey, Accept: "application/json" },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TinyFish search failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as TinyfishSearchResponse;
  // TinyFish has no results-count parameter; cap the response locally.
  const results: SearchResult[] = (data.results ?? []).flatMap((item) =>
    item.url ? [{ title: item.title || item.url, url: item.url, snippet: item.snippet ?? "" }] : [],
  ).slice(0, options.numResults ?? 8);
  return { query, results, provider: "tinyfish" };
}
