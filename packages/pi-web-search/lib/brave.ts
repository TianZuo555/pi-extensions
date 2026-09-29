import { resolveBraveConfig } from "./config.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

interface BraveSearchResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

export async function searchBrave(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const config = resolveBraveConfig();
  if (!config) throw new Error("Brave API key not found. Set BRAVE_API_KEY or run /websearch-auth");

  const includes = options.domainFilter?.filter((d) => !d.startsWith("-")) ?? [];
  const excludes = options.domainFilter?.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()) ?? [];
  const scopedQuery = [
    query,
    includes.length ? `(${includes.map((d) => `site:${d}`).join(" OR ")})` : "",
    ...excludes.map((d) => `-site:${d}`),
  ].filter(Boolean).join(" ");
  const url = new URL(config.baseUrl);
  url.searchParams.set("q", scopedQuery);
  url.searchParams.set("count", String(Math.min(options.numResults ?? 8, 20)));
  url.searchParams.set("result_filter", "web");

  const timeout = AbortSignal.timeout(60_000);
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": config.apiKey, Accept: "application/json" },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brave search failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as BraveSearchResponse;
  const results: SearchResult[] = (data.web?.results ?? []).flatMap((item) =>
    item.url ? [{ title: item.title || item.url, url: item.url, snippet: item.description ?? "" }] : [],
  ).slice(0, options.numResults ?? 8);
  return { query, results, provider: "brave" };
}
