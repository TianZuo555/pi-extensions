import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveOpenAISearchRequest } from "./openai-session.ts";
import {
  applyIndexCitations,
  isLikelyJunkSearchUrl,
  normalizeSearchUrl,
  titleFromUrl,
  type UrlCitation,
} from "./openai-urls.ts";
import { readSseEvents } from "./sse.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const SEARCH_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("-")) input = input.slice(1).trim();
  if (!input) return null;
  try {
    const parsed = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    input = parsed.hostname;
  } catch {
    input = input.split("/")[0]?.split(":")[0] ?? "";
  }
  input = input.replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(
  domainFilter: string[] | undefined,
): { allowedDomains?: string[]; blockedDomains?: string[] } | null {
  if (!domainFilter?.length) return null;

  const allowedDomains: string[] = [];
  const blockedDomains: string[] = [];
  for (const raw of domainFilter) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const target = raw.trim().startsWith("-") ? blockedDomains : allowedDomains;
    if (!target.includes(domain)) target.push(domain);
  }

  return allowedDomains.length > 0 || blockedDomains.length > 0
    ? {
        ...(allowedDomains.length > 0 ? { allowedDomains: allowedDomains.slice(0, 100) } : {}),
        ...(blockedDomains.length > 0 ? { blockedDomains: blockedDomains.slice(0, 100) } : {}),
      }
    : null;
}

function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "web_search" };
  const filters = normalizeDomainFilters(options.domainFilter);
  if (filters) {
    tool.filters = {
      ...(filters.allowedDomains ? { allowed_domains: filters.allowedDomains } : {}),
      ...(filters.blockedDomains ? { blocked_domains: filters.blockedDomains } : {}),
    };
  }
  return tool;
}

function extractSnippetAround(text: string, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || !text) return "";
  const before = Math.max(0, start - 100);
  const after = Math.min(text.length, end + 100);
  const snippet = text
    .slice(before, after)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(
  results: SearchResult[],
  seen: Set<string>,
  url: unknown,
  title: unknown,
  snippet = "",
): void {
  if (typeof url !== "string" || url.trim().length === 0) return;
  const cleanUrl = normalizeSearchUrl(url);
  if (isLikelyJunkSearchUrl(cleanUrl) || seen.has(cleanUrl)) return;
  seen.add(cleanUrl);
  results.push({
    title: typeof title === "string" && title.trim().length > 0 ? title : titleFromUrl(cleanUrl),
    url: cleanUrl,
    snippet,
  });
}

function extractUrlCitation(
  annotation: unknown,
): (UrlCitation & { startIndex?: number }) | undefined {
  if (!isRecord(annotation) || annotation.type !== "url_citation") return undefined;
  const nested = isRecord(annotation.url_citation)
    ? annotation.url_citation
    : isRecord(annotation.urlCitation)
      ? annotation.urlCitation
      : undefined;
  const url = annotation.url ?? nested?.url;
  if (typeof url !== "string" || !url) return undefined;
  const titleValue = annotation.title ?? nested?.title;
  const endIndexValue =
    annotation.end_index ?? annotation.endIndex ?? nested?.end_index ?? nested?.endIndex;
  const startIndexValue =
    annotation.start_index ?? annotation.startIndex ?? nested?.start_index ?? nested?.startIndex;
  const cleanUrl = normalizeSearchUrl(url);
  if (isLikelyJunkSearchUrl(cleanUrl)) return undefined;
  return {
    url: cleanUrl,
    title:
      typeof titleValue === "string" && titleValue.trim() ? titleValue : titleFromUrl(cleanUrl),
    endIndex: typeof endIndexValue === "number" ? endIndexValue : undefined,
    startIndex: typeof startIndexValue === "number" ? startIndexValue : undefined,
  };
}

function extractSearchResults(
  output: unknown[],
  numResults: number | undefined,
): { results: SearchResult[]; internalSources: string[]; citations: UrlCitation[] } {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const internalSources = new Set<string>();
  const citations: UrlCitation[] = [];

  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const text = typeof part.text === "string" ? part.text : "";
      const annotations = part.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        const citation = extractUrlCitation(annotation);
        if (!citation) continue;
        citations.push(citation);
        addResult(
          results,
          seenUrls,
          citation.url,
          citation.title,
          extractSnippetAround(text, citation.startIndex, citation.endIndex),
        );
      }
    }
  }

  for (const item of output) {
    if (!isRecord(item) || item.type !== "web_search_call") continue;
    const actionSources =
      isRecord(item.action) && Array.isArray(item.action.sources) ? item.action.sources : undefined;
    const sourceGroups = [actionSources, item.sources, item.results];
    for (const group of sourceGroups) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        if (!isRecord(source)) continue;
        const url = source.url ?? source.source_website_url;
        if (typeof url === "string" && url.trim().length > 0) {
          addResult(
            results,
            seenUrls,
            url,
            source.title ?? source.caption ?? source.display_name ?? source.name,
          );
        } else if (source.type === "api" && typeof source.name === "string" && source.name) {
          internalSources.add(source.name);
        }
      }
    }
    if (isRecord(item.action) && typeof item.action.url === "string") {
      addResult(results, seenUrls, item.action.url, undefined);
    }
  }

  const sliced =
    typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0
      ? results.slice(0, Math.min(Math.floor(numResults), 20))
      : results;
  return { results: sliced, internalSources: [...internalSources], citations };
}

/** Concatenate the assistant message text across output items. Exported for
 * the DeepSeek provider (same output shape). */
export function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const text = typeof part.text === "string" ? part.text : "";
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function eventType(event: unknown): string | undefined {
  return isRecord(event) && typeof event.type === "string" ? event.type : undefined;
}

