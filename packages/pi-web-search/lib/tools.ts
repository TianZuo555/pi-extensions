import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  createWebSearchRuntime,
  runWebSearch,
  WebSearchRuntime,
  type WebSearchRuntimeInstance,
} from "../src/runtime.ts";
import {
  WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS,
  WEB_FETCH_PARAMETER_DESCRIPTIONS,
  WEB_FETCH_PROMPT_SNIPPET,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS,
  WEB_SEARCH_PARAMETER_DESCRIPTIONS,
  WEB_SEARCH_PROMPT_SNIPPET,
  WEB_SEARCH_TOOL_DESCRIPTION,
  formatWebFetchProvider,
} from "./prompt.ts";
import type {
  FetchProviderName,
  FetchResponse,
  SearchOptions,
  SearchProviderName,
  SearchResponse,
} from "./types.ts";

export const WebSearchParams = Type.Object({
  query: Type.String({
    description: WEB_SEARCH_PARAMETER_DESCRIPTIONS.query,
  }),
  numResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: WEB_SEARCH_PARAMETER_DESCRIPTIONS.numResults,
    }),
  ),
});

export type WebSearchInput = Static<typeof WebSearchParams>;

const WebSearchHitSchema = Type.Object({
  title: Type.String({ description: "Result title." }),
  url: Type.String({ description: "Result URL." }),
  snippet: Type.String({ description: "Snippet or empty string." }),
});

export const WebSearchOutputSchema = Type.Object({
  query: Type.String({ description: WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS.query }),
  provider: Type.String({ description: WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS.provider }),
  answer: Type.Optional(
    Type.String({ description: WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS.answer }),
  ),
  results: Type.Array(WebSearchHitSchema, {
    description: WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS.results,
  }),
  internalSources: Type.Optional(
    Type.Array(Type.String(), {
      description: WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS.internalSources,
    }),
  ),
  fallbackFrom: Type.Optional(
    Type.Array(Type.String(), {
      description: WEB_SEARCH_OUTPUT_FIELD_DESCRIPTIONS.fallbackFrom,
    }),
  ),
});

export type WebSearchStructuredContent = Static<typeof WebSearchOutputSchema>;

export function webSearchStructuredContent(
  params: WebSearchInput,
  response: SearchResponse,
): WebSearchStructuredContent {
  return {
    query: params.query,
    provider: response.provider,
    ...(response.answer ? { answer: response.answer } : {}),
    results: response.results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    })),
    ...(response.internalSources?.length
      ? { internalSources: response.internalSources }
      : {}),
    ...(response.fallbacks?.length
      ? { fallbackFrom: response.fallbacks.map((fallback) => fallback.provider) }
      : {}),
  };
}

export interface WebSearchDetails {
  query: string;
  provider: SearchProviderName;
  resultsCount: number;
  hasAnswer: boolean;
  results: Array<{ title: string; url: string }>;
  /** Non-URL sources behind an answer-only response (e.g. oai-weather). */
  internalSources?: string[];
  fallbackFrom?: string[];
}

export const WebFetchParams = Type.Object({
  url: Type.String({
    description: WEB_FETCH_PARAMETER_DESCRIPTIONS.url,
  }),
  raw: Type.Optional(
    Type.Boolean({
      description: WEB_FETCH_PARAMETER_DESCRIPTIONS.raw,
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 10000,
      description: WEB_FETCH_PARAMETER_DESCRIPTIONS.maxPages,
    }),
  ),
});

export type WebFetchInput = Static<typeof WebFetchParams>;

export const WebFetchOutputSchema = Type.Object({
  url: Type.String({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.url }),
  provider: Type.String({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.provider }),
  title: Type.Optional(Type.String({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.title })),
  text: Type.String({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.text }),
  contentType: Type.Optional(
    Type.String({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.contentType }),
  ),
  bytes: Type.Integer({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.bytes }),
  pages: Type.Optional(Type.Integer({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.pages })),
  savedTo: Type.Optional(Type.String({ description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.savedTo })),
  fallbackFrom: Type.Optional(
    Type.Array(Type.String(), {
      description: WEB_FETCH_OUTPUT_FIELD_DESCRIPTIONS.fallbackFrom,
    }),
  ),
});

export type WebFetchStructuredContent = Static<typeof WebFetchOutputSchema>;

