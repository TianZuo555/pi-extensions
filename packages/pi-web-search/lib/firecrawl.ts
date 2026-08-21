import { resolveFirecrawlConfig } from "./config.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

interface FirecrawlSearchResultItem {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

interface FirecrawlSearchApiResponse {
  success?: boolean;
  data?: FirecrawlSearchResultItem[];
  error?: string;
}

interface FirecrawlScrapeApiResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    content?: string;
    metadata?: {
      title?: string;
      description?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

export async function searchFirecrawl(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveFirecrawlConfig();
  if (!config) {
    throw new Error(
      "Firecrawl API key not found. Set FIRECRAWL_API_KEY or configure ~/.config/pi-web-search/config.json",
    );
  }

  const searchUrl = `${config.baseUrl.replace(/\/+$/, "")}/search`;
  const limit = options.numResults && options.numResults > 0 ? options.numResults : 8;

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
    body: JSON.stringify({
      query,
      limit,
    }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `Firecrawl search failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as FirecrawlSearchApiResponse;
  const rawResults = Array.isArray(data.data) ? data.data : [];

  const results: SearchResult[] = rawResults.map((item) => {
    const url = item.url || "";
    const title = item.title || url;
    const snippet = item.description || (item.markdown ? item.markdown.slice(0, 300) : "");
    return { title, url, snippet };
  });

  return {
    query,
    results,
    provider: "firecrawl",
  };
}

export async function fetchFirecrawl(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const config = resolveFirecrawlConfig();
  if (!config) {
    throw new Error(
      "Firecrawl API key not found. Set FIRECRAWL_API_KEY or configure ~/.config/pi-web-search/config.json",
    );
  }

  const scrapeUrl = `${config.baseUrl.replace(/\/+$/, "")}/scrape`;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(scrapeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
    }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `Firecrawl scrape failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as FirecrawlScrapeApiResponse;
  const markdown = data.data?.markdown || data.data?.content || "";
  const title = data.data?.metadata?.title;

  if (!markdown) {
    throw new Error(`Firecrawl returned no readable content for ${url}`);
  }

  return {
    url,
    title,
    text: markdown,
    provider: "firecrawl",
    contentType: "text/markdown",
  };
}
