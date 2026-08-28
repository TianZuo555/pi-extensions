import { resolveFirecrawlConfig } from "./config.ts";
import type { ResolvedFirecrawlConfig } from "./config.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Keyless-tier state. The free tier (1,000 credits/month, no account) is
 * tried first; when it hits its quota wall (402/403) or a rate limit (429),
 * we stop paying that latency for the rest of the session (or 2 minutes for
 * rate limits) and use the user's own key, if one is configured.
 */
let keylessExhaustedForSession = false;
let keylessRetryAt = 0;

/** Reset keyless exhaustion state (used by tests). */
export function resetFirecrawlKeylessState(): void {
  keylessExhaustedForSession = false;
  keylessRetryAt = 0;
}

function firecrawlHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey
    ? {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      }
    : { "Content-Type": "application/json" };
}

/**
 * POST to a Firecrawl endpoint, honoring the keyless → user-key ladder:
 * keyless first, and on quota exhaustion switch to the user's key when one
 * exists; the switch is remembered so later calls skip the dead tier.
 */
async function firecrawlPost(
  path: string,
  body: unknown,
  config: ResolvedFirecrawlConfig,
  signal: AbortSignal,
  label: string,
): Promise<Response> {
  const attempt = (apiKey: string | undefined) =>
    fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: firecrawlHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });

  if (!config.keyless) {
    return attempt(config.apiKey);
  }

  if (keylessExhaustedForSession || Date.now() < keylessRetryAt) {
    if (config.overflowApiKey) return attempt(config.overflowApiKey);
    throw new Error(
      `Firecrawl keyless failed (${label}): free monthly credits exhausted (402); set FIRECRAWL_API_KEY to keep using Firecrawl`,
    );
  }

  const res = await attempt(undefined);
  if (res.status === 402 || res.status === 403 || res.status === 429) {
    if (res.status === 429) {
      keylessRetryAt = Date.now() + 120_000;
    } else {
      keylessExhaustedForSession = true;
    }
    if (config.overflowApiKey) return attempt(config.overflowApiKey);
    throw new Error(
      `Firecrawl keyless failed (${res.status} ${res.statusText}): free monthly credits exhausted; set FIRECRAWL_API_KEY to keep using Firecrawl`,
    );
  }
  return res;
}

interface FirecrawlSearchResultItem {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

interface FirecrawlSearchApiResponse {
  success?: boolean;
  /** v2 wraps results in category objects (`{ web: [...] }`); older
   * deployments returned a bare array. */
  data?: FirecrawlSearchResultItem[] | { web?: FirecrawlSearchResultItem[] };
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
      "Firecrawl is unavailable: keyless mode disabled (FIRECRAWL_KEYLESS=0 or firecrawl.keyless=false) and no FIRECRAWL_API_KEY set",
    );
  }

  const searchUrl = `/search`;
  const limit = options.numResults && options.numResults > 0 ? options.numResults : 8;

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await firecrawlPost(
    searchUrl,
    {
      query,
      limit,
    },
    config,
    combinedSignal,
    "search",
  );

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `Firecrawl search failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as FirecrawlSearchApiResponse;
  const rawResults = Array.isArray(data.data)
    ? data.data
    : (data.data?.web ?? []);

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
      "Firecrawl is unavailable: keyless mode disabled (FIRECRAWL_KEYLESS=0 or firecrawl.keyless=false) and no FIRECRAWL_API_KEY set",
    );
  }

  const scrapeUrl = `/scrape`;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await firecrawlPost(
    scrapeUrl,
    {
      url,
      formats: ["markdown"],
      // v2: deterministic HTML-level filter that drops navs, headers, footers.
      onlyMainContent: true,
    },
    config,
    combinedSignal,
    "scrape",
  );

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
