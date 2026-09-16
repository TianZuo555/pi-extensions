import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { registerTools, WebFetchParams, WebSearchParams } from "../lib/tools.ts";
import {
  DEFAULT_OPENAI_SYSTEM_PROMPT,
  WEB_FETCH_PROMPT_SNIPPET,
  WEB_FETCH_TOOL_DESCRIPTION,
  WEB_SEARCH_PROMPT_SNIPPET,
  WEB_SEARCH_TOOL_DESCRIPTION,
} from "../lib/prompt.ts";

test("WebSearchParams schema contains only query and numResults", () => {
  const properties = WebSearchParams.properties;
  const propNames = Object.keys(properties);
  assert.deepEqual(propNames.sort(), ["numResults", "query"]);
  assert.equal(properties.query.type, "string");
  const numResults = properties.numResults as typeof properties.numResults & {
    minimum: number;
    maximum: number;
  };
  assert.equal(numResults.type, "integer");
  assert.equal(numResults.minimum, 1);
  assert.equal(numResults.maximum, 20);
});

test("WebFetchParams schema contains url, raw, and maxPages", () => {
  const properties = WebFetchParams.properties;
  const propNames = Object.keys(properties);
  assert.deepEqual(propNames.sort(), ["maxPages", "raw", "url"]);
  assert.equal(properties.url.type, "string");
  assert.equal(properties.raw.type, "boolean");
  assert.equal(properties.maxPages.type, "integer");
});

test("every web tool parameter has a description", () => {
  for (const schema of [WebSearchParams, WebFetchParams]) {
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok((property as { description?: string }).description, `${name} has no description`);
    }
  }
});

test("model-facing web tool metadata stays concise", () => {
  const tools = [
    {
      name: "web_search",
      schema: WebSearchParams,
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      snippet: WEB_SEARCH_PROMPT_SNIPPET,
      schemaBudget: 220,
    },
    {
      name: "web_fetch",
      schema: WebFetchParams,
      description: WEB_FETCH_TOOL_DESCRIPTION,
      snippet: WEB_FETCH_PROMPT_SNIPPET,
      schemaBudget: 340,
    },
  ];

  for (const tool of tools) {
    const schemaLength = JSON.stringify(tool.schema).length;
    assert.ok(
      schemaLength <= tool.schemaBudget,
      `${tool.name} schema budget exceeded: ${schemaLength} chars`,
    );
    assert.ok(tool.description.length <= 60, `${tool.name} description is too long`);
    assert.ok(tool.snippet.length <= 24, `${tool.name} snippet is too long`);
  }

  assert.ok(DEFAULT_OPENAI_SYSTEM_PROMPT.length <= 90);
});

interface CapturedTool {
  readonly renderResult?: (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: { isError: boolean },
  ) => Component;
}

function captureTool(name: string): CapturedTool {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool as unknown as CapturedTool);
    },
  } as unknown as ExtensionAPI;
  registerTools(pi);
  const tool = tools.get(name);
  assert.ok(tool, `${name} was not registered`);
  return tool;
}

const theme = {
  fg(_color: string, value: string) {
    return value;
  },
  bold(value: string) {
    return value;
  },
} as unknown as Theme;

const render = (component: Component, width = 120): string[] => {
  const lines = component.render(width);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line exceeds width: ${line}`);
  }
  return lines;
};

const errorResult = (message: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: message }],
  details: {},
});

for (const [toolName, verb] of [
  ["web_fetch", "Fetch"],
  ["web_search", "Search"],
] as const) {
  test(`${toolName} renders an error line instead of a fake success summary`, () => {
    const tool = captureTool(toolName);
    const component = tool.renderResult!(
      errorResult(
        `All ${verb.toLowerCase()} providers failed:\n  • direct: Failed to parse PDF\n  • firecrawl: fetch failed`,
      ),
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    );
    const [line] = render(component);
    assert.equal(line.trimEnd(), `✗ All ${verb.toLowerCase()} providers failed:`);
  });

  test(`${toolName} expands to the full provider failure list`, () => {
    const tool = captureTool(toolName);
    const component = tool.renderResult!(
      errorResult(
        `All ${verb.toLowerCase()} providers failed:\n  • direct: Failed to parse PDF\n  • firecrawl: fetch failed`,
      ),
      { expanded: true, isPartial: false },
      theme,
      { isError: true },
    );
    const text = render(component).join("\n");
    assert.match(text, /✗ All \w+ providers failed:/);
    assert.match(text, /• direct: Failed to parse PDF/);
    assert.match(text, /• firecrawl: fetch failed/);
  });

  test(`${toolName} falls back to "${verb} failed" when the error carries no text`, () => {
    const tool = captureTool(toolName);
    const component = tool.renderResult!(
      { content: [], details: {} },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    );
    assert.equal(render(component)[0].trimEnd(), `✗ ${verb} failed`);
  });
}
