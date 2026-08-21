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

export type SearchProviderName = "openai" | "exa" | "firecrawl" | "ollama";
export type FetchProviderName = "firecrawl" | "exa" | "ollama" | "direct";

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
  openai?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    systemPrompt?: string;
  };
  exa?: {
    baseUrl?: string;
  };
  firecrawl?: {
    baseUrl?: string;
  };
  ollama?: {
    baseUrl?: string;
  };
}
