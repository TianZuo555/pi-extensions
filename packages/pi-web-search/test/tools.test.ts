import assert from "node:assert/strict";
import test from "node:test";
import {
  WebFetchParams,
  WebSearchParams,
} from "../lib/tools.ts";
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

test("WebFetchParams schema contains only url and raw", () => {
  const properties = WebFetchParams.properties;
  const propNames = Object.keys(properties);
  assert.deepEqual(propNames.sort(), ["raw", "url"]);
  assert.equal(properties.url.type, "string");
  assert.equal(properties.raw.type, "boolean");
});

test("every web tool parameter has a description", () => {
  for (const schema of [WebSearchParams, WebFetchParams]) {
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok(property.description, `${name} has no description`);
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
      schemaBudget: 200,
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
