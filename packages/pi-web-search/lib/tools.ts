import { StringEnum } from "@earendil-works/pi-ai";
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
import type {
  FetchProviderName,
  FetchResponse,
  SearchOptions,
  SearchProviderName,
  SearchResponse,
} from "./types.ts";

export const WebSearchParams = Type.Object({
  query: Type.String({
    description: "Search query to look up on the live web",
  }),
  numResults: Type.Optional(
    Type.Number({
      description: "Maximum number of search results to return (default: 8)",
    }),
  ),
  provider: Type.Optional(
    StringEnum(["openai", "exa", "firecrawl", "ollama"] as const, {
      description: "Search provider override: openai, exa, firecrawl, or ollama",
    }),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter results by domain. Prefix with '-' to block (e.g. ['docs.rs', '-reddit.com'])",
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
}

export const WebFetchParams = Type.Object({
  url: Type.String({
    description: "The HTTP or HTTPS URL of the web page or document to fetch",
  }),
  provider: Type.Optional(
    StringEnum(["firecrawl", "exa", "ollama", "direct"] as const, {
      description: "Fetch provider override: firecrawl, exa, ollama, or direct",
    }),
  ),
  raw: Type.Optional(
    Type.Boolean({
      description: "Return raw HTML or unmodified text instead of clean Markdown (default: false)",
    }),
  ),
});

export type WebFetchInput = Static<typeof WebFetchParams>;

export interface WebFetchDetails {
  url: string;
  provider: FetchProviderName;
  title?: string;
  bytes: number;
}

export async function executeSearch(
  params: WebSearchInput,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  runtime?: WebSearchRuntimeInstance,
): Promise<{ text: string; details: WebSearchDetails }> {
  const searchRuntime = runtime ?? createWebSearchRuntime();
  const searchService = searchRuntime.runSync(WebSearchRuntime);

  const searchOptions: SearchOptions = {
    numResults: params.numResults,
    domainFilter: params.domainFilter,
    signal,
  };

  const response: SearchResponse = await runWebSearch(
    searchRuntime,
    searchService.search(
      params.query,
      searchOptions,
      params.provider as SearchProviderName | undefined,
      ctx,
    ),
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
  };

  return { text, details };
}

export async function executeFetch(
  params: WebFetchInput,
  signal: AbortSignal | undefined,
  runtime?: WebSearchRuntimeInstance,
): Promise<{ text: string; details: WebFetchDetails }> {
  const searchRuntime = runtime ?? createWebSearchRuntime();
  const searchService = searchRuntime.runSync(WebSearchRuntime);

  const response: FetchResponse = await runWebSearch(
    searchRuntime,
    searchService.fetch(
      params.url,
      { signal, raw: params.raw },
      params.provider as FetchProviderName | undefined,
    ),
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
  };

  return { text, details };
}

export function registerTools(
  pi: ExtensionAPI,
  runtime?: WebSearchRuntimeInstance,
): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web for current information, documentation, news, or technical references using OpenAI, Exa, Firecrawl, or Ollama.",
    promptSnippet: "Search the live web for up-to-date information and documentation.",
    promptGuidelines: [
      "Use web_search when questions require recent info, library docs, or facts beyond training data.",
      "Prefer specific keyword queries over conversational sentences.",
    ],
    parameters: WebSearchParams,

    async execute(_toolCallId, params: WebSearchInput, signal, _onUpdate, ctx) {
      const { text, details } = await executeSearch(params, signal, ctx, runtime);
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },

    renderCall(args: WebSearchInput, theme: Theme) {
      const queryStr = `"${args.query}"`;
      const providerStr = args.provider ? ` (${args.provider})` : "";
      const line =
        theme.fg("toolTitle", theme.bold("web_search ")) +
        theme.fg("accent", queryStr) +
        theme.fg("muted", providerStr);
      return new Text(line, 0, 0);
    },

    renderResult(result: AgentToolResult<unknown>, { expanded }, theme: Theme) {
      const details = result.details as WebSearchDetails | undefined;
      if (!details) {
        return new Text(theme.fg("success", "✓ Search completed"), 0, 0);
      }

      const summary =
        theme.fg("success", "✓ ") +
        theme.fg(
          "muted",
          `${details.resultsCount} result${details.resultsCount === 1 ? "" : "s"} via ${details.provider}${
            details.hasAnswer ? " (with summary)" : ""
          }`,
        );

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
    description:
      "Fetch and convert an HTTP/HTTPS webpage or documentation URL into readable clean Markdown or text.",
    promptSnippet: "Fetch the content of a specific web URL.",
    promptGuidelines: [
      "Use web_fetch to inspect specific webpage links, API documentation pages, or articles found via web_search.",
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId, params: WebFetchInput, signal) {
      const { text, details } = await executeFetch(params, signal, runtime);
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },

    renderCall(args: WebFetchInput, theme: Theme) {
      const providerStr = args.provider ? ` (${args.provider})` : "";
      const line =
        theme.fg("toolTitle", theme.bold("web_fetch ")) +
        theme.fg("accent", args.url) +
        theme.fg("muted", providerStr);
      return new Text(line, 0, 0);
    },

    renderResult(result: AgentToolResult<unknown>, { expanded }, theme: Theme) {
      const details = result.details as WebFetchDetails | undefined;
      if (!details) {
        return new Text(theme.fg("success", "✓ Fetch completed"), 0, 0);
      }

      const kb = (details.bytes / 1024).toFixed(1);
      const titleStr = details.title ? ` (${details.title})` : "";
      const summary =
        theme.fg("success", "✓ ") +
        theme.fg("muted", `${kb} KB via ${details.provider}${titleStr}`);

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const lines = [
        summary,
        `  ${theme.fg("accent", "URL:")} ${theme.fg("dim", details.url)}`,
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
