import { resolveParallelConfig } from "./config.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

interface ParallelSearchResponse {
  results?: Array<{ title?: string | null; url: string; excerpts?: string[] }>;
}

export async function searchParallel(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const config = resolveParallelConfig();
  if (!config) throw new Error("Parallel API key not found. Set PARALLEL_API_KEY or run /websearch-auth");

  const includes = options.domainFilter?.filter((d) => !d.startsWith("-")) ?? [];
  const excludes = options.domainFilter?.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()) ?? [];
  const sourcePolicy = {
    ...(includes.length ? { include_domains: includes } : {}),
    ...(excludes.length ? { exclude_domains: excludes } : {}),
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
      ...(Object.keys(advancedSettings).length ? { advanced_settings: advancedSettings } : {}),
    }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Parallel search failed (${res.status} ${res.statusText}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as ParallelSearchResponse;
  const results: SearchResult[] = (data.results ?? []).flatMap((item) =>
    item.url ? [{ title: item.title || item.url, url: item.url, snippet: (item.excerpts ?? []).join(" ... ").slice(0, 400) }] : [],
  ).slice(0, options.numResults ?? 8);
  return { query, results, provider: "parallel" };
}
