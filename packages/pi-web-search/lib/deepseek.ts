import { resolveDeepseekConfig } from "./config.ts";
import { extractAnswer, parseOpenAIResponse } from "./openai.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./types.ts";

/** Agentic server-side search: DeepSeek's Responses API runs the built-in
 * `web_search` tool on their servers (multi-round search + page reads, up to
 * 10 rounds), so allow more time than direct search APIs. */
const SEARCH_TIMEOUT_MS = 90_000;

/** Strip DeepSeek's internal `#ws_call_id=...` fragment from open_page URLs. */
function cleanUrl(rawUrl: string): string {
  return rawUrl.replace(/#ws_call_id=[^#]*$/, "");
}

function addResult(results: SearchResult[], seen: Set<string>, url: string, title?: string): void {
  const cleaned = cleanUrl(url);
  if (!cleaned || seen.has(cleaned)) return;
  seen.add(cleaned);
  results.push({
    title: title?.trim() || cleaned,
    url: cleaned,
    snippet: "",
  });
}

/** DeepSeek does not return OpenAI-style `url_citation` annotations or a
 * per-call source list (`include` is unsupported); instead the cited sources
 * appear as Markdown links in the answer text, and every page the model
 * opened shows up as a `web_search_call` item with an `open_page` action. */
function extractSearchResults(output: unknown[], answerText: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const match of answerText.matchAll(/\[([^\]]{0,300})\]\((https?:\/\/[^)\s]+)\)/g)) {
    addResult(results, seen, match[2], match[1]);
  }

  for (const item of output) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "web_search_call"
    ) {
      continue;
    }
    const action = (item as { action?: unknown }).action;
    if (!action || typeof action !== "object") continue;
    const record = action as { type?: unknown; url?: unknown };
    if (record.type === "open_page" && typeof record.url === "string") {
      addResult(results, seen, record.url);
    }
  }

  return results;
}

export async function searchDeepseek(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const config = resolveDeepseekConfig();
  if (!config) {
    throw new Error(
      "DeepSeek credentials not found. /login with DeepSeek in pi, set DEEPSEEK_API_KEY, or run /websearch-auth.",
    );
  }

  const body: Record<string, unknown> = {
    model: config.model,
    instructions: config.systemPrompt,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: query }],
      },
    ],
    tools: [{ type: "web_search" }],
    tool_choice: { type: "web_search" },
    reasoning: { effort: config.reasoning },
    stream: true,
  };

  const timeoutSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(config.baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `DeepSeek Responses API error (${response.status} ${response.statusText}): ${errorText.slice(0, 300)}`,
    );
  }

  const parsed = await parseOpenAIResponse(response);
  const answer = extractAnswer(parsed.output);
  let results = extractSearchResults(parsed.output, answer);

  if (
    typeof options.numResults === "number" &&
    Number.isFinite(options.numResults) &&
    options.numResults > 0
  ) {
    results = results.slice(0, Math.min(Math.floor(options.numResults), 20));
  }

  return {
    query,
    results,
    answer: answer || undefined,
    provider: "deepseek",
  };
}
