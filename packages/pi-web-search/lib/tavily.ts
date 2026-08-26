import { resolveTavilyConfig } from "./config.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const TAVILY_MAX_SNIPPET_CHARS = 400;

interface TavilySearchResultItem {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilySearchApiResponse {
  query?: string;
  answer?: string;
  results?: TavilySearchResultItem[];
}

interface TavilyExtractApiResponse {
  results?: Array<{
    url?: string;
    raw_content?: string;
  }>;
  failed_results?: Array<{
    url?: string;
    error?: string;
  }>;
}

export async function searchTavily(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveTavilyConfig();
  if (!config) {
    throw new Error(
      "Tavily API key not found. Set TAVILY_API_KEY or run /websearch-auth",
    );
  }

  const searchUrl = `${config.baseUrl.replace(/\/+$/, "")}/search`;
  const maxResults =
    options.numResults && options.numResults > 0 ? options.numResults : 8;

  const body: Record<string, unknown> = {
    query,
    max_results: maxResults,
    include_answer: true,
  };

  if (options.domainFilter?.length) {
    const includes = options.domainFilter.filter((d) => !d.startsWith("-"));
    const excludes = options.domainFilter
      .filter((d) => d.startsWith("-"))
      .map((d) => d.slice(1).trim());
    if (includes.length > 0) body.include_domains = includes;
    if (excludes.length > 0) body.exclude_domains = excludes;
  }

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(searchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `Tavily search failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as TavilySearchApiResponse;
  const rawResults = Array.isArray(data.results) ? data.results : [];

  const results: SearchResult[] = rawResults.map((item) => {
    const url = item.url || "";
    const title = item.title || url;
    const snippet = item.content?.slice(0, TAVILY_MAX_SNIPPET_CHARS) || "";
    return { title, url, snippet };
  });

  return {
    query,
    results,
    answer: data.answer?.trim() || undefined,
    provider: "tavily",
  };
}

export async function fetchTavily(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const config = resolveTavilyConfig();
  if (!config) {
    throw new Error(
      "Tavily API key not found. Set TAVILY_API_KEY or run /websearch-auth",
    );
  }

  const extractUrl = `${config.baseUrl.replace(/\/+$/, "")}/extract`;
  const timeoutSignal = AbortSignal.timeout(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(extractUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      urls: [url],
      format: "markdown",
    }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `Tavily extract failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as TavilyExtractApiResponse;
  const item = data.results?.find((r) => r.raw_content);
  if (!item) {
    const failure = data.failed_results?.find((r) => r.url === url);
    throw new Error(
      `Tavily returned no readable content for ${url}${failure?.error ? `: ${failure.error}` : ""}`,
    );
  }

  return {
    url,
    text: item.raw_content || "",
    provider: "tavily",
    contentType: "text/markdown",
  };
}