export function webFetchStructuredContent(
  response: FetchResponse,
  bytes: number,
): WebFetchStructuredContent {
  return {
    url: response.url,
    provider: response.provider,
    ...(response.title ? { title: response.title } : {}),
    text: response.text,
    ...(response.contentType ? { contentType: response.contentType } : {}),
    bytes,
    ...(response.pages ? { pages: response.pages } : {}),
    ...(response.savedTo ? { savedTo: response.savedTo } : {}),
    ...(response.fallbacks?.length
      ? { fallbackFrom: response.fallbacks.map((fallback) => fallback.provider) }
      : {}),
  };
}

/**
 * Shared error renderer: failed tool calls carry the error text in content
 * (often with an empty/partial details object), so render the first
 * non-empty error line instead of the success summary.
 */
function renderToolError(
  result: AgentToolResult<unknown>,
  expanded: boolean,
  verb: string,
  theme: Theme,
): Text {
  const output = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? `${verb} failed`;
  const summary = theme.fg("error", `✗ ${firstLine}`);
  if (!expanded || output === firstLine) return new Text(summary, 0, 0);
  return new Text(`${summary}\n${theme.fg("toolOutput", output)}`, 0, 0);
}

export interface WebFetchDetails {
  url: string;
  provider: FetchProviderName;
  title?: string;
  bytes: number;
  /** Total page count when the fetched document is a PDF. */
  pages?: number;
  /** Local file path when an oversized PDF extraction was written to disk. */
  savedTo?: string;
  fallbackFrom?: string[];
}

export async function executeSearch(
  params: WebSearchInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  runtime?: WebSearchRuntimeInstance | (() => WebSearchRuntimeInstance),
): Promise<{
  text: string;
  details: WebSearchDetails;
  structuredContent: WebSearchStructuredContent;
}> {
  const searchRuntime =
    typeof runtime === "function" ? runtime() : (runtime ?? createWebSearchRuntime());
  const searchService = searchRuntime.runSync(WebSearchRuntime);

  const searchOptions: SearchOptions = {
    numResults: params.numResults,
    signal,
  };

  const response: SearchResponse = await runWebSearch(
    searchRuntime,
    searchService.search(params.query, searchOptions, undefined, ctx),
    { signal },
  );

  const sections: string[] = [];

  if (response.answer) {
    sections.push(`## Summary\n\n${response.answer}`);
  }

  if (response.results.length > 0) {
    const list = response.results.map((r, i) => {
      const header = `${i + 1}. [${r.title || r.url}](${r.url})`;
      return r.snippet ? `${header}\n   ${r.snippet}` : header;
    });
    sections.push(`## Sources & Results (${response.provider})\n\n${list.join("\n\n")}`);
  } else if (response.internalSources?.length) {
    sections.push(
      `Answer from internal ${response.provider} source: ${response.internalSources.join(", ")} (no web URLs).`,
    );
  } else if (!response.answer) {
    sections.push(`No search results found for: "${params.query}" via ${response.provider}.`);
  }

  const text = sections.join("\n\n");
  const details: WebSearchDetails = {
    query: params.query,
    provider: response.provider,
    resultsCount: response.results.length,
    hasAnswer: !!response.answer,
    results: response.results.map((r) => ({ title: r.title, url: r.url })),
    internalSources: response.internalSources?.length ? response.internalSources : undefined,
    fallbackFrom: response.fallbacks?.length
      ? response.fallbacks.map((f) => f.provider)
      : undefined,
  };

  return { text, details, structuredContent: webSearchStructuredContent(params, response) };
}

export async function executeFetch(
  params: WebFetchInput,
  signal: AbortSignal | undefined,
  runtime?: WebSearchRuntimeInstance | (() => WebSearchRuntimeInstance),
): Promise<{
  text: string;
  details: WebFetchDetails;
  structuredContent: WebFetchStructuredContent;
}> {
  const searchRuntime =
    typeof runtime === "function" ? runtime() : (runtime ?? createWebSearchRuntime());
  const searchService = searchRuntime.runSync(WebSearchRuntime);

  const response: FetchResponse = await runWebSearch(
    searchRuntime,
    searchService.fetch(
      params.url,
      { signal, raw: params.raw, maxPages: params.maxPages },
      undefined,
    ),
    { signal },
  );

  const outputParts: string[] = [formatWebFetchProvider(response.provider), ""];
  if (response.title) {
    outputParts.push(`# ${response.title}\n`);
  }
  outputParts.push(response.text);

  const text = outputParts.join("\n");
  const bytes = Buffer.byteLength(text, "utf-8");
  const details: WebFetchDetails = {
    url: response.url,
    provider: response.provider,
    title: response.title,
    bytes,
    pages: response.pages,
    savedTo: response.savedTo,
    fallbackFrom: response.fallbacks?.length
      ? response.fallbacks.map((f) => f.provider)
      : undefined,
  };

  return { text, details, structuredContent: webFetchStructuredContent(response, bytes) };
}

