import { resolveExaConfig } from "./config.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const EXA_MAX_SNIPPET_CHARS = 400;
const EXA_MAX_FETCH_CHARS = 500_000;

interface ExaSearchResultItem {
  id?: string;
  url?: string;
  title?: string;
  text?: string;
  highlights?: string[];
  snippet?: string;
}

interface ExaSearchApiResponse {
  results?: ExaSearchResultItem[];
}

interface ExaContentsApiResponse {
  results?: Array<{
    id?: string;
    url?: string;
    title?: string;
    text?: string;
  }>;
}

export async function searchExa(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveExaConfig();
  if (!config) {
    throw new Error(
      "Exa API key not found. Set EXA_API_KEY or configure ~/.config/pi-tian-web-search/config.json",
    );
  }

  const searchUrl = `${config.baseUrl.replace(/\/+$/, "")}/search`;
  const numResults = options.numResults && options.numResults > 0 ? options.numResults : 8;

  const body: Record<string, unknown> = {
    query,
    numResults,
    contents: {
      text: {
        maxCharacters: EXA_MAX_SNIPPET_CHARS,
      },
    },
  };

  if (options.domainFilter?.length) {
    const includes = options.domainFilter.filter((d) => !d.startsWith("-"));
    const excludes = options.domainFilter
      .filter((d) => d.startsWith("-"))
      .map((d) => d.slice(1).trim());
    if (includes.length > 0) body.includeDomains = includes;
    if (excludes.length > 0) body.excludeDomains = excludes;
  }

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(searchUrl, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Exa search failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`);
  }

  const data = (await res.json()) as ExaSearchApiResponse;
  const rawResults = Array.isArray(data.results) ? data.results : [];

  const results: SearchResult[] = rawResults.map((item) => {
    const url = item.url || item.id || "";
    const title = item.title || url;
    const snippet =
      item.highlights?.join(" ... ") ||
      item.snippet ||
      item.text?.slice(0, EXA_MAX_SNIPPET_CHARS) ||
      "";
    return { title, url, snippet };
  });

  return {
    query,
    results,
    provider: "exa",
  };
}

export async function fetchExa(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const config = resolveExaConfig();
  if (!config) {
    throw new Error(
      "Exa API key not found. Set EXA_API_KEY or configure ~/.config/pi-tian-web-search/config.json",
    );
  }

  const contentsUrl = `${config.baseUrl.replace(/\/+$/, "")}/contents`;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(contentsUrl, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ids: [url],
      text: {
        maxCharacters: EXA_MAX_FETCH_CHARS,
      },
    }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`Exa fetch failed (${res.status} ${res.statusText}): ${errorText.slice(0, 300)}`);
  }

  const data = (await res.json()) as ExaContentsApiResponse;
  const item = data.results?.[0];
  if (!item || (!item.text && !item.title)) {
    throw new Error(`Exa returned no readable content for ${url}`);
  }

  return {
    url,
    title: item.title,
    text: item.text || "",
    provider: "exa",
    contentType: "text/plain",
  };
}
