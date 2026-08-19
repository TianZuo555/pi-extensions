/**
 * Model-facing prompt strings and parameter descriptions for web search and fetch tools.
 */

export const DEFAULT_OPENAI_SYSTEM_PROMPT =
  "Search the web and provide a concise, accurate answer grounded in the web sources. Cite sources with markdown links where appropriate.";

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the live web for current information, documentation, news, or technical references.";

export const WEB_SEARCH_PROMPT_SNIPPET =
  "Search the live web for up-to-date information and documentation.";

export const WEB_SEARCH_PROMPT_GUIDELINES = [
  "Use web_search when answers need current info.",
];

export const WEB_SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "Search query to look up on the live web",
  numResults: "Maximum number of search results to return (default: 8)",
};

export const WEB_FETCH_TOOL_DESCRIPTION =
  "Fetch and convert an HTTP/HTTPS webpage or documentation URL into readable clean Markdown or text.";

export const WEB_FETCH_PROMPT_SNIPPET = "Fetch the content of a specific web URL.";

export const WEB_FETCH_PROMPT_GUIDELINES = [
  "Use web_fetch to inspect specific webpage links.",
];

export const WEB_FETCH_PARAMETER_DESCRIPTIONS = {
  url: "The HTTP or HTTPS URL of the web page or document to fetch",
  raw: "Return raw HTML or unmodified text instead of clean Markdown (default: false)",
};
