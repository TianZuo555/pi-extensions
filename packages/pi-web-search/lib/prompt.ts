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

export const WEB_FETCH_TOOL_DESCRIPTION =
  "Fetch an HTTP(S) page as clean Markdown or text.";
export const WEB_FETCH_PROMPT_SNIPPET = "Fetch a web page";

export const WEB_FETCH_PARAMETER_DESCRIPTIONS = {
  url: "HTTP(S) URL.",
  raw: "Return raw HTML/text; default false.",
};
