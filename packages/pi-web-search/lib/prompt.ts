/**
 * Model-facing web tool text. Keep descriptions short and non-overlapping;
 * detailed provider errors belong in on-demand results.
 */

export const DEFAULT_OPENAI_SYSTEM_PROMPT =
  "Search the web. Answer concisely and accurately; cite sources with Markdown links.";

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the live web for current information and sources.";
export const WEB_SEARCH_PROMPT_SNIPPET = "Search the live web";

export const WEB_SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "Web search query.",
  numResults: "Maximum results; default 8.",
};

export const WEB_FETCH_TOOL_DESCRIPTION = "Fetch an HTTP(S) page or PDF as clean Markdown or text.";
export const WEB_FETCH_PROMPT_SNIPPET = "Fetch a web page or PDF";

export function formatWebFetchProvider(provider: string): string {
  return `Fetched via ${provider}.`;
}

export const WEB_FETCH_PARAMETER_DESCRIPTIONS = {
  url: "HTTP(S) URL (web page or PDF).",
  raw: "Return raw HTML/text; default false. Ignored for PDFs.",
  maxPages: "PDF only: max pages to extract; default 100.",
};

/** Field text on web tool `outputSchema` (code-mode scripts, not the model). */
export const WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS = {
  query: "The search query.",
  provider: "Provider that produced this result.",
  answer: "Optional short answer from the provider.",
  results: "Ranked pages with title, URL, and snippet.",
  internalSources: "Non-URL sources behind an answer-only result.",
  fallbackFrom: "Providers that failed before this result.",
};

export const WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS = {
  url: "Final fetched URL.",
  provider: "Provider that produced this result.",
  title: "Document title when known.",
  text: "Extracted Markdown or text. A preview when savedTo is set.",
  contentType: "Response Content-Type when known.",
  bytes: "Byte size of the model-facing text.",
  pages: "PDF page count when known.",
  savedTo: "Local file when the full extraction was spilled to disk.",
  fallbackFrom: "Providers that failed before this result.",
};