export function registerTools(
  pi: ExtensionAPI,
  runtime?: WebSearchRuntimeInstance | (() => WebSearchRuntimeInstance),
): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    promptSnippet: WEB_SEARCH_PROMPT_SNIPPET,
    parameters: WebSearchParams,
    outputSchema: WebSearchOutputSchema,

    async execute(_toolCallId, params: WebSearchInput, signal, _onUpdate, ctx) {
      const activeRuntime = typeof runtime === "function" ? runtime() : runtime;
      const { text, details, structuredContent } = await executeSearch(
        params,
        signal,
        ctx,
        activeRuntime,
      );
      return {
        content: [{ type: "text" as const, text }],
        details,
        structuredContent,
      };
    },

    renderCall(args: WebSearchInput, theme: Theme) {
      const queryStr = `"${args.query}"`;
      const line = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", queryStr);
      return new Text(line, 0, 0);
    },

    renderResult(result: AgentToolResult<unknown>, { expanded }, theme: Theme, context) {
      if (context.isError) {
        return renderToolError(result, expanded, "Search", theme);
      }
      const details = result.details as WebSearchDetails | undefined;
      if (!details) {
        return new Text(theme.fg("success", "✓ Search completed"), 0, 0);
      }

      const fallbackStr = details.fallbackFrom?.length
        ? theme.fg("warning", ` (fallback from ${details.fallbackFrom.join(" → ")})`)
        : "";
      const summary =
        theme.fg("success", "✓ ") +
        theme.fg(
          "muted",
          details.internalSources?.length
            ? `answer via ${details.provider} (internal source: ${details.internalSources.join(", ")})`
            : `${details.resultsCount} result${details.resultsCount === 1 ? "" : "s"} via ${details.provider}${
                details.hasAnswer ? " (with summary)" : ""
              }`,
        ) +
        fallbackStr;

      if (!expanded || details.results.length === 0) {
        return new Text(summary, 0, 0);
      }

      const lines = [summary];
      for (const r of details.results) {
        lines.push(`  ${theme.fg("accent", "•")} ${theme.fg("dim", r.title || r.url)}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: WEB_FETCH_TOOL_DESCRIPTION,
    promptSnippet: WEB_FETCH_PROMPT_SNIPPET,
    parameters: WebFetchParams,
    outputSchema: WebFetchOutputSchema,

    async execute(_toolCallId, params: WebFetchInput, signal) {
      const activeRuntime = typeof runtime === "function" ? runtime() : runtime;
      const { text, details, structuredContent } = await executeFetch(
        params,
        signal,
        activeRuntime,
      );
      return {
        content: [{ type: "text" as const, text }],
        details,
        structuredContent,
      };
    },

    renderCall(args: WebFetchInput, theme: Theme) {
      const line = theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", args.url);
      return new Text(line, 0, 0);
    },

    renderResult(result: AgentToolResult<unknown>, { expanded }, theme: Theme, context) {
      if (context.isError) {
        return renderToolError(result, expanded, "Fetch", theme);
      }
      const details = result.details as WebFetchDetails | undefined;
      if (!details) {
        return new Text(theme.fg("success", "✓ Fetch completed"), 0, 0);
      }

      const kb = (details.bytes / 1024).toFixed(1);
      const pdfStr = details.pages ? `, ${details.pages}p PDF` : "";
      const titleStr = details.title ? ` (${details.title})` : "";
      const fallbackStr = details.fallbackFrom?.length
        ? theme.fg("warning", ` (fallback from ${details.fallbackFrom.join(" → ")})`)
        : "";
      const summary =
        theme.fg("success", "✓ ") +
        theme.fg("muted", `${kb} KB via ${details.provider}${pdfStr}${titleStr}`) +
        fallbackStr;

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const lines = [summary, `  ${theme.fg("accent", "URL:")} ${theme.fg("dim", details.url)}`];
      if (details.savedTo) {
        lines.push(`  ${theme.fg("accent", "Saved to:")} ${theme.fg("dim", details.savedTo)}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
