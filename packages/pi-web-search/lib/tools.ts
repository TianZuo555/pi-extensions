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
  WEB_FETCH_PARAMETER_DESCRIPTIONS,
  WEB_FETCH_PROMPT_SNIPPET,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_PARAMETER_DESCRIPTIONS,
  WEB_SEARCH_PROMPT_SNIPPET,
  WEB_SEARCH_TOOL_DESCRIPTION,
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
});

export type WebFetchInput = Static<typeof WebFetchParams>;

export interface WebFetchDetails {
  url: string;
  provider: FetchProviderName;
  title?: string;
  bytes: number;
  fallbackFrom?: string[];
}

export async function executeSearch(
  params: WebSearchInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  runtime?: WebSearchRuntimeInstance | (() => WebSearchRuntimeInstance),
): Promise<{ text: string; details: WebSearchDetails }> {
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

  return { text, details };
}

export async function executeFetch(
  params: WebFetchInput,
  signal: AbortSignal | undefined,
  runtime?: WebSearchRuntimeInstance | (() => WebSearchRuntimeInstance),
): Promise<{ text: string; details: WebFetchDetails }> {
  const searchRuntime =
    typeof runtime === "function" ? runtime() : (runtime ?? createWebSearchRuntime());
  const searchService = searchRuntime.runSync(WebSearchRuntime);

  const response: FetchResponse = await runWebSearch(
    searchRuntime,
    searchService.fetch(params.url, { signal, raw: params.raw }, undefined),
    { signal },
  );

  const outputParts: string[] = [];
  if (response.title) {
    outputParts.push(`# ${response.title}\n`);
  }
  outputParts.push(response.text);

  const text = outputParts.join("\n");
  const details: WebFetchDetails = {
    url: response.url,
    provider: response.provider,
    title: response.title,
    bytes: Buffer.byteLength(text, "utf-8"),
    fallbackFrom: response.fallbacks?.length
      ? response.fallbacks.map((f) => f.provider)
      : undefined,
  };

  return { text, details };
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

    async execute(_toolCallId, params: WebSearchInput, signal, _onUpdate, ctx) {
      const activeRuntime = typeof runtime === "function" ? runtime() : runtime;
      const { text, details } = await executeSearch(params, signal, ctx, activeRuntime);
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },

    renderCall(args: WebSearchInput, theme: Theme) {
      const queryStr = `"${args.query}"`;
      const line = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", queryStr);
      return new Text(line, 0, 0);
    },

    renderResult(result: AgentToolResult<unknown>, { expanded }, theme: Theme) {
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

    async execute(_toolCallId, params: WebFetchInput, signal) {
      const activeRuntime = typeof runtime === "function" ? runtime() : runtime;
      const { text, details } = await executeFetch(params, signal, activeRuntime);
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },

    renderCall(args: WebFetchInput, theme: Theme) {
      const line = theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", args.url);
      return new Text(line, 0, 0);
    },

    renderResult(result: AgentToolResult<unknown>, { expanded }, theme: Theme) {
      const details = result.details as WebFetchDetails | undefined;
      if (!details) {
        return new Text(theme.fg("success", "✓ Fetch completed"), 0, 0);
      }

      const kb = (details.bytes / 1024).toFixed(1);
      const titleStr = details.title ? ` (${details.title})` : "";
      const fallbackStr = details.fallbackFrom?.length
        ? theme.fg("warning", ` (fallback from ${details.fallbackFrom.join(" → ")})`)
        : "";
      const summary =
        theme.fg("success", "✓ ") +
        theme.fg("muted", `${kb} KB via ${details.provider}${titleStr}`) +
        fallbackStr;

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const lines = [summary, `  ${theme.fg("accent", "URL:")} ${theme.fg("dim", details.url)}`];
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