/** Parse a Responses API reply: either a JSON body or an SSE stream
 * (OpenAI and DeepSeek both speak this shape). Exported for the DeepSeek
 * provider, which uses the same wire format. */
export async function parseOpenAIResponse(response: Response): Promise<{ output: unknown[] }> {
  const text = await response.text();
  const trimmed = text.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (Array.isArray(parsed)) return { output: parsed };
      if (Array.isArray(parsed.output)) return { output: parsed.output };
      return { output: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Responses API returned invalid JSON: ${message}`);
    }
  }

  const outputItems: unknown[] = [];
  let completedResponse: Record<string, unknown> | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === "response.output_item.done" && parsed.item) {
        outputItems.push(parsed.item);
      }
      if (
        (parsed.type === "response.done" || parsed.type === "response.completed") &&
        parsed.response &&
        typeof parsed.response === "object"
      ) {
        completedResponse = parsed.response as Record<string, unknown>;
      }
    } catch {
      // Skip bad lines
    }
  }

  if (
    completedResponse &&
    Array.isArray(completedResponse.output) &&
    completedResponse.output.length > 0
  ) {
    return { output: completedResponse.output };
  }
  if (outputItems.length > 0) {
    return { output: outputItems };
  }

  throw new Error("Responses API returned no parseable response output");
}

function requestInput(variant: "openai" | "codex" | "xai", query: string): unknown {
  if (variant === "xai") return [{ role: "user", content: query }];
  return [{ role: "user", content: [{ type: "input_text", text: query }] }];
}

async function parseStreamingResponse(
  response: Response,
  signal: AbortSignal | undefined,
  onUpdate: SearchOptions["onUpdate"],
  variant: "openai" | "codex" | "xai",
): Promise<{ output: unknown[]; streamedText: string }> {
  let accumulatedText = "";
  const outputItems: unknown[] = [];
  let completedOutput: unknown[] | undefined;
  const label = variant === "xai" ? "xAI" : "OpenAI";

  await readSseEvents(response, signal, ({ data: event }) => {
    const type = eventType(event);
    if (!isRecord(event) || !type) return;

    if (type === "error" || type === "response.failed") {
      const error = isRecord(event.error)
        ? event.error
        : isRecord(event.response)
          ? event.response.error
          : undefined;
      const message =
        (typeof event.message === "string" && event.message) ||
        (isRecord(error) && typeof error.message === "string" && error.message) ||
        JSON.stringify(error ?? event);
      throw new Error(message);
    }

    if (type === "response.output_text.delta") {
      accumulatedText += typeof event.delta === "string" ? event.delta : "";
      onUpdate?.({
        content: [{ type: "text", text: accumulatedText }],
        details: { streaming: true },
      });
      return;
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (event.item) outputItems.push(event.item);
      return;
    }

    if (type === "response.web_search_call.searching") {
      onUpdate?.({
        content: [{ type: "text", text: accumulatedText || `Searching the web with ${label}...` }],
        details: { streaming: true, searching: true },
      });
      return;
    }

    if (
      type === "response.completed" ||
      type === "response.done" ||
      type === "response.incomplete" ||
      (isRecord(event.response) && event.response.status === "incomplete")
    ) {
      if (isRecord(event.response) && Array.isArray(event.response.output)) {
        completedOutput = event.response.output;
      }
      if (variant === "codex") return true;
    }
  });

  return {
    output: completedOutput && completedOutput.length > 0 ? completedOutput : outputItems,
    streamedText: accumulatedText,
  };
}

export async function searchOpenAI(
  query: string,
  options: SearchOptions = {},
  ctx?: ExtensionContext,
): Promise<SearchResponse> {
  const auth = await resolveOpenAISearchRequest(ctx);
  if (!auth) {
    throw new Error(
      "OpenAI credentials not found. Set OPENAI_API_KEY, configure ~/.pi/web-search.json, sign in with pi's /login (OpenAI), or use an OpenAI Responses session model (Azure, Codex, Copilot, OpenCode, or xAI).",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...auth.headers,
  };

  const include = auth.includeResults
    ? ["web_search_call.action.sources", "web_search_call.results"]
    : ["web_search_call.action.sources"];

  const body: Record<string, unknown> = {
    model: auth.model,
    store: false,
    instructions: auth.systemPrompt,
    input: requestInput(auth.variant, query),
    tools: [buildWebSearchTool(options)],
    include,
    stream: true,
    tool_choice: "required",
    ...(auth.reasoning ? { reasoning: { effort: auth.reasoning } } : {}),
  };
  if (auth.variant === "codex") {
    body.text = { verbosity: "low" };
    body.parallel_tool_calls = true;
  }

  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(auth.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const label = auth.variant === "xai" ? "xAI" : "OpenAI";
    throw new Error(
      `${label} Responses API error (${response.status} ${response.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  let output: unknown[];
  let streamedText = "";
  if (contentType.includes("json") && !contentType.includes("event-stream")) {
    const parsed = await parseOpenAIResponse(response);
    output = parsed.output;
  } else if (contentType.includes("event-stream")) {
    const parsed = await parseStreamingResponse(
      response,
      combinedSignal,
      options.onUpdate,
      auth.variant,
    );
    output = parsed.output;
    streamedText = parsed.streamedText;
  } else {
    const parsed = await parseOpenAIResponse(response);
    output = parsed.output;
  }

  const fromOutput = extractAnswer(output);
  const answer = fromOutput || streamedText;
  const { results, internalSources, citations } = extractSearchResults(output, options.numResults);
  const citedAnswer = answer
    ? applyIndexCitations(
        answer,
        citations,
        results.map((result) => result.url),
      )
    : "";

  return {
    query,
    results,
    answer: citedAnswer || undefined,
    provider: "openai",
    internalSources: internalSources.length > 0 ? internalSources : undefined,
  };
}
