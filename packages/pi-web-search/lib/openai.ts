import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveOpenAIConfig } from "./config.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

const SEARCH_TIMEOUT_MS = 60_000;

function cleanSourceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.get("utm_source") === "openai") {
      url.searchParams.delete("utm_source");
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/[?&]utm_source=openai$/, "");
  }
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
  const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
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
  const cleanUrl = cleanSourceUrl(url);
  if (seen.has(cleanUrl)) return;
  seen.add(cleanUrl);
  results.push({
    title: typeof title === "string" && title.trim().length > 0 ? title : cleanUrl,
    url: cleanUrl,
    snippet,
  });
}

function extractSearchResults(output: unknown[], numResults: number | undefined): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
      const annotations = (part as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
        addResult(
          results,
          seenUrls,
          (annotation as { url?: unknown }).url,
          (annotation as { title?: unknown }).title,
          extractSnippetAround(text, (annotation as { start_index?: unknown }).start_index, (annotation as { end_index?: unknown }).end_index),
        );
      }
    }
  }

  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") continue;
    const value = item as { action?: unknown; sources?: unknown; results?: unknown };
    const actionSources =
      value.action && typeof value.action === "object"
        ? (value.action as { sources?: unknown }).sources
        : undefined;
    const sourceGroups = [actionSources, value.sources, value.results];
    for (const group of sourceGroups) {
      if (!Array.isArray(group)) continue;
      for (const source of group) {
        if (!source || typeof source !== "object") continue;
        const record = source as Record<string, unknown>;
        addResult(results, seenUrls, record.url ?? record.source_website_url, record.title ?? record.caption);
      }
    }
  }

  if (typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0) {
    return results.slice(0, Math.min(Math.floor(numResults), 20));
  }
  return results;
}

function extractAnswer(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

async function parseOpenAIResponse(response: Response): Promise<{ output: unknown[] }> {
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
      throw new Error(`OpenAI API returned invalid JSON: ${message}`);
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

  if (completedResponse && Array.isArray(completedResponse.output) && completedResponse.output.length > 0) {
    return { output: completedResponse.output };
  }
  if (outputItems.length > 0) {
    return { output: outputItems };
  }

  throw new Error("OpenAI API returned no parseable response output");
}

export async function searchOpenAI(
  query: string,
  options: SearchOptions = {},
  ctx?: ExtensionContext,
): Promise<SearchResponse> {
  const auth = resolveOpenAIConfig(ctx);
  if (!auth) {
    throw new Error(
      "OpenAI credentials not found. Set OPENAI_API_KEY, configure ~/.config/pi-tian-web-search/config.json, or log into pi with Codex.",
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.apiKey}`,
    "Content-Type": "application/json",
  };
  if (auth.accountId) {
    headers["ChatGPT-Account-Id"] = auth.accountId;
  }

  const body: Record<string, unknown> = {
    model: auth.model,
    store: false,
    instructions: auth.systemPrompt,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: query }],
      },
    ],
    tools: [buildWebSearchTool(options)],
    include: ["web_search_call.action.sources"],
    stream: true,
    tool_choice: "required",
  };

  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(auth.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Responses API error (${response.status} ${response.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const parsed = await parseOpenAIResponse(response);
  const answer = extractAnswer(parsed.output);
  const results = extractSearchResults(parsed.output, options.numResults);

  return {
    query,
    results,
    answer: answer || undefined,
    provider: "openai",
  };
}
