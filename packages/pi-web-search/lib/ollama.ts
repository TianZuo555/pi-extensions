import { resolveOllamaConfig } from "./config.ts";
import type {
  FetchOptions,
  FetchResponse,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

interface OllamaSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
}

interface OllamaSearchApiResponse {
  results?: OllamaSearchResultItem[];
}

interface OllamaFetchApiResponse {
  title?: string;
  content?: string;
  text?: string;
}

async function tryPost(
  url: string,
  body: Record<string, unknown>,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

export async function searchOllama(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveOllamaConfig();
  const maxResults = options.numResults && options.numResults > 0 ? options.numResults : 8;

  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const endpoints = [
    `${config.baseUrl}/api/experimental/web_search`,
    `${config.baseUrl}/api/web_search`,
  ];

  let res: Response | null = null;
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const candidate = await tryPost(
        endpoint,
        { query, max_results: maxResults },
        config.apiKey,
        combinedSignal,
      );
      if (candidate.ok) {
        res = candidate;
        break;
      }
      if (candidate.status !== 404) {
        const text = await candidate.text().catch(() => "");
        throw new Error(
          `Ollama search failed (${candidate.status} ${candidate.statusText}): ${text.slice(0, 300)}`,
        );
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!res || !res.ok) {
    throw (
      lastError ||
      new Error(
        `Ollama web_search endpoint not found at ${config.baseUrl}. Ensure Ollama is running and web search is enabled.`,
      )
    );
  }

  const data = (await res.json()) as OllamaSearchApiResponse | OllamaSearchResultItem[];
  const rawResults: OllamaSearchResultItem[] = Array.isArray(data)
    ? data
    : Array.isArray(data.results)
      ? data.results
      : [];

  const results: SearchResult[] = rawResults.map((item) => {
    const url = item.url || "";
    const title = item.title || url;
    const snippet = item.snippet || item.content?.slice(0, 300) || "";
    return { title, url, snippet };
  });

  return {
    query,
    results,
    provider: "ollama",
  };
}

export async function fetchOllama(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const config = resolveOllamaConfig();
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const endpoints = [
    `${config.baseUrl}/api/experimental/web_fetch`,
    `${config.baseUrl}/api/web_fetch`,
  ];

  let res: Response | null = null;
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const candidate = await tryPost(
        endpoint,
        { url },
        config.apiKey,
        combinedSignal,
      );
      if (candidate.ok) {
        res = candidate;
        break;
      }
      if (candidate.status !== 404) {
        const text = await candidate.text().catch(() => "");
        throw new Error(
          `Ollama fetch failed (${candidate.status} ${candidate.statusText}): ${text.slice(0, 300)}`,
        );
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!res || !res.ok) {
    throw (
      lastError ||
      new Error(
        `Ollama web_fetch endpoint not found at ${config.baseUrl}. Ensure Ollama is running and web fetch is enabled.`,
      )
    );
  }

  const data = (await res.json()) as OllamaFetchApiResponse;
  const text = data.content || data.text || "";
  const title = data.title;

  if (!text) {
    throw new Error(`Ollama returned no readable content for ${url}`);
  }

  return {
    url,
    title,
    text,
    provider: "ollama",
    contentType: "text/plain",
  };
}
