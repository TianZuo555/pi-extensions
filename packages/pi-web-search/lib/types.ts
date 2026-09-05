export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  numResults?: number;
  domainFilter?: string[];
  signal?: AbortSignal;
}

export interface ProviderFallback {
  provider: string;
  reason: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answer?: string;
  provider: SearchProviderName;
  /** Providers that were tried before this response and failed */
  fallbacks?: ProviderFallback[];
  /** Non-URL sources that produced the answer, e.g. OpenAI internal APIs
   * ("oai-weather"). Present when the answer came from an internal source
   * instead of web pages — web result lists are then legitimately empty. */
  internalSources?: string[];
}

export interface FetchOptions {
  signal?: AbortSignal;
  raw?: boolean;
  timeoutMs?: number;
}

export interface FetchResponse {
  url: string;
  title?: string;
  text: string;
  provider: FetchProviderName;
  contentType?: string;
  /** Providers that were tried before this response and failed */
  fallbacks?: ProviderFallback[];
}

export type SearchProviderName =
  | "openai"
  | "deepseek"
  | "exa"
  | "tavily"
  | "firecrawl"
  | "ollama"
  | "monid";
export type FetchProviderName = "firecrawl" | "exa" | "tavily" | "ollama" | "monid" | "direct";

export interface ProviderStatus {
  name: string;
  label: string;
  configured: boolean;
  source?: string;
  baseUrl?: string;
  model?: string;
}

export interface WebSearchConfig {
  searchProvider?: SearchProviderName;
  fetchProvider?: FetchProviderName;
  /** Explicit search fallback priority; credentialed providers not listed
   * here still join the end of the chain in canonical order. */
  searchOrder?: SearchProviderName[];
  /** Explicit fetch fallback priority; credentialed providers not listed
   * here still join the end of the chain in canonical order. */
  fetchOrder?: FetchProviderName[];
  openai?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    systemPrompt?: string;
    /** Responses API reasoning effort. Explicit setting wins; otherwise the
     * session's pi thinking level is used (mapped via the model registry);
     * with neither, the model default (medium) applies. "low" is ~40%
     * faster and usually plenty for search queries. */
    reasoning?: "low" | "medium" | "high";
  };
  deepseek?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    systemPrompt?: string;
    /** Responses API reasoning effort for the server-side web_search tool.
     * Defaults to "low": fast and cheap for search queries. "none" disables
     * thinking mode entirely. */
    reasoning?: "none" | "low" | "medium" | "high";
  };
  exa?: {
    baseUrl?: string;
  };
  firecrawl?: {
    baseUrl?: string;
    /** Set false to disable the keyless no-API-key tier (default on). */
    keyless?: boolean;
  };
  tavily?: {
    baseUrl?: string;
  };
  ollama?: {
    baseUrl?: string;
  };
  monid?: {
    baseUrl?: string;
  };
}
