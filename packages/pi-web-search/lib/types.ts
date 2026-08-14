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

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  answer?: string;
  provider: SearchProviderName;
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
    apiKey?: string;
    baseUrl?: string;
  };
  firecrawl?: {
    apiKey?: string;
    baseUrl?: string;
  };
  ollama?: {
    baseUrl?: string;
    apiKey?: string;
  };
}
